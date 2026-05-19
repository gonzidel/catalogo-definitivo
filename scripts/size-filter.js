// scripts/size-filter.js - Filtro de talles con modal bottom sheet

import { fylDevLog } from "./config.js";
import { supabase } from "./supabase-client.js";
import { compareCatalogSizes, normalizeSize } from "./utils/size-normalizer.js";

// Estado global
let currentCategory = null;
let selectedSizes = [];
let sizeFilterActive = false;
let tempCategoryForSizeFilter = null; // Para almacenar categoría seleccionada temporalmente
let combinedSizesMap = new Map(); // Mapa de talles combinados: "37/38" -> ["37", "38"]

function normalizeCategoryName(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function doesCategoryMatchProduct(selectedCategory, productCategory) {
  const selected = normalizeCategoryName(selectedCategory);
  const product = normalizeCategoryName(productCategory);

  if (!selected || selected === "all") return true;
  if (!product) return false;
  if (selected === product) return true;

  // Lencería y Marroquinería suelen vivir en "Otros" en products.
  if ((selected === "lenceria" || selected === "marroquineria") && product === "otros") {
    return true;
  }

  return false;
}

function getCardArticulo(card) {
  const fromBadge = card?.querySelector(".product-name-badge")?.textContent?.trim() || "";
  const badgeArticulo = fromBadge.replace(/^Art\.\s+/i, "").trim();
  return (
    card?.dataset?.articulo?.trim() ||
    card?.querySelector(".article-box")?.textContent?.trim() ||
    badgeArticulo ||
    ""
  );
}

function getAppliedSizeFilterCount() {
  if (!sizeFilterActive) return 0;
  const raw =
    typeof window !== "undefined" ? window.__fylActiveSizeFilters : [];
  const arr = Array.isArray(raw) ? raw : [];
  return arr.filter(Boolean).length;
}

/** Sincroniza clase activa, texto (Talles · N) y limpia estilos inline legacy en los botones. */
function updateSizeFilterButtonsUI() {
  const count = getAppliedSizeFilterCount();
  const labelText =
    sizeFilterActive && count > 0 ? `Talles · ${count}` : "Talles";
  const ariaLabel =
    sizeFilterActive && count > 0
      ? `Filtrar por talle, ${count} activos`
      : "Filtrar por talle";

  const entries = [
    {
      btn: document.getElementById("size-filter-btn"),
      label: document.getElementById("size-filter-btn-label"),
    },
    {
      btn: document.getElementById("size-filter-btn-desktop"),
      label: document.getElementById("size-filter-btn-desktop-label"),
    },
  ];

  entries.forEach(({ btn, label }) => {
    if (!btn) return;
    btn.classList.toggle("is-active", sizeFilterActive);
    btn.style.background = "";
    btn.style.color = "";
    btn.style.borderColor = "";
    const lab = label || btn.querySelector(".size-filter-chip__label, .size-filter-btn__label");
    if (lab) lab.textContent = labelText;
    btn.setAttribute("aria-label", ariaLabel);
  });
}

/** Letras principales (Ropa). 6XL+ no forman parte del bloque S–5XL. */
const ROPA_LETTER_SET = new Set(["S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL"]);
const ROPA_LETTER_ORDER = ["S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL"];

/**
 * Pares letra + número: una sola celda; el filtro acepta talle de letra O talle numérico (OR).
 * Claves = las de classifyRopaTalle (ROPA:L:* y ROPA:N:*).
 */
const ROPA_UNIFIED_PAIRS = [
  { label: "S/1", keys: ["ROPA:L:S", "ROPA:N:1"] },
  { label: "M/2", keys: ["ROPA:L:M", "ROPA:N:2"] },
  { label: "L/3", keys: ["ROPA:L:L", "ROPA:N:3"] },
  { label: "XL/4", keys: ["ROPA:L:XL", "ROPA:N:4"] },
  { label: "2XL/5", keys: ["ROPA:L:2XL", "ROPA:N:5"] },
  { label: "3XL/6", keys: ["ROPA:L:3XL", "ROPA:N:6"] },
  { label: "4XL/7", keys: ["ROPA:L:4XL", "ROPA:N:7"] },
  { label: "5XL/8", keys: ["ROPA:L:5XL", "ROPA:N:8"] },
];

const ROPA_PAIR_LABELS = new Set(ROPA_UNIFIED_PAIRS.map((p) => p.label));

function stripTrailingSizeDots(s) {
  return String(s ?? "")
    .trim()
    .replace(/\.+$/g, "")
    .trim();
}

/**
 * Clave de comparación y de deduplicación: trim, sin puntos finales.
 */
function normalizeRopaTalleString(s) {
  return stripTrailingSizeDots(s);
}

/**
 * "UNICO", "úNico", " unica. " → unico/unica (sin acento para comparar).
 */
function isRopaUnicoToken(s) {
  if (s == null) return false;
  const t = String(s)
    .trim()
    .replace(/\.+$/g, "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  return t === "unico" || t === "unica";
}

/**
 * S, M, L, 2XL… (solo ROPA_LETTER_SET). 6XL+ → null (va a «Otros talles»).
 */
function ropaLetterCanonicalFromText(s) {
  const raw = String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
  if (!raw) return null;
  if (/^(6|7|8|9|1[0-9]|[2-9]\d)xl$/.test(raw)) return null;

  const map = {
    s: "S",
    m: "M",
    l: "L",
    xl: "XL",
    xxl: "2XL",
    "2xl": "2XL",
    xxxl: "3XL",
    "3xl": "3XL",
    xxxxl: "4XL",
    "4xl": "4XL",
    xxxxxl: "5XL",
    "5xl": "5XL",
  };
  const c = map[raw] ?? (ROPA_LETTER_SET.has(raw.toUpperCase()) ? raw.toUpperCase() : null);
  return c && ROPA_LETTER_SET.has(c) ? c : null;
}

function parseRopaIntSize(s) {
  const t = normalizeRopaTalleString(s);
  if (t === "") return null;
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const n = parseInt(normalizeSize(t) || t, 10);
  if (Number.isNaN(n) || n < 0) return null;
  return n;
}

/**
 * Un talle → una sección. `filterValue` = valor en data-size (coincide con lógica de filtro).
 * `mainType`: letter | num1_10 | extra (dentro de sección M).
 * Orden de reglas: Único → letras 2xl… (no confundir "2" con "2xl") → enteros.
 */
function classifyRopaTalle(s) {
  const t0 = String(s);
  if (!t0 || !String(t0).trim()) return null;
  const t = normalizeRopaTalleString(t0);
  if (!t) return null;

  if (isRopaUnicoToken(t)) {
    return {
      key: "ROPA:U",
      display: "Único",
      filterValue: "Único",
      section: "U",
      mainType: null,
    };
  }

  const letterFirst = ropaLetterCanonicalFromText(t);
  if (letterFirst) {
    return {
      key: `ROPA:L:${letterFirst}`,
      display: letterFirst,
      filterValue: letterFirst,
      section: "M",
      mainType: "letter",
    };
  }

  const n = parseRopaIntSize(t);
  if (n !== null) {
    const fv = String(n);
    if (n >= 36 && n <= 58) {
      return {
        key: `ROPA:P:${n}`,
        display: fv,
        filterValue: fv,
        section: "P",
        mainType: null,
      };
    }
    if (n >= 1 && n <= 10) {
      return {
        key: `ROPA:N:${n}`,
        display: fv,
        filterValue: fv,
        section: "M",
        mainType: "num1_10",
      };
    }
    return {
      key: `ROPA:E:${n}`,
      display: fv,
      filterValue: fv,
      section: "M",
      mainType: "extra",
    };
  }

  const x = t.replace(/\s+/g, " ").trim();
  const k = `ROPA:X:${x.normalize("NFD").toLowerCase()}`;
  return {
    key: k,
    display: x,
    filterValue: x,
    section: "M",
    mainType: "extra",
  };
}

function ropaTalleKey(s) {
  const c = classifyRopaTalle(s);
  return c ? c.key : "";
}

function isRopaFilterCategoryName(cat) {
  return normalizeCategoryName(cat) === "ropa";
}

function ropaSelectionKey(sel) {
  const t = String(sel ?? "").trim();
  if (ROPA_PAIR_LABELS.has(t)) {
    return `ROPA:SEL:PAIR:${t}`;
  }
  return ropaTalleKey(t) || "";
}

function isSizeSelectedRopa(value, selectedList) {
  const kv = ropaSelectionKey(value);
  if (!kv) return false;
  return (selectedList || []).some((x) => ropaSelectionKey(x) === kv);
}

/**
 * Construye la grilla principal Ropa: pares S/1…, 9 y 10, extras, Único al final.
 * Los pares se muestran si existe en catálogo cualquiera de sus dos clases (letra o número).
 */
function buildRopaUnifiedMainEntries(byKey) {
  const consumed = new Set();
  const out = [];

  for (const p of ROPA_UNIFIED_PAIRS) {
    const show = p.keys.some((k) => byKey.has(k));
    if (show) {
      p.keys.forEach((k) => consumed.add(k));
      out.push({ kind: "pair", token: p.label });
    }
  }

  for (const n of [9, 10]) {
    const k = `ROPA:N:${n}`;
    if (byKey.has(k) && !consumed.has(k)) {
      consumed.add(k);
      out.push({ kind: "num", token: String(n) });
    }
  }

  const extraItems = [];
  for (const [key, fv] of byKey.entries()) {
    if (consumed.has(key)) continue;
    if (key.startsWith("ROPA:P:") || key === "ROPA:U") continue;
    consumed.add(key);
    extraItems.push(fv);
  }
  extraItems.sort((a, b) => compareCatalogSizes(a, b));
  for (const fv of extraItems) {
    out.push({ kind: "extra", token: fv });
  }

  if (byKey.has("ROPA:U")) {
    out.push({ kind: "unico", token: "Único" });
  }

  return out;
}

function getSearchDerivedCategory() {
  const derived =
    typeof window.__fylSearchDerivedCategory === "string"
      ? window.__fylSearchDerivedCategory.trim()
      : "";
  return derived || null;
}

// Obtener categoría actual
function getCurrentCategory() {
  // Intentar detectar desde la URL
  const urlParams = new URLSearchParams(window.location.search);
  const tabSlug = urlParams.get('tab');
  
  // Mapear slugs a categorías
  const slugToCategory = {
    'calzado': 'Calzado',
    'ropa': 'Ropa',
    'lenceria': 'Lenceria',
    'marroquineria': 'Marroquineria',
    'novedades': 'Novedades',
    'ofertas': 'Ofertas'
  };
  
  if (tabSlug && slugToCategory[tabSlug]) {
    return slugToCategory[tabSlug];
  }

  // Cuando hay búsqueda activa, priorizar la categoría inferida por resultados/tag.
  const derivedFromSearch = getSearchDerivedCategory();
  if (hasActiveSearch() && derivedFromSearch) {
    return derivedFromSearch;
  }

  // Misma categoría que está mostrando el catálogo (Lencería/Marroquinería vía Otros+tags, etc.)
  const synced = typeof window.__fylCategoriaActual === 'string' ? window.__fylCategoriaActual.trim() : '';
  if (synced && synced !== 'all') {
    return synced;
  }
  
  // Detectar desde el botón activo de acciones rápidas
  const activeBtn = document.querySelector('.quick-action-btn.category-chip--active');
  if (activeBtn) {
    const actionValue = activeBtn.dataset.actionValue;
    if (actionValue && actionValue !== 'all') {
      // Mapear valores comunes
      if (actionValue === 'Ofertas') return 'Ofertas';
      if (actionValue === 'Novedades') return 'Novedades';
      return actionValue;
    }
  }
  
  // Detectar desde el menú desktop activo (si existe)
  const activeMenuBtn = document.querySelector('.menu-desktop button.active, .menu button.active');
  if (activeMenuBtn && activeMenuBtn.textContent) {
    const text = activeMenuBtn.textContent.trim();
    if (text.includes('Calzado')) return 'Calzado';
    if (text.includes('Ropa')) return 'Ropa';
    if (text.includes('Lencería')) return 'Lenceria';
    if (text.includes('Accesorios')) return 'Marroquineria';
    if (text.includes('Novedades')) return 'Novedades';
    if (text.includes('Ofertas')) return 'Ofertas';
  }
  
  return currentCategory || null;
}

// Función helper para expandir talles combinados
function expandCombinedSizes(sizes) {
  const expanded = new Set();
  const combinedMap = new Map(); // Para tracking: "37/38" -> ["37", "38"]
  
  sizes.forEach(size => {
    if (size && typeof size === 'string' && size.includes('/')) {
      // Es un talle combinado, expandirlo
      const parts = size.split('/').map(s => s.trim()).filter(Boolean);
      if (parts.length >= 2) {
        combinedMap.set(size, parts);
        parts.forEach(part => {
          if (part && part.trim() !== '') {
            expanded.add(part.trim());
          }
        });
      } else {
        // Si solo tiene una parte después de split, tratarlo como talle individual
        expanded.add(size.trim());
      }
    } else {
      // Es un talle individual
      if (size && size.trim() !== '') {
        expanded.add(size.trim());
      }
    }
  });
  
  return {
    individualSizes: Array.from(expanded),
    combinedMap: combinedMap
  };
}

// Detectar si hay búsqueda activa
function hasActiveSearch() {
  const searchInput = document.getElementById("searchInput") || document.getElementById("search-bar-mobile");
  if (!searchInput) return false;
  const searchTerm = searchInput.value?.trim();
  return searchTerm && searchTerm.length > 0;
}

// Obtener IDs de productos visibles actualmente
async function getVisibleProductIds() {
  const cards = document.querySelectorAll('.card.producto:not([style*="display: none"])');
  const productNames = new Set();
  
  cards.forEach(card => {
    const articulo = getCardArticulo(card);
    if (articulo) {
      productNames.add(articulo);
    }
  });
  
  if (productNames.size === 0) return [];
  
  // Consultar products para obtener IDs
  try {
    const { data, error } = await supabase
      .from('products')
      .select('id, name')
      .in('name', Array.from(productNames))
      .eq('status', 'active');
    
    if (error) {
      console.error('Error obteniendo IDs de productos:', error);
      return [];
    }
    
    return (data || []).map(p => p.id);
  } catch (error) {
    console.error('Error en getVisibleProductIds:', error);
    return [];
  }
}

function sortExpandedSizes(individualSizes) {
  return individualSizes.sort((a, b) => {
    const numA = parseInt(a, 10);
    const numB = parseInt(b, 10);
    const isNumA = !isNaN(numA);
    const isNumB = !isNaN(numB);
    if (isNumA && isNumB) return numA - numB;
    if (isNumA) return -1;
    if (isNumB) return 1;
    return a.localeCompare(b);
  });
}

// Obtener talles: preferir la misma fuente que el catálogo (cargarDesdeSupabase → catalog_public_view)
// para que coincida con Lencería/Otros por tags y no falle .eq('category') en products.
async function getAvailableSizes(category = null, productIds = null) {
  try {
    const canUseCatalogLoader =
      typeof window.cargarDesdeSupabase === 'function' &&
      category &&
      category !== 'all';

    if (canUseCatalogLoader) {
      const rows = await window.cargarDesdeSupabase(category);
      let list = Array.isArray(rows) ? rows : [];

      if (hasActiveSearch()) {
        const visibleNames = new Set();
        document.querySelectorAll('.card.producto').forEach((card) => {
          if (card.style.display === 'none') return;
          const articulo = getCardArticulo(card);
          if (articulo) visibleNames.add(articulo);
        });
        if (visibleNames.size > 0) {
          list = list.filter((r) => visibleNames.has((r.Articulo || '').trim()));
        }
      } else if (productIds && productIds.length > 0) {
        const { data: prods, error: pidErr } = await supabase
          .from('products')
          .select('id, name')
          .in('id', productIds)
          .eq('status', 'active');
        if (pidErr) {
          console.warn('getAvailableSizes: error resolviendo nombres por id', pidErr);
        }
        const names = new Set((prods || []).map((p) => (p.name || '').trim()).filter(Boolean));
        if (names.size > 0) {
          list = list.filter((r) => names.has((r.Articulo || '').trim()));
        }
      }

      const sizesSet = new Set();
      for (const row of list) {
        const raw = row.Numeracion;
        if (raw == null || raw === '') continue;
        String(raw)
          .split(',')
          .map((t) => t.trim())
          .filter((t) => t && t !== 'Único')
          .forEach((t) => sizesSet.add(t));
      }

      console.log('📊 Talles desde catálogo (filas):', list.length, '| talles únicos (pre-expansión):', sizesSet.size);

      if (sizesSet.size > 0) {
        const { individualSizes, combinedMap } = expandCombinedSizes(Array.from(sizesSet));
        combinedSizesMap = combinedMap;
        console.log('🔍 Talles combinados encontrados:', Array.from(combinedMap.keys()));
        console.log('📏 Talles individuales para grid:', individualSizes.length);
        return sortExpandedSizes(individualSizes);
      }
      if (list.length > 0) {
        console.warn('⚠️ Catálogo con filas pero sin Numeracion útil; intentando variant_sizes vía products.');
      }
    }

    // Fallback: consultar variant_sizes vía products.category (Calzado/Ropa puros en products)
    let productQuery = supabase
      .from('products')
      .select('id, name')
      .eq('status', 'active');
    
    // Filtrar por categoría si se proporciona
    if (category && category !== 'all' && category !== 'Novedades' && category !== 'Ofertas') {
      productQuery = productQuery.eq('category', category);
    }
    
    // Filtrar por IDs si se proporcionan
    if (productIds && productIds.length > 0) {
      productQuery = productQuery.in('id', productIds);
    }
    
    const { data: products, error: productsError } = await productQuery;
    
    if (productsError) {
      console.error('Error obteniendo productos:', productsError);
      throw productsError;
    }
    
    if (!products || products.length === 0) {
      return [];
    }
    
    const productIdsToUse = products.map(p => p.id);
    
    // Obtener variantes activas de esos productos
    const { data: variants, error: variantsError } = await supabase
      .from('product_variants')
      .select('id')
      .in('product_id', productIdsToUse)
      .eq('active', true);
    
    if (variantsError) {
      console.error('Error obteniendo variantes:', variantsError);
      throw variantsError;
    }
    
    if (!variants || variants.length === 0) {
      return [];
    }
    
    const variantIds = variants.map(v => v.id);
    
    // Obtener talles con stock > 0 de esas variantes
    console.log('🔍 Consultando variant_sizes para', variantIds.length, 'variantes');
    const { data: sizes, error: sizesError } = await supabase
      .from('variant_sizes')
      .select('size, stock_qty')
      .in('variant_id', variantIds)
      .gt('stock_qty', 0);
    
    if (sizesError) {
      console.error('❌ Error obteniendo talles:', sizesError);
      throw sizesError;
    }
    
    console.log('📊 Registros de variant_sizes obtenidos:', sizes?.length || 0);
    
    // Extraer talles únicos (incluyendo talles combinados)
    const sizesSet = new Set();
    (sizes || []).forEach(item => {
      if (item.size && item.size.trim() !== '' && item.size.trim() !== 'Único') {
        sizesSet.add(item.size.trim());
      }
    });
    
    // Expandir talles combinados
    const { individualSizes, combinedMap } = expandCombinedSizes(Array.from(sizesSet));
    
    // Guardar mapa de talles combinados globalmente para usar en checkProductHasSizes
    combinedSizesMap = combinedMap;
    
    console.log('🔍 Talles combinados encontrados:', Array.from(combinedMap.keys()));
    console.log('📏 Talles individuales para grid:', individualSizes.length);

    return sortExpandedSizes(individualSizes);
  } catch (error) {
    console.error('Error en getAvailableSizes:', error);
    return [];
  }
}

/**
 * @deprecated Dejó de usarse: sin categoría activa se muestra toast + resaltado de chips, no el modal.
 * Se mantiene por si se reutiliza (tests / admin / otro flujo).
 */
function renderCategorySelector() {
  const body = document.getElementById('size-filter-body');
  const footer = document.getElementById('size-filter-footer');

  if (!body) return;

  footer.style.display = 'none';

  body.innerHTML = `
    <div class="size-filter-category-selector">
      <p>Seleccione una categoría</p>
      <div class="size-filter-category-buttons">
        <button class="size-filter-category-btn" data-category="Calzado">Calzado</button>
        <button class="size-filter-category-btn" data-category="Ropa">Ropa</button>
        <button class="size-filter-category-btn" data-category="Lenceria">Lencería</button>
      </div>
    </div>
  `;

  body.querySelectorAll('.size-filter-category-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const category = btn.dataset.category;
      tempCategoryForSizeFilter = category;
      await loadSizesForCategory(category);
    });
  });
}

