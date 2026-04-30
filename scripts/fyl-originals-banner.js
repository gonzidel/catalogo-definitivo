// scripts/fyl-originals-banner.js - Banner de productos FYL Originals

import { supabase } from "./supabase-client.js";

function fylDevLog(...args) {
  if (
    typeof window !== "undefined" &&
    (window.FYL_DEBUG_CATALOG === true ||
      /(?:^|[&?])debug=catalog(?:&|$)/.test(window.location.search || ""))
  ) {
    console.log.apply(console, args);
  }
}

let fylProducts = [];
let fylProductsLoaded = 0; // Contador de productos mostrados
const PRODUCTS_PER_PAGE = 10; // Cantidad de productos a cargar por página
let scrollListenerAttached = false; // Flag para evitar múltiples listeners
let currentScrollHandler = null; // Referencia al handler de scroll actual

function buildLocalDateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function stableStringHash(text) {
  const input = String(text || "");
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function getMainImage(producto) {
  return producto?.VariantePrincipal || producto?.DetalleColor?.[0]?.images?.[0] || "";
}

function getPrimaryColorLabel(producto) {
  return (producto?.DetalleColor?.[0]?.color || "sin-color").trim().toLowerCase();
}

function getFirstVariantDetail(producto) {
  for (const detalleColor of producto?.DetalleColor || []) {
    for (const vd of detalleColor?.variantDetails || []) {
      if (!vd) continue;
      if (vd.sku || vd.variant_id || vd.variantId) return vd;
    }
  }
  return null;
}

function getProductIdentity(producto) {
  if (!producto) return null;
  const sku = obtenerSKUDefecto(producto);
  if (sku) return `sku:${String(sku).trim().toLowerCase()}`;

  const firstVariant = getFirstVariantDetail(producto);
  const variantId = firstVariant?.variant_id || firstVariant?.variantId || producto.variant_id;
  if (variantId) return `variant:${String(variantId).trim().toLowerCase()}`;

  const articulo = (producto.Articulo || "").trim().toLowerCase();
  const color = getPrimaryColorLabel(producto);
  if (articulo) return `articuloColor:${articulo}__${color}`;
  return null;
}

function isActiveProduct(producto) {
  const activo = producto?.Activo;
  if (activo === false) return false;
  if (typeof activo === "string" && activo.trim().toLowerCase() === "false") return false;
  return true;
}

function hasPositiveStock(producto) {
  let total = 0;
  let sawNumericSignal = false;

  for (const detalleColor of producto?.DetalleColor || []) {
    for (const vd of detalleColor?.variantDetails || []) {
      if (vd?.available === null || vd?.available === undefined || vd?.available === "") {
        continue;
      }
      const num = Number(vd?.available);
      if (!Number.isNaN(num)) {
        total += num;
        sawNumericSignal = true;
      }
    }
  }

  if (!sawNumericSignal) return true;
  return total > 0;
}

function isRenderableProduct(producto) {
  const image = getMainImage(producto);
  const nombre = (producto?.Articulo || producto?.Descripcion || "").trim();
  const id = getProductIdentity(producto);
  return Boolean(image && nombre && id);
}

function normalizeCategory(value) {
  return String(value || "").trim().toLowerCase();
}

function isVisuallyDistinctFromTop3(producto, top3) {
  const ownCategory = normalizeCategory(producto?.Filtro1 || producto?.Filtro2 || producto?.Filtro3);
  const ownColor = getPrimaryColorLabel(producto);

  for (const p of top3) {
    if (!p) continue;
    const cat = normalizeCategory(p?.Filtro1 || p?.Filtro2 || p?.Filtro3);
    const color = getPrimaryColorLabel(p);
    if (ownCategory && cat && ownCategory === cat) return false;
    if (ownColor && color && ownColor === color) return false;
  }
  return true;
}

function dedupeBySafeIdentity(products) {
  const seen = new Set();
  const out = [];
  products.forEach((p) => {
    const id = getProductIdentity(p);
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push(p);
  });
  return out;
}

function excludeProducts(base, excludedProducts) {
  const excludedIds = new Set(
    (excludedProducts || [])
      .map((p) => getProductIdentity(p))
      .filter(Boolean)
  );
  return base.filter((p) => !excludedIds.has(getProductIdentity(p)));
}

function pickBestCandidate(pool, scorer) {
  let best = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  pool.forEach((p) => {
    const score = scorer(p);
    const id = getProductIdentity(p) || "";
    const bestId = getProductIdentity(best) || "";

    if (score > bestScore || (score === bestScore && id < bestId)) {
      best = p;
      bestScore = score;
    }
  });

  return best;
}

function parseDateMs(value) {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isNaN(ms) ? 0 : ms;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }

  const text = String(value || "").trim();
  if (!text) return 0;

  // Soportar DD/MM/YYYY (fecha local) proveniente de catalog_public_view.
  const dmyMatch = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (dmyMatch) {
    const day = Number(dmyMatch[1]);
    const month = Number(dmyMatch[2]);
    const year = Number(dmyMatch[3]);
    const localDate = new Date(year, month - 1, day);
    if (
      localDate.getFullYear() === year &&
      localDate.getMonth() === month - 1 &&
      localDate.getDate() === day
    ) {
      return localDate.getTime();
    }
    return 0;
  }

  const ms = Date.parse(text);
  return Number.isNaN(ms) ? 0 : ms;
}

