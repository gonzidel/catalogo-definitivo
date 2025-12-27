// admin/stock.js
import { requireAuth } from "./admin-auth.js";
import { supabase } from "../scripts/supabase-client.js";
import { checkPermission, requirePermission } from "./permissions-helper.js";

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
  }
}

await checkStockPermissions();

const tbody = document.querySelector("#tbl tbody");
if (!tbody) {
  console.error("No se encontró el elemento #tbl tbody en el DOM");
  document.body.innerHTML = "<div style='padding:20px;color:red;'>Error: No se encontró la tabla de stock. Por favor, recarga la página.</div>";
  throw new Error("Elemento #tbl tbody no encontrado");
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

let allData = [];
const pendingChanges = new Map(); // id -> { stock_general, stock_venta_publico, price, active }

// Cargar contador de productos incompletos
async function loadIncompleteCount() {
  if (!incompleteAlert || !incompleteCount) {
    console.warn("Elementos de alerta incompleta no encontrados");
    return;
  }
  
  const { count, error } = await supabase
    .from("products")
    .select("id", { count: "exact", head: true })
    .eq("status", "incomplete");
  
  if (error) {
    console.error("Error cargando productos incompletos:", error);
    return;
  }
  
  incompleteCount.textContent = String(count || 0);
  
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

async function load() {
  msg.textContent = "Cargando...";
  tbody.innerHTML = "";
  // Reiniciar pendientes en cada carga/recarga
  pendingChanges.clear();
  setPendingCount();
  
  // Obtener variantes
  const { data: variants, error: variantsError } = await supabase
    .from("product_variants")
    .select("id, sku, color, size, price, active, products(id, name, category, status, created_at, handle)")
    .order("sku", { ascending: true });
  
  if (variantsError) {
    msg.textContent = variantsError.message;
    console.error("Error cargando variantes:", variantsError);
    return;
  }
  
  console.log(`📦 Total variantes cargadas: ${(variants || []).length}`);
  
  // Excluir solo productos archivados - incluir incomplete y active
  const validVariants = (variants || []).filter((r) => {
    const status = r.products?.status;
    const isValid = status && status !== "archived";
    if (!isValid && r.products) {
      console.log(`⚠️ Variante excluida - Producto status: ${status}`, r.products.name);
    }
    return isValid;
  });
  
  console.log(`✅ Variantes válidas (no archivadas): ${validVariants.length}`);
  
  // Obtener IDs de almacenes
  const { data: warehouses, error: warehousesError } = await supabase
    .from("warehouses")
    .select("id, code")
    .in("code", ["general", "venta-publico"]);
  
  if (warehousesError) {
    msg.textContent = `Error cargando almacenes: ${warehousesError.message}`;
    console.error("Error cargando almacenes:", warehousesError);
    return;
  }
  
  const warehouseMap = new Map();
  warehouses.forEach(w => warehouseMap.set(w.code, w.id));
  const generalWarehouseId = warehouseMap.get("general");
  const ventaPublicoWarehouseId = warehouseMap.get("venta-publico");
  
  if (!generalWarehouseId || !ventaPublicoWarehouseId) {
    msg.textContent = "Error: No se encontraron los almacenes necesarios";
    console.error("Almacenes no encontrados:", { generalWarehouseId, ventaPublicoWarehouseId });
    return;
  }
  
  // Obtener stocks por almacén
  const variantIds = validVariants.map(v => v.id);
  const { data: stocks, error: stocksError } = await supabase
    .from("variant_warehouse_stock")
    .select("variant_id, warehouse_id, stock_qty")
    .in("variant_id", variantIds)
    .in("warehouse_id", [generalWarehouseId, ventaPublicoWarehouseId]);
  
  if (stocksError) {
    msg.textContent = `Error cargando stocks: ${stocksError.message}`;
    console.error("Error cargando stocks:", stocksError);
    return;
  }
  
  // Crear mapa de stocks por variante y almacén
  const stockMap = new Map();
  (stocks || []).forEach(s => {
    const key = `${s.variant_id}_${s.warehouse_id}`;
    stockMap.set(key, s.stock_qty || 0);
  });
  
  // Combinar datos: agregar stocks a cada variante
  allData = validVariants.map(v => {
    const stockGeneralKey = `${v.id}_${generalWarehouseId}`;
    const stockVentaPublicoKey = `${v.id}_${ventaPublicoWarehouseId}`;
    const stock_general = stockMap.get(stockGeneralKey) || 0;
    const stock_venta_publico = stockMap.get(stockVentaPublicoKey) || 0;
    const stock_total = stock_general + stock_venta_publico;
    
    return {
      ...v,
      stock_general,
      stock_venta_publico,
      stock_total
    };
  });
  
  console.log(`📊 Status de productos:`, {
    active: allData.filter(r => r.products?.status === 'active').length,
    incomplete: allData.filter(r => r.products?.status === 'incomplete').length,
    other: allData.filter(r => r.products?.status && !['active', 'incomplete'].includes(r.products.status)).length
  });
  
  populateFilters(allData);
  render();
  msg.textContent = `${allData.length} variantes`;
  updateLowAlertBadge();
  await loadIncompleteCount();
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
  return rows.filter((r) => {
    if (term) {
      const hit = [r.sku, r.color, r.size, r.products?.name, r.products?.category]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(term));
      if (!hit) return false;
    }
    if (cat && r.products?.category !== cat) return false;
    if (color && r.color !== color) return false;
    if (size && String(r.size) !== String(size)) return false;
    if (active === "true" && !r.active) return false;
    if (active === "false" && r.active) return false;
    if (onlyLow) {
      // Calcular stock total considerando cambios pendientes
      const change = pendingChanges.get(r.id);
      let stock_total;
      if (change) {
        const stock_general = change.stock_general !== undefined ? change.stock_general : r.stock_general;
        const stock_venta_publico = change.stock_venta_publico !== undefined ? change.stock_venta_publico : r.stock_venta_publico;
        stock_total = (stock_general || 0) + (stock_venta_publico || 0);
      } else {
        stock_total = r.stock_total || 0;
      }
      if (Number(stock_total) > 3) return false;
    }
    return true;
  });
}

function render() {
  tbody.innerHTML = "";
  const rows = applyFilters(allData);
  rows.forEach((r) => {
    const tr = document.createElement("tr");
    const pending = pendingChanges.get(r.id);
    
    // Calcular valores efectivos considerando cambios pendientes
    const stock_general = pending?.stock_general !== undefined ? pending.stock_general : (r.stock_general || 0);
    const stock_venta_publico = pending?.stock_venta_publico !== undefined ? pending.stock_venta_publico : (r.stock_venta_publico || 0);
    const stock_total = stock_general + stock_venta_publico;
    
    const low = Number(stock_total) <= 3;
    if (low) tr.classList.add("low-stock");
    if (pendingChanges.has(r.id)) tr.classList.add("dirty-row");
    
    const effectivePrice = pending?.price ?? r.price ?? 0;
    const priceChanged = pending?.price !== undefined && Number(pending.price) !== Number(r.price ?? 0);
    
    tr.innerHTML = `
      <td>${r.products?.name || ""}</td>
      <td>${r.products?.category || ""}</td>
      <td>${r.sku || ""}</td>
      <td>${r.color || ""}</td>
      <td>${r.size || ""}</td>
      <td class="stock-total-cell" style="font-weight:600;text-align:center;">${stock_total}</td>
      <td><input type="number" min="0" value="${stock_general}" data-id="${r.id}" data-field="stock_general"/></td>
      <td><input type="number" min="0" value="${stock_venta_publico}" data-id="${r.id}" data-field="stock_venta_publico"/></td>
      <td>
        <input type="number" min="0" step="1" value="${effectivePrice}" data-id="${r.id}" data-field="price"/>
        <button class="mini-btn" data-apply-price data-product-id="${r.products?.id ?? ""}" data-source-id="${r.id}" style="display:${priceChanged ? "inline-block" : "none"}">Aplicar a todos</button>
      </td>
      <td class="cell-center"><input type="checkbox" ${pendingChanges.get(r.id)?.active ?? r.active ? "checked" : ""} data-id="${r.id}" data-field="active"/></td>
      <td><button data-save="${r.id}">Guardar</button></td>
    `;
    tbody.appendChild(tr);
  });
  
  // Aplicar permisos después del render
  applyPermissions();
}

function markChange(id, field, value) {
  const base = allData.find((r) => String(r.id) === String(id));
  if (!base) return;
  const current = pendingChanges.get(base.id) || { 
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
    pendingChanges.delete(base.id);
  } else {
    pendingChanges.set(base.id, current);
  }
  setPendingCount();
  
  // Actualizar solo la fila afectada para no perder el foco
  const inputEl = tbody.querySelector(`input[data-id="${id}"][data-field="${field}"]`);
  const tr = inputEl ? inputEl.closest("tr") : null;
  if (tr) {
    tr.classList.toggle("dirty-row", pendingChanges.has(base.id));
    
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

tbody.addEventListener("click", async (e) => {
  // Guardar fila
  const saveBtn = e.target.closest("button[data-save]");
  if (saveBtn) {
    if (!canEditStock) {
      alert("No tienes permiso para editar el stock.");
      return;
    }
    
    const id = saveBtn.getAttribute("data-save");
    const stockGeneral = parseInt(tbody.querySelector(`input[data-id="${id}"][data-field="stock_general"]`).value || "0", 10);
    const stockVentaPublico = parseInt(tbody.querySelector(`input[data-id="${id}"][data-field="stock_venta_publico"]`).value || "0", 10);
    const price = parseFloat(tbody.querySelector(`input[data-id="${id}"][data-field="price"]`).value || "0");
    const active = tbody.querySelector(`input[data-id="${id}"][data-field="active"]`).checked;
    
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
    
    // Actualizar stocks en variant_warehouse_stock
    const updates = [
      supabase
        .from("variant_warehouse_stock")
        .upsert({ variant_id: id, warehouse_id: generalWarehouseId, stock_qty: stockGeneral }, { onConflict: "variant_id,warehouse_id" }),
      supabase
        .from("variant_warehouse_stock")
        .upsert({ variant_id: id, warehouse_id: ventaPublicoWarehouseId, stock_qty: stockVentaPublico }, { onConflict: "variant_id,warehouse_id" }),
      supabase
        .from("product_variants")
        .update({ price, active })
        .eq("id", id)
    ];
    
    const results = await Promise.all(updates);
    const error = results.find((r) => r.error)?.error;
    
    saveBtn.disabled = false;
    if (!error) {
      const row = allData.find((r) => String(r.id) === String(id));
      if (row) {
        row.stock_general = stockGeneral;
        row.stock_venta_publico = stockVentaPublico;
        row.stock_total = stockGeneral + stockVentaPublico;
        row.price = price;
        row.active = active;
      }
      pendingChanges.delete(Number(id));
      setPendingCount();
      render();
    }
    msg.textContent = error ? `Error: ${error.message}` : "Guardado";
    return;
  }
  // Aplicar precio a todas las variantes del producto
  const applyBtn = e.target.closest("button[data-apply-price]");
  if (applyBtn) {
    const productId = applyBtn.getAttribute("data-product-id");
    const sourceId = applyBtn.getAttribute("data-source-id");
    const sourceInput = tbody.querySelector(`input[data-id="${sourceId}"][data-field="price"]`);
    const targetPrice = parseFloat(sourceInput?.value || "0");
    if (!Number.isFinite(targetPrice)) return;
    const variants = allData.filter((r) => String(r.products?.id) === String(productId));
    variants.forEach((r) => {
      const change = pendingChanges.get(r.id) || { 
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
        pendingChanges.delete(r.id);
      } else {
        pendingChanges.set(r.id, change);
      }
      // Reflejar en input visible si está en el DOM
      const input = tbody.querySelector(`input[data-id="${r.id}"][data-field="price"]`);
      if (input) input.value = String(targetPrice);
      const rowEl = input ? input.closest("tr") : null;
      if (rowEl) rowEl.classList.add("dirty-row");
    });
    setPendingCount();
    // Actualizar visibilidad de botones "Aplicar a todos"
    tbody.querySelectorAll("button[data-apply-price]").forEach((b) => {
      const sid = b.getAttribute("data-source-id");
      const base = allData.find((r) => String(r.id) === String(sid));
      const pending = pendingChanges.get(Number(sid));
      const changed = pending && Number(pending.price ?? 0) !== Number(base?.price ?? 0);
      b.style.display = changed ? "inline-block" : "none";
    });
    msg.textContent = `Precio aplicado a ${variants.length} variantes`;
  }
});

// Cambios en vivo en inputs -> marcar como pendiente
tbody.addEventListener("input", (e) => {
  if (!canEditStock) {
    e.target.value = e.target.defaultValue;
    if (e.target.type === "checkbox") {
      e.target.checked = e.target.defaultChecked;
    }
    alert("No tienes permiso para editar el stock.");
    return;
  }
  
  const input = e.target.closest("input[data-id]");
  if (!input) return;
  const id = input.getAttribute("data-id");
  const field = input.getAttribute("data-field");
  let value;
  if (field === "active") {
    value = input.checked;
  } else {
    value = field === "price" ? parseFloat(input.value || "0") : parseInt(input.value || "0", 10);
    if (!Number.isFinite(value) || value < 0) value = 0;
  }
  markChange(id, field, value);
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
  
  // Preparar todas las actualizaciones
  const updates = [];
  const variantUpdates = [];
  
  pendingChanges.forEach((change, id) => {
    // Actualizar stocks en variant_warehouse_stock
    if (change.stock_general !== undefined) {
      updates.push(
        supabase
          .from("variant_warehouse_stock")
          .upsert({ variant_id: id, warehouse_id: generalWarehouseId, stock_qty: change.stock_general }, { onConflict: "variant_id,warehouse_id" })
      );
    }
    if (change.stock_venta_publico !== undefined) {
      updates.push(
        supabase
          .from("variant_warehouse_stock")
          .upsert({ variant_id: id, warehouse_id: ventaPublicoWarehouseId, stock_qty: change.stock_venta_publico }, { onConflict: "variant_id,warehouse_id" })
      );
    }
    
    // Actualizar precio y activo en product_variants
    const variantUpdate = {};
    if (change.price !== undefined) variantUpdate.price = change.price;
    if (change.active !== undefined) variantUpdate.active = change.active;
    
    if (Object.keys(variantUpdate).length > 0) {
      variantUpdates.push(
        supabase.from("product_variants").update(variantUpdate).eq("id", id)
      );
    }
  });
  
  const allUpdates = [...updates, ...variantUpdates];
  const results = await Promise.all(allUpdates);
  const error = results.find((r) => r.error)?.error;
  
  if (!error) {
    // Aplicar cambios a cache y limpiar pendientes
    pendingChanges.forEach((change, id) => {
      const row = allData.find((r) => String(r.id) === String(id));
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

reloadBtn.addEventListener("click", load);
q.addEventListener("input", render);
fCategory.addEventListener("change", render);
fColor.addEventListener("change", render);
fSize.addEventListener("change", render);
fActive.addEventListener("change", render);
fLow.addEventListener("change", render);
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
  await load(); // recargar tabla principal
  await openOldProductsModal(); // reabrir con lista actualizada
});
load();