let categoryToastTimer = null;
let categoryBarAttentionTimer = null;

function showCategoryRequiredToast() {
  let toast = document.getElementById('category-required-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'category-required-toast';
    toast.className = 'category-required-toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    document.body.appendChild(toast);
  }

  const bar =
    document.getElementById('category-bar') ||
    document.querySelector('.category-bar') ||
    document.querySelector('.quick-actions-container');
  if (bar) {
    const rect = bar.getBoundingClientRect();
    const y = Math.round(rect.bottom + 8);
    toast.style.top = `${y}px`;
  } else {
    toast.style.top = '112px';
  }
  toast.textContent = 'Elegí una categoría para ver talles';

  window.clearTimeout(categoryToastTimer);
  toast.classList.remove('is-visible');
  void toast.offsetWidth;
  toast.classList.add('is-visible');

  categoryToastTimer = window.setTimeout(() => {
    toast.classList.remove('is-visible');
    categoryToastTimer = null;
  }, 1800);
}

function pulseCategoryBar() {
  const bar =
    document.getElementById('category-bar') ||
    document.querySelector('.category-bar') ||
    document.querySelector('.quick-actions-container') ||
    document.querySelector('.category-chips') ||
    document.querySelector('.top-categories');
  if (!bar) return;

  window.clearTimeout(categoryBarAttentionTimer);
  bar.classList.remove('category-bar--attention');
  void bar.offsetWidth;
  bar.classList.add('category-bar--attention');

  categoryBarAttentionTimer = window.setTimeout(() => {
    bar.classList.remove('category-bar--attention');
    categoryBarAttentionTimer = null;
  }, 600);
}