function getBestRecencyMs(producto) {
  const candidates = [
    producto?.FechaIngreso,
    producto?.updated_at,
    producto?.created_at,
    producto?.Fecha,
    producto?.fecha,
  ];

  for (const value of candidates) {
    const ms = parseDateMs(value);
    if (ms > 0) return ms;
  }
  return 0;
}

// Calcula la mejor fecha de "publicación reciente" para una fila de variante.
// Prioridad: republicación explícita > updated_at > created_at > FechaIngreso.
// Devuelve { ms, source } para diagnosticar de dónde salió el valor.
function getVariantRecency(row) {
  if (!row || typeof row !== "object") return { ms: 0, source: "" };

  const candidates = [
    ["republished_at", row.republished_at],
    ["republished_at", row.republishedAt],
    ["last_published_at", row.last_published_at],
    ["variant_updated_at", row.variant_updated_at],
    ["product_variant_updated_at", row.product_variant_updated_at],
    ["updated_at", row.updated_at],
    ["variant_created_at", row.variant_created_at],
    ["product_variant_created_at", row.product_variant_created_at],
    ["created_at", row.created_at],
    ["FechaIngreso", row.FechaIngreso],
  ];

  for (const [source, value] of candidates) {
    const ms = parseDateMs(value);
    if (ms > 0) return { ms, source };
  }
  return { ms: 0, source: "" };
}

// Recibe filas (rows) o detalles de color del mismo artículo y devuelve la
// más reciente según getVariantRecency(). Útil para el banner FYL Originals.
function pickMostRecentVariant(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;

  let winner = null;
  let winnerMs = -1;
  let winnerSource = "";
  let winnerIndex = -1;

  rows.forEach((row, index) => {
    const { ms, source } = getVariantRecency(row);
    if (ms > winnerMs || (ms === winnerMs && index < winnerIndex)) {
      winner = row;
      winnerMs = ms;
      winnerSource = source;
      winnerIndex = index;
    }
  });

  return winner ? { row: winner, ms: winnerMs, source: winnerSource } : null;
}

function fallbackBasicOrdering(products) {
  if (!Array.isArray(products) || products.length === 0) return [];

  const dated = products
    .map((product, index) => ({
      product,
      index,
      ms: parseDateMs(product?.FechaIngreso),
    }))
    .filter((item) => item.ms > 0);

  if (dated.length > 0) {
    return [...products].sort((a, b) => parseDateMs(b?.FechaIngreso) - parseDateMs(a?.FechaIngreso));
  }

  console.warn("[FYL] Fallback sin fecha válida: se mantiene orden original", {
    totalProducts: products.length,
  });
  return products;
}

function sumKnownStock(producto) {
  let sum = 0;

  const candidates = [producto?.Stock, producto?.stock, producto?.available, producto?.Available];
  candidates.forEach((v) => {
    const n = Number(v);
    if (!Number.isNaN(n) && n > 0) sum += n;
  });

  for (const detalleColor of producto?.DetalleColor || []) {
    for (const vd of detalleColor?.variantDetails || []) {
      const n = Number(vd?.available);
      if (!Number.isNaN(n) && n > 0) sum += n;
    }
  }
  return sum;
}

function scoreRecentProduct(producto) {
  return getBestRecencyMs(producto);
}

