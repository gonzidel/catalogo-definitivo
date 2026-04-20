// scripts/product-alternatives.js
// Sistema de productos alternativos cuando un producto/variante está sin stock

import { supabase as supabaseClient } from "./supabase-client.js";

let supabase = supabaseClient;

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Busca productos alternativos basándose en similitud usando find_similar_products.
 * Versión mejorada que usa el sistema de similitud con scoring.
 * @param {Object} params - Parámetros de búsqueda
 * @param {string} params.productId - ID del producto original (nuevo, preferido)
 * @param {string} params.articulo - Nombre del artículo original (legacy, usado si no hay productId)
 * @param {string} params.talle - Talle deseado
 * @param {string[]} params.tags - Tags del producto original (legacy, no usado en nueva versión)
 * @param {string} params.color - Color del producto original (opcional)
 * @param {number} limit - Límite de productos a retornar (default: 6)
 * @returns {Promise<Array>} Lista de productos alternativos
 */
export async function buscarProductosAlternativos({
  productId = null,
  articulo = null,
  talle,
  tags = [],
  color = null,
  limit = 6,
}) {
  try {
    if (!supabase) {
      console.warn("⚠️ Supabase no disponible para buscar alternativas");
      return [];
    }

    console.log("🔍 Buscando productos alternativos:", {
      productId,
      articulo,
      talle,
      color,
      limit,
    });

    // Si no hay productId, intentar obtenerlo por nombre (legacy)
    let sourceProductId = productId;
    if (!sourceProductId && articulo) {
      const { data: product } = await supabase
        .from("products")
        .select("id")
        .eq("name", articulo)
        .eq("status", "active")
        .maybeSingle();
      if (product) {
        sourceProductId = product.id;
      }
    }

    if (!sourceProductId) {
      console.warn("⚠️ No se pudo determinar productId para buscar similares");
      return [];
    }

    // RPC opcional: si no existe en Supabase (404 / does not exist), no ensuciar consola.
    const disableRpc =
      typeof window !== "undefined" && window.__DISABLE_SIMILAR_RPC__ === true;

    let similares = null;
    if (!disableRpc) {
      const { data: rpcData, error: similaresError } = await supabase
        .rpc("find_similar_products", {
          source_product_id: sourceProductId,
          size_filter: talle || null,
          limit_count: limit,
        });

      if (similaresError) {
        const msg = String(similaresError.message || "").toLowerCase();
        const isNotFound =
          msg.includes("not found") ||
          msg.includes("does not exist") ||
          String(similaresError.code || "") === "404";

        if (!isNotFound) {
          console.error("❌ Error buscando similares (RPC):", similaresError);
        } else {
          console.info("ℹ️ RPC find_similar_products no disponible. Usando fallback.");
        }

        const fallback = await buscarAlternativasFallbackPorCatalogo({
          articulo,
          talle,
          tags,
          color,
          limit,
        });
        return attachPdpUrls(fallback);
      }

      similares = rpcData || null;
    }

    if (!similares || similares.length === 0) {
      console.log("ℹ️ No se encontraron productos similares (RPC). Usando fallback...");
      const fallback = await buscarAlternativasFallbackPorCatalogo({
        articulo,
        talle,
        tags,
        color,
        limit,
      });
      return attachPdpUrls(fallback);
    }

    // Resolver UUIDs de warehouses una sola vez antes de enriquecer variantes
    const { data: whRows } = await supabase
      .from('warehouses')
      .select('id, code')
      .in('code', ['general', 'venta-publico']);
    const whMap = new Map((whRows || []).map((w) => [w.code, w.id]));
    const generalId = whMap.get('general') || null;
    const ventaId = whMap.get('venta-publico') || null;
    const whIds = [generalId, ventaId].filter(Boolean);

    // Enriquecer con imágenes y datos adicionales
    const productosEnriquecidosRaw = await Promise.all(
      similares.map(async (item) => {
        // Obtener variante específica (color y talle) — sin columnas deprecated de stock
        const { data: variant } = await supabase
          .from('product_variants')
          .select('id, color, size, sku, price')
          .eq('product_id', item.product_id)
          .eq('color', item.color)
          .in('size', item.available_sizes || [])
          .eq('active', true)
          .maybeSingle();

        // Obtener imagen principal
        const { data: image } = await supabase
          .from('variant_images')
          .select('url')
          .eq('variant_id', variant?.id)
          .eq('position', 1)
          .maybeSingle();

        // Calcular stock disponible desde fuente canónica por warehouse (usando UUIDs reales)
        let stockDisponible = 0;
        if (variant?.id && whIds.length > 0) {
          const { data: whStock } = await supabase
            .from('variant_warehouse_stock')
            .select('stock_qty')
            .eq('variant_id', variant.id)
            .in('warehouse_id', whIds);
          (whStock || []).forEach((row) => {
            stockDisponible += Number(row.stock_qty ?? 0);
          });
          stockDisponible = Math.max(0, stockDisponible);
        }

        // Obtener todos los colores disponibles para este producto y talle
        const { data: variantesColor } = await supabase
          .from('product_variants')
          .select('id, color, price')
          .eq('product_id', item.product_id)
          .in('size', item.available_sizes || [])
          .eq('active', true);

        // Para cada variante de color, verificar stock canónico (usando UUIDs reales)
        const coloresConStock = await Promise.all(
          (variantesColor || []).map(async (v) => {
            if (whIds.length === 0) return null;
            const { data: stockRows } = await supabase
              .from('variant_warehouse_stock')
              .select('stock_qty')
              .eq('variant_id', v.id)
              .in('warehouse_id', whIds);
            const total = (stockRows || []).reduce((sum, r) => sum + Number(r.stock_qty ?? 0), 0);
            return total > 0 ? { color: v.color, precio: Number(v.price ?? 0), stock: total } : null;
          })
        ).then((results) => results.filter(Boolean));

        // Obtener highlights para mostrar como tags
        const { data: highlights } = await supabase
          .rpc('get_product_highlights', { product_id: item.product_id });

        return {
          product_id: item.product_id,
          articulo: item.name,
          categoria: item.category,
          descripcion: '',
          color: item.color,
          talle: item.available_sizes?.[0] || talle,
          sku: variant?.sku || null,
          precio: Number(item.price ?? 0) || 0,
          imagen: image?.url || null,
          stock_disponible: stockDisponible,
          colores_disponibles: coloresConStock,
          tags: (highlights || []).map(h => h.name),
          similitud: item.similarity_score / 100,
          variant_id: variant?.id,
        };
      })
    );

    const productosEnriquecidos = await attachPdpUrls(productosEnriquecidosRaw);

    console.log(
      `✅ Encontrados ${productosEnriquecidos.length} productos alternativos`
    );

    return productosEnriquecidos;
  } catch (error) {
    console.error("❌ Error buscando productos alternativos:", error);
    // Último fallback: armar alternativas leyendo catalog_public_view.
    const fallback = await buscarAlternativasFallbackPorCatalogo({
      articulo,
      talle,
      tags,
      color,
      limit,
    });
    return attachPdpUrls(fallback);
  }
}