function hasCategoryForSizeFilter() {
  const c = getCurrentCategory();
  return Boolean(c && String(c).trim() !== 'all');
}

function showNeedCategoryFirstFeedback() {
  showCategoryRequiredToast();
  pulseCategoryBar();
}

// Cargar talles para una categoría
async function loadSizesForCategory(category) {
  const body = document.getElementById('size-filter-body');
  const footer = document.getElementById('size-filter-footer');
  
  if (!body) {
    console.error('size-filter-body no encontrado');
    return;
  }
  
  body.innerHTML = '<div class="size-filter-loading">Cargando talles...</div>';
  footer.style.display = 'none';
  
  try {
    let sizes = [];
    const hasSearch = hasActiveSearch();
    
    console.log('🔍 Cargando talles. Categoría:', category, 'Búsqueda activa:', hasSearch);
    
    if (hasSearch) {
      // Si hay búsqueda activa, obtener IDs de productos visibles
      console.log('📦 Obteniendo IDs de productos visibles...');
      const productIds = await getVisibleProductIds();
      console.log('📦 Productos visibles encontrados:', productIds.length);
      sizes = await getAvailableSizes(category, productIds);
    } else {
      // Si no hay búsqueda, usar solo categoría
      console.log('📦 Consultando talles por categoría...');
      sizes = await getAvailableSizes(category, null);
    }
    
    console.log('✅ Talles encontrados:', sizes.length, sizes);
    
    if (sizes.length === 0) {
      body.innerHTML = '<div class="size-filter-empty">No hay talles disponibles para esta categoría</div>';
      footer.style.display = 'none';
      return;
    }
    
    renderSizeGrid(sizes);
    footer.style.display = 'block';
  } catch (error) {
    console.error('❌ Error cargando talles:', error);
    body.innerHTML = `<div class="size-filter-empty">Error al cargar talles: ${error.message}</div>`;
    footer.style.display = 'none';
  }
}