function scoreStrongProduct(producto) {
  let score = 0;
  if (producto?.OfertaActiva === true || producto?.OfertaActiva === "true") score += 4;
  if (String(producto?.PromoActiva || "").trim() !== "") score += 3;
  score += Math.min(3, Math.floor(sumKnownStock(producto) / 5));
  score += parseDateMs(producto?.FechaIngreso) / 1e13;
  return score;
}

function scorePushProduct(producto) {
  const stock = sumKnownStock(producto);
  const recencyPenalty = parseDateMs(producto?.FechaIngreso) / 1e12;
  return stock - recencyPenalty;
}

function pickDailyHookByDateIndex(pool, dateKey) {
  if (!pool || pool.length === 0) return null;
  const sorted = [...pool].sort((a, b) => {
    const ida = getProductIdentity(a) || "";
    const idb = getProductIdentity(b) || "";
    return ida.localeCompare(idb);
  });
  const dateHash = stableStringHash(dateKey);
  const index = dateHash % sorted.length;
  return sorted[index] || null;
}

function curateFylOriginalsSlots(products, now = new Date()) {
  if (!Array.isArray(products) || products.length === 0) return [];

  const eligible = dedupeBySafeIdentity(
    products
      .filter(isActiveProduct)
      .filter(isRenderableProduct)
      .filter(hasPositiveStock)
  );

  if (eligible.length === 0) {
    console.warn("[FYL] Curaduría no aplicada: eligible vacío", {
      totalProducts: products.length,
    });
    return fallbackBasicOrdering(products);
  }

  const slot1 = pickBestCandidate(eligible, scoreRecentProduct);
  const poolAfter1 = excludeProducts(eligible, [slot1]);
  const slot2 = pickBestCandidate(poolAfter1, scoreStrongProduct);
  const poolAfter2 = excludeProducts(poolAfter1, [slot2]);
  const slot3 = pickBestCandidate(poolAfter2, scorePushProduct);
  const poolAfter3 = excludeProducts(poolAfter2, [slot3]);

  const top3 = [slot1, slot2, slot3].filter(Boolean);
  const diverseCandidates = poolAfter3.filter((p) => isVisuallyDistinctFromTop3(p, top3));
  const slot4Pool = diverseCandidates.length > 0 ? diverseCandidates : poolAfter3;
  const dateKey = buildLocalDateKey(now);
  const slot4 = pickDailyHookByDateIndex(slot4Pool, dateKey) || slot4Pool[0] || null;

  const top4 = [slot1, slot2, slot3, slot4].filter(Boolean);
  const rest = excludeProducts(products, top4);
  return [...top4, ...rest];
}

