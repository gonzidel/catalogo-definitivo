// scripts/custom-banner.js - Banner de productos personalizable

import { supabase } from "./supabase-client.js?v=m260607";
import {
  applyLatestVariantMainImage,
  enrichGroupedProductsWithVariantRecency,
  parseDateMs,
} from "./fyl-originals-banner.js?v=m260607";
import {
  loadCommercialTagNamesForAdmin,
  syncGroupedProductsDetallesSimilitud,
} from "./commercial-tags.js?v=m260607";
import { fylPerf } from "./fyl-perf.js?v=m260607";
import {
  buildCommercialTagMatchComparison,
  collectFiltro3CommercialMatchParts,
  evaluateCommercialTagExactMatch,
  groupedProductMatchesAnyCommercialTag,
  groupedProductMatchesCommercialTag,
  mergeProductRowCommercialTags,
  mergeProductRowFilterTags,
  normalizeCommercialTag,
  parseTagSelectorValues,
  productRowMatchesAnyCommercialTag,
  productRowMatchesCommercialTag,
  splitCommercialTags,
} from "./tag-normalize.js?v=m260607";
import { buildTagsHash } from "./tag-routing.js?v=m260607";

/** Banners curated en DB; este módulo no los usa (carga condicional vía fyl-legacy-banner-loader.js). */
const CURATED_TAG_PLACEHOLDER = "__curated__";

/** Logs verbosos del banner/catálogo. Activar: `window.FYL_DEBUG_CATALOG = true` antes de cargar, o `?debug=catalog` en la URL. */
function fylCatalogDebugEnabled() {
  if (typeof window === "undefined") return false;
  if (window.FYL_DEBUG_CATALOG === true) return true;
  try {
    return /(?:^|[&?])debug=catalog(?:&|$)/.test(window.location.search || "");
  } catch (_) {
    return false;
  }
}
function fylCatalogDbg(...args) {
  if (fylCatalogDebugEnabled()) console.log.apply(console, args);
}
function fylCatalogWarn(...args) {
  if (fylCatalogDebugEnabled()) console.warn.apply(console, args);
}

/** Auditoría del banner: `window.FYL_BANNER_AUDIT = true` o `?debug=banner` en la URL. */
function fylBannerAuditEnabled() {
  if (typeof window !== "undefined" && window.FYL_BANNER_AUDIT === true) return true;
  try {
    return /(?:^|[&?])debug=banner(?:&|$)/.test(window.location.search || "");
  } catch (_) {
    return false;
  }
}

function logBannerAudit(summary, detail = null) {
  if (!fylBannerAuditEnabled()) return;
  if (detail != null) {
    console.warn("[FYL Banner Audit]", summary, detail);
  } else {
    console.warn("[FYL Banner Audit]", summary);
  }
}

/** Logs de estabilización del banner (siempre visibles en consola). */
function logBannerDebug(step, detail = null) {
  if (detail != null) {
    console.warn("[FYL Banner Debug]", step, detail);
  } else {
    console.warn("[FYL Banner Debug]", step);
  }
}

let customBannerProducts = [];
let customBannerProductsLoaded = 0; // Contador de productos mostrados
const PRODUCTS_PER_PAGE = 10; // Cantidad de productos a cargar por página
let scrollListenerAttached = false; // Flag para evitar múltiples listeners
let currentScrollHandler = null; // Referencia al handler de scroll actual

function trackBannerProductClick({ banner, articulo, sku }) {
  const payload = {
    banner: String(banner || "unknown"),
    articulo: String(articulo || ""),
    sku: String(sku || ""),
  };
  try {
    if (window.fylAnalytics?.isReady?.()) {
      window.fylAnalytics.event("banner_product_click", payload);
    }
  } catch (_e) {}

  const sendMeta = () => {
    if (typeof fbq !== "function") return false;
    fbq("trackCustom", "BannerProductClick", payload);
    return true;
  };
  if (sendMeta()) return;
  setTimeout(() => {
    sendMeta();
  }, 300);
}

// Cargar configuración del banner desde Supabase
export async function loadCustomBannerConfig() {
  try {
    const { data, error } = await supabase
      .from("custom_product_banners")
      .select("*")
      .eq("enabled", true)
      .neq("tag_value", CURATED_TAG_PLACEHOLDER)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      if (error.code === "PGRST116") {
        return null;
      }
      console.error("❌ Error cargando configuración del banner:", error);
      return null;
    }

    return data ?? null;
  } catch (error) {
    console.error("❌ Error en loadCustomBannerConfig:", error);
    return null;
  }
}

// Tags comerciales (Detalles para similitud / product_tag_details)
export async function getAllUniqueTags() {
  try {
    const tags = await loadCommercialTagNamesForAdmin();
    fylCatalogDbg(`✅ Tags comerciales (detalles similitud): ${tags.length}`, tags.slice(0, 10));
    return tags;
  } catch (error) {
    console.error("❌ Error en getAllUniqueTags:", error);
    return [];
  }
}

