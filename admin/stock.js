// admin/stock.js
import { requireAuth } from "./admin-auth.js";
import { supabase } from "../scripts/supabase-client.js";
import { checkPermission, requirePermission } from "./permissions-helper.js";
import { normalizeSize } from "../scripts/utils/size-normalizer.js";
import { printProductLabelsZebra } from "./qz-printing.js";

await requireAuth();

// Verificar permisos de stock
let canViewStock = false;
let canEditStock = false;
let canDeleteStock = false;

async function checkStockPermissions() {
  canViewStock = await checkPermission('stock', 'view');
  canEditStock = await checkPermission('stock', 'edit');
  canDeleteStock = await checkPermission('stock', 'delete');
  
  if (!canViewStock) {
    alert("No tienes permiso para ver el stock.");
    window.location.href = "./index.html";
    return;
  }
  
  // Ocultar/mostrar elementos según permisos
  if (!canEditStock) {
    // Ocultar botones de guardar y editar
    const saveAllBtn = document.getElementById("save-all");
    const discardAllBtn = document.getElementById("discard-all");
    if (saveAllBtn) saveAllBtn.style.display = "none";
    if (discardAllBtn) discardAllBtn.style.display = "none";
    
    // Hacer inputs de solo lectura (esto se aplicará después del render)
    // La función applyPermissions se llamará después de cada render
  }
}

// Aplicar permisos a los inputs después del render
function applyPermissions() {
  if (!canEditStock) {
    // Aplicar a tabla (si existe)
    document.querySelectorAll("#tbl input[type='number'][data-field='stock_general']").forEach(input => {
      input.disabled = true;
      input.style.backgroundColor = "#f5f5f5";
    });
    document.querySelectorAll("#tbl input[type='number'][data-field='stock_venta_publico']").forEach(input => {
      input.disabled = true;
      input.style.backgroundColor = "#f5f5f5";
    });
    document.querySelectorAll("#tbl input[type='number'][data-field='price']").forEach(input => {
      input.disabled = true;
      input.style.backgroundColor = "#f5f5f5";
    });
    document.querySelectorAll("#tbl input[type='checkbox']").forEach(input => {
      input.disabled = true;
    });
    document.querySelectorAll("#tbl button[data-save]").forEach(btn => {
      btn.disabled = true;
    });
    
    // Aplicar a tarjetas
    document.querySelectorAll(".sizes-table input[type='number']").forEach(input => {
      input.disabled = true;
      input.style.backgroundColor = "#f5f5f5";
    });
    document.querySelectorAll(".sizes-table input[type='checkbox']").forEach(input => {
      input.disabled = true;
    });
    document.querySelectorAll(".sizes-table button[data-save]").forEach(btn => {
      btn.disabled = true;
    });
  }
}

await checkStockPermissions();

const tbody = document.querySelector("#tbl tbody");
const productsContainer = document.getElementById("products-container");
const noResults = document.getElementById("no-results");
const tbl = document.getElementById("tbl");

// Ocultar tabla por defecto, mostrar contenedor de productos
if (tbl) tbl.style.display = "none";
if (productsContainer) productsContainer.style.display = "grid";

if (!tbody && !productsContainer) {
  console.error("No se encontró el elemento #tbl tbody o #products-container en el DOM");
  document.body.innerHTML = "<div style='padding:20px;color:red;'>Error: No se encontró el contenedor de stock. Por favor, recarga la página.</div>";
  throw new Error("Elemento #tbl tbody o #products-container no encontrado");
}
const q = document.getElementById("q");
const reloadBtn = document.getElementById("reload");
const msg = document.getElementById("msg");
const fCategory = document.getElementById("f-category");
const fColor = document.getElementById("f-color");
const fSize = document.getElementById("f-size");
const fActive = document.getElementById("f-active");
const fLow = document.getElementById("f-low");
const saveAllBtn = document.getElementById("save-all");
const discardAllBtn = document.getElementById("discard-all");
const pendingCount = document.getElementById("pending-count");
const lowAlertBtn = document.getElementById("low-alert");
const lowAlertCount = document.getElementById("low-alert-count");
const overlay = document.getElementById("overlay");
const closeOverlay = document.getElementById("close-overlay");
const lowListTbody = document.getElementById("low-list");
const lowSummary = document.getElementById("low-summary");
const oldBtn = document.getElementById("old-products");
const overlayOld = document.getElementById("overlay-old");
const closeOverlayOld = document.getElementById("close-overlay-old");
const oldListTbody = document.getElementById("old-list");
const oldSummary = document.getElementById("old-summary");
const oldCheckAll = document.getElementById("old-check-all");
const archiveSelectedBtn = document.getElementById("archive-selected");
const incompleteAlert = document.getElementById("incomplete-alert");
const incompleteCount = document.getElementById("incomplete-count");
const productNamesDatalist = document.getElementById("product-names");

let allData = [];
const pendingChanges = new Map(); // id -> { stock_general, stock_venta_publico, price, active }

// Cargar nombres de productos para autocompletado
async function loadProductNames() {
  if (!productNamesDatalist) return;
  
  try {
    // Obtener todos los nombres de productos únicos (excluyendo archivados)
    const { data: products, error } = await supabase
      .from("products")
      .select("name")
      .neq("status", "archived")
      .not("name", "is", null)
      .order("name", { ascending: true });
    
    if (error) {
      console.error("Error cargando nombres de productos:", error);
      return;
    }
    
    // Limpiar datalist existente
    productNamesDatalist.innerHTML = "";
    
    // Obtener nombres únicos
    const uniqueNames = [...new Set((products || []).map(p => p.name).filter(Boolean))];
    
    // Agregar opciones al datalist
    uniqueNames.forEach(name => {
      const option = document.createElement("option");
      option.value = name;
      productNamesDatalist.appendChild(option);
    });
    
    console.log(`✅ ${uniqueNames.length} nombres de productos cargados para autocompletado`);
  } catch (err) {
    console.error("Error en loadProductNames:", err);
  }
}

// Cargar contador de productos incompletos (pending_stock con stock 0)
async function loadIncompleteCount() {
  if (!incompleteAlert || !incompleteCount) {
    console.warn("Elementos de alerta incompleta no encontrados");
    return;
  }
  
  // Obtener productos con status pending_stock
  const { data: products, error: productsError } = await supabase
    .from("products")
    .select("id")
    .eq("status", "pending_stock");
  
  if (productsError) {
    console.error("Error cargando productos pending_stock:", productsError);
    return;
  }
  
  if (!products || products.length === 0) {
    incompleteCount.textContent = "0";
    incompleteAlert.style.display = "none";
    return;
  }
  
  // Obtener IDs de almacenes
  const { data: warehouses, error: warehousesError } = await supabase
    .from("warehouses")
    .select("id, code")
    .in("code", ["general", "venta-publico"]);
  
  if (warehousesError) {
    console.error("Error cargando almacenes:", warehousesError);
    return;
  }
  
  const warehouseMap = new Map();
  warehouses.forEach(w => warehouseMap.set(w.code, w.id));
  const generalWarehouseId = warehouseMap.get("general");
  const ventaPublicoWarehouseId = warehouseMap.get("venta-publico");
  
  if (!generalWarehouseId || !ventaPublicoWarehouseId) {
    console.error("No se encontraron los almacenes necesarios");
    return;
  }
  
  // Obtener todas las variantes de estos productos
  const productIds = products.map(p => p.id);
  const { data: variants, error: variantsError } = await supabase
    .from("product_variants")
    .select("id, product_id")
    .in("product_id", productIds);
  
  if (variantsError) {
    console.error("Error cargando variantes:", variantsError);
    return;
  }
  
  if (!variants || variants.length === 0) {
    // Si no hay variantes, todos los productos tienen stock 0
    incompleteCount.textContent = String(products.length);
    incompleteAlert.style.display = products.length > 0 ? "block" : "none";
    return;
  }
  
  // Obtener stocks de todas las variantes
  // Dividir en lotes para evitar error 400 con arrays grandes
  const variantIds = variants.map(v => v.id);
  const batchSize = 100;
  const totalBatches = Math.ceil(variantIds.length / batchSize);
  let allStocks = [];
  
  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
    const startIndex = batchIndex * batchSize;
    const endIndex = Math.min(startIndex + batchSize, variantIds.length);
    const batchVariantIds = variantIds.slice(startIndex, endIndex);
    
    if (batchVariantIds.length === 0) continue;
    
    const { data: stocks, error: stocksError } = await supabase
      .from("variant_warehouse_stock")
      .select("variant_id, warehouse_id, stock_qty")
      .in("variant_id", batchVariantIds)
      .in("warehouse_id", [generalWarehouseId, ventaPublicoWarehouseId]);
    
    if (stocksError) {
      console.error(`Error cargando stocks (lote ${batchIndex + 1}/${totalBatches}):`, stocksError);
      return;
    }
    
    if (stocks && stocks.length > 0) {
      allStocks.push(...stocks);
    }
  }
  
  // Crear mapa de stocks por variante y almacén
  const stockMap = new Map();
  allStocks.forEach(s => {
    const key = `${s.variant_id}_${s.warehouse_id}`;
    stockMap.set(key, s.stock_qty || 0);
  });
  
  // Calcular stock total por producto
  const productStockMap = new Map();
  variants.forEach(v => {
    const stockGeneralKey = `${v.id}_${generalWarehouseId}`;
    const stockVentaPublicoKey = `${v.id}_${ventaPublicoWarehouseId}`;
    const stockGeneral = stockMap.get(stockGeneralKey) || 0;
    const stockVentaPublico = stockMap.get(stockVentaPublicoKey) || 0;
    const stockTotal = stockGeneral + stockVentaPublico;
    
    const currentTotal = productStockMap.get(v.product_id) || 0;
    productStockMap.set(v.product_id, currentTotal + stockTotal);
  });
  
  // Contar productos con stock total = 0
  let count = 0;
  productIds.forEach(productId => {
    const totalStock = productStockMap.get(productId) || 0;
    if (totalStock === 0) {
      count++;
    }
  });
  
  incompleteCount.textContent = String(count);
  
  if (count > 0) {
    incompleteAlert.style.display = "block";
  } else {
    incompleteAlert.style.display = "none";
  }
}

function setPendingCount() {
  pendingCount.textContent = String(pendingChanges.size);
  saveAllBtn.disabled = pendingChanges.size === 0;
  discardAllBtn.disabled = pendingChanges.size === 0;
}

function computeLowStockGroups(threshold = 12) {
  // Agrupar por producto+color y sumar stock_total, considerando cambios pendientes si existen
  const map = new Map(); // key -> { productId, name, category, color, total, variants }
  for (const r of allData) {
    const key = `${r.products?.id ?? "?"}__${r.color ?? ""}`;
    const change = pendingChanges.get(r.id);
    // Calcular stock total considerando cambios pendientes
    let stock_total;
    if (change) {
      const stock_general = change.stock_general !== undefined ? change.stock_general : r.stock_general;
      const stock_venta_publico = change.stock_venta_publico !== undefined ? change.stock_venta_publico : r.stock_venta_publico;
      stock_total = (stock_general || 0) + (stock_venta_publico || 0);
    } else {
      stock_total = r.stock_total || 0;
    }
    const qty = Number(stock_total);
    const entry =
      map.get(key) ||
      {
        productId: r.products?.id,
        name: r.products?.name,
        category: r.products?.category,
        color: r.color,
        total: 0,
        variants: [],
      };
    entry.total += qty;
    entry.variants.push({ id: r.id, size: r.size, qty });
    map.set(key, entry);
  }
  return Array.from(map.values()).filter((g) => g.total < threshold);
}

function updateLowAlertBadge() {
  const groups = computeLowStockGroups();
  lowAlertCount.textContent = String(groups.length);
  lowAlertBtn.disabled = groups.length === 0;
}

// Función normalizeSize importada desde scripts/utils/size-normalizer.js (centralizada)