function normalizeTalleForCompare(t) {
  const s = String(t ?? "").trim();
  if (!s) return "";
  return s;
}

function parseNumeracionList(numeracion) {
  const raw = String(numeracion ?? "").trim();
  if (!raw) return [];
  // Numeracion viene como "36,37,38"
  return raw
    .split(",")
    .map((s) => String(s).trim())
    .filter(Boolean);
}

function splitPossibleTagList(tagValue) {
  const raw = String(tagValue ?? "").trim();
  if (!raw) return [];
  return raw
    .split(/[,;]/)
    .map((s) => String(s).trim())
    .filter(Boolean);
}

function normalizeTagValue(v) {
  const s = String(v ?? "").trim().toLowerCase();
  if (!s) return "";
  // Quitar acentos/diacríticos y normalizar espacios
  const noDiacritics = s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return noDiacritics.replace(/\s+/g, " ").trim();
}

function safeParsePrice(p) {
  let s = String(p ?? "").trim();
  if (!s) return 0;
  // Quitar símbolos y espacios raros, mantener dígitos y separadores
  s = s.replace(/[^\d.,-]/g, "");
  if (!s) return 0;

  const hasComma = s.includes(",");
  const hasDot = s.includes(".");

  // Caso 1: "30.800,00" (AR): puntos miles + coma decimal
  if (hasComma) {
    const normalized = s.replace(/\./g, "").replace(",", ".");
    const n = Number(normalized);
    return Number.isFinite(n) ? n : 0;
  }

  // Caso 2: "30800.00" (US): punto decimal
  if (hasDot) {
    // Si termina en .0 / .00 / .000 (decimal), NO es separador de miles
    if (/\.\d{1,3}$/.test(s)) {
      const n = Number(s);
      return Number.isFinite(n) ? n : 0;
    }
    // Si no parece decimal, tratar puntos como miles: "30.800"
    const n = Number(s.replace(/\./g, ""));
    return Number.isFinite(n) ? n : 0;
  }

  // Caso 3: "30800"
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

async function buscarAlternativasFallbackPorCatalogo({
  articulo,
  talle,
  tags,
  color,
  limit,
}) {
  if (!supabase) return [];

  const targetTalle = normalizeTalleForCompare(talle);
  if (!articulo || !targetTalle) return [];

  const sourceTags = Array.isArray(tags)
    ? tags.filter(Boolean).map((t) => String(t).trim())
    : [];
  const sourceFiltro1 = sourceTags[0] || "";
  const sourceFiltro2 = sourceTags[1] || "";
  const sourceFiltro3Tokens = splitPossibleTagList(sourceTags[2] || "");

  // 1) Obtener categoría base + tags del producto a reemplazar.
  // Usar select('*') para evitar problemas con columnas con mayúsculas/quotes.
  const { data: sourceRow, error: sourceErr } = await supabase
    .from("catalog_public_view")
    .select("*")
    .eq("Articulo", articulo)
    .limit(1)
    .maybeSingle();

  if (sourceErr) {
    console.warn("⚠️ Fallback alternativas: no se pudo leer sourceRow:", sourceErr);
  }

  const categoria = sourceRow?.Categoria || null;
  const sourceFiltro1Resolved = sourceFiltro1 || sourceRow?.Filtro1 || "";
  const sourceFiltro2Resolved = sourceFiltro2 || sourceRow?.Filtro2 || "";
  const sourceFiltro3ResolvedTokens = sourceFiltro3Tokens.length
    ? sourceFiltro3Tokens
    : splitPossibleTagList(sourceRow?.Filtro3 || "");

  const sourceF1Norm = normalizeTagValue(sourceFiltro1Resolved);
  const sourceF2Norm = normalizeTagValue(sourceFiltro2Resolved);
  const sourceF3NormTokens = sourceFiltro3ResolvedTokens.map(normalizeTagValue).filter(Boolean);

  async function fetchCandidateRows({ scopedToCategory }) {
    let q = supabase.from("catalog_public_view").select("*");
    if (scopedToCategory && categoria) q = q.eq("Categoria", categoria);
    // Limit para evitar cargar demasiado; rankeamos en JS.
    q = q.limit(scopedToCategory ? 1500 : 3000);
    const { data, error } = await q;
    if (error) {
      console.error("❌ Fallback alternativas: error consultando catalog_public_view:", error);
      return [];
    }
    return data || [];
  }

  // 2) Traer candidatos desde la vista (primero por categoría; si no alcanza, ampliar)
  let rows = await fetchCandidateRows({ scopedToCategory: true });
  if (!rows || rows.length === 0) {
    rows = await fetchCandidateRows({ scopedToCategory: false });
  }
  if (!rows || rows.length === 0) return [];

  const targetTalleLower = targetTalle.toLowerCase();

  const scored = [];
  const scoredLoose = [];
  let filteredByTalle = 0;
  let filteredByTags12 = 0;
  let filteredByTag1Only = 0;

  for (const row of rows) {
    const rowArticulo = String(row.Articulo ?? "").trim();
    if (!rowArticulo) continue;
    if (rowArticulo.toLowerCase() === String(articulo).trim().toLowerCase()) continue;

    const numeracionList = parseNumeracionList(row.Numeracion);
    const hasTargetTalle = numeracionList.some(
      (n) => String(n).trim().toLowerCase() === targetTalleLower
    );
    if (!hasTargetTalle) continue;
    filteredByTalle++;

    const f1 = String(row.Filtro1 ?? "").trim();
    const f2 = String(row.Filtro2 ?? "").trim();
    const f3Tokens = splitPossibleTagList(row.Filtro3 ?? "");

    // Requisito (según intención de negocio):
    // - Tag1 (Filtro1) DEBE coincidir (ej. "Bota").
    // - "Tag2" puede vivir en Filtro2 O en alguno de los tags de Filtro3 (ej. "Caña Alta", "Media Caña").
    //   En tu caso, Filtro2 puede ser algo como "Lluvia", y la altura de caña está en Filtro3.
    const mustMatchF1 = !!sourceF1Norm;
    const f1Norm = normalizeTagValue(f1);
    if (mustMatchF1 && (!f1Norm || f1Norm !== sourceF1Norm)) continue;

    const f2Norm = normalizeTagValue(f2);
    const f3NormTokens = f3Tokens.map(normalizeTagValue).filter(Boolean);

    // "Segundo tag" del origen: preferimos Filtro2 si existe, pero también consideramos Filtro3.
    // Debe haber al menos 1 match contra (candidate.Filtro2 o candidate.Filtro3).
    const sourceSecondary = [];
    if (sourceF2Norm) sourceSecondary.push(sourceF2Norm);
    sourceSecondary.push(...sourceF3NormTokens);
    const sourceSecondaryUnique = Array.from(new Set(sourceSecondary)).filter(Boolean);

    const matchesSecondary =
      sourceSecondaryUnique.length === 0
        ? true
        : sourceSecondaryUnique.some((t) => t && (t === f2Norm || f3NormTokens.includes(t)));

    // Guardar un set "loose" (solo Tag1 + talle) para no quedarnos sin alternativas
    // cuando el tag secundario del origen es demasiado específico (ej. "Lluvia").
    filteredByTag1Only++;

    let score = 0;
    if (mustMatchF1) score += 50;
    // Bonus si el candidato matchea el Filtro2 exacto del origen (si existiera)
    if (sourceF2Norm && f2Norm && f2Norm === sourceF2Norm) score += 30;
    if (sourceF3NormTokens.length > 0 && f3NormTokens.length > 0) {
      const overlaps = f3NormTokens.filter((t) => sourceF3NormTokens.includes(t));
      score += Math.min(overlaps.length * 5, 15);
    }

    const rowColor = String(row.Color ?? "").trim();
    if (color && rowColor && rowColor.toLowerCase() === String(color).trim().toLowerCase()) score += 2;

    const imagen =
      row["Imagen Principal"] ||
      row["Imagen 1"] ||
      row["Imagen 2"] ||
      row["Imagen 3"] ||
      "";

    const tagsOut = [
      row.Filtro1,
      row.Filtro2,
      ...splitPossibleTagList(row.Filtro3),
    ]
      .filter(Boolean)
      .map((t) => String(t).trim())
      .filter(Boolean);

    const baseItem = {
      product_id: null,
      articulo: rowArticulo,
      categoria: String(row.Categoria ?? ""),
      descripcion: String(row.Descripcion ?? ""),
      color: rowColor,
      talle: targetTalle,
      precio: safeParsePrice(row.Precio),
      imagen,
      stock_disponible: "OK",
      colores_disponibles: [],
      tags: Array.from(new Set(tagsOut)),
      similitud: score / 100,
      variant_id: null,
      _score: score,
      _fecha: String(row.FechaIngreso ?? ""),
    };

    // Siempre incluir en loose (Tag1 only)
    scoredLoose.push(baseItem);

    // Incluir en strict solo si cumple “tag secundario”
    if (!matchesSecondary) continue;
    filteredByTags12++;
    scored.push(baseItem);
  }

  const pool = scored.length > 0 ? scored : scoredLoose;

  const dbg = {
    articulo,
    talle: targetTalle,
    categoria: categoria || "(sin categoria)",
    sourceFiltro1Resolved: sourceFiltro1Resolved || "(vacío)",
    sourceFiltro2Resolved: sourceFiltro2Resolved || "(vacío)",
    sourceF1Norm: sourceF1Norm || "(vacío)",
    sourceF2Norm: sourceF2Norm || "(vacío)",
    sourceF3NormTokens: sourceF3NormTokens.slice(0, 10),
    candidatesFetched: rows.length,
    candidatesWithTalle: filteredByTalle,
    candidatesWithTag1Tag2: filteredByTags12,
    candidatesWithTag1Only: filteredByTag1Only,
    resultsStrict: scored.length,
    resultsLoose: scoredLoose.length,
    using: scored.length > 0 ? "strict(tag1+secondary)" : "loose(tag1-only)",
    results: pool.length,
  };
  // Stringify para que se vea aunque no expandas el objeto en consola
  console.log("🔁 Fallback alternativas (catalog_public_view): " + JSON.stringify(dbg));

  pool.sort((a, b) => {
    if (b._score !== a._score) return b._score - a._score;
    return String(b._fecha).localeCompare(String(a._fecha));
  });

  // 3) Dedupe por Articulo+Color y armar colores_disponibles por Articulo.
  const byArticulo = new Map();
  for (const it of pool) {
    const k = it.articulo.toLowerCase();
    if (!byArticulo.has(k)) byArticulo.set(k, []);
    byArticulo.get(k).push(it);
  }

  const final = [];
  const seen = new Set();
  for (const it of pool) {
    const key = `${it.articulo}__${it.color}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const opcionesColor = (byArticulo.get(it.articulo.toLowerCase()) || [])
      .slice(0, 3)
      .map((x) => ({
        color: x.color,
        precio: x.precio,
        stock: 1,
      }));

    final.push({
      product_id: it.product_id,
      articulo: it.articulo,
      categoria: it.categoria,
      descripcion: it.descripcion,
      color: it.color,
      talle: it.talle,
      sku: null,
      precio: it.precio,
      imagen: it.imagen,
      stock_disponible: it.stock_disponible,
      colores_disponibles: opcionesColor,
      tags: it.tags,
      similitud: it.similitud,
      variant_id: it.variant_id,
    });

    if (final.length >= Number(limit) || final.length >= 6) break;
  }

  return final;
}

async function attachPdpUrls(productos = []) {
  if (!supabase || !Array.isArray(productos) || productos.length === 0) return productos;

  return Promise.all(
    productos.map(async (p) => {
      const existingSku = String(p?.sku || "").trim();
      if (existingSku) {
        return {
          ...p,
          pdp_url: `../index.html#/pdp/${encodeURIComponent(existingSku)}`,
        };
      }

      const articulo = String(p?.articulo || "").trim();
      const color = String(p?.color || "").trim();
      if (!articulo || !color) {
        return { ...p, pdp_url: `../index.html?articulo=${encodeURIComponent(articulo)}` };
      }

      try {
        const { data: variant, error } = await supabase
          .from("product_variants")
          .select("sku, products!inner(name)")
          .eq("active", true)
          .eq("color", color)
          .eq("products.name", articulo)
          .not("sku", "is", null)
          .limit(1)
          .maybeSingle();

        if (error || !variant?.sku) {
          return { ...p, pdp_url: `../index.html?articulo=${encodeURIComponent(articulo)}` };
        }

        const sku = String(variant.sku).trim();
        return {
          ...p,
          sku,
          pdp_url: `../index.html#/pdp/${encodeURIComponent(sku)}`,
        };
      } catch (_) {
        return { ...p, pdp_url: `../index.html?articulo=${encodeURIComponent(articulo)}` };
      }
    })
  );
}