/** Reutiliza catálogo ya cargado en main (0 requests extra en Home). */
async function obtainCatalogForBanner() {
  if (
    typeof window !== "undefined" &&
    Array.isArray(window.__allProductsCache) &&
    window.__allProductsCache.length > 0
  ) {
    fylPerf("banner_catalog_reuse", {
      source: "__allProductsCache",
      grouped: window.__allProductsCache.length,
    });
    return { mode: "grouped", data: window.__allProductsCache };
  }

  if (typeof window !== "undefined" && window.__FYL_CATALOG_ALL_INFLIGHT) {
    await window.__FYL_CATALOG_ALL_INFLIGHT;
    if (Array.isArray(window.__allProductsCache) && window.__allProductsCache.length > 0) {
      fylPerf("banner_catalog_reuse", {
        source: "__allProductsCache_after_inflight",
        grouped: window.__allProductsCache.length,
      });
      return { mode: "grouped", data: window.__allProductsCache };
    }
  }

  if (
    typeof window !== "undefined" &&
    Array.isArray(window.__allCatalogRawRows) &&
    window.__allCatalogRawRows.length > 0
  ) {
    fylPerf("banner_catalog_reuse", {
      source: "__allCatalogRawRows",
      rows: window.__allCatalogRawRows.length,
    });
    return { mode: "raw", data: window.__allCatalogRawRows };
  }

  if (typeof window.cargarDesdeSupabase === "function") {
    fylPerf("banner_catalog_reuse", { source: "cargarDesdeSupabase_all", fetch: true });
    const rows = await window.cargarDesdeSupabase("all");
    return { mode: "raw", data: Array.isArray(rows) ? rows : [] };
  }

  logBannerDebug("Sin catálogo compartido disponible para banner", {});
  return { mode: "raw", data: [] };
}

/**
 * Artículos que matchean el tag en filas crudas (DetallesSimilitud por variante) o en grupo.
 * Las filas crudas suelen tener detalles más completos que el cache agrupado.
 */
function buildArticulosSetMatchingCommercialTags(grouped, rawRows, selectedTags) {
  const matched = new Set();
  for (const row of rawRows || []) {
    const art = String(row?.Articulo ?? "").trim();
    if (!art) continue;
    const ok =
      selectedTags.length === 1
        ? productRowMatchesCommercialTag(row, selectedTags[0])
        : productRowMatchesAnyCommercialTag(row, selectedTags);
    if (ok) matched.add(art);
  }
  for (const p of grouped || []) {
    const art = String(p?.Articulo ?? "").trim();
    if (!art || matched.has(art)) continue;
    const ok =
      selectedTags.length === 1
        ? groupedProductMatchesCommercialTag(p, selectedTags[0])
        : groupedProductMatchesAnyCommercialTag(p, selectedTags);
    if (ok) matched.add(art);
  }
  return matched;
}

function filterGroupedByCommercialTags(grouped, selectedTags, rawRows = null) {
  if (!selectedTags.length) return [];
  const rows =
    rawRows ||
    (typeof window !== "undefined" ? window.__allCatalogRawRows : null) ||
    [];
  const matchedArts = buildArticulosSetMatchingCommercialTags(
    grouped,
    rows,
    selectedTags
  );
  return (grouped || []).filter((p) =>
    matchedArts.has(String(p?.Articulo ?? "").trim())
  );
}

/** Cuántos artículos tienen el tag en Detalles vs solo en Filtro3 (Tags jerárquicos). */
function buildBannerTagGapReport(grouped, selectedTags) {
  if (!selectedTags?.length || !Array.isArray(grouped)) {
    return { por_tag: [], nota: "sin_tags_o_catalogo" };
  }
  const porTag = selectedTags.map((tag) => {
    const key = normalizeCommercialTag(tag);
    const enDetalles = [];
    const soloFiltro3 = [];
    const enAmbos = [];
    for (const p of grouped) {
      const art = String(p?.Articulo ?? "").trim();
      if (!art) continue;
      const detailKeys = new Set(
        splitCommercialTags(p?.DetallesSimilitud, { silent: true }).tags
          .map((t) => normalizeCommercialTag(t))
          .filter(Boolean)
      );
      const f3KeySet = new Set(collectFiltro3CommercialMatchParts(p?.Filtro3).keys);
      const matchDetalles = Boolean(key && detailKeys.has(key));
      const matchF3 = Boolean(key && f3KeySet.has(key));
      if (matchDetalles && matchF3) enAmbos.push(art);
      else if (matchDetalles) enDetalles.push(art);
      else if (matchF3) soloFiltro3.push(art);
    }
    return {
      tag,
      en_detalles_comerciales: enDetalles.length + enAmbos.length,
      solo_en_filtro3_tags3: soloFiltro3.length,
      en_ambos: enAmbos.length,
      muestra_solo_filtro3: soloFiltro3.slice(0, 25),
      nota:
        soloFiltro3.length > 0
          ? "Tienen el tag solo en Filtro3 (Tags3), no en Detalles comerciales — el banner los incluye por Filtro3."
          : null,
    };
  });
  return { por_tag: porTag };
}