// Cargar productos del proveedor FYL
export async function loadFYLOriginals() {
  try {
    // Primero obtener el proveedor FYL
    const { data: supplierData, error: supplierError } = await supabase
      .from("suppliers")
      .select("id, code")
      .eq("code", "FYL")
      .limit(1)
      .single();

    if (supplierError || !supplierData) {
      console.warn("⚠️ No se encontró el proveedor FYL:", supplierError);
      return [];
    }

    // Obtener productos del proveedor FYL desde catalog_public_view
    const { data, error } = await supabase
      .from("catalog_public_view")
      .select("*")
      .eq("SupplierCode", "FYL")
      .order("FechaIngreso", { ascending: false });

    if (error) {
      console.error("❌ Error cargando productos FYL:", error);
      return [];
    }

    if (!data || data.length === 0) {
      fylDevLog("ℹ️ No hay productos del proveedor FYL");
      return [];
    }

    const getRowRecencyMs = (row) => {
      return (
        parseDateMs(row?.updated_at) ||
        parseDateMs(row?.created_at) ||
        parseDateMs(row?.FechaIngreso) ||
        0
      );
    };

    // Agrupar productos por artículo (similar a cargarCategoria)
    const grupos = data.reduce((acc, i) => {
      const art = i.Articulo?.trim();
      if (!art) return acc;
      const rowRecencyMs = getRowRecencyMs(i);

      if (!acc[art]) {
        acc[art] = {
          Articulo: art,
          Descripcion: i.Descripcion || "",
          Precio: i.Precio || "",
          VariantePrincipal: i["Imagen Principal"],
          Oferta: i.Oferta || "",
          FechaIngreso: i.FechaIngreso || "",
          Filtro1: i.Filtro1 || "",
          Filtro2: i.Filtro2 || "",
          Filtro3: i.Filtro3 || "",
          OfertaActiva: false,
          PrecioOferta: '',
          PromoActiva: '',
          DetalleColor: [],
        };
      }

      // Actualizar información de ofertas
      if (i.OfertaActiva === true || i.OfertaActiva === 'true') {
        acc[art].OfertaActiva = true;
        if (!acc[art].PrecioOferta) {
          acc[art].PrecioOferta = i.PrecioOferta || '';
        }
      }

      if (i.PromoActiva && i.PromoActiva !== '') {
        acc[art].PromoActiva = i.PromoActiva;
      }

      // Agregar color si no existe
      const colorExists = acc[art].DetalleColor.find(c =>
        (c.color || "").trim().toLowerCase() === (i.Color || "").trim().toLowerCase()
      );

      if (!colorExists) {
        const talles = String(i.Numeracion || "")
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean);
        acc[art].DetalleColor.push({
          color: i.Color || "Sin color",
          hex_color: i.ColorHex || null,
          talles: talles.length > 0 ? talles : ["Único"],
          images: [
            i["Imagen Principal"],
            i["Imagen 1"],
            i["Imagen 2"],
            i["Imagen 3"],
          ].filter(Boolean),
          __recencyMs: rowRecencyMs,
        });
      } else {
        const existingRecency = Number(colorExists.__recencyMs) || 0;
        if (rowRecencyMs > existingRecency) {
          const incomingImages = [
            i["Imagen Principal"],
            i["Imagen 1"],
            i["Imagen 2"],
            i["Imagen 3"],
          ].filter(Boolean);
          if (incomingImages.length > 0) {
            colorExists.images = incomingImages;
          }
          colorExists.__recencyMs = rowRecencyMs;
        }
      }

      return acc;
    }, {});

    const productosAgrupados = Object.values(grupos);

    // Cargar fechas reales por variante (created_at/updated_at) para calcular
    // VariantePrincipal según la variante MÁS RECIENTE, no por orden alfabético
    // de color. catalog_public_view solo expone FechaIngreso del producto, que
    // es idéntico para todos los colores y no sirve para distinguir variantes.
    const articulos = productosAgrupados
      .map((p) => (p.Articulo || "").trim())
      .filter(Boolean);

    const articleColorRecency = new Map(); // articulo(lower) -> Map(color(lower) -> { ms, source })

    if (articulos.length > 0) {
      try {
        const { data: variantsData, error: variantsError } = await supabase
          .from("products")
          .select(
            "name, product_variants(color, active, created_at, updated_at)"
          )
          .in("name", articulos);

        if (variantsError) {
          console.warn(
            "⚠️ No se pudieron obtener fechas de variantes para FYL Originals:",
            variantsError.message
          );
        } else if (Array.isArray(variantsData)) {
          variantsData.forEach((row) => {
            const articuloKey = (row?.name || "").trim().toLowerCase();
            if (!articuloKey) return;

            const colorMap =
              articleColorRecency.get(articuloKey) || new Map();
            (row.product_variants || []).forEach((v) => {
              if (!v || v.active === false) return;
              const colorKey = (v.color || "").trim().toLowerCase();
              if (!colorKey) return;
              const { ms, source } = getVariantRecency(v);
              if (ms <= 0) return;
              const prev = colorMap.get(colorKey);
              if (!prev || ms > prev.ms) {
                colorMap.set(colorKey, { ms, source });
              }
            });
            if (colorMap.size > 0) {
              articleColorRecency.set(articuloKey, colorMap);
            }
          });
        }
      } catch (e) {
        console.warn(
          "⚠️ Excepción cargando fechas de variantes para FYL Originals:",
          e?.message || e
        );
      }
    }

    fylProducts = productosAgrupados.map((producto) => {
      const colors = Array.isArray(producto.DetalleColor) ? producto.DetalleColor : [];
      if (colors.length === 0) return producto;

      const articuloKey = (producto.Articulo || "").trim().toLowerCase();
      const colorRecencyMap = articleColorRecency.get(articuloKey) || null;

      // Propagar __variantRecencyMs real (de product_variants) a cada color.
      let usedRealVariantDates = false;
      if (colorRecencyMap) {
        colors.forEach((color) => {
          const colorKey = (color?.color || "").trim().toLowerCase();
          const entry = colorRecencyMap.get(colorKey);
          if (entry?.ms > 0) {
            color.__variantRecencyMs = entry.ms;
            color.__variantRecencySource = entry.source;
            usedRealVariantDates = true;
          }
        });
      }

      // Elegir el color más reciente con imagen, priorizando datos reales de
      // variante si están disponibles. Usamos pickMostRecentVariant que ya
      // resuelve la prioridad (updated_at > created_at > FechaIngreso) sobre
      // las propiedades expuestas en cada DetalleColor.
      const colorsWithImage = colors.filter(
        (c) => Array.isArray(c?.images) && c.images.length > 0 && c.images[0]
      );

      // Para que pickMostRecentVariant funcione directo sobre DetalleColor,
      // exponemos updated_at/created_at desde __variantRecencyMs cuando existe;
      // si no, dejamos FechaIngreso del producto como fallback débil.
      const variantPick = pickMostRecentVariant(
        colorsWithImage.map((c) => ({
          __color: c,
          updated_at:
            Number(c?.__variantRecencyMs) > 0
              ? new Date(Number(c.__variantRecencyMs)).toISOString()
              : null,
          created_at: null,
          FechaIngreso:
            Number(c?.__recencyMs) > 0
              ? new Date(Number(c.__recencyMs)).toISOString()
              : producto.FechaIngreso || null,
        }))
      );

      const bestColor = variantPick?.row?.__color || null;

      if (bestColor && bestColor.images?.[0]) {
        producto.VariantePrincipal = bestColor.images[0];

        // Si se usaron fechas reales de variante, marcar la fuente para que
        // enrichProductsWithStock no sobrescriba la decisión del banner.
        if (usedRealVariantDates) {
          producto.__variantePrincipalSource = "recency-banner";

          // Reordenar DetalleColor por recencia descendente (estable) para
          // que los color-dots y la imagen ganadora coincidan en el banner.
          producto.DetalleColor = [...colors].sort((a, b) => {
            const aMs =
              Number(a?.__variantRecencyMs) || Number(a?.__recencyMs) || 0;
            const bMs =
              Number(b?.__variantRecencyMs) || Number(b?.__recencyMs) || 0;
            return bMs - aMs;
          });

          fylDevLog("[FYL] VariantePrincipal por recencia real", {
            articulo: producto.Articulo,
            color: bestColor.color,
            sku: getFirstVariantDetail(producto)?.sku || null,
            fechaMs: variantPick?.ms || 0,
            fuente: bestColor.__variantRecencySource || variantPick?.source || "",
            imagen: bestColor.images[0],
          });
        }
      }

      return producto;
    });

    fylDevLog(`✅ Productos FYL cargados: ${fylProducts.length}`);

    return fylProducts;
  } catch (error) {
    console.error("❌ Error en loadFYLOriginals:", error);
    return [];
  }
}