// Organizar talles en grupos específicos según categoría
function organizeSizesInGroups(sizes, category) {
  const categoryLower = (category || '').toLowerCase();
  
  // Si es Ropa
  if (categoryLower === "ropa") {
    const byKey = new Map();
    for (const raw of sizes) {
      const t = String(raw).trim();
      if (!t) continue;
      const c = classifyRopaTalle(t);
      if (!c) continue;
      if (!byKey.has(c.key)) {
        byKey.set(c.key, c.filterValue);
      }
    }

    const ropaMain = buildRopaUnifiedMainEntries(byKey);
    const ropaP = [];
    for (const fv of byKey.values()) {
      const m = classifyRopaTalle(fv);
      if (m && m.section === "P") {
        ropaP.push(fv);
      }
    }
    ropaP.sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

    return { isRopa: true, ropaMain, ropaP };
  }
  // Si es Calzado (o cualquier otra categoría)
  else {
    const size35_40 = [];
    const size41_46 = [];
    const size18_34 = [];
    const otherSizes = [];
    
    sizes.forEach(size => {
      const numSize = parseInt(size);
      if (!isNaN(numSize)) {
        if (numSize >= 35 && numSize <= 40) {
          size35_40.push(size);
        } else if (numSize >= 41 && numSize <= 46) {
          size41_46.push(size);
        } else if (numSize >= 18 && numSize <= 34) {
          size18_34.push(size);
        } else {
          otherSizes.push(size);
        }
      } else {
        otherSizes.push(size);
      }
    });
    
    // Ordenar cada grupo
    size35_40.sort((a, b) => parseInt(a) - parseInt(b));
    size41_46.sort((a, b) => parseInt(a) - parseInt(b));
    size18_34.sort((a, b) => parseInt(a) - parseInt(b));
    otherSizes.sort((a, b) => {
      const numA = parseInt(a);
      const numB = parseInt(b);
      if (!isNaN(numA) && !isNaN(numB)) return numA - numB;
      return a.localeCompare(b);
    });
    
    return {
      isRopa: false,
      group1: size35_40,
      group2: size41_46,
      group3: size18_34,
      others: otherSizes,
    };
  }
}