/** Resumen legible de por qué el banner muestra N productos (siempre en consola). */
export function logBannerPipelineSummary({
  tagValue,
  selectedTags,
  totalGrouped,
  matchedTag,
  afterStockImage,
  descartados = [],
}) {
  const grouped =
    typeof window !== "undefined" && Array.isArray(window.__allProductsCache)
      ? window.__allProductsCache
      : [];
  const brechaDatos = buildBannerTagGapReport(grouped, selectedTags);

  console.info("[Banner] Resumen pipeline", {
    tag_configurado: tagValue,
    tags_parseados: selectedTags,
    productos_en_catalogo: totalGrouped,
    coinciden_tag_comercial: matchedTag,
    se_muestran_en_banner: afterStockImage,
    brecha_datos_detalles_vs_filtro3: brechaDatos,
    descartados_total: Math.max(0, matchedTag - afterStockImage),
    motivos_descarte: {
      sin_tag_en_detalles_ni_filtro3:
        "Sin el tag en Detalles comerciales ni en Filtro3 (Tags3)",
      sin_stock: "Stock 0 en todos los talles (tras enrich)",
      sin_imagen: "Sin VariantePrincipal ni imagen de color",
    },
    muestra_descartados: descartados.slice(0, 20),
    ver_todo_en_catalogo: selectedTags?.length
      ? buildTagsHash(selectedTags)
      : "#/",
  });
}

/** Auditoría directa: quick-action vs detalles comerciales por SKU. */
function auditBannerCommercialTagMatch(tagValue, catalog, selectedTags, renderedProducts) {
  console.log("[Banner] quick-action raw tag", tagValue);
  console.log("[Banner] quick-action parsed tags", selectedTags);
  console.log("[Banner] quick-action normalized keys", selectedTags.map(normalizeCommercialTag));

  const source =
    catalog.mode === "grouped"
      ? catalog.data.map((p) => ({
          Articulo: p.Articulo,
          DetallesSimilitud: p.DetallesSimilitud,
        }))
      : catalog.data;

  const detallesPorSku = source
    .filter((r) => String(r?.DetallesSimilitud ?? "").trim())
    .map((r) => ({ sku: r.Articulo, detalles: r.DetallesSimilitud }));
  console.log("[Banner] tags comerciales por producto", detallesPorSku.slice(0, 80));

  const expectedSet = new Set();
  const comparisonLogs = [];
  for (const row of source) {
    for (const tag of selectedTags) {
      const ev = evaluateCommercialTagExactMatch(row, tag);
      comparisonLogs.push({ sku: row.Articulo, ...ev });
      if (ev.matched_exact && row.Articulo) expectedSet.add(row.Articulo);
    }
  }
  const expected = [...expectedSet];
  console.log("[Banner] comparacion exacta (token)", comparisonLogs.slice(0, 80));

  const matchedSkus = expectedSet;
  const renderedSkus = new Set(
    (renderedProducts || []).map((p) => String(p?.Articulo ?? "").trim()).filter(Boolean)
  );

  const rendered = [...renderedSkus];
  const missingInBanner = expected.filter((sku) => !renderedSkus.has(sku));
  const discarded = [];

  for (const sku of missingInBanner) {
    const row = source.find((r) => r.Articulo === sku);
    discarded.push({
      sku,
      motivo: "tag_match_pero_no_en_banner_render",
      detalles: row?.DetallesSimilitud || "",
      comparison: buildCommercialTagMatchComparison(row || {}, selectedTags),
    });
  }

  for (const row of source) {
    const report = buildCommercialTagMatchComparison(row, selectedTags);
    if (!report.matched && report.detalles) {
      discarded.push({
        sku: report.sku,
        motivo: "detalles_sin_match_tag_configurado",
        detalles: report.detalles,
        comparison: report,
      });
      if (discarded.length >= 30) break;
    }
  }

  console.log("[Banner] resumen matcher", {
    catalogMode: catalog.mode,
    totalFuente: source.length,
    conMatchTag: matchedSkus.size,
    renderizados: rendered.length,
    faltanEnBanner: missingInBanner.length,
  });
  console.log("[Banner] productos esperados (match tag)", expected);
  console.log("[Banner] productos renderizados", rendered);

  const falsosPositivos = [];
  for (const p of renderedProducts || []) {
    const row = { Articulo: p.Articulo, DetallesSimilitud: p.DetallesSimilitud };
    const report = buildCommercialTagMatchComparison(row, selectedTags);
    if (!report.matched) {
      falsosPositivos.push({
        sku: p.Articulo,
        motivo: "renderizado_sin_match_exacto",
        detalles: p.DetallesSimilitud,
        comparisons: report.comparisons,
      });
    }
  }
  if (falsosPositivos.length) {
    console.warn("[Banner] posibles falsos positivos en render", falsosPositivos);
  }

  console.log("[Banner] descartados / faltantes", discarded.slice(0, 40));
}

function sortCustomBannerProductsByRecency(products) {
  return [...products].sort((a, b) => {
    const aMs =
      parseDateMs(a?.FechaIngreso) ||
      Number(a?.DetalleColor?.[0]?.__variantRecencyMs) ||
      0;
    const bMs =
      parseDateMs(b?.FechaIngreso) ||
      Number(b?.DetalleColor?.[0]?.__variantRecencyMs) ||
      0;
    return bMs - aMs;
  });
}