// Función para formatear precio con punto como separador de miles
function formatPrice(precio) {
  if (!precio) return '$0';
  
  // Limpiar el precio de símbolos y espacios
  let precioLimpio = precio.toString().replace(/[^\d.,]/g, '').replace(',', '.');
  const precioNum = parseFloat(precioLimpio);
  
  if (isNaN(precioNum)) return '$0';
  
  // Formatear con punto como separador de miles y sin decimales
  const precioFormateado = Math.round(precioNum).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  
  return `$${precioFormateado}`;
}

// Máximo 3 colores visibles; si hay más, se muestra un "+" en la misma fila
const FYL_ORIGINALS_MAX_VISIBLE_COLORS = 3;

// Renderizar puntos de colores (solo 3 visibles + círculo "+" si hay más)
function renderColorDots(producto, cardIndex) {
  if (!producto.DetalleColor || producto.DetalleColor.length === 0) {
    return '';
  }

  // Obtener colores únicos con hex_color e imagen
  const todosColores = producto.DetalleColor
    .filter(detalle => detalle.hex_color && detalle.images && detalle.images.length > 0)
    .map(detalle => ({
      color: detalle.color,
      hex: detalle.hex_color,
      imagen: detalle.images[0] || null
    }))
    .filter((color, index, self) => 
      index === self.findIndex(c => 
        (c.color || "").trim().toLowerCase() === (color.color || "").trim().toLowerCase()
      )
    );

  if (todosColores.length === 0) {
    return '';
  }

  const coloresVisibles = todosColores.slice(0, FYL_ORIGINALS_MAX_VISIBLE_COLORS);
  const hayMas = todosColores.length > FYL_ORIGINALS_MAX_VISIBLE_COLORS;

  return `
    <div class="fyl-originals-colors">
      ${coloresVisibles.map((c) => `
        <button class="color-dot color-dot-btn" 
             style="background-color: ${c.hex};"
             data-color-image="${c.imagen || ''}"
             data-card-index="${cardIndex}"
             title="${c.color}"
             type="button">
        </button>
      `).join('')}
      ${hayMas ? `<span class="color-dot color-dot-more" title="Más colores" aria-hidden="true">+</span>` : ''}
    </div>
  `;
}