async function load() {
  msg.textContent = "Cargando...";
  tbody.innerHTML = "";
  allData = []; // Limpiar al inicio para que, si hay return anticipado, no queden datos viejos
  // Reiniciar pendientes en cada carga/recarga
  pendingChanges.clear();
  setPendingCount();
  
  // Obtener variantes (sin size, ya que los talles están en variant_sizes)
  const { data: variants, error: variantsError } = await supabase
    .from("product_variants")
    .select("id, sku, color, price, active, products(id, name, category, status, created_at, handle)")
    .order("sku", { ascending: true });
  
  if (variantsError) {
    msg.textContent = variantsError.message;
    console.error("Error cargando variantes:", variantsError);
    return false;
  }
  
  console.log(`📦 Total variantes cargadas: ${(variants || []).length}`);
  
  // Filtrar productos: mostrar todos excepto archivados
  const validVariants = (variants || []).filter((r) => {
    const status = r.products?.status;
    const isValid = status && status !== "archived";
    if (!isValid && r.products) {
      console.log(`⚠️ Variante excluida - Producto status: ${status} (archivado)`, r.products.name);
    }
    return isValid;
  });
  
  console.log(`✅ Variantes válidas (excluyendo archivados): ${validVariants.length}`);
  
  // Obtener IDs de almacenes
  const { data: warehouses, error: warehousesError } = await supabase
    .from("warehouses")
    .select("id, code")
    .in("code", ["general", "venta-publico"]);
  
  if (warehousesError) {
    msg.textContent = `Error cargando almacenes: ${warehousesError.message}`;
    console.error("Error cargando almacenes:", warehousesError);
    return false;
  }
  
  const warehouseMap = new Map();
  warehouses.forEach(w => warehouseMap.set(w.code, w.id));
  const generalWarehouseId = warehouseMap.get("general");
  const ventaPublicoWarehouseId = warehouseMap.get("venta-publico");
  
  if (!generalWarehouseId || !ventaPublicoWarehouseId) {
    msg.textContent = "Error: No se encontraron los almacenes necesarios";
    console.error("Almacenes no encontrados:", { generalWarehouseId, ventaPublicoWarehouseId });
    return false;
  }
  
  // Obtener talles desde variant_sizes con paginación (para manejar más de 1000 registros)
  const variantIds = validVariants.map(v => v.id);
  // Log reducido: no mostrar el array completo de variantIds (muy verboso)
  console.log(`🔧 Buscando talles para ${variantIds.length} variantes`);
  
  let allSizesData = [];
  const batchSize = 100; // Dividir en lotes de 100 para evitar error 400 con arrays grandes
  const totalBatches = Math.ceil(variantIds.length / batchSize);
  
  // Procesar en lotes para evitar error 400 con arrays grandes
  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
    const startIndex = batchIndex * batchSize;
    const endIndex = Math.min(startIndex + batchSize, variantIds.length);
    const batchVariantIds = variantIds.slice(startIndex, endIndex);
    
    if (batchVariantIds.length === 0) continue;
    
    let offset = 0;
    const pageSize = 1000;
    let hasMore = true;
    
    while (hasMore) {
      const { data: sizesData, error: sizesError } = await supabase
        .from("variant_sizes")
        .select("variant_id, size, stock_qty, sku, qr_code")
        .in("variant_id", batchVariantIds)
        .order("size")
        .range(offset, offset + pageSize - 1);
      
      if (sizesError) {
        console.error(`❌ Error cargando talles (lote ${batchIndex + 1}/${totalBatches}):`, sizesError);
        msg.textContent = `Error cargando talles: ${sizesError.message}`;
        break;
      }
      
      if (sizesData && sizesData.length > 0) {
        allSizesData.push(...sizesData);
        offset += pageSize;
        hasMore = sizesData.length === pageSize; // Si hay menos de pageSize, no hay más
      } else {
        hasMore = false;
      }
    }
  }
  
  const sizesData = allSizesData;
  if (sizesData.length > 0) {
    console.log(`✅ Total talles cargados: ${sizesData.length} (en ${totalBatches} lote${totalBatches > 1 ? 's' : ''})`);
  }
  
  // Agrupar talles por variant_id
  // IMPORTANTE: Incluir TODOS los talles desde variant_sizes, incluso con stock 0
  const sizesByVariant = new Map();
  if (sizesData && sizesData.length > 0) {
    sizesData.forEach(sizeRow => {
      if (!sizeRow.variant_id) {
        console.warn("⚠️ Talle sin variant_id:", sizeRow);
        return;
      }
      if (!sizesByVariant.has(sizeRow.variant_id)) {
        sizesByVariant.set(sizeRow.variant_id, []);
      }
      // Normalizar el tamaño usando la función definida al inicio de load()
      // IMPORTANTE: Incluir talles incluso si stock_qty es 0
      const sizeValue = normalizeSize(sizeRow.size);
      if (sizeValue) {
        sizesByVariant.get(sizeRow.variant_id).push({
          size: sizeValue,
          stock_qty: sizeRow.stock_qty || 0, // Incluir incluso si es 0
          sku: sizeRow.sku || null,
          qr_code: sizeRow.qr_code || null,
        });
      }
    });
  } else {
    console.warn("⚠️ No se encontraron talles en variant_sizes para las variantes");
  }
  
  // Log reducido: solo mostrar resumen
  if (sizesData && sizesData.length > 0) {
    console.log(`📏 ${sizesData.length} talles cargados para ${sizesByVariant.size} variantes`);
  }
  
  // Obtener stocks por almacén (stock total por variante desde variant_warehouse_stock)
  // Dividir en lotes para evitar error 400 con arrays grandes
  let allStocks = [];
  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
    const startIndex = batchIndex * batchSize;
    const endIndex = Math.min(startIndex + batchSize, variantIds.length);
    const batchVariantIds = variantIds.slice(startIndex, endIndex);
    
    if (batchVariantIds.length === 0) continue;
    
    const { data: stocks, error: stocksError } = await supabase
      .from("variant_warehouse_stock")
      .select("variant_id, warehouse_id, stock_qty")
      .in("variant_id", batchVariantIds)
      .in("warehouse_id", [generalWarehouseId, ventaPublicoWarehouseId]);
    
    if (stocksError) {
      console.error(`❌ Error cargando stocks (lote ${batchIndex + 1}/${totalBatches}):`, stocksError);
      msg.textContent = `Error cargando stocks: ${stocksError.message}`;
      return false;
    }
    
    if (stocks && stocks.length > 0) {
      allStocks.push(...stocks);
    }
  }
  
  const stocks = allStocks;
  
  // Crear mapa de stocks por variante y almacén
  const stockMap = new Map();
  (stocks || []).forEach(s => {
    const key = `${s.variant_id}_${s.warehouse_id}`;
    stockMap.set(key, s.stock_qty || 0);
  });
  
  // Obtener TODOS los stocks por talle y warehouse con paginación (para manejar más de 1000 registros)
  // Dividir en lotes para evitar error 400 con arrays grandes
  let allSizeWarehouseStocks = [];
  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
    const startIndex = batchIndex * batchSize;
    const endIndex = Math.min(startIndex + batchSize, variantIds.length);
    const batchVariantIds = variantIds.slice(startIndex, endIndex);
    
    if (batchVariantIds.length === 0) continue;
    
    let stockOffset = 0;
    const stockPageSize = 1000;
    let hasMoreStocks = true;
    
    while (hasMoreStocks) {
      const { data: sizeWarehouseStocks, error: allSizeWarehouseError } = await supabase
        .from("variant_size_warehouse_stock")
        .select("variant_id, size, warehouse_id, stock_qty")
        .in("variant_id", batchVariantIds)
        .in("warehouse_id", [generalWarehouseId, ventaPublicoWarehouseId])
        .range(stockOffset, stockOffset + stockPageSize - 1);
      
      if (allSizeWarehouseError) {
        console.warn(`⚠️ Error cargando stock por talle y warehouse (lote ${batchIndex + 1}/${totalBatches}):`, allSizeWarehouseError);
        break;
      }
      
      if (sizeWarehouseStocks && sizeWarehouseStocks.length > 0) {
        allSizeWarehouseStocks.push(...sizeWarehouseStocks);
        stockOffset += stockPageSize;
        hasMoreStocks = sizeWarehouseStocks.length === stockPageSize;
      } else {
        hasMoreStocks = false;
      }
    }
  }
  
  if (allSizeWarehouseStocks.length > 0) {
    console.log(`✅ Total stocks por talle/warehouse cargados: ${allSizeWarehouseStocks.length} (en ${totalBatches} lote${totalBatches > 1 ? 's' : ''})`);
  }
  
  // Crear mapa global de stock por variante, talle y warehouse
  // key: `${variant_id}_${size}_${warehouse_id}` -> stock_qty
  // IMPORTANTE: Usar la misma función normalizeSize definida al inicio para asegurar consistencia
  const globalSizeWarehouseMap = new Map();
  if (allSizeWarehouseStocks && allSizeWarehouseStocks.length > 0) {
    allSizeWarehouseStocks.forEach(sws => {
      const sizeNormalized = normalizeSize(sws.size);
      if (sizeNormalized) {
        const key = `${sws.variant_id}_${sizeNormalized}_${sws.warehouse_id}`;
        globalSizeWarehouseMap.set(key, sws.stock_qty || 0);
      }
    });
  }
  
  // Crear filas: una por cada talle de cada variante
  // IMPORTANTE: Incluir TODOS los talles desde variant_sizes, incluso si tienen stock 0
  allData = [];
  for (const v of validVariants) {
    const sizes = sizesByVariant.get(v.id) || [];
    
    if (sizes && sizes.length > 0) {
      // Crear una fila por cada talle (TODOS, incluso con stock 0)
      sizes.forEach(sizeData => {
        // Normalizar el size usando la función definida al inicio de load()
        // IMPORTANTE: Usar la misma normalización que se usó para crear el mapa global
        const sizeNormalized = normalizeSize(sizeData.size);
        
        // Si el size está vacío después de normalizar, saltar este registro
        if (!sizeNormalized) {
          console.warn(`⚠️ Variante ${v.id} (${v.color}): Saltando talle con size vacío:`, sizeData);
          return;
        }
        
        // Obtener stock por warehouse desde el mapa global usando la misma normalización
        const generalKey = `${v.id}_${sizeNormalized}_${generalWarehouseId}`;
        const ventaPublicoKey = `${v.id}_${sizeNormalized}_${ventaPublicoWarehouseId}`;
        let stock_general = globalSizeWarehouseMap.get(generalKey) || 0;
        let stock_venta_publico = globalSizeWarehouseMap.get(ventaPublicoKey) || 0;
        
        // Si no hay stock en variant_size_warehouse_stock, usar stock_qty de variant_sizes como fallback
        // IMPORTANTE: Incluir talles incluso con stock 0 - solo usar fallback si stock_qty > 0
        if (stock_general === 0 && stock_venta_publico === 0 && sizeData.stock_qty > 0) {
          // Si hay stock en variant_sizes pero no en variant_size_warehouse_stock,
          // poner todo en general como fallback
          stock_general = sizeData.stock_qty || 0;
        }
        // Si stock_general === 0 && stock_venta_publico === 0 && stock_qty === 0,
        // mantener stock en 0 pero INCLUIR el talle igual (esto es correcto)
        
        const stock_total = stock_general + stock_venta_publico;
        
        const rowData = {
          ...v,
          size: sizeNormalized, // Talle normalizado desde variant_sizes
          sku: sizeData.sku || v.sku, // SKU completo con talle si existe
          qr_code: sizeData.qr_code || null, // QR code del talle si existe
          stock_general, // Stock del talle en warehouse general (puede ser 0)
          stock_venta_publico, // Stock del talle en warehouse venta público (puede ser 0)
          stock_total, // Stock total (puede ser 0)
          rowId: `${v.id}_${sizeNormalized}` // ID único para esta combinación variante+talle
        };
        
        allData.push(rowData);
      });
    } else {
      console.log(`⚠️ Variante ${v.id} (${v.color}): Sin talles en variant_sizes`);
      // Si no tiene talles, agregar la variante sin size (modo legacy)
      const stockGeneralKey = `${v.id}_${generalWarehouseId}`;
      const stockVentaPublicoKey = `${v.id}_${ventaPublicoWarehouseId}`;
      const stock_general = stockMap.get(stockGeneralKey) || 0;
      const stock_venta_publico = stockMap.get(stockVentaPublicoKey) || 0;
      const stock_total = stock_general + stock_venta_publico;
      
      allData.push({
        ...v,
        size: null, // Sin talle
        stock_general,
        stock_venta_publico,
        stock_total
      });
    }
  }
  
  // Log resumido
  console.log(`📊 ${allData.length} filas creadas (${validVariants.length} variantes)`);
  
  populateFilters(allData);
  render();
  if (allData.length > 0) {
    msg.textContent = `${allData.length} variantes cargadas.`;
  } else {
    msg.textContent = `Usa el buscador o filtros para ver productos.`;
  }
  updateLowAlertBadge();
  await loadIncompleteCount();
  return true;
}

function populateFilters(rows) {
  // Rellenar selects con opciones únicas
  const setFrom = (arr, getter) =>
    Array.from(new Set(arr.map(getter).filter(Boolean))).sort((a, b) =>
      String(a).localeCompare(String(b), "es")
    );
  const categories = setFrom(rows, (r) => r.products?.category);
  const colors = setFrom(rows, (r) => r.color);
  const sizes = setFrom(rows, (r) => r.size);

  function fillSelect(select, values) {
    const current = select.value;
    const base = select.querySelector("option[value='']")?.outerHTML || "<option value=''></option>";
    select.innerHTML = base + values.map((v) => `<option value="${String(v)}">${String(v)}</option>`).join("");
    // Restaurar selección si existe
    if ([...select.options].some((o) => o.value === current)) {
      select.value = current;
    }
  }
  fillSelect(fCategory, categories);
  fillSelect(fColor, colors);
  fillSelect(fSize, sizes);
}