// Cargar productos filtrados por tag(s) — OR en DetallesSimilitud (comercial).
export async function loadCustomBannerProducts(tagValue) {
  try {
    console.log("[Banner] quick-action raw tag", tagValue);
    const selectedTags = parseTagSelectorValues(tagValue);
    fylCatalogDbg(
      `🔍 loadCustomBannerProducts — tags (${selectedTags.length}):`,
      selectedTags
    );
    logBannerAudit("Tags seleccionados", {
      raw: tagValue,
      parsed: selectedTags,
      canonical: selectedTags.map((t) => normalizeCommercialTag(t)),
    });

    if (!selectedTags.length) {
      logBannerDebug("Sin tags válidos en tag_value", { raw: tagValue });
      logBannerAudit("Sin tags válidos en configuración; 0 productos");
      return [];
    }

    const catalog = await obtainCatalogForBanner();

    if (catalog.mode === "grouped") {
      let groupedData = catalog.data;
      if (
        typeof window !== "undefined" &&
        Array.isArray(window.__allCatalogRawRows) &&
        window.__allCatalogRawRows.length
      ) {
        groupedData = syncGroupedProductsDetallesSimilitud(
          groupedData,
          window.__allCatalogRawRows
        );
      }
      const filteredGrouped = filterGroupedByCommercialTags(
        groupedData,
        selectedTags,
        window.__allCatalogRawRows
      );
      fylCatalogDbg(
        `📊 Banner (tag en filas crudas + agrupado): ${filteredGrouped.length} de ${catalog.data.length}`
      );
      if (filteredGrouped.length === 0) {
        logBannerDebug("0 productos tras matcher en cache agrupado", { tags: selectedTags });
        auditBannerCommercialTagMatch(
          tagValue,
          { mode: "grouped", data: groupedData },
          selectedTags,
          []
        );
        return [];
      }
      customBannerProducts = await enrichGroupedProductsWithVariantRecency(
        sortCustomBannerProductsByRecency(filteredGrouped)
      );
      logBannerAudit("Tras filtro comercial (cache agrupado)", {
        productosAgrupados: customBannerProducts.length,
      });
      auditBannerCommercialTagMatch(
        tagValue,
        { mode: "grouped", data: groupedData },
        selectedTags,
        customBannerProducts
      );
      return customBannerProducts;
    }

    const allData = catalog.data;
    fylCatalogDbg(`📊 Productos cargados (reuse raw): ${allData?.length || 0}`);
    
    // Log para confirmar que se cargan productos de todas las categorías
    if (allData && allData.length > 0) {
      const categoriasUnicas = [...new Set(allData.map(p => p.Categoria).filter(Boolean))];
      const productosOtros = allData.filter(p => (p.Categoria || "").trim().toLowerCase() === "otros");
      fylCatalogDbg(`📦 Productos cargados para banner: ${allData.length} productos de ${categoriasUnicas.length} categorías:`, categoriasUnicas);
      fylCatalogDbg(`📦 Productos de categoría "Otros": ${productosOtros.length}`);
      if (productosOtros.length > 0) {
        fylCatalogDbg(`   Ejemplos de productos "Otros":`, productosOtros.slice(0, 3).map(p => ({
          Articulo: p.Articulo,
          Filtro1: p.Filtro1,
          Filtro2: p.Filtro2,
          Filtro3: p.Filtro3
        })));
      }
    }
    
    if (fylCatalogDebugEnabled()) {
      const { data: allDataDebug } = await supabase
        .from("catalog_public_view")
        .select("Articulo, Descripcion, Mostrar, Filtro1, Filtro2, Filtro3")
        .ilike("Articulo", "%F314%")
        .limit(10);

      if (allDataDebug && allDataDebug.length > 0) {
        fylCatalogDbg(`🔍 Productos F314 encontrados en catalog_public_view:`, allDataDebug);
      } else {
        console.warn(`⚠️ F314 NO encontrado en catalog_public_view. Esto puede deberse a:`);
        console.warn(`   1. El producto tiene status != 'active'`);
        console.warn(`   2. No tiene variantes activas (pv.active = true)`);
        console.warn(`   3. No tiene stock > 0 en ningún talle`);
        console.warn(`   4. No tiene imágenes asociadas`);
        console.warn(`   5. El nombre del artículo no es exactamente "F314"`);

        try {
          const { data: productDirect } = await supabase
            .from("products")
            .select("id, name, status, created_at")
            .ilike("name", "%F314%")
            .limit(5);

          if (productDirect && productDirect.length > 0) {
            fylCatalogDbg(`🔍 Productos F314 encontrados en tabla products:`, productDirect);
          } else {
            console.warn(`   Tampoco encontrado en tabla products`);
          }
        } catch (err) {
          console.warn(`   No se pudo consultar tabla products directamente:`, err.message);
        }
      }
    }

    if (!allData || allData.length === 0) {
      fylCatalogDbg(`ℹ️ No hay productos visibles`);
      return [];
    }

    fylCatalogDbg(
      `🔍 Filtrando por OR de ${selectedTags.length} tag(s) comercial(es) — todas las categorías`
    );
    fylCatalogDbg(`📦 Total de productos a filtrar: ${allData.length}`);

    const discardNoTag = [];
    const filteredData = allData.filter((row) => {
      const match =
        selectedTags.length === 1
          ? productRowMatchesCommercialTag(row, selectedTags[0])
          : productRowMatchesAnyCommercialTag(row, selectedTags);
      if (match && (fylCatalogDebugEnabled() || fylBannerAuditEnabled())) {
        logBannerDebug("match_comercial", buildCommercialTagMatchComparison(row, selectedTags));
      } else if (!match && fylBannerAuditEnabled() && discardNoTag.length < 40) {
        discardNoTag.push({
          ...buildCommercialTagMatchComparison(row, selectedTags),
          categoria: row.Categoria,
          motivo: "sin_coincidencia_tag_comercial",
        });
      }
      return match;
    });

    fylCatalogDbg(`📊 Productos filtrados: ${filteredData.length} de ${allData.length} totales`);
    logBannerAudit("Coincidencia por tag comercial (filas variantes)", {
      filasVisibles: allData.length,
      filasConTag: filteredData.length,
      articulosUnicos: new Set(filteredData.map((r) => r.Articulo?.trim()).filter(Boolean)).size,
      descartadosSinTag: discardNoTag.length,
      muestraDescartados: discardNoTag.slice(0, 15),
    });
    
    // Log específico para productos de categoría "Otros"
    const productosOtrosFiltrados = filteredData.filter(p => (p.Categoria || "").trim().toLowerCase() === "otros");
    if (productosOtrosFiltrados.length > 0) {
      fylCatalogDbg(`📦 Productos de categoría "Otros" encontrados: ${productosOtrosFiltrados.length}`);
    } else if (fylCatalogDebugEnabled()) {
      console.warn(`⚠️ No se encontraron productos de categoría "Otros" con el tag "${tagValue}"`);
      const productosOtrosEjemplo = allData.filter(p => (p.Categoria || "").trim().toLowerCase() === "otros").slice(0, 3);
      if (productosOtrosEjemplo.length > 0) {
        fylCatalogDbg(`   Ejemplos de productos "Otros" disponibles:`, productosOtrosEjemplo.map(p => ({
          Articulo: p.Articulo,
          Filtro1: p.Filtro1,
          Filtro2: p.Filtro2,
          Filtro3: p.Filtro3
        })));
      }
    }

    if (filteredData.length === 0) {
      fylCatalogDbg(`ℹ️ No hay productos con los tags configurados`);
      logBannerDebug("0 filas tras matcher OR", {
        tags: selectedTags,
        filasVisibles: allData.length,
      });
      logBannerAudit("0 filas tras filtro OR de tags comerciales");
      return [];
    }

    // Usar los datos filtrados para continuar
    const data = filteredData;

    const getRowRecencyMs = (row) =>
      parseDateMs(row?.updated_at) ||
      parseDateMs(row?.created_at) ||
      parseDateMs(row?.FechaIngreso) ||
      0;

    // Agrupar productos por artículo (misma base que FYL Originals)
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
          DetallesSimilitud: i.DetallesSimilitud || "",
          OfertaActiva: false,
          PrecioOferta: '',
          PromoActiva: '',
          DetalleColor: [],
        };
      }

      if (i.OfertaActiva === true || i.OfertaActiva === 'true') {
        acc[art].OfertaActiva = true;
        if (!acc[art].PrecioOferta) {
          acc[art].PrecioOferta = i.PrecioOferta || '';
        }
      }

      if (i.PromoActiva && i.PromoActiva !== '') {
        acc[art].PromoActiva = i.PromoActiva;
      }

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

      mergeProductRowFilterTags(acc[art], i);
      mergeProductRowCommercialTags(acc[art], i);
      return acc;
    }, {});

    customBannerProducts = await enrichGroupedProductsWithVariantRecency(
      Object.values(grupos)
    );
    fylCatalogDbg(`✅ Productos del banner personalizado cargados: ${customBannerProducts.length}`);
    logBannerAudit("Tras agrupar por artículo", {
      productosAgrupados: customBannerProducts.length,
    });

    auditBannerCommercialTagMatch(
      tagValue,
      { mode: "grouped", data: Object.values(grupos) },
      selectedTags,
      customBannerProducts
    );

    return customBannerProducts;
  } catch (error) {
    console.error("❌ Error en loadCustomBannerProducts:", error);
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

// Renderizar puntos de colores
function renderColorDots(producto, cardIndex) {
  if (!producto.DetalleColor || producto.DetalleColor.length === 0) {
    return '';
  }

  // Obtener colores únicos con hex_color e imagen
  const colores = producto.DetalleColor
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
    )
    .slice(0, 8); // Máximo 8 colores visibles

  if (colores.length === 0) {
    return '';
  }

  return `
    <div class="custom-banner-colors">
      ${colores.map((c, idx) => `
        <button class="color-dot color-dot-btn" 
             style="background-color: ${c.hex};"
             data-color-image="${c.imagen || ''}"
             data-card-index="${cardIndex}"
             title="${c.color}"
             type="button">
        </button>
      `).join('')}
    </div>
  `;
}