const SIZE_KIDS_COLLAPSE_THRESHOLD = 8;

function escDataAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Mapea grupos técnicos a secciones con títulos (Calzado / Ropa / resto).
 */
function getSizeFilterSections(sizes, category) {
  const groups = organizeSizesInGroups(sizes, category);
  const cat = (category || "").toLowerCase();

  if (cat === "ropa" && groups.isRopa) {
    return [
      {
        type: "ropaLetrasYEquiv",
        key: "ropa-unified",
        title: "Letras y tallas",
        subtitle: "S/1 a 5XL/8, 9 y 10. Único con borde punteado al final",
        entries: groups.ropaMain,
        sizes: null,
        collapse: false,
      },
      {
        key: "pants",
        title: "Pantalones",
        subtitle: "Talles numerados de pantalón",
        sizes: groups.ropaP,
        collapse: false,
      },
    ].filter((s) => {
      if (s.type === "ropaLetrasYEquiv") {
        return s.entries && s.entries.length > 0;
      }
      return s.sizes && s.sizes.length > 0;
    });
  }

  return [
    {
      key: "mujer",
      title: "Mujer",
      subtitle: "Talles más frecuentes",
      sizes: groups.group1,
      collapse: false,
    },
    {
      key: "hombre",
      title: "Especiales / Hombre",
      subtitle: "41 a 46",
      sizes: groups.group2,
      collapse: false,
    },
    {
      key: "ninos",
      title: "Niños",
      subtitle: "Talles infantiles",
      sizes: groups.group3,
      collapse: (groups.group3 || []).length > SIZE_KIDS_COLLAPSE_THRESHOLD,
      kidsStyle: true,
    },
    {
      key: "other",
      title: "Otros",
      subtitle: null,
      sizes: groups.others,
      collapse: false,
    },
  ].filter((s) => s.sizes && s.sizes.length > 0);
}

function buildRopaLetrasYEquivGridHtml(entries) {
  const cat = tempCategoryForSizeFilter || getCurrentCategory() || "";
  return (entries || [])
    .map((e) => {
      const token = e.token;
      const isSel = isSizeSelectedRopa(token, selectedSizes);
      const sel = isSel ? "is-selected" : "";
      const ds = escDataAttr(token);
      const uClass = e.kind === "unico" ? " size-option--unico" : "";
      if (e.kind === "unico") {
        return `<button type="button" class="size-option${uClass} ${sel}" data-size="${ds}" data-category="${escDataAttr(cat)}" data-kind="unico">${escHtml(token)}</button>`;
      }
      if (e.kind === "pair") {
        return `<button type="button" class="size-option size-option--pair ${sel}" data-size="${ds}" data-category="${escDataAttr(cat)}" data-kind="pair">${escHtml(token)}</button>`;
      }
      return `<button type="button" class="size-option ${sel}" data-size="${ds}" data-category="${escDataAttr(cat)}">${escHtml(token)}</button>`;
    })
    .join("");
}

function buildSizeOptionsGridHtml(sizes) {
  const cat = tempCategoryForSizeFilter || getCurrentCategory() || "";
  const ropa = isRopaFilterCategoryName(cat);
  return (sizes || [])
    .map((size) => {
      const isSel = ropa
        ? isSizeSelectedRopa(size, selectedSizes)
        : selectedSizes.includes(size);
      const ds = escDataAttr(size);
      return `<button type="button" class="size-option ${isSel ? "is-selected" : ""}" data-size="${ds}" data-category="${escDataAttr(cat)}">${escHtml(String(size))}</button>`;
    })
    .join("");
}

function updateSizeFilterFooter() {
  const applyBtn = document.getElementById("size-filter-apply");
  const clearBtn = document.getElementById("size-filter-clear");
  const n = selectedSizes.length;
  if (applyBtn) {
    applyBtn.textContent = n > 0 ? "Aplicar talles" : "Ver productos";
  }
  if (clearBtn) {
    clearBtn.style.display = n > 0 ? "" : "none";
  }
}