// Renderizar card individual de producto
function renderFYLProductCard(producto, index) {
  const skuDefecto = obtenerSKUDefecto(producto);
  const imagen = producto.VariantePrincipal || producto.DetalleColor?.[0]?.images?.[0] || '';
  const precioDisplay = producto.OfertaActiva && producto.PrecioOferta 
    ? producto.PrecioOferta 
    : producto.Precio;
  
  const precioFormateado = formatPrice(precioDisplay);
  const colorDots = renderColorDots(producto, index);

  const nombreProducto = producto.Articulo || producto.Descripcion || 'Producto';
  
  const eagerImage = index < 2;
  return `
    <div class="fyl-originals-card" 
         data-articulo="${producto.Articulo}"
         data-sku="${skuDefecto || ''}">
      <div class="fyl-originals-badge">${nombreProducto}</div>
      <img class="fyl-originals-card-image" 
           src="${cloudinaryOptimized(imagen, 400)}" 
           alt="${producto.Descripcion || producto.Articulo}"
           loading="${eagerImage ? 'eager' : 'lazy'}"
           fetchpriority="${eagerImage ? 'high' : 'auto'}"
           data-sku="${skuDefecto || ''}">
      ${colorDots}
      <div class="fyl-originals-card-content">
        <div class="fyl-originals-card-price">${precioFormateado}</div>
        <div class="fyl-originals-card-wholesale">Precio por Mayor</div>
      </div>
    </div>
  `;
}

function waitForFirstFYLImage(maxMs = 900) {
  const firstImg = document.querySelector("#fyl-originals-scroll .fyl-originals-card-image");
  if (!firstImg) return Promise.resolve();
  if (firstImg.complete && firstImg.naturalWidth > 0) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      firstImg.removeEventListener("load", done);
      firstImg.removeEventListener("error", done);
      resolve();
    };
    firstImg.addEventListener("load", done, { once: true });
    firstImg.addEventListener("error", done, { once: true });
    setTimeout(done, maxMs);
  });
}

// Misma heurística que main-supabase.js (obtenerSKUDefecto): no depende de window.skuIndex
// (skuIndex no está expuesto globalmente; antes este helper devolvía siempre null).
function obtenerSKUDefecto(producto) {
  if (!producto || !producto.DetalleColor) return null;

  for (const detalleColor of producto.DetalleColor) {
    if (!detalleColor.variantDetails) continue;

    const conStock = detalleColor.variantDetails.find(
      (vd) => vd.sku && (vd.available === null || vd.available > 0)
    );
    if (conStock && conStock.sku) return conStock.sku;

    const primerSku = detalleColor.variantDetails.find((vd) => vd.sku);
    if (primerSku && primerSku.sku) return primerSku.sku;
  }

  return null;
}