/**
 * Crea y muestra un modal con productos alternativos
 * @param {Object} params - Parámetros para el modal
 * @param {string} [params.mensaje] - Texto plano (se escapa). Ignorado si hay mensajeArticulo y mensajeTalle.
 * @param {string} [params.mensajeArticulo] - Artículo para el texto "Productos similares a …"
 * @param {string} [params.mensajeTalle] - Talle para "en talle …" (negrita junto al artículo)
 * @param {Array} params.productos - Lista de productos alternativos
 * @param {Function} params.onProductoSeleccionado - Callback cuando se selecciona un producto
 * @param {Function} params.onCerrar - Callback cuando se cierra el modal
 */
export function mostrarModalAlternativas({
  mensaje,
  mensajeArticulo,
  mensajeTalle,
  productos = [],
  onProductoSeleccionado = null,
  onCerrar = null,
}) {
  const mensajeHtml =
    mensajeArticulo != null && mensajeArticulo !== "" && mensajeTalle != null && mensajeTalle !== ""
      ? `Productos similares a <strong>${escapeHtml(mensajeArticulo)}</strong> en talle <strong>${escapeHtml(mensajeTalle)}</strong>.`
      : escapeHtml(mensaje || "");
  // Remover modal anterior si existe
  const modalAnterior = document.getElementById("alternativas-modal");
  if (modalAnterior) {
    modalAnterior.remove();
  }

  // Crear modal
  const modal = document.createElement("div");
  modal.id = "alternativas-modal";
  modal.className = "alternativas-modal";
  modal.innerHTML = `
    <div class="alternativas-modal-content">
      <div class="alternativas-modal-header alternativas-modal-header--sticky">
        <h2>Alternativas</h2>
        <button type="button" class="alternativas-modal-close" id="alternativas-close-btn" aria-label="Cerrar">×</button>
      </div>
      <div class="alternativas-modal-body">
        <p class="alternativas-modal-message">${mensajeHtml}</p>
        ${
          productos.length === 0
            ? `<div class="alternativas-empty">
                <p>No se encontraron productos alternativos con stock disponible.</p>
              </div>`
            : `<div class="alternativas-grid" id="alternativas-grid">
                ${productos
                  .map((producto, index) => {
                    const imagenUrl =
                      producto.imagen ||
                      "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200' viewBox='0 0 200 200'%3E%3Crect width='200' height='200' fill='%23f0f0f0'/%3E%3Ctext x='50%25' y='50%25' text-anchor='middle' dy='.3em' fill='%23999'%3ESin imagen%3C/text%3E%3C/svg%3E";
                    return `
                      <div class="alternativa-card" data-product-id="${producto.product_id}" data-variant-id="${producto.variant_id}">
                        <img src="${imagenUrl}" alt="${producto.articulo}" class="alternativa-image" onerror="this.src='data:image/svg+xml,%3Csvg xmlns=\\'http://www.w3.org/2000/svg\\' width=\\'200\\' height=\\'200\\'%3E%3Crect fill=\\'%23f0f0f0\\'/%3E%3Ctext fill=\\'%23999\\'%3ESin imagen%3C/text%3E%3C/svg%3E'">
                        <div class="alternativa-info">
                          <div class="alternativa-title-row" style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                            <h3 class="alternativa-title">
                              <span class="alternativa-art-label">Art.</span>
                              <span class="alternativa-title-name">${producto.articulo}</span>
                            </h3>
                            ${
                              producto.tags.length > 0
                                ? `<div class="alternativa-tags" style="margin:0;">${producto.tags
                                    .map((t) => `<span class="alternativa-tag">${t}</span>`)
                                    .join("")}</div>`
                                : ""
                            }
                          </div>
                          <p class="alternativa-meta">Color: ${producto.color} • Talle: ${producto.talle}</p>
                          ${producto.colores_disponibles.length > 1 ? `<p class="alternativa-colores">También disponible en: ${producto.colores_disponibles.slice(0, 3).map(c => c.color).join(", ")}</p>` : ""}
                          <p class="alternativa-precio">
                            <span class="alternativa-precio-monto">$${producto.precio.toLocaleString("es-AR")}</span>
                            <span class="alternativa-precio-etiqueta">precio por mayor</span>
                          </p>
                        </div>
                        <div class="alternativa-actions" style="display:flex; gap:10px; margin-top: 5px;">
                          <a class="alternativa-view-btn" 
                             href="${producto.pdp_url || `../index.html?articulo=${encodeURIComponent(producto.articulo)}`}"
                             style="flex:0 0 auto; min-width: 86px; text-align:center; padding: 10px 12px; border-radius: 10px; font-weight: 700; font-size: 13px; border: 1px solid rgba(0,0,0,0.14); background: #f0f0f0; color: #333; text-decoration: none;">
                            Ver
                          </a>
                          <button class="alternativa-select-btn" data-index="${index}" style="flex:1;">
                            Seleccionar
                          </button>
                        </div>
                      </div>
                    `;
                  })
                  .join("")}
              </div>`
        }
      </div>
      <div class="alternativas-modal-footer">
        <button class="alternativas-cerrar-btn" id="alternativas-cerrar-btn">Cerrar</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  // Mostrar modal
  setTimeout(() => {
    modal.classList.add("active");
  }, 10);

  // Event listeners
  const closeBtn = document.getElementById("alternativas-close-btn");
  const cerrarBtn = document.getElementById("alternativas-cerrar-btn");

  const cerrarModal = () => {
    modal.classList.remove("active");
    setTimeout(() => {
      modal.remove();
      if (onCerrar) onCerrar();
    }, 300);
  };

  if (closeBtn) {
    closeBtn.addEventListener("click", cerrarModal);
  }

  if (cerrarBtn) {
    cerrarBtn.addEventListener("click", cerrarModal);
  }

  // Cerrar al hacer clic fuera del modal
  modal.addEventListener("click", (e) => {
    if (e.target === modal) {
      cerrarModal();
    }
  });

  // Cerrar con tecla ESC
  const handleEsc = (e) => {
    if (e.key === "Escape" && modal.classList.contains("active")) {
      cerrarModal();
      document.removeEventListener("keydown", handleEsc);
    }
  };
  document.addEventListener("keydown", handleEsc);

  // Botones de selección de producto
  if (productos.length > 0) {
    document
      .querySelectorAll(".alternativa-select-btn")
      .forEach((btn) => {
        btn.addEventListener("click", (e) => {
          const index = parseInt(btn.dataset.index);
          const producto = productos[index];
          if (producto && onProductoSeleccionado) {
            onProductoSeleccionado(producto);
            cerrarModal();
          }
        });
      });

    // También permitir seleccionar haciendo clic en la tarjeta
    document.querySelectorAll(".alternativa-card").forEach((card) => {
      card.addEventListener("click", (e) => {
        // Solo si no se hizo clic en el botón
        if (!e.target.closest(".alternativa-select-btn")) {
          const productId = card.dataset.productId;
          const producto = productos.find((p) => p.product_id === productId);
          if (producto && onProductoSeleccionado) {
            onProductoSeleccionado(producto);
            cerrarModal();
          }
        }
      });
      card.style.cursor = "pointer";
    });
  }

  return modal;
}

// Exportar funciones globalmente
if (typeof window !== "undefined") {
  window.buscarProductosAlternativos = buscarProductosAlternativos;
  window.mostrarModalAlternativas = mostrarModalAlternativas;
}