function applyFilters(rows) {
  const term = (q.value || "").toLowerCase().trim();
  const cat = fCategory.value || "";
  const color = fColor.value || "";
  const size = fSize.value || "";
  const active = fActive.value;
  const onlyLow = fLow.checked;
  
  // Si no hay ningún filtro activo, no mostrar nada
  const hasAnyFilter = term || cat || color || size || active || onlyLow;
  if (!hasAnyFilter) {
    return [];
  }
  
  // IMPORTANTE: Incluir TODOS los talles, incluso con stock 0
  // El filtro solo debe excluir filas que no coincidan con los criterios de búsqueda,
  // NO debe excluir filas por tener stock 0 (excepto cuando se activa el filtro "Solo bajo stock")
  return rows.filter((r) => {
    // Filtro por término de búsqueda (solo nombre de producto)
    if (term) {
      const productName = r.products?.name;
      if (!productName || !String(productName).toLowerCase().includes(term)) {
        return false;
      }
    }
    // Filtro por categoría
    if (cat && r.products?.category !== cat) return false;
    // Filtro por color
    if (color && r.color !== color) return false;
    // Filtro por talle específico
    if (size && String(r.size) !== String(size)) return false;
    // Filtro por estado activo
    if (active === "true" && !r.active) return false;
    if (active === "false" && r.active) return false;
    // Filtro "Solo bajo stock" - solo excluir si stock > 3
    // NOTA: Este filtro NO excluye talles con stock 0, solo excluye talles con stock > 3
    if (onlyLow) {
      // Calcular stock total considerando cambios pendientes
      const change = pendingChanges.get(r.rowId || `${r.id}_${r.size || 'null'}`);
      let stock_total;
      if (change) {
        const stock_general = change.stock_general !== undefined ? change.stock_general : r.stock_general;
        const stock_venta_publico = change.stock_venta_publico !== undefined ? change.stock_venta_publico : r.stock_venta_publico;
        stock_total = (stock_general || 0) + (stock_venta_publico || 0);
      } else {
        stock_total = r.stock_total || 0;
      }
      // Solo excluir si stock > 3 (incluye talles con stock 0, 1, 2, 3)
      if (Number(stock_total) > 3) return false;
    }
    return true;
  });
}

// Agrupar datos por producto
function groupByProduct(rows) {
  const productsMap = new Map();
  
  rows.forEach(r => {
    const productId = r.products?.id;
    if (!productId) return;
    
    if (!productsMap.has(productId)) {
      productsMap.set(productId, {
        product: r.products,
        variants: new Map(), // key: variantId
        totalStock: 0,
        totalStockGeneral: 0,
        totalStockVentaPublico: 0,
        colors: new Set(),
        price: r.price || 0
      });
    }
    
    const productData = productsMap.get(productId);
    const variantId = r.id;
    
    if (!productData.variants.has(variantId)) {
      productData.variants.set(variantId, {
        variant: r,
        sizes: [] // Array de talles
      });
      productData.colors.add(r.color || 'Sin color');
    }
    
    const variantData = productData.variants.get(variantId);
    const pending = pendingChanges.get(r.rowId || `${r.id}_${r.size || 'null'}`);
    
    const stock_general = pending?.stock_general !== undefined ? pending.stock_general : (r.stock_general || 0);
    const stock_venta_publico = pending?.stock_venta_publico !== undefined ? pending.stock_venta_publico : (r.stock_venta_publico || 0);
    const stock_total = stock_general + stock_venta_publico;
    
    // VERIFICAR SI EL TALLE YA EXISTE (evitar duplicados)
    // IMPORTANTE: Usar la misma función normalizeSize definida al inicio de load()
    // Asegurar que el tamaño se normalice de la misma manera que en allData
    const sizeNormalized = normalizeSize(r.size) || "null";
    const sizeKey = `${variantId}_${sizeNormalized}`;
    
    const existingSizeIndex = variantData.sizes.findIndex(s => {
      const sSizeNormalized = normalizeSize(s.size) || "null";
      const sKey = `${variantId}_${sSizeNormalized}`;
      return sKey === sizeKey;
    });
    
    if (existingSizeIndex >= 0) {
      // Talle ya existe - actualizar en lugar de agregar duplicado
      const oldSize = variantData.sizes[existingSizeIndex];
      
      // RESTAR los valores anteriores antes de actualizar
      productData.totalStock -= oldSize.stock_total || 0;
      productData.totalStockGeneral -= oldSize.stock_general || 0;
      productData.totalStockVentaPublico -= oldSize.stock_venta_publico || 0;
      
      // Actualizar el existente
      variantData.sizes[existingSizeIndex] = {
        ...r,
        size: sizeNormalized, // Asegurar que el size normalizado se guarde
        stock_general,
        stock_venta_publico,
        stock_total,
        pending
      };
      
      // SUMAR los nuevos valores después de actualizar
      productData.totalStock += stock_total;
      productData.totalStockGeneral += stock_general;
      productData.totalStockVentaPublico += stock_venta_publico;
    } else {
      // Talle no existe - agregar nuevo
      variantData.sizes.push({
        ...r,
        size: sizeNormalized, // Asegurar que el size normalizado se guarde
        stock_general,
        stock_venta_publico,
        stock_total,
        pending
      });
      
      // SUMAR los nuevos valores
      productData.totalStock += stock_total;
      productData.totalStockGeneral += stock_general;
      productData.totalStockVentaPublico += stock_venta_publico;
    }
  });
  
  // Convertir el mapa a array antes de procesar
  const result = Array.from(productsMap.values());
  
  // Ordenar talles por tamaño después de agrupar (para mostrar en orden)
  result.forEach(productData => {
    productData.variants.forEach((variantData, variantId) => {
      // Ordenar talles numéricamente cuando sea posible, o alfabéticamente
      variantData.sizes.sort((a, b) => {
        const aSize = String(a.size || "").trim();
        const bSize = String(b.size || "").trim();
        const aNum = Number(aSize);
        const bNum = Number(bSize);
        
        // Si ambos son números, ordenar numéricamente
        if (!isNaN(aNum) && !isNaN(bNum) && isFinite(aNum) && isFinite(bNum)) {
          return aNum - bNum;
        }
        
        // Si solo uno es número, el número va primero
        if (!isNaN(aNum) && isFinite(aNum)) return -1;
        if (!isNaN(bNum) && isFinite(bNum)) return 1;
        
        // Ambos son strings, ordenar alfabéticamente
        return aSize.localeCompare(bSize, "es", { numeric: true, sensitivity: "base" });
      });
    });
  });
  
  return result;
}

function render() {
  if (tbody) tbody.innerHTML = "";
  if (!productsContainer) return;
  
  productsContainer.innerHTML = "";
  const rows = applyFilters(allData);
  
  // Verificar si hay filtros activos
  const term = (q.value || "").toLowerCase().trim();
  const cat = fCategory.value || "";
  const color = fColor.value || "";
  const size = fSize.value || "";
  const active = fActive.value;
  const onlyLow = fLow.checked;
  const hasAnyFilter = term || cat || color || size || active || onlyLow;
  
  if (rows.length === 0) {
    if (noResults) {
      noResults.style.display = "block";
      if (hasAnyFilter) {
        noResults.innerHTML = "<p>No se encontraron productos con los filtros aplicados.</p>";
      } else {
        noResults.innerHTML = "<p>Ingresa un término de búsqueda o aplica un filtro para ver los productos.</p>";
      }
    }
    return;
  }
  
  if (noResults) noResults.style.display = "none";
  
  const products = groupByProduct(rows);
  
  products.forEach(productData => {
    const card = document.createElement("div");
    card.className = "product-card";
    card.dataset.productId = productData.product.id;
    
    const colorsList = Array.from(productData.colors).join(", ");
    const lowStock = productData.totalStock <= 3;
    if (lowStock) card.classList.add("low-stock");
    
    card.innerHTML = `
      <div class="product-card-header" onclick="toggleProductCard('${productData.product.id}')">
        <div class="product-card-info">
          <div class="product-card-title" style="display: flex; align-items: center; gap: 6px;">
            <span>${productData.product.name || "Sin nombre"}</span>
            <button class="stock-history-btn" onclick="event.stopPropagation(); showStockHistory('${productData.product.id}', '${productData.product.name || "Sin nombre"}')" title="Ver historial de stock" style="font-size: 12px; padding: 2px 5px; border: 1px solid #ddd; border-radius: 3px; background: #f8f8f8; cursor: pointer; line-height: 1;">
              📊
            </button>
          </div>
          <div class="product-card-meta">
            <span>Categoría: ${productData.product.category || ""}</span>
            <span style="margin-left: 10px;">Colores: ${colorsList}</span>
          </div>
        </div>
        <div style="text-align: right;">
          <div class="product-price">$${formatNumber(productData.price || 0)}</div>
        </div>
      </div>
      <div class="product-card-body">
        <div class="product-card-section">
          <div style="display: flex; justify-content: space-between; gap: 12px;">
            <div>
              <div class="product-card-section-title">Stock Total</div>
              <div style="font-size: 20px; font-weight: 600;">${productData.totalStock}</div>
            </div>
            <div>
              <div class="product-card-section-title">Depósito</div>
              <div style="font-size: 18px; font-weight: 600; color: #2c3e50;">${productData.totalStockGeneral}</div>
            </div>
            <div>
              <div class="product-card-section-title">Local</div>
              <div style="font-size: 18px; font-weight: 600; color: #2c3e50;">${productData.totalStockVentaPublico}</div>
            </div>
          </div>
        </div>
      </div>
      <div class="variants-container" id="variants-${productData.product.id}">
        ${renderVariants(productData)}
      </div>
    `;
    
    productsContainer.appendChild(card);
  });
  
  // Aplicar permisos después del render
  applyPermissions();
}

function renderVariants(productData) {
  let html = "";
  productData.variants.forEach((variantData, variantId) => {
    const variant = variantData.variant;
    const pending = pendingChanges.get(variantId);
    const active = pending?.active !== undefined ? pending.active : (variant.active ?? true);
    
    // Calcular totales de la variante
    let variantStockTotal = 0;
    let variantStockGeneral = 0;
    let variantStockVentaPublico = 0;
    
    variantData.sizes.forEach(size => {
      variantStockTotal += size.stock_total || 0;
      variantStockGeneral += size.stock_general || 0;
      variantStockVentaPublico += size.stock_venta_publico || 0;
    });
    
    html += `
      <div class="variant-card">
        <div class="variant-card-header" onclick="toggleVariantCard('${productData.product.id}', '${variantId}')">
          <div>
            <span class="variant-color">${variant.color || "Sin color"}</span>
            <button class="edit-variant-btn" onclick="event.stopPropagation(); toggleEditMode('${productData.product.id}', '${variantId}')">Editar</button>
            <span style="margin-left: 10px; font-size: 11px; color: #666;">
              Total: ${variantStockTotal} | Depósito: ${variantStockGeneral} | Local: ${variantStockVentaPublico}
            </span>
          </div>
          <span class="variant-toggle">▼</span>
        </div>
        <div class="sizes-detail" id="sizes-${productData.product.id}-${variantId}">
          <table class="sizes-table" data-editing="false">
            <thead>
              <tr>
                <th>Talle</th>
                <th>SKU</th>
                <th>Stock Total</th>
                <th>Carga</th>
                <th>Imprimir</th>
                <th>Depósito</th>
                <th>Local</th>
                <th>Precio</th>
                <th>Activa</th>
                <th>Acción</th>
              </tr>
            </thead>
            <tbody>
              ${variantData.sizes.map(size => {
                const effectivePrice = size.pending?.price !== undefined ? size.pending.price : (size.price || 0);
                const sizeActive = size.pending?.active !== undefined ? size.pending.active : (size.active ?? true);
                const priceChanged = size.pending?.price !== undefined && Number(size.pending.price) !== Number(size.price ?? 0);
                const rowId = size.rowId || `${size.id}_${size.size}`; // ID único para esta fila
                const hasChanges = pendingChanges.has(rowId);
                
                return `
                  <tr class="${hasChanges ? 'dirty-row' : ''}" data-row-id="${rowId}">
                    <td>${size.size || "N/A"}</td>
                    <td>${size.sku || ""}</td>
                    <td style="font-weight: 600; text-align: center;">${size.stock_total}</td>
                    <td>
                      <input type="number" min="0" value="" class="carga-input" 
                             data-load-input="${rowId}" placeholder="0"
                             ${!canEditStock ? 'disabled' : ''} />
                      <button class="carga-btn" data-add-load 
                              data-row-id="${rowId}" 
                              data-variant-id="${size.id}" 
                              data-size="${size.size}"
                              ${!canEditStock ? 'disabled' : ''}>+</button>
                    </td>
                    <td>
                      <button class="print-label-btn" data-print-labels
                              data-row-id="${rowId}"
                              data-product-name="${productData.product.name || ''}"
                              data-color="${variant.color || ''}"
                              data-size="${size.size || ''}"
                              data-sku="${size.sku || ''}"
                              data-qr-code="${size.qr_code || ''}"
                              ${!canEditStock ? 'disabled' : ''}>
                        Imprimir
                      </button>
                    </td>
                    <td>
                      <input type="number" min="0" value="${size.stock_general}" 
                             data-row-id="${rowId}" data-field="stock_general" 
                             readonly
                             ${!canEditStock ? 'disabled' : ''} />
                    </td>
                    <td>
                      <input type="number" min="0" value="${size.stock_venta_publico}" 
                             data-row-id="${rowId}" data-field="stock_venta_publico"
                             readonly
                             ${!canEditStock ? 'disabled' : ''} />
                    </td>
                    <td>
                      <input type="number" min="0" step="1" value="${effectivePrice}" 
                             data-row-id="${rowId}" data-field="price"
                             ${!canEditStock ? 'disabled' : ''} />
                      ${priceChanged ? `<button class="mini-btn" data-apply-price data-product-id="${productData.product.id}" data-source-id="${rowId}">Aplicar</button>` : ''}
                    </td>
                    <td style="text-align: center;">
                      <input type="checkbox" ${sizeActive ? "checked" : ""} 
                             data-row-id="${rowId}" data-field="active"
                             ${!canEditStock ? 'disabled' : ''} />
                    </td>
                    <td>
                      <button data-save="${rowId}" data-variant-id="${size.id}" data-size="${size.size}" ${!canEditStock ? 'disabled' : ''}>Guardar</button>
                    </td>
                  </tr>
                `;
              }).join("")}
            </tbody>
          </table>
        </div>
      </div>
    `;
  });
  
  return html;
}