// Función helper para cloudinaryOptimized (reutilizar si está disponible)
function cloudinaryOptimized(url, width) {
  if (typeof window !== 'undefined' && typeof window.cloudinaryOptimized === 'function') {
    return window.cloudinaryOptimized(url, width);
  }
  
  // Fallback básico
  if (!url) return '';
  if (url.includes('cloudinary.com')) {
    return url.replace(/\/upload\//, `/upload/w_${width},q_auto,f_auto/`);
  }
  return url;
}

// Renderizar más productos en el carrusel
function renderMoreFYLProducts(products, startIndex, count) {
  const scrollContainer = document.getElementById("fyl-originals-scroll");
  if (!scrollContainer) return;

  const endIndex = Math.min(startIndex + count, products.length);
  const productsToAdd = products.slice(startIndex, endIndex);

  productsToAdd.forEach((producto, relativeIndex) => {
    const globalIndex = startIndex + relativeIndex;
    const cardHTML = renderFYLProductCard(producto, globalIndex);
    scrollContainer.insertAdjacentHTML('beforeend', cardHTML);
  });

  // Configurar event listeners para las nuevas cards
  setupFYLCardListeners(scrollContainer, startIndex, endIndex);
  
  return endIndex;
}

// PDP rápido (skuIndex) o lento (skeleton + fetch en main-supabase.js)
function tryOpenPdpFromSku(sku) {
  const s = sku != null ? String(sku).trim() : "";
  if (!s) return false;

  if (typeof window.abrirModalPorSKU === "function" && window.abrirModalPorSKU(s, { pushState: true })) {
    return true;
  }
  if (typeof window.abrirPdpPorSkuIfPossible === "function") {
    void window.abrirPdpPorSkuIfPossible(s, { pushState: true });
    return true;
  }
  return false;
}

// Configurar event listeners para las cards
function setupFYLCardListeners(scrollContainer, startIndex = 0, endIndex = null) {
  const allCards = scrollContainer.querySelectorAll('.fyl-originals-card');
  const cards = endIndex !== null 
    ? Array.from(allCards).slice(startIndex, endIndex)
    : Array.from(allCards).slice(startIndex);

  cards.forEach((card, relativeIndex) => {
    const globalIndex = startIndex + relativeIndex;
    
    // Configurar click en puntos de color usando delegación de eventos
    card.querySelectorAll('.color-dot-btn').forEach(dot => {
      dot.setAttribute('data-card-index', globalIndex);
      
      // Remover listeners previos si existen
      const newDot = dot.cloneNode(true);
      dot.parentNode.replaceChild(newDot, dot);
      
      newDot.addEventListener('click', (e) => {
        e.stopPropagation();
        // En el banner F&L Originals no cambiamos la imagen al seleccionar color
      });
    });

    // Configurar click en la card para abrir PDP
    card.addEventListener('click', (e) => {
      e.preventDefault();
      const sku = card.dataset.sku;
      const articulo = card.dataset.articulo;

      if (tryOpenPdpFromSku(sku)) return;

      const productoEncontrado = fylProducts.find(p =>
        (p.Articulo || "").trim() === (articulo || "").trim()
      );

      if (productoEncontrado) {
        let skuDisponible = null;
        for (const detalleColor of productoEncontrado.DetalleColor || []) {
          if (!detalleColor.variantDetails) continue;
          const conStock = detalleColor.variantDetails.find(vd =>
            vd.sku && (vd.available === null || vd.available > 0)
          );
          if (conStock && conStock.sku) {
            skuDisponible = conStock.sku;
            break;
          }
          const primerSku = detalleColor.variantDetails.find(vd => vd.sku);
          if (primerSku && primerSku.sku) {
            skuDisponible = primerSku.sku;
            break;
          }
        }

        if (tryOpenPdpFromSku(skuDisponible)) return;

        // Sin SKU en variantes: abrir PDP con el objeto producto (misma ruta que el catálogo)
        if (typeof window.abrirModalConResultado === "function") {
          const primerColor = productoEncontrado.DetalleColor?.[0]?.color || null;
          window.abrirModalConResultado(
            { producto: productoEncontrado, color: primerColor, talle: null },
            { pushState: true }
          );
          return;
        }

        const cardsEnCatalogo = document.querySelectorAll(".card.producto");
        for (const cardEnCatalogo of cardsEnCatalogo) {
          const cardArticulo = cardEnCatalogo.querySelector(".article-box")?.textContent?.trim();
          if (cardArticulo === (articulo || "").trim()) {
            cardEnCatalogo.scrollIntoView({ behavior: "smooth", block: "center" });
            setTimeout(() => {
              const img = cardEnCatalogo.querySelector(".main-image");
              if (img) img.click();
              else cardEnCatalogo.click();
            }, 300);
            return;
          }
        }
      }
    });
  });
}

// Manejar scroll horizontal para cargar más productos
function setupFYLScrollListener(scrollContainer, allProducts) {
  // Remover listener previo si existe
  if (scrollListenerAttached && currentScrollHandler) {
    scrollContainer.removeEventListener('scroll', currentScrollHandler);
    scrollListenerAttached = false;
    currentScrollHandler = null;
  }

  let isLoading = false;
  
  currentScrollHandler = () => {
    // Verificar si ya se cargaron todos los productos
    if (fylProductsLoaded >= allProducts.length) {
      return;
    }

    // Verificar si ya se está cargando para evitar múltiples cargas simultáneas
    if (isLoading) {
      return;
    }

    // Calcular si el usuario está cerca del final (80% del scroll)
    const scrollLeft = scrollContainer.scrollLeft;
    const scrollWidth = scrollContainer.scrollWidth;
    const clientWidth = scrollContainer.clientWidth;
    const scrollPercentage = (scrollLeft + clientWidth) / scrollWidth;

    if (scrollPercentage >= 0.8) {
      isLoading = true;
      
      // Cargar los siguientes productos
      const nextIndex = renderMoreFYLProducts(allProducts, fylProductsLoaded, PRODUCTS_PER_PAGE);
      fylProductsLoaded = nextIndex;
      
      // Permitir cargar más después de un pequeño delay
      setTimeout(() => {
        isLoading = false;
      }, 300);
    }
  };

  scrollContainer.addEventListener('scroll', currentScrollHandler);
  scrollListenerAttached = true;
}

// Renderizar banner con productos
export function renderFYLOriginalsBanner(products) {
  const banner = document.getElementById("fyl-originals-banner");
  const scrollContainer = document.getElementById("fyl-originals-scroll");
  
  if (!banner || !scrollContainer) {
    console.warn("⚠️ Contenedor de banner FYL no encontrado");
    return;
  }

  if (!products || products.length === 0) {
    banner.style.display = 'none';
    return;
  }

  // Resetear contador
  fylProductsLoaded = 0;

  // Limpiar contenedor
  scrollContainer.innerHTML = '';

  // Renderizar primeros productos (máximo 10)
  const initialCount = Math.min(PRODUCTS_PER_PAGE, products.length);
  fylProductsLoaded = renderMoreFYLProducts(products, 0, initialCount);

  // Configurar listener de scroll para cargar más productos
  setupFYLScrollListener(scrollContainer, products);


  // El CTA "Ver colección →" es un <a href="#/coleccion/fyl-originals">; el router maneja la navegación


  // Mostrar banner
  banner.style.display = 'block';
}

// Ocultar banner
export function hideFYLOriginalsBanner() {
  const banner = document.getElementById("fyl-originals-banner");
  if (banner) {
    banner.style.display = 'none';
  }
}

function applyLatestVariantMainImage(products) {
  if (!Array.isArray(products) || products.length === 0) return;

  products.forEach((producto) => {
    // Si el banner ya eligió VariantePrincipal con datos reales de variante,
    // no la sobrescribimos: el orden DetalleColor también ya viene aplicado.
    if (producto?.__variantePrincipalSource === "recency-banner") return;

    const colors = Array.isArray(producto?.DetalleColor) ? producto.DetalleColor : [];
    if (colors.length === 0) return;

    const getColorRecency = (detalleColor) => {
      const directRecency =
        Number(detalleColor?.__variantRecencyMs) ||
        Number(detalleColor?.__recencyMs) ||
        0;
      if (directRecency > 0) return directRecency;

      let best = 0;
      for (const vd of detalleColor?.variantDetails || []) {
        const vdRecency =
          parseDateMs(vd?.updated_at) ||
          parseDateMs(vd?.created_at) ||
          parseDateMs(vd?.FechaIngreso) ||
          0;
        if (vdRecency > best) best = vdRecency;
      }
      return best;
    };

    const decorated = colors.map((color) => ({
      color,
      recency: getColorRecency(color),
      image: Array.isArray(color?.images) && color.images[0] ? color.images[0] : "",
    }));

    const hasRecency = decorated.some((entry) => entry.recency > 0);
    if (!hasRecency) return;

    const winner = decorated
      .filter((entry) => entry.image)
      .sort((a, b) => b.recency - a.recency)[0];

    if (!winner?.image) return;

    producto.VariantePrincipal = winner.image;
    fylDevLog("[FYL] VariantePrincipal recalculada post-enrich", {
      articulo: producto?.Articulo || producto?.Descripcion || "",
      colorGanador: winner?.color?.color || "",
      imagenGanadora: winner.image,
      recencyUsada: winner.recency,
    });
  });
}

// Función principal para cargar y mostrar banner
export async function loadAndShowFYLBanner() {
  const products = await loadFYLOriginals();
  
  // Enriquecer productos con información de stock/variantes si es necesario
  if (products.length > 0 && typeof window.enrichProductsWithStock === 'function') {
    await window.enrichProductsWithStock(products);
    applyLatestVariantMainImage(products);
  }
  
  const curatedProducts = curateFylOriginalsSlots(products, new Date());
  renderFYLOriginalsBanner(curatedProducts);
  await waitForFirstFYLImage();
}

// Exportar funciones globalmente
if (typeof window !== 'undefined') {
  window.loadAndShowFYLBanner = loadAndShowFYLBanner;
  window.hideFYLOriginalsBanner = hideFYLOriginalsBanner;
}