function toggleSizeOptionByButton(btn) {
  const size = btn.getAttribute("data-size");
  if (size == null || size === "") return;
  const cat = tempCategoryForSizeFilter || getCurrentCategory() || "";
  toggleSize(size);
  const isSel = isRopaFilterCategoryName(cat)
    ? isSizeSelectedRopa(size, selectedSizes)
    : selectedSizes.includes(size);
  btn.classList.toggle("is-selected", isSel);
  updateSizeFilterFooter();
}

function handleSizeFilterModalClick(ev) {
  const modal = document.getElementById("size-filter-modal");
  if (!modal || !modal.classList.contains("active")) return;

  const opt = ev.target.closest(".size-option");
  if (opt) {
    ev.preventDefault();
    toggleSizeOptionByButton(opt);
    return;
  }

  const reveal = ev.target.closest(".size-kids-reveal");
  if (reveal) {
    const wrap = reveal.closest(".size-kids-wrap");
    if (!wrap) return;
    const panel = wrap.querySelector(".size-kids-grid-wrap");
    const expandLabel =
      reveal.getAttribute("data-text-expand") || "Ver talles de niños";
    const collapseLabel =
      reveal.getAttribute("data-text-collapse") || "Ocultar talles de niños";
    const expanded = wrap.classList.toggle("is-expanded");
    if (panel) {
      if (expanded) {
        panel.removeAttribute("hidden");
        reveal.setAttribute("aria-expanded", "true");
        reveal.textContent = collapseLabel;
      } else {
        panel.setAttribute("hidden", "");
        reveal.setAttribute("aria-expanded", "false");
        reveal.textContent = expandLabel;
      }
    }
  }
}

// Renderizar secciones + grillas compactas
function renderSizeGrid(sizes) {
  const body = document.getElementById("size-filter-body");
  if (!body) {
    console.error("size-filter-body no encontrado para renderizar grid");
    return;
  }

  const category = tempCategoryForSizeFilter || getCurrentCategory() || "";
  const sections = getSizeFilterSections(sizes, category);
  if (sections.length === 0) {
    body.innerHTML = '<div class="size-filter-empty">No hay talles disponibles</div>';
    updateSizeFilterFooter();
    return;
  }

  const parts = sections.map((sec) => {
    const hasKidsStyle = sec.kidsStyle;
    const doCollapse = sec.collapse && hasKidsStyle;
    const grid =
      sec.type === "ropaLetrasYEquiv"
        ? buildRopaLetrasYEquivGridHtml(sec.entries)
        : buildSizeOptionsGridHtml(sec.sizes);

    if (doCollapse) {
      const expandL = sec.revealExpandText || "Ver talles de niños";
      const collapseL = sec.revealCollapseText || "Ocultar talles de niños";
      return `
        <section class="size-section size-section--ninos" data-key="${escHtml(sec.key)}">
          <h3 class="size-section-title">${escHtml(sec.title)}</h3>
          ${
            sec.subtitle
              ? `<p class="size-section-subtitle">${escHtml(sec.subtitle)}</p>`
              : ""
          }
          <div class="size-kids-wrap">
            <div class="size-kids-cta">
              <button type="button" class="size-kids-reveal" aria-expanded="false" data-text-expand="${escDataAttr(expandL)}" data-text-collapse="${escDataAttr(collapseL)}">${escHtml(expandL)}</button>
            </div>
            <div class="size-kids-grid-wrap" hidden>
              <div class="size-options-grid">${grid}</div>
            </div>
          </div>
        </section>`;
    }

    return `
      <section class="size-section" data-key="${escHtml(sec.key)}">
        <h3 class="size-section-title">${escHtml(sec.title)}</h3>
        ${
          sec.subtitle
            ? `<p class="size-section-subtitle">${escHtml(sec.subtitle)}</p>`
            : ""
        }
        <div class="size-options-grid">${grid}</div>
      </section>`;
  });

  body.innerHTML = `<div class="size-filter-sections">${parts.join("")}</div>`;
  updateSizeFilterFooter();
}

// Toggle selección de talle
function toggleSize(size) {
  const cat = tempCategoryForSizeFilter || getCurrentCategory() || "";
  if (isRopaFilterCategoryName(cat)) {
    const k = ropaSelectionKey(size);
    const index = selectedSizes.findIndex((s) => ropaSelectionKey(s) === k);
    if (index > -1) {
      selectedSizes.splice(index, 1);
    } else {
      selectedSizes.push(size);
    }
    return;
  }
  const index = selectedSizes.indexOf(size);
  if (index > -1) {
    selectedSizes.splice(index, 1);
  } else {
    selectedSizes.push(size);
  }
}

// Abrir modal de filtro de talles
async function openSizeFilterModal() {
  const modal = document.getElementById('size-filter-modal');
  if (!modal) {
    console.error('Modal size-filter-modal no encontrado');
    return;
  }

  const category = getCurrentCategory();
  const hasSearch = hasActiveSearch();
  console.log('🔍 Talles: estado', { category, hasSearch });

  if (!hasCategoryForSizeFilter()) {
    showNeedCategoryFirstFeedback();
    return;
  }

  const cat = String(category || '').trim();
  selectedSizes = [];
  tempCategoryForSizeFilter = cat;

  modal.classList.add('active');
  document.body.classList.add('modal-open');
  document.body.classList.add('size-filter-open');

  console.log('📏 Cargando talles para categoría:', cat);
  await loadSizesForCategory(cat);
}

// Cerrar modal
function closeSizeFilterModal() {
  const modal = document.getElementById('size-filter-modal');
  if (modal) {
    modal.classList.remove('active');
  }
  document.body.classList.remove('modal-open');
  document.body.classList.remove('size-filter-open');

  if (tempCategoryForSizeFilter && !sizeFilterActive) {
    tempCategoryForSizeFilter = null;
  }
}