function formatNumber(num) {
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

// Funciones globales para toggle
window.toggleProductCard = function(productId) {
  const card = document.querySelector(`[data-product-id="${productId}"]`);
  const variantsContainer = document.getElementById(`variants-${productId}`);
  if (!card || !variantsContainer) return;
  
  card.classList.toggle("expanded");
  variantsContainer.classList.toggle("expanded");
};

window.toggleVariantCard = function(productId, variantId) {
  const sizesDetail = document.getElementById(`sizes-${productId}-${variantId}`);
  if (!sizesDetail) return;
  
  sizesDetail.classList.toggle("expanded");
};

window.toggleEditMode = function(productId, variantId) {
  const table = document.querySelector(`#sizes-${productId}-${variantId} table`);
  if (!table) return;
  
  const isEditing = table.dataset.editing === 'true';
  
  // Toggle modo edición
  table.dataset.editing = isEditing ? 'false' : 'true';
  
  // Habilitar/deshabilitar inputs de stock
  const stockInputs = table.querySelectorAll('input[data-field="stock_general"], input[data-field="stock_venta_publico"]');
  stockInputs.forEach(input => {
    input.readOnly = isEditing; // Si estaba editando, volver a readonly
  });
  
  // Mostrar/ocultar columna carga
  const cargaInputs = table.querySelectorAll('.carga-input, .carga-btn');
  cargaInputs.forEach(el => {
    el.style.display = isEditing ? '' : 'none'; // Si estaba editando, mostrar carga
  });
  
  // Cambiar texto del botón
  const variantCard = table.closest('.variant-card');
  const editBtn = variantCard?.querySelector('.edit-variant-btn');
  if (editBtn) {
    editBtn.textContent = isEditing ? 'Editar' : 'Cancelar';
  }
};

function markChange(rowId, field, value) {
  // Buscar la fila usando rowId o id+size como fallback
  const base = allData.find((r) => 
    (r.rowId && String(r.rowId) === String(rowId)) || 
    String(r.id) === String(rowId)
  );
  if (!base) {
    console.warn("No se encontró fila con rowId:", rowId);
    return;
  }
  
  // Usar rowId como clave única, o id+size si no existe rowId
  const uniqueKey = base.rowId || `${base.id}_${base.size || 'null'}`;
  
  const current = pendingChanges.get(uniqueKey) || { 
    stock_general: base.stock_general, 
    stock_venta_publico: base.stock_venta_publico, 
    price: base.price, 
    active: base.active 
  };
  current[field] = value;
  
  // Calcular stock total para comparación
  const currentStockGeneral = current.stock_general !== undefined ? current.stock_general : base.stock_general;
  const currentStockVentaPublico = current.stock_venta_publico !== undefined ? current.stock_venta_publico : base.stock_venta_publico;
  
  // Si no cambió respecto al original, quitar de pending
  const same =
    Number(currentStockGeneral ?? 0) === Number(base.stock_general ?? 0) &&
    Number(currentStockVentaPublico ?? 0) === Number(base.stock_venta_publico ?? 0) &&
    Number(current.price ?? 0) === Number(base.price ?? 0) &&
    Boolean(current.active) === Boolean(base.active);
  if (same) {
    pendingChanges.delete(uniqueKey);
  } else {
    pendingChanges.set(uniqueKey, current);
  }
  setPendingCount();
  
  // Actualizar solo la fila afectada para no perder el foco
  const inputEl = (tbody || document).querySelector(`input[data-row-id="${rowId}"][data-field="${field}"]`);
  const tr = inputEl ? inputEl.closest("tr") : null;
  if (tr) {
    tr.classList.toggle("dirty-row", pendingChanges.has(uniqueKey));
    
    // Recalcular stock total y actualizar visualización
    const stockTotal = currentStockGeneral + currentStockVentaPublico;
    const stockTotalCell = tr.querySelector(".stock-total-cell");
    if (stockTotalCell) {
      stockTotalCell.textContent = stockTotal;
    }
    
    // Recalcular low-stock si cambió el stock
    if (field === "stock_general" || field === "stock_venta_publico") {
      if (Number(stockTotal) <= 3) {
        tr.classList.add("low-stock");
      } else {
        tr.classList.remove("low-stock");
      }
    }
    
    if (field === "price") {
      const applyBtn = tr.querySelector("button[data-apply-price]");
      if (applyBtn) {
        const changed = Number(value) !== Number(base.price ?? 0);
        applyBtn.style.display = changed ? "inline-block" : "none";
      }
    }
  }
}

// Función para agregar carga de stock
async function addStockLoad(rowId, variantId, size, loadQty) {
  if (!loadQty || loadQty <= 0) {
    msg.textContent = "La cantidad debe ser mayor a 0";
    return;
  }
  
  msg.textContent = "Cargando stock...";
  
  // Normalizar el tamaño PRIMERO para asegurar consistencia
  const normalizedSize = normalizeSize(size);
  if (!normalizedSize) {
    console.error("Error: No se pudo normalizar el tamaño", { size });
    msg.textContent = "Error: Tamaño inválido";
    return;
  }
  
  // Buscar la fila usando el tamaño normalizado
  // Primero intentar por rowId exacto, luego por combinación variantId+size normalizado
  const row = allData.find(r => {
    // Primero intentar por rowId exacto
    if (r.rowId === rowId) return true;
    // Si no coincide, buscar por variantId + size normalizado
    const rSizeNormalized = normalizeSize(r.size);
    return String(r.id) === String(variantId) && rSizeNormalized === normalizedSize;
  });
  
  if (!row) {
    console.error("Error: No se encontró la fila", { 
      rowId, 
      variantId, 
      size, 
      normalizedSize,
      allDataSample: allData.slice(0, 3).map(r => ({ rowId: r.rowId, id: r.id, size: r.size }))
    });
    msg.textContent = "Error: No se encontró la fila. Recargá la página.";
    return;
  }
  
  console.log("Agregando carga de stock:", { rowId, variantId, size: normalizedSize, loadQty, stockActual: row.stock_general });
  
  const newStockGeneral = (row.stock_general || 0) + loadQty;
  
  // Obtener IDs de almacenes
  const { data: warehouses, error: warehousesError } = await supabase
    .from("warehouses")
    .select("id, code")
    .eq("code", "general");
  
  if (warehousesError) {
    console.error("Error obteniendo almacenes:", warehousesError);
    msg.textContent = `Error: ${warehousesError.message}`;
    return;
  }
  
  const generalWarehouseId = warehouses[0]?.id;
  if (!generalWarehouseId) {
    console.error("Error: No se encontró el almacén general");
    msg.textContent = "Error: No se encontró el almacén general";
    return;
  }
  
  // Actualizar stock por talle y warehouse (usar tamaño normalizado)
  const { error: stockError } = await supabase
    .from("variant_size_warehouse_stock")
    .upsert({ 
      variant_id: variantId, 
      size: normalizedSize, 
      warehouse_id: generalWarehouseId, 
      stock_qty: newStockGeneral 
    }, { onConflict: "variant_id,size,warehouse_id" });
  
  if (stockError) {
    console.error("Error guardando stock:", stockError);
    msg.textContent = `Error guardando stock: ${stockError.message}`;
    return;
  }
  
  console.log("Stock actualizado en variant_size_warehouse_stock:", { variantId, size: normalizedSize, newStockGeneral });
  
  // Actualizar variant_sizes con el stock total del talle
  const { data: ventaPublicoWarehouse, error: ventaPublicoError } = await supabase
    .from("warehouses")
    .select("id")
    .eq("code", "venta-publico")
    .single();
  
  if (ventaPublicoError) {
    console.error("Error obteniendo almacén venta-publico:", ventaPublicoError);
  }
  
  const { data: currentVentaPublico, error: currentVentaPublicoError } = await supabase
    .from("variant_size_warehouse_stock")
    .select("stock_qty")
    .eq("variant_id", variantId)
    .eq("size", normalizedSize)
    .eq("warehouse_id", ventaPublicoWarehouse?.id)
    .maybeSingle();
  
  if (currentVentaPublicoError && currentVentaPublicoError.code !== 'PGRST116') {
    console.error("Error obteniendo stock venta-publico:", currentVentaPublicoError);
  }
  
  const stockVentaPublico = currentVentaPublico?.stock_qty || 0;
  const totalStock = newStockGeneral + stockVentaPublico;
  
  const { error: variantSizeError } = await supabase
    .from("variant_sizes")
    .upsert({ 
      variant_id: variantId, 
      size: normalizedSize, 
      stock_qty: totalStock 
    }, { onConflict: "variant_id,size" });
  
  if (variantSizeError) {
    console.error("Error actualizando variant_sizes:", variantSizeError);
    msg.textContent = `Error actualizando variant_sizes: ${variantSizeError.message}`;
    return;
  }
  
  console.log("variant_sizes actualizado:", { variantId, size: normalizedSize, totalStock });
  
  // Recalcular y actualizar variant_warehouse_stock
  const { data: allSizes } = await supabase
    .from("variant_size_warehouse_stock")
    .select("warehouse_id, stock_qty")
    .eq("variant_id", variantId);
  
  if (allSizes && allSizes.length > 0) {
    let totalGeneral = 0;
    let totalVentaPublicoStock = 0;
    
    allSizes.forEach(s => {
      if (String(s.warehouse_id) === String(generalWarehouseId)) {
        totalGeneral += s.stock_qty || 0;
      } else if (String(s.warehouse_id) === String(ventaPublicoWarehouse?.id)) {
        totalVentaPublicoStock += s.stock_qty || 0;
      }
    });
    
    await Promise.all([
      supabase
        .from("variant_warehouse_stock")
        .upsert({ variant_id: variantId, warehouse_id: generalWarehouseId, stock_qty: totalGeneral }, { onConflict: "variant_id,warehouse_id" }),
      supabase
        .from("variant_warehouse_stock")
        .upsert({ variant_id: variantId, warehouse_id: ventaPublicoWarehouse?.id, stock_qty: totalVentaPublicoStock }, { onConflict: "variant_id,warehouse_id" })
    ]);
  }
  
  // Registrar en historial
  const productId = row.products?.id;
  if (productId) {
    await supabase.rpc("log_stock_change", {
      p_product_id: productId,
      p_variant_id: variantId,
      p_size: normalizedSize,
      p_warehouse_id: generalWarehouseId,
      p_change_type: "load",
      p_stock_before: row.stock_general || 0,
      p_stock_after: newStockGeneral,
      p_from_warehouse_id: null,
      p_to_warehouse_id: null
    });
  }
  
  // Recargar datos desde la base de datos antes de renderizar
  msg.textContent = `Carga exitosa: +${loadQty} unidades. Recargando...`;
  
  // Recargar todos los datos desde la base de datos
  const ok = await load();
  if (ok) dataLoaded = true;
  updateLowAlertBadge();
}

// Event listeners para tabla y tarjetas
(tbody || productsContainer || document).addEventListener("click", async (e) => {
  console.log("Event listener ejecutado", { target: e.target.tagName, className: e.target.className });
  
  // Debug: verificar clicks en botones (incluso si están deshabilitados)
  const clickedButton = e.target.closest("button");
  if (clickedButton && (clickedButton.hasAttribute("data-print-labels") || clickedButton.hasAttribute("data-add-load"))) {
    console.log("Click detectado en botón:", {
      className: clickedButton.className,
      disabled: clickedButton.disabled,
      canEditStock: canEditStock,
      hasDataPrint: clickedButton.hasAttribute("data-print-labels"),
      hasDataAddLoad: clickedButton.hasAttribute("data-add-load")
    });
    
    // Si el botón está deshabilitado, mostrar mensaje útil
    if (clickedButton.disabled) {
      if (!canEditStock) {
        msg.textContent = "No tenés permisos para realizar esta acción";
        alert("No tenés permisos para realizar esta acción. Contactá al administrador.");
      } else {
        msg.textContent = "El botón está deshabilitado. Recargá la página.";
        console.warn("Botón deshabilitado pero usuario tiene permisos - posible error de renderizado");
      }
      return;
    }
  }
  
  // Guardar fila
  const saveBtn = e.target.closest("button[data-save]");
  if (saveBtn) {
    if (!canEditStock) {
      alert("No tienes permiso para editar el stock.");
      return;
    }
    
    const rowId = saveBtn.getAttribute("data-save");
    const variantId = saveBtn.getAttribute("data-variant-id");
    const size = saveBtn.getAttribute("data-size");
    
    if (!variantId || !size || !rowId) {
      console.error("Error: No se encontraron variantId, size o rowId en el botón", { variantId, size, rowId });
      msg.textContent = "Error: Datos incompletos en el botón de guardar";
      saveBtn.disabled = false;
      return;
    }
    
    // Validar que variantId sea un UUID válido (formato básico)
    if (!variantId || typeof variantId !== 'string' || variantId.length < 30) {
      console.error("Error: variantId no es un UUID válido:", variantId);
      msg.textContent = "Error: ID de variante inválido";
      saveBtn.disabled = false;
      return;
    }
    
    // Usar variantId directamente como UUID (string)
    const variantIdStr = variantId;
    
    const row = allData.find((r) => (r.rowId && String(r.rowId) === String(rowId)) || (String(r.id) === String(variantId) && String(r.size) === String(size)));
    if (!row) {
      console.error("Error: No se encontró la fila con rowId:", rowId, "variantId:", variantId, "size:", size);
      msg.textContent = `Error: No se encontró la fila`;
      saveBtn.disabled = false;
      return;
    }
    
    // Buscar inputs en tabla o tarjetas usando rowId
    const stockGeneralInput = (tbody || document).querySelector(`input[data-row-id="${rowId}"][data-field="stock_general"]`);
    const stockVentaPublicoInput = (tbody || document).querySelector(`input[data-row-id="${rowId}"][data-field="stock_venta_publico"]`);
    const priceInput = (tbody || document).querySelector(`input[data-row-id="${rowId}"][data-field="price"]`);
    const activeInput = (tbody || document).querySelector(`input[data-row-id="${rowId}"][data-field="active"]`);
    
    if (!stockGeneralInput || !stockVentaPublicoInput || !priceInput || !activeInput) {
      console.error("Error: No se encontraron los campos de entrada", { rowId, stockGeneralInput: !!stockGeneralInput, stockVentaPublicoInput: !!stockVentaPublicoInput, priceInput: !!priceInput, activeInput: !!activeInput });
      msg.textContent = "Error: No se encontraron los campos de entrada";
      saveBtn.disabled = false;
      return;
    }
    
    const stockGeneral = parseInt(stockGeneralInput.value || "0", 10);
    const stockVentaPublico = parseInt(stockVentaPublicoInput.value || "0", 10);
    const price = parseFloat(priceInput.value || "0");
    const active = activeInput.checked;
    
    console.log("Guardando fila:", { rowId, variantId: variantIdStr, size: row.size, stockGeneral, stockVentaPublico, price, active });
    
    saveBtn.disabled = true;
    
    // Obtener IDs de almacenes
    const { data: warehouses, error: warehousesError } = await supabase
      .from("warehouses")
      .select("id, code")
      .in("code", ["general", "venta-publico"]);
    
    if (warehousesError) {
      msg.textContent = `Error: ${warehousesError.message}`;
      saveBtn.disabled = false;
      return;
    }
    
    const warehouseMap = new Map();
    warehouses.forEach(w => warehouseMap.set(w.code, w.id));
    const generalWarehouseId = warehouseMap.get("general");
    const ventaPublicoWarehouseId = warehouseMap.get("venta-publico");
    
    if (!generalWarehouseId || !ventaPublicoWarehouseId) {
      msg.textContent = "Error: No se encontraron los almacenes necesarios";
      saveBtn.disabled = false;
      return;
    }
    
    // Preparar actualizaciones
    let error = null;
    
    // Si la fila tiene un talle (size), actualizar variant_size_warehouse_stock y variant_sizes
    if (row.size) {
      // Obtener stock anterior antes de actualizar (para historial)
      const { data: oldStockData } = await supabase
        .from("variant_size_warehouse_stock")
        .select("warehouse_id, stock_qty")
        .eq("variant_id", variantIdStr)
        .eq("size", row.size)
        .in("warehouse_id", [generalWarehouseId, ventaPublicoWarehouseId]);
      
      const oldStockGeneral = oldStockData?.find(s => String(s.warehouse_id) === String(generalWarehouseId))?.stock_qty || 0;
      const oldStockVentaPublico = oldStockData?.find(s => String(s.warehouse_id) === String(ventaPublicoWarehouseId))?.stock_qty || 0;
      
      // 1. Actualizar stock por talle y warehouse usando el size de la fila
      const sizeValue = row.size;
      const sizeStockUpdates = [
        supabase
          .from("variant_size_warehouse_stock")
          .upsert({ variant_id: variantIdStr, size: sizeValue, warehouse_id: generalWarehouseId, stock_qty: stockGeneral }, { onConflict: "variant_id,size,warehouse_id" }),
        supabase
          .from("variant_size_warehouse_stock")
          .upsert({ variant_id: variantIdStr, size: sizeValue, warehouse_id: ventaPublicoWarehouseId, stock_qty: stockVentaPublico }, { onConflict: "variant_id,size,warehouse_id" })
      ];
      
      const sizeStockResults = await Promise.all(sizeStockUpdates);
      error = sizeStockResults.find((r) => r.error)?.error;
      
      if (error) {
        msg.textContent = `Error guardando stock por talle: ${error.message}`;
        saveBtn.disabled = false;
        return;
      }
      
      // Registrar cambios en historial (después de actualizar exitosamente)
      const productId = row.products?.id;
      if (productId && !error) {
        // Detectar tipo de cambio y registrar historial
        const stockGeneralChanged = stockGeneral !== oldStockGeneral;
        const stockVentaPublicoChanged = stockVentaPublico !== oldStockVentaPublico;
        
        // Registrar cambio en almacén general
        if (stockGeneralChanged) {
          const changeType = oldStockVentaPublico > 0 && stockVentaPublico < oldStockVentaPublico && stockGeneral > oldStockGeneral
            ? "move_to_general"
            : stockGeneral > oldStockGeneral
            ? "load"
            : "adjustment";
          
          // Llamar a la función RPC para registrar historial (de forma asíncrona, no bloquea)
          (async () => {
            try {
              const { error: historyError } = await supabase.rpc("log_stock_change", {
                p_product_id: productId,
                p_variant_id: variantIdStr,
                p_size: sizeValue,
                p_warehouse_id: generalWarehouseId,
                p_change_type: changeType,
                p_stock_before: oldStockGeneral,
                p_stock_after: stockGeneral,
                p_from_warehouse_id: changeType === "move_to_general" ? ventaPublicoWarehouseId : null,
                p_to_warehouse_id: changeType === "move_to_general" ? generalWarehouseId : null
              });
              if (historyError) {
                console.warn("Error registrando historial (general):", historyError);
              }
            } catch (err) {
              console.warn("Error registrando historial (general):", err);
            }
          })();
        }
        
        // Registrar cambio en almacén venta-publico
        if (stockVentaPublicoChanged) {
          const changeType = oldStockGeneral > 0 && stockGeneral < oldStockGeneral && stockVentaPublico > oldStockVentaPublico
            ? "move_to_venta_publico"
            : stockVentaPublico > oldStockVentaPublico
            ? "load"
            : "adjustment";
          
          // Llamar a la función RPC para registrar historial (de forma asíncrona, no bloquea)
          (async () => {
            try {
              const { error: historyError } = await supabase.rpc("log_stock_change", {
                p_product_id: productId,
                p_variant_id: variantIdStr,
                p_size: sizeValue,
                p_warehouse_id: ventaPublicoWarehouseId,
                p_change_type: changeType,
                p_stock_before: oldStockVentaPublico,
                p_stock_after: stockVentaPublico,
                p_from_warehouse_id: changeType === "move_to_venta_publico" ? generalWarehouseId : null,
                p_to_warehouse_id: changeType === "move_to_venta_publico" ? ventaPublicoWarehouseId : null
              });
              if (historyError) {
                console.warn("Error registrando historial (venta-publico):", historyError);
              }
            } catch (err) {
              console.warn("Error registrando historial (venta-publico):", err);
            }
          })();
        }
      }
      
      // 2. Actualizar variant_sizes con el stock total del talle
      const { error: variantSizeError } = await supabase
        .from("variant_sizes")
        .upsert({ variant_id: variantIdStr, size: sizeValue, stock_qty: stockGeneral + stockVentaPublico }, { onConflict: "variant_id,size" });
      
      if (variantSizeError) {
        msg.textContent = `Error actualizando variant_sizes: ${variantSizeError.message}`;
        saveBtn.disabled = false;
        return;
      }
      
      // 3. Recalcular y actualizar variant_warehouse_stock (suma de todos los talles de la variante)
      const { data: allSizes, error: sizesError } = await supabase
        .from("variant_size_warehouse_stock")
        .select("warehouse_id, stock_qty")
        .eq("variant_id", variantIdStr);
      
      if (sizesError) {
        console.warn("Error obteniendo talles para recalcular total:", sizesError);
      } else if (allSizes && allSizes.length > 0) {
        // Calcular totales por warehouse
        let totalGeneral = 0;
        let totalVentaPublico = 0;
        
        allSizes.forEach(s => {
          if (String(s.warehouse_id) === String(generalWarehouseId)) {
            totalGeneral += s.stock_qty || 0;
          } else if (String(s.warehouse_id) === String(ventaPublicoWarehouseId)) {
            totalVentaPublico += s.stock_qty || 0;
          }
        });
        
        // Actualizar variant_warehouse_stock con los totales
        const totalUpdates = [
          supabase
            .from("variant_warehouse_stock")
            .upsert({ variant_id: variantIdStr, warehouse_id: generalWarehouseId, stock_qty: totalGeneral }, { onConflict: "variant_id,warehouse_id" }),
          supabase
            .from("variant_warehouse_stock")
            .upsert({ variant_id: variantIdStr, warehouse_id: ventaPublicoWarehouseId, stock_qty: totalVentaPublico }, { onConflict: "variant_id,warehouse_id" })
        ];
        
        const totalResults = await Promise.all(totalUpdates);
        error = totalResults.find((r) => r.error)?.error;
      }
      
      // 4. Actualizar precio y estado activo en product_variants
      if (!error) {
        const { error: variantError } = await supabase
          .from("product_variants")
          .update({ price, active })
          .eq("id", variantIdStr);
        
        if (variantError) {
          error = variantError;
        }
      }
    } else {
      // Si no tiene talle, actualizar directamente variant_warehouse_stock
      // Obtener stock anterior para historial
      const { data: oldStockData } = await supabase
        .from("variant_warehouse_stock")
        .select("warehouse_id, stock_qty")
        .eq("variant_id", variantIdStr)
        .in("warehouse_id", [generalWarehouseId, ventaPublicoWarehouseId]);
      
      const oldStockGeneral = oldStockData?.find(s => String(s.warehouse_id) === String(generalWarehouseId))?.stock_qty || 0;
      const oldStockVentaPublico = oldStockData?.find(s => String(s.warehouse_id) === String(ventaPublicoWarehouseId))?.stock_qty || 0;
      
      const updates = [
        supabase
          .from("variant_warehouse_stock")
          .upsert({ variant_id: variantIdStr, warehouse_id: generalWarehouseId, stock_qty: stockGeneral }, { onConflict: "variant_id,warehouse_id" }),
        supabase
          .from("variant_warehouse_stock")
          .upsert({ variant_id: variantIdStr, warehouse_id: ventaPublicoWarehouseId, stock_qty: stockVentaPublico }, { onConflict: "variant_id,warehouse_id" }),
        supabase
          .from("product_variants")
          .update({ price, active })
          .eq("id", variantIdStr)
      ];
      
      const results = await Promise.all(updates);
      error = results.find((r) => r.error)?.error;
      
      // Registrar cambios en historial (para variantes sin talle)
      const productId = row.products?.id;
      if (productId && !error) {
        const stockGeneralChanged = stockGeneral !== oldStockGeneral;
        const stockVentaPublicoChanged = stockVentaPublico !== oldStockVentaPublico;
        
        if (stockGeneralChanged) {
          const changeType = oldStockVentaPublico > 0 && stockVentaPublico < oldStockVentaPublico && stockGeneral > oldStockGeneral
            ? "move_to_general"
            : stockGeneral > oldStockGeneral
            ? "load"
            : "adjustment";
          
          (async () => {
            try {
              const { error: historyError } = await supabase.rpc("log_stock_change", {
                p_product_id: productId,
                p_variant_id: variantIdStr,
                p_size: null,
                p_warehouse_id: generalWarehouseId,
                p_change_type: changeType,
                p_stock_before: oldStockGeneral,
                p_stock_after: stockGeneral,
                p_from_warehouse_id: changeType === "move_to_general" ? ventaPublicoWarehouseId : null,
                p_to_warehouse_id: changeType === "move_to_general" ? generalWarehouseId : null
              });
              if (historyError) {
                console.warn("Error registrando historial (general, sin talle):", historyError);
              }
            } catch (err) {
              console.warn("Error registrando historial (general, sin talle):", err);
            }
          })();
        }
        
        if (stockVentaPublicoChanged) {
          const changeType = oldStockGeneral > 0 && stockGeneral < oldStockGeneral && stockVentaPublico > oldStockVentaPublico
            ? "move_to_venta_publico"
            : stockVentaPublico > oldStockVentaPublico
            ? "load"
            : "adjustment";
          
          (async () => {
            try {
              const { error: historyError } = await supabase.rpc("log_stock_change", {
                p_product_id: productId,
                p_variant_id: variantIdStr,
                p_size: null,
                p_warehouse_id: ventaPublicoWarehouseId,
                p_change_type: changeType,
                p_stock_before: oldStockVentaPublico,
                p_stock_after: stockVentaPublico,
                p_from_warehouse_id: changeType === "move_to_venta_publico" ? generalWarehouseId : null,
                p_to_warehouse_id: changeType === "move_to_venta_publico" ? ventaPublicoWarehouseId : null
              });
              if (historyError) {
                console.warn("Error registrando historial (venta-publico, sin talle):", historyError);
              }
            } catch (err) {
              console.warn("Error registrando historial (venta-publico, sin talle):", err);
            }
          })();
        }
      }
    }
    
    saveBtn.disabled = false;
    if (!error) {
      if (row) {
        row.stock_general = stockGeneral;
        row.stock_venta_publico = stockVentaPublico;
        row.stock_total = stockGeneral + stockVentaPublico;
        row.price = price;
        row.active = active;
      }
      const uniqueKey = row.rowId || `${row.id}_${row.size || 'null'}`;
      pendingChanges.delete(uniqueKey);
      setPendingCount();
      render();
    }
    msg.textContent = error ? `Error: ${error.message}` : "Guardado";
    return;
  }
  
  // Agregar carga de stock
  // Intentar encontrar el botón de varias formas
  let addLoadBtn = e.target.closest("button[data-add-load]");
  // Si no encuentra, puede ser que el click fue en el texto dentro del botón
  if (!addLoadBtn && e.target.tagName === 'BUTTON' && e.target.hasAttribute("data-add-load")) {
    addLoadBtn = e.target;
  }
  // Si aún no encuentra, buscar por clase
  if (!addLoadBtn) {
    const btn = e.target.closest(".carga-btn");
    if (btn && btn.hasAttribute("data-add-load")) {
      addLoadBtn = btn;
    }
  }
  
  if (addLoadBtn) {
    console.log("Botón de carga encontrado", { 
      disabled: addLoadBtn.disabled, 
      canEditStock,
      hasAttributes: {
        rowId: addLoadBtn.hasAttribute("data-row-id"),
        variantId: addLoadBtn.hasAttribute("data-variant-id"),
        size: addLoadBtn.hasAttribute("data-size")
      }
    });
    
    if (addLoadBtn.disabled) {
      console.warn("Botón deshabilitado - no se puede procesar");
      return;
    }
    
    e.preventDefault();
    e.stopPropagation();
    
    if (!canEditStock) {
      alert("No tienes permiso para editar el stock.");
      return;
    }
    
    const rowId = addLoadBtn.getAttribute("data-row-id");
    const variantId = addLoadBtn.getAttribute("data-variant-id");
    const size = addLoadBtn.getAttribute("data-size");
    
    if (!rowId || !variantId || !size) {
      console.error("Error: Datos incompletos en botón de carga", { rowId, variantId, size });
      msg.textContent = "Error: Datos incompletos. Recargá la página.";
      return;
    }
    
    // Buscar el input de carga en la misma fila
    const row = addLoadBtn.closest("tr");
    const loadInput = row ? row.querySelector(`input[data-load-input="${rowId}"]`) : null;
    
    if (!loadInput) {
      console.error("Error: No se encontró el input de carga", { rowId });
      msg.textContent = "Error: No se encontró el campo de carga.";
      return;
    }
    
    const loadQty = parseInt(loadInput.value || "0", 10);
    
    if (loadQty <= 0) {
      msg.textContent = "Ingresá una cantidad mayor a 0 para cargar";
      return;
    }
    
    console.log("Iniciando carga de stock:", { rowId, variantId, size, loadQty });
    
    try {
      await addStockLoad(rowId, variantId, size, loadQty);
      loadInput.value = ""; // Limpiar input después de cargar exitosamente
    } catch (error) {
      console.error("Error en carga de stock:", error);
      msg.textContent = `Error al cargar stock: ${error.message}`;
    }
    return;
  }
  
  // Imprimir etiquetas
  const printBtn = e.target.closest("button[data-print-labels]");
  if (printBtn) {
    e.preventDefault();
    e.stopPropagation();
    
    console.log("Botón de impresión clickeado", { disabled: printBtn.disabled, canEditStock });
    
    // Verificar si el botón está deshabilitado
    if (printBtn.disabled) {
      console.log("Botón de impresión deshabilitado - no se puede imprimir");
      msg.textContent = "El botón está deshabilitado. Verificá tus permisos.";
      return;
    }
    
    if (!canEditStock) {
      alert("No tienes permiso para imprimir etiquetas.");
      return;
    }
    
    const rowId = printBtn.getAttribute("data-row-id");
    const productName = printBtn.getAttribute("data-product-name");
    const color = printBtn.getAttribute("data-color");
    const size = printBtn.getAttribute("data-size");
    const sku = printBtn.getAttribute("data-sku");
    const qrCode = printBtn.getAttribute("data-qr-code") || sku;
    
    if (!rowId || !sku) {
      console.error("Error: Datos incompletos en botón de impresión", { rowId, sku, productName, color, size });
      msg.textContent = "Error: Datos incompletos. Recargá la página.";
      return;
    }
    
    // Buscar el input de carga en la misma fila
    const row = printBtn.closest("tr");
    const loadInput = row ? row.querySelector(`input[data-load-input="${rowId}"]`) : null;
    
    if (!loadInput) {
      console.error("Error: No se encontró el input de carga", { rowId });
      msg.textContent = "Error: No se encontró el campo de carga.";
      return;
    }
    
    const qty = parseInt(loadInput.value || "0", 10);
    
    if (qty <= 0) {
      msg.textContent = "Ingresá una cantidad mayor a 0 en el campo Carga para imprimir";
      return;
    }
    
    console.log("Iniciando impresión de etiquetas:", { rowId, sku, productName, color, size, qty, qrCode });
    
    // Verificar que la función de impresión esté disponible
    if (typeof printProductLabelsZebra !== 'function') {
      console.error("Error: printProductLabelsZebra no está disponible");
      msg.textContent = "Error: Función de impresión no disponible. Recargá la página.";
      alert("Error: La función de impresión no está disponible. Verificá que el módulo qz-printing.js se haya cargado correctamente.");
      return;
    }
    
    // Deshabilitar botón mientras imprime
    printBtn.disabled = true;
    const originalText = printBtn.textContent;
    printBtn.textContent = "Imprimiendo...";
    msg.textContent = `Imprimiendo ${qty} etiqueta(s)...`;
    
    // Imprimir usando la cantidad de carga
    try {
      await printProductLabelsZebra(sku, productName, color, size, qty, qrCode);
      msg.textContent = `✅ ${qty} etiqueta(s) enviada(s) a imprimir`;
    } catch (error) {
      console.error("Error imprimiendo etiquetas:", error);
      const errorMsg = error.message || 'Error desconocido';
      msg.textContent = `Error al imprimir etiquetas: ${errorMsg}`;
      alert(`Error al imprimir: ${errorMsg}\n\nVerificá que:\n- QZ Tray esté instalado y ejecutándose\n- La impresora esté conectada\n- Tengas sesión activa`);
    } finally {
      // Rehabilitar botón después de imprimir
      printBtn.disabled = false;
      printBtn.textContent = originalText;
    }
    return;
  }
  
  // Aplicar precio a todas las variantes del producto
  const applyBtn = e.target.closest("button[data-apply-price]");
  if (applyBtn) {
    const productId = applyBtn.getAttribute("data-product-id");
    const sourceRowId = applyBtn.getAttribute("data-source-id");
    const sourceInput = (tbody || document).querySelector(`input[data-row-id="${sourceRowId}"][data-field="price"]`);
    const targetPrice = parseFloat(sourceInput?.value || "0");
    if (!Number.isFinite(targetPrice)) return;
    const variants = allData.filter((r) => String(r.products?.id) === String(productId));
    variants.forEach((r) => {
      const uniqueKey = r.rowId || `${r.id}_${r.size || 'null'}`;
      const change = pendingChanges.get(uniqueKey) || { 
        stock_general: r.stock_general, 
        stock_venta_publico: r.stock_venta_publico, 
        price: r.price, 
        active: r.active 
      };
      change.price = targetPrice;
      // Si no cambió vs original, limpiar; si cambió, set
      const currentStockGeneral = change.stock_general !== undefined ? change.stock_general : r.stock_general;
      const currentStockVentaPublico = change.stock_venta_publico !== undefined ? change.stock_venta_publico : r.stock_venta_publico;
      if (Number(change.price ?? 0) === Number(r.price ?? 0) &&
          Number(currentStockGeneral ?? 0) === Number(r.stock_general ?? 0) &&
          Number(currentStockVentaPublico ?? 0) === Number(r.stock_venta_publico ?? 0) &&
          Boolean(change.active) === Boolean(r.active)) {
        pendingChanges.delete(uniqueKey);
      } else {
        pendingChanges.set(uniqueKey, change);
      }
      // Reflejar en input visible si está en el DOM
      const inputRowId = r.rowId || `${r.id}_${r.size || 'null'}`;
      const input = (tbody || document).querySelector(`input[data-row-id="${inputRowId}"][data-field="price"]`);
      if (input) input.value = String(targetPrice);
      const rowEl = input ? input.closest("tr") : null;
      if (rowEl) rowEl.classList.add("dirty-row");
    });
    setPendingCount();
    // Actualizar visibilidad de botones "Aplicar a todos"
    (tbody || document).querySelectorAll("button[data-apply-price]").forEach((b) => {
      const sid = b.getAttribute("data-source-id");
      const base = allData.find((r) => {
        const rowId = r.rowId || `${r.id}_${r.size || 'null'}`;
        return String(rowId) === String(sid);
      });
      if (base) {
        const uniqueKey = base.rowId || `${base.id}_${base.size || 'null'}`;
        const pending = pendingChanges.get(uniqueKey);
        const changed = pending && Number(pending.price ?? 0) !== Number(base?.price ?? 0);
        b.style.display = changed ? "inline-block" : "none";
      }
    });
    msg.textContent = `Precio aplicado a ${variants.length} variantes`;
  }
});

// Cambios en vivo en inputs -> marcar como pendiente (funciona para tabla y tarjetas)
document.addEventListener("input", (e) => {
  if (!canEditStock) {
    e.target.value = e.target.defaultValue;
    if (e.target.type === "checkbox") {
      e.target.checked = e.target.defaultChecked;
    }
    alert("No tienes permiso para editar el stock.");
    return;
  }
  
  const input = e.target.closest("input[data-row-id]");
  if (!input) return;
  const rowId = input.getAttribute("data-row-id");
  const field = input.getAttribute("data-field");
  let value;
  if (field === "active") {
    value = input.checked;
  } else {
    value = field === "price" ? parseFloat(input.value || "0") : parseInt(input.value || "0", 10);
    if (!Number.isFinite(value) || value < 0) value = 0;
  }
  markChange(rowId, field, value);
  if (field === "stock_general" || field === "stock_venta_publico") updateLowAlertBadge();
});

// Guardar todos los pendientes
async function saveAll() {
  if (!canEditStock) {
    alert("No tienes permiso para editar el stock.");
    return;
  }
  
  if (pendingChanges.size === 0) return;
  saveAllBtn.disabled = true;
  msg.textContent = "Guardando cambios...";
  
  // Obtener IDs de almacenes
  const { data: warehouses, error: warehousesError } = await supabase
    .from("warehouses")
    .select("id, code")
    .in("code", ["general", "venta-publico"]);
  
  if (warehousesError) {
    msg.textContent = `Error: ${warehousesError.message}`;
    saveAllBtn.disabled = false;
    return;
  }
  
  const warehouseMap = new Map();
  warehouses.forEach(w => warehouseMap.set(w.code, w.id));
  const generalWarehouseId = warehouseMap.get("general");
  const ventaPublicoWarehouseId = warehouseMap.get("venta-publico");
  
  if (!generalWarehouseId || !ventaPublicoWarehouseId) {
    msg.textContent = "Error: No se encontraron los almacenes necesarios";
    saveAllBtn.disabled = false;
    return;
  }
  
  // Preparar todas las actualizaciones y obtener stocks anteriores para historial
  const updates = [];
  const variantUpdates = [];
  const historyLogs = []; // Para registrar historial después de guardar
  
  // Primero, obtener todos los stocks anteriores para historial
  const variantIdsForHistory = [];
  const rowsForHistory = new Map();
  pendingChanges.forEach((change, uniqueKey) => {
    const row = allData.find((r) => {
      const rKey = r.rowId || `${r.id}_${r.size || 'null'}`;
      return String(rKey) === String(uniqueKey);
    });
    if (row && (change.stock_general !== undefined || change.stock_venta_publico !== undefined)) {
      variantIdsForHistory.push(row.id);
      rowsForHistory.set(uniqueKey, row);
    }
  });
  
  // Obtener stocks anteriores en batch
  // Dividir en lotes para evitar error 400 con arrays grandes
  const oldStocksMap = new Map();
  if (variantIdsForHistory.length > 0) {
    const historyBatchSize = 100;
    const historyTotalBatches = Math.ceil(variantIdsForHistory.length / historyBatchSize);
    
    // Para variantes con talle
    let allOldSizeStocks = [];
    for (let batchIndex = 0; batchIndex < historyTotalBatches; batchIndex++) {
      const startIndex = batchIndex * historyBatchSize;
      const endIndex = Math.min(startIndex + historyBatchSize, variantIdsForHistory.length);
      const batchVariantIds = variantIdsForHistory.slice(startIndex, endIndex);
      
      if (batchVariantIds.length === 0) continue;
      
      const { data: oldSizeStocks } = await supabase
        .from("variant_size_warehouse_stock")
        .select("variant_id, size, warehouse_id, stock_qty")
        .in("variant_id", batchVariantIds)
        .in("warehouse_id", [generalWarehouseId, ventaPublicoWarehouseId]);
      
      if (oldSizeStocks && oldSizeStocks.length > 0) {
        allOldSizeStocks.push(...oldSizeStocks);
      }
    }
    
    if (allOldSizeStocks.length > 0) {
      allOldSizeStocks.forEach(s => {
        const key = `${s.variant_id}_${String(s.size || "").trim()}_${s.warehouse_id}`;
        oldStocksMap.set(key, s.stock_qty || 0);
      });
    }
    
    // Para variantes sin talle
    let allOldVariantStocks = [];
    for (let batchIndex = 0; batchIndex < historyTotalBatches; batchIndex++) {
      const startIndex = batchIndex * historyBatchSize;
      const endIndex = Math.min(startIndex + historyBatchSize, variantIdsForHistory.length);
      const batchVariantIds = variantIdsForHistory.slice(startIndex, endIndex);
      
      if (batchVariantIds.length === 0) continue;
      
      const { data: oldVariantStocks } = await supabase
        .from("variant_warehouse_stock")
        .select("variant_id, warehouse_id, stock_qty")
        .in("variant_id", batchVariantIds)
        .in("warehouse_id", [generalWarehouseId, ventaPublicoWarehouseId]);
      
      if (oldVariantStocks && oldVariantStocks.length > 0) {
        allOldVariantStocks.push(...oldVariantStocks);
      }
    }
    
    if (allOldVariantStocks.length > 0) {
      allOldVariantStocks.forEach(s => {
        const key = `${s.variant_id}_null_${s.warehouse_id}`;
        oldStocksMap.set(key, s.stock_qty || 0);
      });
    }
  }
  
  pendingChanges.forEach((change, uniqueKey) => {
    // Buscar la fila usando uniqueKey (que puede ser rowId o id_size)
    const row = allData.find((r) => {
      const rKey = r.rowId || `${r.id}_${r.size || 'null'}`;
      return String(rKey) === String(uniqueKey);
    });
    
    if (!row) {
      console.warn("No se encontró fila para uniqueKey:", uniqueKey);
      return;
    }
    
    // Usar row.id directamente como UUID (string), no convertir a número
    const variantId = String(row.id);
    if (!variantId || variantId.length < 30) {
      console.warn("variantId inválido para uniqueKey:", uniqueKey, "variantId:", variantId);
      return;
    }
    
    const stockGeneral = change.stock_general !== undefined ? change.stock_general : (row?.stock_general || 0);
    const stockVentaPublico = change.stock_venta_publico !== undefined ? change.stock_venta_publico : (row?.stock_venta_publico || 0);
    
    // Obtener stock anterior para historial
    const sizeKey = row.size ? String(row.size).trim() : "null";
    const oldStockGeneralKey = `${variantId}_${sizeKey}_${generalWarehouseId}`;
    const oldStockVentaPublicoKey = `${variantId}_${sizeKey}_${ventaPublicoWarehouseId}`;
    const oldStockGeneral = oldStocksMap.get(oldStockGeneralKey) || 0;
    const oldStockVentaPublico = oldStocksMap.get(oldStockVentaPublicoKey) || 0;
    
    // Si la fila tiene un talle (size), actualizar variant_size_warehouse_stock
    if (row.size && (change.stock_general !== undefined || change.stock_venta_publico !== undefined)) {
      updates.push(
        supabase
          .from("variant_size_warehouse_stock")
          .upsert({ variant_id: variantId, size: row.size, warehouse_id: generalWarehouseId, stock_qty: stockGeneral }, { onConflict: "variant_id,size,warehouse_id" }),
        supabase
          .from("variant_size_warehouse_stock")
          .upsert({ variant_id: variantId, size: row.size, warehouse_id: ventaPublicoWarehouseId, stock_qty: stockVentaPublico }, { onConflict: "variant_id,size,warehouse_id" })
      );
      
      // También actualizar variant_sizes con el stock total del talle
      updates.push(
        supabase
          .from("variant_sizes")
          .upsert({ variant_id: variantId, size: row.size, stock_qty: stockGeneral + stockVentaPublico }, { onConflict: "variant_id,size" })
      );
      
      // Preparar logs de historial
      const productId = row.products?.id;
      if (productId) {
        if (stockGeneral !== oldStockGeneral) {
          const changeType = oldStockVentaPublico > 0 && stockVentaPublico < oldStockVentaPublico && stockGeneral > oldStockGeneral
            ? "move_to_general"
            : stockGeneral > oldStockGeneral
            ? "load"
            : "adjustment";
          historyLogs.push({
            product_id: productId,
            variant_id: variantId,
            size: row.size,
            warehouse_id: generalWarehouseId,
            change_type: changeType,
            stock_before: oldStockGeneral,
            stock_after: stockGeneral,
            from_warehouse_id: changeType === "move_to_general" ? ventaPublicoWarehouseId : null,
            to_warehouse_id: changeType === "move_to_general" ? generalWarehouseId : null
          });
        }
        if (stockVentaPublico !== oldStockVentaPublico) {
          const changeType = oldStockGeneral > 0 && stockGeneral < oldStockGeneral && stockVentaPublico > oldStockVentaPublico
            ? "move_to_venta_publico"
            : stockVentaPublico > oldStockVentaPublico
            ? "load"
            : "adjustment";
          historyLogs.push({
            product_id: productId,
            variant_id: variantId,
            size: row.size,
            warehouse_id: ventaPublicoWarehouseId,
            change_type: changeType,
            stock_before: oldStockVentaPublico,
            stock_after: stockVentaPublico,
            from_warehouse_id: changeType === "move_to_venta_publico" ? generalWarehouseId : null,
            to_warehouse_id: changeType === "move_to_venta_publico" ? ventaPublicoWarehouseId : null
          });
        }
      }
    } else {
      // Si no tiene talle, actualizar directamente variant_warehouse_stock
      if (change.stock_general !== undefined) {
        updates.push(
          supabase
            .from("variant_warehouse_stock")
            .upsert({ variant_id: variantId, warehouse_id: generalWarehouseId, stock_qty: change.stock_general }, { onConflict: "variant_id,warehouse_id" })
        );
        
        // Preparar log de historial
        const productId = row.products?.id;
        if (productId && stockGeneral !== oldStockGeneral) {
          const changeType = oldStockVentaPublico > 0 && stockVentaPublico < oldStockVentaPublico && stockGeneral > oldStockGeneral
            ? "move_to_general"
            : stockGeneral > oldStockGeneral
            ? "load"
            : "adjustment";
          historyLogs.push({
            product_id: productId,
            variant_id: variantId,
            size: null,
            warehouse_id: generalWarehouseId,
            change_type: changeType,
            stock_before: oldStockGeneral,
            stock_after: stockGeneral,
            from_warehouse_id: changeType === "move_to_general" ? ventaPublicoWarehouseId : null,
            to_warehouse_id: changeType === "move_to_general" ? generalWarehouseId : null
          });
        }
      }
      if (change.stock_venta_publico !== undefined) {
        updates.push(
          supabase
            .from("variant_warehouse_stock")
            .upsert({ variant_id: variantId, warehouse_id: ventaPublicoWarehouseId, stock_qty: change.stock_venta_publico }, { onConflict: "variant_id,warehouse_id" })
        );
        
        // Preparar log de historial
        const productId = row.products?.id;
        if (productId && stockVentaPublico !== oldStockVentaPublico) {
          const changeType = oldStockGeneral > 0 && stockGeneral < oldStockGeneral && stockVentaPublico > oldStockVentaPublico
            ? "move_to_venta_publico"
            : stockVentaPublico > oldStockVentaPublico
            ? "load"
            : "adjustment";
          historyLogs.push({
            product_id: productId,
            variant_id: variantId,
            size: null,
            warehouse_id: ventaPublicoWarehouseId,
            change_type: changeType,
            stock_before: oldStockVentaPublico,
            stock_after: stockVentaPublico,
            from_warehouse_id: changeType === "move_to_venta_publico" ? generalWarehouseId : null,
            to_warehouse_id: changeType === "move_to_venta_publico" ? ventaPublicoWarehouseId : null
          });
        }
      }
    }
    
    // Actualizar precio y activo en product_variants
    const variantUpdate = {};
    if (change.price !== undefined) variantUpdate.price = change.price;
    if (change.active !== undefined) variantUpdate.active = change.active;
    
    if (Object.keys(variantUpdate).length > 0) {
      variantUpdates.push(
        supabase.from("product_variants").update(variantUpdate).eq("id", variantId)
      );
    }
  });
  
  const allUpdates = [...updates, ...variantUpdates];
  const results = await Promise.all(allUpdates);
  const error = results.find((r) => r.error)?.error;
  
  if (!error) {
    // Registrar historial después de guardar exitosamente (de forma asíncrona, no bloquea)
    historyLogs.forEach(log => {
      (async () => {
        try {
          const { error: historyError } = await supabase.rpc("log_stock_change", {
            p_product_id: log.product_id,
            p_variant_id: log.variant_id,
            p_size: log.size,
            p_warehouse_id: log.warehouse_id,
            p_change_type: log.change_type,
            p_stock_before: log.stock_before,
            p_stock_after: log.stock_after,
            p_from_warehouse_id: log.from_warehouse_id,
            p_to_warehouse_id: log.to_warehouse_id
          });
          if (historyError) {
            console.warn("Error registrando historial en saveAll:", historyError);
          }
        } catch (err) {
          console.warn("Error registrando historial en saveAll:", err);
        }
      })();
    });
    // Aplicar cambios a cache y limpiar pendientes
    pendingChanges.forEach((change, uniqueKey) => {
      const row = allData.find((r) => {
        const rKey = r.rowId || `${r.id}_${r.size || 'null'}`;
        return String(rKey) === String(uniqueKey);
      });
      if (row) {
        if (change.stock_general !== undefined) row.stock_general = change.stock_general;
        if (change.stock_venta_publico !== undefined) row.stock_venta_publico = change.stock_venta_publico;
        row.stock_total = (row.stock_general || 0) + (row.stock_venta_publico || 0);
        if (change.price !== undefined) row.price = change.price;
        if (change.active !== undefined) row.active = change.active;
      }
    });
    pendingChanges.clear();
    setPendingCount();
    render();
    updateLowAlertBadge();
  }
  msg.textContent = error ? `Error: ${error.message}` : "Cambios guardados";
  saveAllBtn.disabled = false;
}

function discardAll() {
  pendingChanges.clear();
  setPendingCount();
  render();
}

// Variable para rastrear si ya se cargaron los datos
let dataLoaded = false;
let loadInProgress = false; // Prevenir múltiples cargas simultáneas
let renderTimeout = null; // Para debounce de render

// Función para cargar datos solo cuando hay filtros activos
async function loadIfNeeded() {
  // Prevenir múltiples cargas simultáneas
  if (loadInProgress) {
    return;
  }
  
  // Verificar si hay filtros activos
  const term = (q.value || "").toLowerCase().trim();
  const cat = fCategory.value || "";
  const color = fColor.value || "";
  const size = fSize.value || "";
  const active = fActive.value;
  const onlyLow = fLow.checked;
  const hasAnyFilter = term || cat || color || size || active || onlyLow;
  
  // Solo cargar si hay filtros y aún no se han cargado los datos
  if (hasAnyFilter && !dataLoaded) {
    loadInProgress = true;
    try {
      const ok = await load();
      if (ok) dataLoaded = true; // Solo marcar como cargado si load() terminó bien (sin return anticipado)
    } finally {
      loadInProgress = false;
    }
  }
  
  // Si no hay filtros, no cargar nada
  if (!hasAnyFilter) {
    allData = [];
    // Cancelar render pendiente
    if (renderTimeout) {
      clearTimeout(renderTimeout);
      renderTimeout = null;
    }
    render();
    msg.textContent = `Usa el buscador o filtros para ver productos.`;
    return;
  }
  
  // Si ya se cargaron los datos, solo renderizar (con debounce)
  if (dataLoaded) {
    // Cancelar render anterior pendiente
    if (renderTimeout) {
      clearTimeout(renderTimeout);
    }
    // Debounce: esperar 300ms antes de renderizar
    renderTimeout = setTimeout(() => {
      render();
      renderTimeout = null;
    }, 300);
  }
}

reloadBtn.addEventListener("click", async () => {
  dataLoaded = false; // Resetear para forzar recarga
  const ok = await load();
  if (ok) dataLoaded = true;
  render();
  // Actualizar nombres de productos para autocompletado
  await loadProductNames();
});

// Debounce para búsqueda (input) - prevenir múltiples llamadas mientras el usuario escribe
let searchTimeout = null;
q.addEventListener("input", () => {
  // Si ya hay una carga en progreso, no hacer nada
  if (loadInProgress) {
    return;
  }
  
  // Cancelar búsqueda anterior pendiente
  if (searchTimeout) {
    clearTimeout(searchTimeout);
  }
  
  // Debounce: esperar 800ms antes de buscar (aumentado para evitar múltiples cargas)
  searchTimeout = setTimeout(() => {
    if (!loadInProgress) {
      loadIfNeeded();
    }
    searchTimeout = null;
  }, 800);
});
// Event listeners para filtros - con protección contra cargas duplicadas
const handleFilterChange = () => {
  if (!loadInProgress) {
    loadIfNeeded();
  }
};

fCategory.addEventListener("change", handleFilterChange);
fColor.addEventListener("change", handleFilterChange);
fSize.addEventListener("change", handleFilterChange);
fActive.addEventListener("change", handleFilterChange);
fLow.addEventListener("change", handleFilterChange);
// REMOVIDOS: Event listeners duplicados que causaban múltiples renders
// fColor.addEventListener("change", render);
// fSize.addEventListener("change", render);
// fActive.addEventListener("change", render);
// fLow.addEventListener("change", render);
saveAllBtn.addEventListener("click", saveAll);
discardAllBtn.addEventListener("click", discardAll);
lowAlertBtn.addEventListener("click", () => {
  const groups = computeLowStockGroups();
  lowSummary.textContent = groups.length === 0 ? "No hay grupos con bajo stock." : `${groups.length} producto(s) con bajo stock (< 12 unidades por color)`;
  lowListTbody.innerHTML = groups
    .map(
      (g) => `
      <tr>
        <td>${g.name || ""}</td>
        <td>${g.category || ""}</td>
        <td><span class="chip">${g.color || ""}</span></td>
        <td><strong>${g.total}</strong></td>
        <td>${g.variants
          .map((v) => `<span class="chip">Talle ${v.size}: ${v.qty}</span>`)
          .join(" ")}</td>
      </tr>`
    )
    .join("");
  overlay.classList.add("show");
  overlay.setAttribute("aria-hidden", "false");
});
closeOverlay.addEventListener("click", () => {
  overlay.classList.remove("show");
  overlay.setAttribute("aria-hidden", "true");
});
overlay.addEventListener("click", (e) => {
  if (e.target === overlay) {
    overlay.classList.remove("show");
    overlay.setAttribute("aria-hidden", "true");
  }
});

// ------ Productos antiguos (18+ meses) ------
async function openOldProductsModal() {
  // Traer productos con created_at < now - 18 meses (y no archivados)
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 18);
  const cutoffIso = cutoff.toISOString();
  const { data: products, error } = await supabase
    .from("products")
    .select("id, name, handle, category, created_at, status")
    .lt("created_at", cutoffIso)
    .neq("status", "archived")
    .order("created_at", { ascending: true });
  if (error) {
    oldSummary.textContent = `Error: ${error.message}`;
    oldSummary.style.color = "#c00";
    overlayOld.classList.add("show");
    overlayOld.setAttribute("aria-hidden", "false");
    return;
  }
  // Contar variantes por producto
  let variantCounts = new Map();
  if (products?.length) {
    const { data: vc } = await supabase
      .from("product_variants")
      .select("id, product_id")
      .in(
        "product_id",
        products.map((p) => p.id)
      );
    variantCounts = new Map();
    (vc || []).forEach((v) => {
      variantCounts.set(v.product_id, (variantCounts.get(v.product_id) || 0) + 1);
    });
  }
  oldSummary.style.color = "inherit";
  oldSummary.textContent = `${products?.length || 0} producto(s) con más de 18 meses`;
  oldListTbody.innerHTML = (products || [])
    .map(
      (p) => `
      <tr>
        <td><input type="checkbox" class="old-check" data-id="${p.id}" data-handle="${p.handle}"/></td>
        <td>${p.name || ""}</td>
        <td>${p.handle || ""}</td>
        <td>${p.category || ""}</td>
        <td>${new Date(p.created_at).toLocaleDateString()}</td>
        <td>${variantCounts.get(p.id) || 0}</td>
      </tr>`
    )
    .join("");
  oldCheckAll.checked = false;
  overlayOld.classList.add("show");
  overlayOld.setAttribute("aria-hidden", "false");
}