// Renderizar card individual de producto
function renderCustomBannerProductCard(producto, index) {
  const skuDefecto = getSafePdpSku(producto);
  const imagen = producto.VariantePrincipal || producto.DetalleColor?.[0]?.images?.[0] || '';
  const precioDisplay = producto.OfertaActiva && producto.PrecioOferta 
    ? producto.PrecioOferta 
    : producto.Precio;
  
  const precioFormateado = formatPrice(precioDisplay);

  const nombreProducto = producto.Articulo || producto.Descripcion || 'Producto';
  
  return `
    <div class="custom-banner-card" 
         data-articulo="${producto.Articulo}"
         data-sku="${skuDefecto || ''}">
      <div class="custom-banner-badge">${nombreProducto}</div>
      <img class="custom-banner-card-image" 
           src="${cloudinaryOptimized(imagen, 400)}" 
           alt="${producto.Descripcion || producto.Articulo}"
           loading="lazy"
           data-sku="${skuDefecto || ''}">
      <div class="custom-banner-card-content">
        <div class="custom-banner-card-price">${precioFormateado}</div>
      </div>
    </div>
  `;
}

// Función helper para obtener SKU defecto (reutilizar de main-supabase.js si está disponible)
function obtenerSKUDefecto(producto) {
  if (!producto || !producto.DetalleColor) return null;
  
  // Resolver SKU desde variantDetails enriquecido (no depender de window.skuIndex)
  for (const detalleColor of producto.DetalleColor) {
    if (!detalleColor.variantDetails) continue;
    
    const conStock = detalleColor.variantDetails.find(vd => 
      vd?.sku && Number(vd?.available) > 0
    );
    if (conStock && conStock.sku) return conStock.sku;
  }
  
  return null;
}