// Aplicar filtro de talles
async function applySizeFilter() {
  if (selectedSizes.length === 0) {
    clearSizeFilter();
    closeSizeFilterModal();
    return;
  }
  
  const category = tempCategoryForSizeFilter || getCurrentCategory();
  
  // Marcar filtro como activo
  sizeFilterActive = true;
  
  // Obtener todos los productos visibles
  const cards = document.querySelectorAll('.card.producto');
  
  let visibleCount = 0;
  
  for (const card of cards) {
    // Obtener el nombre del producto
    const articulo = getCardArticulo(card);
    if (!articulo) {
      card.style.display = 'none';
      continue;
    }
    
    let hasSelectedSize = false;
    const fromMemory =
      typeof window.fylProductHasSizesInMemory === "function"
        ? window.fylProductHasSizesInMemory(articulo, selectedSizes)
        : null;
    if (fromMemory === true) {
      hasSelectedSize = true;
    } else if (fromMemory === false) {
      hasSelectedSize = false;
    } else {
      hasSelectedSize = await checkProductHasSizes(articulo, selectedSizes, category);
    }
    
    if (hasSelectedSize) {
      card.style.display = '';
      card.setAttribute('data-filtered-by-size', 'true');
      visibleCount++;
    } else {
      card.style.display = 'none';
      card.setAttribute('data-filtered-by-size', 'true');
    }
  }
  
  // Mostrar mensaje si no hay resultados
  const catalogContainer = document.getElementById('catalogo') || document.getElementById('catalog-container');
  let noResultsMsg = catalogContainer.querySelector('.no-results-size-filter');
  
  if (visibleCount === 0) {
    if (!noResultsMsg) {
      noResultsMsg = document.createElement('div');
      noResultsMsg.className = 'no-results-size-filter';
      noResultsMsg.style.cssText = 'text-align: center; padding: 40px 20px; color: #666; background: white; border-radius: 8px; margin: 20px;';
      noResultsMsg.innerHTML = `
        <h3 style="margin: 0 0 12px; color: #333;">No se encontraron productos</h3>
        <p style="margin: 0 0 20px;">No hay productos disponibles con los talles seleccionados.</p>
        <button onclick="window.clearSizeFilter()" style="
          background: #CD844D;
          color: white;
          border: none;
          padding: 10px 20px;
          border-radius: 6px;
          cursor: pointer;
          font-size: 14px;
        ">Limpiar filtros</button>
      `;
      if (catalogContainer) {
        catalogContainer.insertBefore(noResultsMsg, catalogContainer.firstChild);
      }
    }
  } else {
    if (noResultsMsg) {
      noResultsMsg.remove();
    }
  }
  
  closeSizeFilterModal();
  
  // Actualizar botones de filtro para indicar que está activo
  updateSizeFilterButtonsUI();
  if (typeof window !== "undefined") {
    window.__fylActiveSizeFilters = selectedSizes.slice();
  }
  if (typeof window.refreshCatalogFilterBar === "function") {
    window.refreshCatalogFilterBar();
  }
}

// Verificar si un producto tiene alguno de los talles seleccionados
async function checkProductHasSizes(articulo, selectedSizesArray, category) {
  try {
    if (isRopaFilterCategoryName(category)) {
      const keySet = new Set();
      for (const s of selectedSizesArray || []) {
        const t = String(s).trim();
        if (ROPA_PAIR_LABELS.has(t)) {
          const pair = ROPA_UNIFIED_PAIRS.find((p) => p.label === t);
          if (pair) {
            pair.keys.forEach((k) => keySet.add(k));
            continue;
          }
        }
        const k = ropaTalleKey(t);
        if (k) keySet.add(k);
      }
      if (keySet.size === 0) {
        return false;
      }
      const { data: products, error: productError } = await supabase
        .from("products")
        .select("id, category")
        .eq("name", articulo)
        .eq("status", "active")
        .limit(1);
      if (productError || !products || products.length === 0) {
        return false;
      }
      const product = products[0];
      if (!doesCategoryMatchProduct(category, product.category)) {
        return false;
      }
      const { data: variants, error: variantError } = await supabase
        .from("product_variants")
        .select("id")
        .eq("product_id", product.id)
        .eq("active", true);
      if (variantError || !variants || variants.length === 0) {
        return false;
      }
      const variantIds = variants.map((v) => v.id);
      const { data: variantSizes, error: sizeError } = await supabase
        .from("variant_sizes")
        .select("size")
        .in("variant_id", variantIds)
        .gt("stock_qty", 0);
      if (sizeError || !variantSizes || variantSizes.length === 0) {
        return false;
      }
      for (const variantSize of variantSizes) {
        const sizeRaw = variantSize.size?.trim();
        if (!sizeRaw) continue;
        if (sizeRaw.includes("/")) {
          const parts = sizeRaw
            .split("/")
            .map((p) => p.trim())
            .filter(Boolean);
          for (const part of parts) {
            const k = ropaTalleKey(part);
            if (k && keySet.has(k)) return true;
          }
        } else {
          const k = ropaTalleKey(sizeRaw);
          if (k && keySet.has(k)) return true;
        }
      }
      return false;
    }

    const selectedNormalized = new Set(
      (selectedSizesArray || [])
        .map((size) => normalizeSize(size) || String(size || "").trim().toUpperCase())
        .filter(Boolean)
    );

    if (selectedNormalized.size === 0) {
      return false;
    }

    // Obtener el producto
    const { data: products, error: productError } = await supabase
      .from('products')
      .select('id, category')
      .eq('name', articulo)
      .eq('status', 'active')
      .limit(1);
    
    if (productError || !products || products.length === 0) {
      return false;
    }
    
    const product = products[0];
    
    // Si hay categoría, verificar que coincida
    if (!doesCategoryMatchProduct(category, product.category)) {
      return false;
    }
    
    // Obtener variantes del producto
    const { data: variants, error: variantError } = await supabase
      .from('product_variants')
      .select('id')
      .eq('product_id', product.id)
      .eq('active', true);
    
    if (variantError || !variants || variants.length === 0) {
      return false;
    }
    
    const variantIds = variants.map(v => v.id);
    
    // Obtener todos los talles del producto (incluyendo combinados)
    const { data: variantSizes, error: sizeError } = await supabase
      .from('variant_sizes')
      .select('size')
      .in('variant_id', variantIds)
      .gt('stock_qty', 0);
    
    if (sizeError) {
      console.error('Error verificando talles:', sizeError);
      return false;
    }
    
    if (!variantSizes || variantSizes.length === 0) {
      return false;
    }
    
    // Verificar si algún talle del producto coincide con los seleccionados
    for (const variantSize of variantSizes) {
      const sizeRaw = variantSize.size?.trim();
      const size = normalizeSize(sizeRaw) || String(sizeRaw || "").trim().toUpperCase();
      if (!size) continue;
      
      // Verificar si es un talle combinado
      if (size.includes('/')) {
        // Es un talle combinado, expandirlo en números individuales
        // El producto aparece si AL MENOS UNO de sus números está seleccionado
        const parts = size.split('/').map(s => s.trim()).filter(Boolean);
        if (parts.length >= 2) {
          // Verificar si AL MENOS UNO de los números está seleccionado
          const anyPartSelected = parts.some(part => selectedNormalized.has(part));
          if (anyPartSelected) {
            return true; // El producto tiene este talle combinado y al menos uno de sus números está seleccionado
          }
        }
      } else {
        // Es un talle individual, verificar si está en selectedSizesArray
        if (selectedNormalized.has(size)) {
          return true; // El producto tiene este talle individual seleccionado
        }
      }
    }
    
    return false; // Ningún talle coincide
  } catch (error) {
    console.error('Error en checkProductHasSizes:', error);
    return false;
  }
}