oldBtn?.addEventListener("click", openOldProductsModal);
closeOverlayOld?.addEventListener("click", () => {
  overlayOld.classList.remove("show");
  overlayOld.setAttribute("aria-hidden", "true");
});
overlayOld?.addEventListener("click", (e) => {
  if (e.target === overlayOld) {
    overlayOld.classList.remove("show");
    overlayOld.setAttribute("aria-hidden", "true");
  }
});
oldCheckAll?.addEventListener("change", () => {
  const boxes = overlayOld.querySelectorAll(".old-check");
  boxes.forEach((b) => (b.checked = oldCheckAll.checked));
});
archiveSelectedBtn?.addEventListener("click", async () => {
  if (!canDeleteStock) {
    alert("No tienes permiso para eliminar/archivar productos.");
    return;
  }
  
  const boxes = Array.from(overlayOld.querySelectorAll(".old-check")).filter((b) => b.checked);
  if (!boxes.length) {
    oldSummary.textContent = "Seleccioná al menos un producto.";
    oldSummary.style.color = "#c00";
    return;
  }
  oldSummary.style.color = "inherit";
  oldSummary.textContent = "Archivando seleccionados...";
  // Archivar: status=archived y liberar handle con sufijo timestamp
  const updates = boxes.map((b) => {
    const id = Number(b.getAttribute("data-id"));
    const handle = b.getAttribute("data-handle") || "prod";
    const newHandle = `${handle}__arch_${Date.now()}_${Math.floor(Math.random()*1000)}`;
    return supabase.from("products").update({ status: "archived", handle: newHandle }).eq("id", id);
  });
  const results = await Promise.all(updates);
  const failed = results.find((r) => r.error)?.error;
  if (failed) {
    oldSummary.textContent = `Error: ${failed.message}`;
    oldSummary.style.color = "#c00";
    return;
  }
  // Desactivar variantes de esos productos
  const ids = boxes.map((b) => Number(b.getAttribute("data-id")));
  await supabase.from("product_variants").update({ active: false }).in("product_id", ids);
  oldSummary.textContent = "Archivado completo. Actualizando lista…";
  dataLoaded = false; // Resetear para forzar recarga
  const ok = await load(); // recargar tabla principal
  if (ok) dataLoaded = true;
  await openOldProductsModal(); // reabrir con lista actualizada
});
// No cargar automáticamente al inicio - solo cargar cuando hay filtros o búsqueda
// load(); // Comentado: no cargar automáticamente