function getSafePdpSku(producto) {
  return obtenerSKUDefecto(producto);
}

function hasUsableImage(producto) {
  const imagen = producto?.VariantePrincipal || producto?.DetalleColor?.[0]?.images?.[0] || '';
  return Boolean(String(imagen || '').trim());
}

function hasAtLeastOneVariantWithRealStock(producto) {
  if (!producto || !Array.isArray(producto.DetalleColor)) return false;
  return producto.DetalleColor.some((detalleColor) =>
    Array.isArray(detalleColor?.variantDetails) &&
    detalleColor.variantDetails.some((vd) => vd?.sku && Number(vd?.available) > 0)
  );
}

function isCustomBannerEligible(producto) {
  if (!producto) return false;
  if (!hasUsableImage(producto)) return false;
  return hasAtLeastOneVariantWithRealStock(producto);
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
function renderMoreCustomBannerProducts(products, startIndex, count) {
  const scrollContainer = document.getElementById("custom-banner-scroll");
  if (!scrollContainer) return;

  const endIndex = Math.min(startIndex + count, products.length);
  const productsToAdd = products.slice(startIndex, endIndex);

  productsToAdd.forEach((producto, relativeIndex) => {
    const globalIndex = startIndex + relativeIndex;
    const cardHTML = renderCustomBannerProductCard(producto, globalIndex);
    scrollContainer.insertAdjacentHTML('beforeend', cardHTML);
  });

  // Configurar event listeners para las nuevas cards
  setupCustomBannerCardListeners(scrollContainer, startIndex, endIndex);
  
  return endIndex;
}

// Configurar event listeners para las cards
function setupCustomBannerCardListeners(scrollContainer, startIndex = 0, endIndex = null) {
  const allCards = scrollContainer.querySelectorAll('.custom-banner-card');
  const cards = endIndex !== null 
    ? Array.from(allCards).slice(startIndex, endIndex)
    : Array.from(allCards).slice(startIndex);

  cards.forEach((card, relativeIndex) => {
    const globalIndex = startIndex + relativeIndex;

    // Configurar click en la card
    card.addEventListener('click', () => {
      const articulo = card.dataset.articulo;
      const productoEncontrado = customBannerProducts.find(p => 
        (p.Articulo || "").trim() === (articulo || "").trim()
      );
      const skuSeguro = getSafePdpSku(productoEncontrado);
      trackBannerProductClick({ banner: "custom_dynamic", articulo, sku: skuSeguro || "" });
      
      if (skuSeguro && typeof window.abrirModalPorSKU === 'function') {
        const abierto = window.abrirModalPorSKU(skuSeguro, { pushState: true });
        if (abierto) return;
        fylCatalogWarn("⚠️ abrirModalPorSKU no pudo abrir desde custom banner para SKU seguro:", skuSeguro, "artículo:", articulo);
      } else {
        fylCatalogWarn("⚠️ Custom banner sin SKU seguro; se omite apertura PDP.", { articulo });
      }
    });
  });
}

// Manejar scroll horizontal para cargar más productos
function setupCustomBannerScrollListener(scrollContainer, allProducts) {
  // Remover listener previo si existe
  if (scrollListenerAttached && currentScrollHandler) {
    scrollContainer.removeEventListener('scroll', currentScrollHandler);
    scrollListenerAttached = false;
    currentScrollHandler = null;
  }

  let isLoading = false;
  
  currentScrollHandler = () => {
    // Verificar si ya se cargaron todos los productos
    if (customBannerProductsLoaded >= allProducts.length) {
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
      const nextIndex = renderMoreCustomBannerProducts(allProducts, customBannerProductsLoaded, PRODUCTS_PER_PAGE);
      customBannerProductsLoaded = nextIndex;
      
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
export function renderCustomBanner(products, bannerName, tagValue) {
  // Buscar el banner inline primero (dentro del grid), luego el normal
  let banner = document.getElementById("custom-banner-container-inline");
  let scrollContainer = banner ? banner.querySelector("#custom-banner-scroll") : null;
  let headerTitle = banner ? banner.querySelector("#custom-banner-title") : null;
  let headerContainer = banner ? banner.querySelector(".custom-banner-header") : null;
  
  // Si no está inline, buscar el contenedor normal
  if (!banner) {
    banner = document.getElementById("custom-banner-container");
    scrollContainer = document.getElementById("custom-banner-scroll");
    headerTitle = document.getElementById("custom-banner-title");
    headerContainer = banner ? banner.querySelector(".custom-banner-header") : null;
  }
  
  if (!banner || !scrollContainer) {
    logBannerDebug("Contenedor DOM no encontrado", {
      inline: !!document.getElementById("custom-banner-container-inline"),
      root: !!document.getElementById("custom-banner-container"),
    });
    return;
  }

  if (!products || products.length === 0) {
    banner.style.display = 'none';
    return;
  }

  // Actualizar título del banner
  if (headerTitle) {
    headerTitle.textContent = bannerName || 'Productos Destacados';
  }
  
  // Agregar botón "Ver todo >" si no existe
  if (headerContainer) {
    let verTodoBtn = headerContainer.querySelector('.custom-banner-ver-todo-btn');
    if (!verTodoBtn && tagValue) {
      const tagHref = buildTagsHash(tagValue);
      verTodoBtn = document.createElement("a");
      verTodoBtn.href = tagHref;
      verTodoBtn.className = "custom-banner-ver-todo-btn";
      verTodoBtn.style.cssText =
        "display: flex; align-items: center; gap: 4px; color: #CD844D; text-decoration: none; font-size: 0.9rem; font-weight: 500;";
      verTodoBtn.innerHTML =
        'Ver todo <svg class="custom-banner-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 16px; height: 16px;"><polyline points="9 18 15 12 9 6"></polyline></svg>';
      verTodoBtn.addEventListener("click", (e) => {
        e.preventDefault();
        if (typeof window.navigateToTagsHash === "function") {
          window.navigateToTagsHash(tagValue, { source: "banner_ver_todo" });
        } else {
          location.hash = buildTagsHash(tagValue);
        }
      });
      headerContainer.appendChild(verTodoBtn);
    } else if (verTodoBtn && tagValue) {
      verTodoBtn.href = buildTagsHash(tagValue);
    }
  }

  // Resetear contador
  customBannerProductsLoaded = 0;

  // Limpiar contenedor
  scrollContainer.innerHTML = '';

  // Renderizar primeros productos (máximo 10)
  const initialCount = Math.min(PRODUCTS_PER_PAGE, products.length);
  customBannerProductsLoaded = renderMoreCustomBannerProducts(products, 0, initialCount);

  // Configurar listener de scroll para cargar más productos
  setupCustomBannerScrollListener(scrollContainer, products);

  // Mostrar banner
  banner.style.display = 'block';
}

// Ocultar banner
export function hideCustomBanner() {
  const banner = document.getElementById("custom-banner-container");
  if (banner) {
    banner.style.display = 'none';
  }
  // También ocultar banner inline si existe
  const inlineBanner = document.getElementById("custom-banner-container-inline");
  if (inlineBanner) {
    inlineBanner.style.display = 'none';
  }
  // Eliminar wrapper del banner inline si existe
  const bannerWrapper = document.getElementById("custom-banner-wrapper");
  if (bannerWrapper) {
    bannerWrapper.remove();
  }
  const homeSlot = document.getElementById("home-custom-banner-slot");
  if (homeSlot) {
    homeSlot.hidden = true;
    homeSlot.setAttribute("aria-hidden", "true");
  }
}

// Cantidad de productos del catálogo que ya están visibles arriba del banner (no duplicar en Productos Destacados)
const PRODUCTOS_CATALOGO_ANTES_DEL_BANNER = 12;

function getArticulosYaMostradosEnCatalogo() {
  const catalogo = document.getElementById("catalogo");
  if (!catalogo) return new Set();
  const cards = catalogo.querySelectorAll(".card.producto");
  const yaMostrados = new Set();
  for (let i = 0; i < Math.min(PRODUCTOS_CATALOGO_ANTES_DEL_BANNER, cards.length); i++) {
    const art = (cards[i].dataset.articulo || cards[i].getAttribute("data-articulo") || "").trim();
    if (art) yaMostrados.add(art);
  }
  return yaMostrados;
}

// Función principal para cargar y mostrar banner
export async function loadAndShowCustomBanner() {
  try {
    logBannerDebug("loadAndShowCustomBanner inicio", {
      hash: location.hash,
      categoria: typeof window.categoriaActual !== "undefined" ? window.categoriaActual : null,
    });
    // No mostrar en vista colección FYL
    if (location.hash === "#/coleccion/fyl-originals") {
      logBannerDebug("Oculto: colección FYL Originals");
      hideCustomBanner();
      return;
    }
    fylCatalogDbg("🔄 Iniciando carga de banner personalizado...");
    
    // Verificar si hay parámetro ?banner en la URL
    const urlParams = new URLSearchParams(window.location.search);
    const bannerParam = urlParams.get('banner');
    
    let tagValue = null;
    let bannerName = null;
    
    if (bannerParam) {
      // Usar tag de la URL si existe
      tagValue = bannerParam.trim();
      fylCatalogDbg(`📋 Usando tag de URL: "${tagValue}"`);
    } else {
      // Cargar configuración de la BD
      const config = await loadCustomBannerConfig();
      
      if (!config || !config.enabled) {
        logBannerDebug("Sin config habilitada en Supabase", { config });
        fylCatalogDbg("ℹ️ Banner personalizado no está habilitado o no hay configuración");
        hideCustomBanner();
        return;
      }
      
      tagValue = config.tag_value;
      bannerName = config.name;
      logBannerDebug("Config banner encontrada", {
        name: bannerName,
        tag_value: tagValue,
        tagsParseados: parseTagSelectorValues(tagValue),
      });
      
      fylCatalogDbg(`📋 Configuración del banner:`, {
        name: config.name,
        tag_value: config.tag_value,
        enabled: config.enabled
      });
    }

    // Cargar productos filtrados
    let products = await loadCustomBannerProducts(tagValue);
    
    fylCatalogDbg(`📦 Productos cargados para banner: ${products.length}`);
    logBannerDebug("Productos agrupados por tag", { count: products.length });

    if (products.length === 0) {
      logBannerPipelineSummary({
        tagValue,
        selectedTags: parseTagSelectorValues(tagValue),
        totalGrouped:
          typeof window !== "undefined" && window.__allProductsCache
            ? window.__allProductsCache.length
            : 0,
        matchedTag: 0,
        afterStockImage: 0,
        descartados: [],
      });
      logBannerDebug("Oculto: 0 productos tras matcher/agrupación");
      fylCatalogDbg(
        "⚠️ Ningún producto tiene el tag en Detalles comerciales ni en Filtro3 (Tags3)."
      );
      hideCustomBanner();
      return;
    }

    // Enriquecer productos con información de stock/variantes si es necesario
    if (products.length > 0 && typeof window.enrichProductsWithStock === 'function') {
      fylCatalogDbg("🔄 Enriqueciendo productos con información de stock...");
      await window.enrichProductsWithStock(products);
    }

    const matchedByTagCount = products.length;
    const beforeEligible = products.length;
    const discarded = [];
    products = products.filter((producto) => {
      const hasImage = hasUsableImage(producto);
      const hasStock = hasAtLeastOneVariantWithRealStock(producto);
      const ok = hasImage && hasStock;
      if (!ok && discarded.length < 50) {
        discarded.push({
          articulo: producto.Articulo,
          motivo: !hasImage
            ? "sin_imagen_usable"
            : !hasStock
              ? "sin_stock_disponible"
              : "no_elegible",
        });
      }
      return ok;
    });
    fylCatalogDbg(
      `📉 Banner: ${products.length} con imagen y stock > 0 (de ${beforeEligible} por tag)`
    );
    logBannerPipelineSummary({
      tagValue,
      selectedTags: parseTagSelectorValues(tagValue),
      totalGrouped:
        typeof window !== "undefined" && window.__allProductsCache
          ? window.__allProductsCache.length
          : matchedByTagCount,
      matchedTag: matchedByTagCount,
      afterStockImage: products.length,
      descartados: discarded,
    });
    logBannerAudit("Tras filtro imagen + stock", {
      antes: beforeEligible,
      despues: products.length,
      descartados: beforeEligible - products.length,
      muestraDescartados: discarded.slice(0, 15),
    });

    if (products.length === 0) {
      logBannerDebug("Oculto: ningún producto con imagen y stock", {
        antesFiltro: beforeEligible,
      });
      fylCatalogWarn(
        "⚠️ Custom banner oculto: ningún producto del tag tiene imagen y stock disponible."
      );
      hideCustomBanner();
      return;
    }

    applyLatestVariantMainImage(products);
    products = sortCustomBannerProductsByRecency(products);

    if (location.hash === "#/coleccion/fyl-originals") {
      logBannerDebug("Oculto: colección FYL (post-filtro imagen)");
      hideCustomBanner();
      return;
    }
    renderCustomBanner(products, bannerName, tagValue);
    logBannerDebug("Banner renderizado", {
      productosEnCarrusel: products.length,
      target:
        document.getElementById("custom-banner-container-inline")?.id ||
        "custom-banner-container",
    });
    fylCatalogDbg("✅ Banner personalizado renderizado exitosamente");
  } catch (error) {
    logBannerDebug("Excepción en loadAndShowCustomBanner", {
      message: error?.message,
      stack: error?.stack,
    });
    console.error("❌ Error en loadAndShowCustomBanner:", error);
    hideCustomBanner();
  }
}

// Exportar funciones globalmente
if (typeof window !== "undefined") {
  window.loadAndShowCustomBanner = loadAndShowCustomBanner;
  window.hideCustomBanner = hideCustomBanner;
  window.getAllUniqueTags = getAllUniqueTags;
}