// Limpiar filtro de talles
function clearSizeFilter() {
  selectedSizes = [];
  sizeFilterActive = false;
  tempCategoryForSizeFilter = null;
  
  // Mostrar todos los productos y remover marca de filtro
  const cards = document.querySelectorAll('.card.producto');
  cards.forEach(card => {
    card.style.display = '';
    card.removeAttribute('data-filtered-by-size');
  });
  
  // Si hay búsqueda activa, re-aplicarla
  if (hasActiveSearch()) {
    const searchInput = document.getElementById("searchInput") || document.getElementById("search-bar-mobile");
    if (searchInput && typeof window.performSearch === 'function') {
      window.performSearch(searchInput.value.trim().toLowerCase());
    }
  }
  
  // Remover mensaje de no resultados
  const noResultsMsg = document.querySelector('.no-results-size-filter');
  if (noResultsMsg) {
    noResultsMsg.remove();
  }
  
  // Restaurar estilo de ambos botones (mobile + desktop)
  updateSizeFilterButtonsUI();
  if (typeof window !== "undefined") {
    window.__fylActiveSizeFilters = [];
  }
  if (typeof window.refreshCatalogFilterBar === "function") {
    window.refreshCatalogFilterBar();
  }
}

async function reapplyActiveSizeFilter() {
  if (!sizeFilterActive || selectedSizes.length === 0) return;
  await applySizeFilter();
}

// Inicializar event listeners
function initSizeFilter() {
  const modal = document.getElementById('size-filter-modal');
  const closeBtn = document.getElementById('size-filter-close');
  const overlay = modal?.querySelector('.size-filter-overlay');
  const applyBtn = document.getElementById('size-filter-apply');
  const clearBtn = document.getElementById('size-filter-clear');
  
  if (closeBtn) {
    closeBtn.addEventListener('click', closeSizeFilterModal);
  }
  
  if (overlay) {
    overlay.addEventListener('click', closeSizeFilterModal);
  }
  
  if (applyBtn) {
    applyBtn.addEventListener('click', applySizeFilter);
  }
  
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      selectedSizes = [];
      document
        .querySelectorAll("#size-filter-body .size-option.is-selected")
        .forEach((b) => b.classList.remove("is-selected"));
      updateSizeFilterFooter();
    });
  }

  if (modal && !modal.dataset.fylSizeDelegate) {
    modal.dataset.fylSizeDelegate = "1";
    modal.addEventListener("click", handleSizeFilterModalClick);
  }
  
  // Cerrar con ESC
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal?.classList.contains('active')) {
      closeSizeFilterModal();
    }
  });
}

// Función para hookear cambiarCategoria
function hookCambiarCategoria() {
  // Esperar a que cambiarCategoria esté disponible
  let attempts = 0;
  const maxAttempts = 10;
  const checkInterval = setInterval(() => {
    attempts++;
    if (typeof window.cambiarCategoria !== 'undefined' || attempts >= maxAttempts) {
      clearInterval(checkInterval);
      if (typeof window.cambiarCategoria !== 'undefined') {
        const originalCambiarCategoria = window.cambiarCategoria;
        window.cambiarCategoria = function(cat) {
          currentCategory = cat;
          // Si hay filtro de talles activo, limpiarlo al cambiar categoría
          if (sizeFilterActive) {
            clearSizeFilter();
          }
          // Cerrar modal si está abierto
          closeSizeFilterModal();
          return originalCambiarCategoria.apply(this, arguments);
        };
        fylDevLog("✅ Hook de cambiarCategoria configurado");
      }
    }
  }, 100);
}

/** Aplicar filtro de talle desde URL (ej. "Ver similares" desde dashboard). No abre el modal. */
async function applySizeFilterFromURL(talle) {
  const normalized = normalizeSize(talle) || String(talle || '').trim();
  if (!normalized) return;
  selectedSizes = [normalized];
  // No usar categoría: los productos ya están filtrados por tag (ej. Bota). Si usáramos
  // getCurrentCategory() podría devolver el tag y checkProductHasSizes excluiría todos
  // porque product.category es "Calzado"/"Otros", no el tag.
  tempCategoryForSizeFilter = null;
  await applySizeFilter();
}

// Exportar funciones globales inmediatamente
if (typeof window !== 'undefined') {
  window.__fylActiveSizeFilters = Array.isArray(window.__fylActiveSizeFilters)
    ? window.__fylActiveSizeFilters
    : [];
  window.openSizeFilterModal = openSizeFilterModal;
  window.clearSizeFilter = clearSizeFilter;
  window.applySizeFilterFromURL = applySizeFilterFromURL;
  window.reapplyActiveSizeFilter = reapplyActiveSizeFilter;
  window.updateSizeFilterButtonsUI = updateSizeFilterButtonsUI;
  fylDevLog("✅ Funciones de size-filter exportadas globalmente");
}

// Actualizar categoría cuando cambia
// Esto se ejecutará después de que main-supabase.js se cargue
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    initSizeFilter();
    hookCambiarCategoria();
    updateSizeFilterButtonsUI();
  });
} else {
  initSizeFilter();
  updateSizeFilterButtonsUI();
  // Ya cargado, ejecutar después de un breve delay
  setTimeout(hookCambiarCategoria, 500);
}