// Cargar nombres de productos para autocompletado al iniciar
loadProductNames();

// ========== FUNCIONES DE HISTORIAL DE STOCK ==========

// Cargar historial de stock para un producto
async function loadStockHistory(productId) {
  try {
    const { data: history, error } = await supabase
      .from("stock_history")
      .select(`
        id,
        variant_id,
        size,
        warehouse_id,
        change_type,
        stock_before,
        stock_after,
        quantity_changed,
        from_warehouse_id,
        to_warehouse_id,
        notes,
        created_at,
        product_variants(color, sku),
        warehouse:warehouse_id(code, name),
        from_warehouse:from_warehouse_id(code, name),
        to_warehouse:to_warehouse_id(code, name)
      `)
      .eq("product_id", productId)
      .order("created_at", { ascending: false })
      .limit(500); // Limitar a 500 registros más recientes
    
    if (error) {
      console.error("Error cargando historial de stock:", error);
      return [];
    }
    
    return history || [];
  } catch (err) {
    console.error("Error en loadStockHistory:", err);
    return [];
  }
}

// Mostrar historial de stock en modal
async function showStockHistory(productId, productName) {
  const overlay = document.getElementById("overlay-history");
  const historyTitle = document.getElementById("history-title");
  const historySummary = document.getElementById("history-summary");
  const historyList = document.getElementById("history-list");
  
  if (!overlay || !historyTitle || !historySummary || !historyList) {
    console.error("Elementos del modal de historial no encontrados");
    return;
  }
  
  // Actualizar título
  historyTitle.textContent = `Historial de Stock - ${productName}`;
  historySummary.textContent = "Cargando historial...";
  historyList.innerHTML = "";
  
  // Mostrar modal
  overlay.classList.add("show");
  overlay.setAttribute("aria-hidden", "false");
  
  // Cargar historial
  const history = await loadStockHistory(productId);
  
  if (history.length === 0) {
    historySummary.textContent = "No hay historial de stock registrado para este producto.";
    historyList.innerHTML = "<tr><td colspan='7' style='text-align:center;padding:20px;color:#666;'>No hay registros de historial</td></tr>";
    return;
  }
  
  // Formatear historial
  historySummary.textContent = `${history.length} registro(s) de historial encontrado(s)`;
  
  historyList.innerHTML = history.map(h => {
    const date = new Date(h.created_at);
    const dateStr = date.toLocaleString("es-AR", { 
      year: "numeric", 
      month: "2-digit", 
      day: "2-digit", 
      hour: "2-digit", 
      minute: "2-digit" 
    });
    
    // Determinar tipo de cambio
    let changeTypeLabel = "";
    let changeTypeClass = "";
    switch (h.change_type) {
      case "load":
        changeTypeLabel = "Carga";
        changeTypeClass = "history-load";
        break;
      case "move_to_general":
        changeTypeLabel = "Movimiento → Depósito";
        changeTypeClass = "history-move";
        break;
      case "move_to_venta_publico":
        changeTypeLabel = "Movimiento → Local";
        changeTypeClass = "history-move";
        break;
      case "adjustment":
        changeTypeLabel = "Ajuste";
        changeTypeClass = "history-adjust";
        break;
      default:
        changeTypeLabel = h.change_type || "Cambio";
        changeTypeClass = "history-other";
    }
    
    // Determinar almacén (usar la relación especificada)
    let warehouseLabel = "N/A";
    if (h.warehouse) {
      warehouseLabel = h.warehouse.name || h.warehouse.code || "N/A";
    } else if (h.from_warehouse && h.to_warehouse) {
      // Para movimientos, mostrar ambos almacenes
      const fromName = h.from_warehouse.name || h.from_warehouse.code || "N/A";
      const toName = h.to_warehouse.name || h.to_warehouse.code || "N/A";
      warehouseLabel = `${fromName} → ${toName}`;
    } else if (h.from_warehouse) {
      warehouseLabel = h.from_warehouse.name || h.from_warehouse.code || "N/A";
    } else if (h.to_warehouse) {
      warehouseLabel = h.to_warehouse.name || h.to_warehouse.code || "N/A";
    }
    
    // Variante y talle
    const variantColor = h.product_variants?.color || "N/A";
    const size = h.size || "N/A";
    const variantTalle = `${variantColor}${size !== "N/A" ? ` / Talle ${size}` : ""}`;
    
    // Cambio con signo
    const change = h.quantity_changed || 0;
    const changeStr = change > 0 ? `+${change}` : String(change);
    const changeClass = change > 0 ? "history-positive" : change < 0 ? "history-negative" : "";
    
    return `
      <tr>
        <td style="font-size: 12px; white-space: nowrap;">${dateStr}</td>
        <td><span class="history-badge ${changeTypeClass}">${changeTypeLabel}</span></td>
        <td>${variantTalle}</td>
        <td>${warehouseLabel}</td>
        <td style="text-align: center;">${h.stock_before || 0}</td>
        <td style="text-align: center; font-weight: 600;">${h.stock_after || 0}</td>
        <td style="text-align: center; font-weight: 600;" class="${changeClass}">${changeStr}</td>
      </tr>
    `;
  }).join("");
}

// Event listeners para modal de historial
const closeOverlayHistory = document.getElementById("close-overlay-history");
const overlayHistory = document.getElementById("overlay-history");

if (closeOverlayHistory) {
  closeOverlayHistory.addEventListener("click", () => {
    if (overlayHistory) {
      overlayHistory.classList.remove("show");
      overlayHistory.setAttribute("aria-hidden", "true");
    }
  });
}

if (overlayHistory) {
  overlayHistory.addEventListener("click", (e) => {
    if (e.target === overlayHistory) {
      overlayHistory.classList.remove("show");
      overlayHistory.setAttribute("aria-hidden", "true");
    }
  });
}

// Hacer showStockHistory disponible globalmente
window.showStockHistory = showStockHistory;
