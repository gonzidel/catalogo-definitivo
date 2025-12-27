// admin/products.js
import { supabase } from "../scripts/supabase-client.js";

console.log("🔧 products.js cargado");

// Verificación simple de autenticación sin bloquear
let __currentUser = null;
async function checkAuth() {
  try {
    const { data } = await supabase.auth.getSession();
    if (data?.session) {
      __currentUser = data.session.user;
      console.log("✅ Usuario autenticado:", __currentUser?.email);
      return true;
    } else {
      console.log("⚠️ No hay sesión activa");
      return false;
    }
  } catch (e) {
    console.log("⚠️ Error de autenticación:", e.message);
    return false;
  }
}

// Verificar autenticación sin bloquear
checkAuth();

const form = document.getElementById("product-form");
let isSaving = false;
const statusEl = document.getElementById("save-status");
const variantsTable = document.querySelector("#variants-table tbody");
const addVariantBtn = document.getElementById("add-variant");

console.log("🔍 Elementos encontrados:", {
  form: !!form,
  statusEl: !!statusEl,
  variantsTable: !!variantsTable,
  addVariantBtn: !!addVariantBtn,
  supabase: !!supabase,
});

// Search / load controls
const pSearch = document.getElementById("p-search");
const pSearchBtn = document.getElementById("p-search-btn");
const pResults = document.getElementById("p-results");
const pLoad = document.getElementById("p-load");
const pNew = document.getElementById("p-new");
const productsDatalist = document.getElementById("products-datalist");
const pDelete = document.getElementById("p-delete");

// Autocompletar para buscador de productos
let lastProductSuggestions = [];
function productLabel(p) {
  const name = p.name || "(sin nombre)";
  const handle = p.handle || "";
  const cat = p.category ? ` (${p.category})` : "";
  return `${name} — ${handle}${cat}`.trim();
}
function debounce(fn, wait = 300) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

let currentProductId = null;
let originalVariantIds = new Set();

// Helpers: slug & SKU base
let COLORS = [];
let TAGS = [];
// Cache de proveedores: Map<supplierId, supplierCode>
let SUPPLIERS_CACHE = new Map();

// Funciones para gestionar talles recurrentes (localStorage)
const SIZES_STORAGE_KEY = "product_recurrent_sizes";

function getSavedSizes() {
  try {
    const saved = localStorage.getItem(SIZES_STORAGE_KEY);
    return saved ? JSON.parse(saved) : [];
  } catch (e) {
    console.warn("Error cargando talles guardados:", e);
    return [];
  }
}

function saveSizesSet(sizesStr, name = null) {
  if (!sizesStr || !sizesStr.trim()) {
    alert("No hay talles para guardar");
    return false;
  }
  
  const sizes = sizesStr.split(",").map(s => s.trim()).filter(Boolean);
  if (sizes.length === 0) {
    alert("No hay talles válidos para guardar");
    return false;
  }
  
  const saved = getSavedSizes();
  const sizesKey = sizes.sort().join(",");
  
  // Verificar si ya existe
  const exists = saved.find(s => s.sizes === sizesKey);
  if (exists) {
    if (confirm(`Los talles "${sizesKey}" ya están guardados. ¿Querés actualizar el nombre?`)) {
      const newName = name || prompt("Nombre para estos talles:", exists.name || sizesKey);
      if (newName) {
        exists.name = newName.trim();
        exists.updatedAt = new Date().toISOString();
      } else {
        return false;
      }
    } else {
      return false;
    }
  } else {
    // Solicitar nombre si no se proporcionó
    if (!name) {
      const newName = prompt("Nombre para estos talles:", sizesKey);
      if (!newName) return false;
      name = newName.trim();
    }
    
    saved.push({
      name: name,
      sizes: sizesKey,
      sizesArray: sizes,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
  }
  
  try {
    localStorage.setItem(SIZES_STORAGE_KEY, JSON.stringify(saved));
    return true;
  } catch (e) {
    console.error("Error guardando talles:", e);
    alert("Error al guardar los talles");
    return false;
  }
}

function deleteSizesSet(sizesKey) {
  const saved = getSavedSizes();
  const filtered = saved.filter(s => s.sizes !== sizesKey);
  try {
    localStorage.setItem(SIZES_STORAGE_KEY, JSON.stringify(filtered));
    return true;
  } catch (e) {
    console.error("Error eliminando talles:", e);
    return false;
  }
}

function refreshSizesPresets(selectEl) {
  if (!selectEl) return;
  
  const saved = getSavedSizes();
  const currentValue = selectEl.value;
  
  selectEl.innerHTML = '<option value="">Talles guardados...</option>';
  
  saved.forEach(item => {
    const opt = document.createElement("option");
    opt.value = item.sizes;
    opt.textContent = `${item.name} (${item.sizesArray.join(", ")})`;
    opt.dataset.sizesArray = JSON.stringify(item.sizesArray);
    selectEl.appendChild(opt);
  });
  
  // Agregar opción para eliminar (si hay items guardados)
  if (saved.length > 0) {
    const hr = document.createElement("option");
    hr.disabled = true;
    hr.textContent = "──────────";
    selectEl.appendChild(hr);
    
    saved.forEach(item => {
      const opt = document.createElement("option");
      opt.value = `DELETE:${item.sizes}`;
      opt.textContent = `🗑️ Eliminar: ${item.name}`;
      selectEl.appendChild(opt);
    });
  }
  
  // Restaurar selección si existe
  if (currentValue && [...selectEl.options].some(o => o.value === currentValue)) {
    selectEl.value = currentValue;
  }
}

const colorMap = {
  negro: "NEG",
  suela: "SUE",
  suelaa: "SUE",
  blanco: "BLA",
  beige: "BEI",
  marron: "MAR",
  marrón: "MAR",
  rojo: "ROJ",
  azul: "AZU",
  azulmarino: "AZM",
  marino: "MAR",
  verde: "VER",
  gris: "GRI",
  lila: "LIL",
  rosa: "ROS",
  dorado: "DOR",
  plateado: "PLA",
  nude: "NUD",
};

function slugify(str) {
  return (str || "")
    .toString()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)+/g, "");
}

function colorCode(color) {
  if (!color) return "CLR";
  const found = COLORS.find(
    (c) => c.name?.toLowerCase() === color.toString().toLowerCase()
  );
  if (found?.code) return found.code.toUpperCase();
  const k = color.toString().toLowerCase().replace(/\s+/g, "");
  if (colorMap[k]) return colorMap[k];
  return (
    k
      .replace(/[^a-z]/g, "")
      .slice(0, 3)
      .toUpperCase() || "CLR"
  );
}

// Obtener código del proveedor (con cache)
async function getSupplierCode(supplierId) {
  if (!supplierId) return null;
  
  // Verificar cache primero
  if (SUPPLIERS_CACHE.has(supplierId)) {
    return SUPPLIERS_CACHE.get(supplierId);
  }
  
  try {
    const { data, error } = await supabase
      .from("suppliers")
      .select("code")
      .eq("id", supplierId)
      .single();
    
    if (error || !data) {
      console.warn("No se pudo obtener código del proveedor:", error?.message);
      return null;
    }
    
    const code = data.code || null;
    // Guardar en cache
    if (code) {
      SUPPLIERS_CACHE.set(supplierId, code);
    }
    return code;
  } catch (e) {
    console.warn("Error obteniendo código del proveedor:", e);
    return null;
  }
}

function makeSkuBase(handle, color, supplierCode = null) {
  const h = (handle || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
  const colorPart = colorCode(color);
  
  // Si hay código de proveedor, agregarlo al inicio
  if (supplierCode) {
    const prov = (supplierCode || "").toUpperCase().trim();
    if (prov) {
      return `${prov}-${h}-${colorPart}`;
    }
  }
  
  // Formato sin proveedor (comportamiento original)
  return `${h}-${colorPart}`;
}

// ----- Precio ARS helpers -----
function digitsOnly(str) {
  return (str || "").toString().replace(/\D+/g, "");
}

function parseARS(str) {
  const d = digitsOnly(str);
  return d ? parseInt(d, 10) : 0;
}

function formatARS(value) {
  const n = Math.round(Number(value) || 0);
  const s = n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `$${s}`;
}

function attachPriceFormatter(input) {
  // Formateo inicial
  input.value = formatARS(parseARS(input.value));
  input.addEventListener("focus", () => {
    input.value = digitsOnly(input.value);
  });
  input.addEventListener("blur", () => {
    input.value = formatARS(parseARS(input.value));
  });
  input.addEventListener("input", () => {
    const raw = digitsOnly(input.value);
    input.value = raw;
  });
}

// ----- Funciones de cálculo de precio recomendado -----
function roundToNearest100(value) {
  const num = Number(value) || 0;
  if (num <= 0) return 0;
  // Redondear hacia arriba al próximo múltiplo de 100
  return Math.ceil(num / 100) * 100;
}

function calculateRecommendedPrice(cost, percentage, logisticAmount) {
  const costNum = Number(cost) || 0;
  const percentageNum = Number(percentage) || 0;
  const logisticNum = Number(parseARS(logisticAmount)) || 0;
  
  if (costNum <= 0) return 0;
  
  // Fórmula: costo + (costo * porcentaje/100) + monto_logistico
  const calculated = costNum + (costNum * percentageNum / 100) + logisticNum;
  
  // Redondear hacia arriba al múltiplo de 100 más cercano
  return roundToNearest100(calculated);
}

// Auto-handle from name unless user edits handle
const nameEl = document.getElementById("name");
const handleEl = document.getElementById("handle");
let handleDirty = false;
handleEl?.addEventListener("input", () => (handleDirty = true));
nameEl?.addEventListener("input", async () => {
  if (!handleDirty) {
    handleEl.value = slugify(nameEl.value);
    // Update SKU bases in existing rows when handle changes automatically
    const supplierEl = document.getElementById("supplier");
    const supplierId = supplierEl?.value || "";
    const supplierCode = supplierId ? await getSupplierCode(supplierId) : null;
    
    variantsTable.querySelectorAll("tr").forEach((tr) => {
      const color = tr.querySelector(".v-color")?.value || "";
      const skuBaseEl = tr.querySelector(".v-skuBase");
      if (skuBaseEl && !skuBaseEl.dataset.dirty) {
        skuBaseEl.value = makeSkuBase(handleEl.value, color, supplierCode);
      }
    });
  }
});

// Agregar "R " automáticamente cuando el usuario sale del campo nombre si la categoría es Ropa
nameEl?.addEventListener("blur", () => {
  const categoryEl = document.getElementById("category");
  if (categoryEl?.value === "Ropa") {
    const currentName = nameEl.value.trim();
    // Solo agregar si hay texto y no comienza con "R "
    if (currentName && !currentName.startsWith("R ")) {
      nameEl.value = "R " + currentName;
      // Actualizar handle si no fue editado manualmente
      if (!handleDirty) {
        handleEl.value = slugify(nameEl.value);
      }
    }
  }
});

function refreshColorDatalist() {
  const datalist = document.getElementById("colors-datalist");
  if (!datalist) return;
  datalist.innerHTML = (COLORS || [])
    .map((c) => `<option value="${c.name}">${c.code || ""}</option>`)
    .join("");
}

async function loadColors() {
  try {
    const { data, error } = await supabase
      .from("colors")
      .select("name, code")
      .order("name");
    if (error) {
      console.warn("No se pudieron cargar colores:", error.message);
      return;
    }
    if (Array.isArray(data)) {
      COLORS = data;
      refreshColorDatalist();
    }
  } catch (e) {
    console.warn("Error cargando colores", e);
  }
}

function refreshTagsDatalist() {
  const dl = document.getElementById("tags-datalist");
  if (!dl) return;
  dl.innerHTML = (TAGS || [])
    .map((t) => `<option value="${t.name}"></option>`)
    .join("");
}

async function loadTags() {
  try {
    const { data, error } = await supabase
      .from("tags")
      .select("id, name")
      .order("name");
    if (!error && Array.isArray(data)) {
      TAGS = data;
      refreshTagsDatalist();
    }
  } catch (e) {
    console.warn("Error cargando tags", e);
  }
}

async function loadSuppliers() {
  try {
    const { data, error } = await supabase
      .from("suppliers")
      .select("id, name, code")
      .order("name");
    if (error) {
      console.warn("No se pudieron cargar proveedores:", error.message);
      return;
    }
    if (Array.isArray(data)) {
      // Poblar cache de proveedores
      SUPPLIERS_CACHE.clear();
      data.forEach(s => {
        if (s.id && s.code) {
          SUPPLIERS_CACHE.set(s.id, s.code);
        }
      });
      
      const supplierSelect = document.getElementById("supplier");
      if (supplierSelect) {
        const currentValue = supplierSelect.value; // Guardar selección actual
        const base = '<option value="">Sin proveedor</option>';
        supplierSelect.innerHTML = base + data.map(s => 
          `<option value="${s.id}">${s.name}</option>`
        ).join("");
        // Restaurar selección si existe
        if (currentValue && [...supplierSelect.options].some(o => o.value === currentValue)) {
          supplierSelect.value = currentValue;
        }
        // Actualizar visibilidad del botón de editar
        updateEditButtonVisibility();
      }
    }
  } catch (e) {
    console.warn("Error cargando proveedores", e);
  }
}

// Crear nuevo proveedor
async function createNewSupplier() {
  const nameInput = document.getElementById("new-supplier-name");
  const codeInput = document.getElementById("new-supplier-code");
  const name = (nameInput?.value || "").trim();
  let code = (codeInput?.value || "").trim();
  
  if (!name) {
    alert("El nombre del proveedor es obligatorio");
    nameInput?.focus();
    return null;
  }
  
  // Generar código automáticamente si no se proporciona
  if (!code) {
    // Crear código a partir del nombre (primeras 3 letras en mayúsculas)
    code = name
      .substring(0, 3)
      .toUpperCase()
      .replace(/[^A-Z]/g, "");
    
    // Si el código queda vacío, usar las primeras letras
    if (!code) {
      code = name
        .split(" ")
        .map(word => word.charAt(0))
        .join("")
        .substring(0, 3)
        .toUpperCase() || "PRV";
    }
    
    // Verificar que el código no exista ya
    const { data: existing } = await supabase
      .from("suppliers")
      .select("code")
      .eq("code", code)
      .maybeSingle();
    
    if (existing) {
      // Si existe, agregar número
      let counter = 1;
      let newCode = code + counter;
      while (true) {
        const { data: check } = await supabase
          .from("suppliers")
          .select("code")
          .eq("code", newCode)
          .maybeSingle();
        if (!check) break;
        counter++;
        newCode = code + counter;
      }
      code = newCode;
    }
  }
  
  try {
    const supplierData = {
      name: name,
      code: code
    };
    
    const { data, error } = await supabase
      .from("suppliers")
      .insert([supplierData])
      .select("id, name, code")
      .single();
    
    if (error) {
      console.error("Error creando proveedor:", error);
      if (error.code === "23505") { // Violación de unicidad
        alert("Ya existe un proveedor con ese código. Por favor, ingresa un código diferente.");
      } else {
        alert(`Error al crear proveedor: ${error.message}`);
      }
      return null;
    }
    
    // Limpiar formulario
    if (nameInput) nameInput.value = "";
    if (codeInput) codeInput.value = "";
    
    // Ocultar formulario
    const form = document.getElementById("new-supplier-form");
    if (form) form.style.display = "none";
    
    // Recargar lista de proveedores (esto también actualiza el cache)
    await loadSuppliers();
    
    // Seleccionar el proveedor recién creado
    const supplierSelect = document.getElementById("supplier");
    if (supplierSelect && data) {
      supplierSelect.value = data.id;
      // Recalcular SKU bases con el nuevo proveedor
      await recalculateAllSkuBases();
    }
    
    return data;
  } catch (e) {
    console.error("Error creando proveedor:", e);
    alert(`Error al crear proveedor: ${e.message}`);
    return null;
  }
}

function addVariantRow(prefill = {}) {
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td>
      <div style="display:flex;gap:4px;align-items:center;">
        <input class="v-color" placeholder="Negro" value="${
          prefill.color ?? ""
        }" list="colors-datalist" style="flex:1;padding:4px;font-size:11px"/>
        <button type="button" class="color-menu-btn" title="Colores" style="padding:4px 6px;font-size:11px">▼</button>
      </div>
      <div class="color-menu" style="display:none;position:absolute;background:#fff;border:1px solid #ddd;border-radius:4px;padding:6px;box-shadow:0 2px 8px rgba(0,0,0,.1);z-index:10;font-size:11px">
        <div class="color-list"></div>
        <hr style="margin:4px 0"/>
        <div style="display:flex;gap:4px;align-items:center;">
          <input class="new-color-name" placeholder="Nuevo color" style="flex:1;padding:4px;font-size:11px"/>
          <input class="new-color-code" placeholder="COD" style="width:60px;padding:4px;font-size:11px"/>
          <button type="button" class="add-color" style="padding:4px 8px;font-size:11px">Agregar</button>
        </div>
        <small style="color:#666;font-size:10px">Si dejás COD vacío, se autogenera.</small>
      </div>
    </td>
    <td>
      <div class="sizes-editor">
        <div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;">
          <select class="sizes-presets" style="flex:0 0 auto;min-width:100px;padding:4px;font-size:11px">
            <option value="">Talles guardados...</option>
          </select>
          <input class="v-sizes" placeholder="35,36,37" style="flex:1;min-width:120px;padding:4px;font-size:11px" />
          <button type="button" class="sizes-generate" style="padding:4px 8px;font-size:11px;white-space:nowrap">Generar</button>
          <button type="button" class="sizes-save" style="padding:4px 8px;font-size:11px;white-space:nowrap" title="Guardar estos talles">💾</button>
        </div>
        <div class="sizes-list" style="display:flex;gap:6px;flex-wrap:wrap;margin-top:4px;"></div>
        <small style="color:#666;font-size:10px;line-height:1.2;display:block;margin-top:2px">Tip: ingresá talles separados por coma y tocá Generar. Seleccioná talles guardados del menú. O usá el campo de abajo para modo simple.</small>
        <div style="margin-top:4px">
          <label style="font-size:11px">Talle (modo simple): <input class="v-size" placeholder="35" value="${
            prefill.size ?? ""
          }" style="width:70px;padding:4px;font-size:11px"/></label>
        </div>
      </div>
    </td>
    <td><input class="v-skuBase" placeholder="ZAP343-NEG" value="${
      prefill.skuBase ?? ""
    }" style="padding:4px;font-size:11px"/></td>
    <td><input class="v-cost" type="text" inputmode="numeric" value="${
      prefill.cost ?? ""
    }" placeholder="0" style="padding:4px;font-size:11px"/></td>
    <td><input class="v-price" type="text" inputmode="numeric" value="${
      prefill.price ?? 0
    }" style="padding:4px;font-size:11px"/></td>
    <td><input class="v-stock" type="number" step="1" value="${
      prefill.stock_qty ?? 0
    }" style="padding:4px;font-size:11px"/></td>
    <td style="text-align:center;"><input class="v-active" type="checkbox" ${
      prefill.active === false ? "" : "checked"
    }/></td>
    <td><textarea class="v-images" rows="2" placeholder="https://...\nhttps://..." style="padding:4px;font-size:11px;min-height:50px">${(
      prefill.images || []
    ).join("\n")}</textarea></td>
    <td><button type="button" class="rm" style="padding:4px 8px;font-size:12px;min-width:auto">✕</button></td>
    <input class="v-sku" type="hidden" value="${prefill.sku ?? ""}" />
  `;
  if (prefill.id) tr.dataset.variantId = prefill.id;
  tr.querySelector(".rm").addEventListener("click", () => tr.remove());
  
  // Cargar talles guardados en el dropdown
  const sizesPresetsSelect = tr.querySelector(".sizes-presets");
  refreshSizesPresets(sizesPresetsSelect);
  
  // Handler para seleccionar talles guardados
  if (sizesPresetsSelect) {
    sizesPresetsSelect.addEventListener("change", (e) => {
      const value = e.target.value;
      if (!value) return;
      
      if (value.startsWith("DELETE:")) {
        // Eliminar conjunto de talles
        const sizesKey = value.replace("DELETE:", "");
        const saved = getSavedSizes();
        const item = saved.find(s => s.sizes === sizesKey);
        if (item && confirm(`¿Eliminar los talles guardados "${item.name}"?`)) {
          deleteSizesSet(sizesKey);
          refreshSizesPresets(sizesPresetsSelect);
          // Recargar en todas las filas
          variantsTable.querySelectorAll(".sizes-presets").forEach(sel => refreshSizesPresets(sel));
          e.target.value = "";
        } else {
          e.target.value = "";
        }
        return;
      }
      
      // Cargar talles seleccionados
      const saved = getSavedSizes();
      const item = saved.find(s => s.sizes === value);
      if (item && item.sizesArray) {
        const sizesInput = tr.querySelector(".v-sizes");
        if (sizesInput) {
          sizesInput.value = item.sizesArray.join(", ");
          generate();
        }
        e.target.value = ""; // Resetear selección
      }
    });
  }
  
  // Handler para guardar talles
  const saveSizesBtn = tr.querySelector(".sizes-save");
  if (saveSizesBtn) {
    saveSizesBtn.addEventListener("click", () => {
      const sizesInput = tr.querySelector(".v-sizes");
      const sizesStr = sizesInput?.value?.trim() || "";
      
      if (!sizesStr) {
        alert("Primero ingresá los talles que querés guardar");
        sizesInput?.focus();
        return;
      }
      
      if (saveSizesSet(sizesStr)) {
        // Recargar dropdowns en todas las filas
        variantsTable.querySelectorAll(".sizes-presets").forEach(sel => refreshSizesPresets(sel));
        statusEl.textContent = "Talles guardados correctamente";
        statusEl.style.color = "#090";
        setTimeout(() => {
          statusEl.textContent = "";
        }, 2000);
      }
    });
  }
  
  // sizes generate handler
  const generate = () => {
    const sizesStr = tr.querySelector(".v-sizes").value.trim();
    const list = tr.querySelector(".sizes-list");
    list.innerHTML = "";
    if (!sizesStr) return;
    const sizes = sizesStr
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    sizes.forEach((s) => {
      const box = document.createElement("div");
      box.style =
        "display:flex;flex-direction:column;align-items:center;gap:2px;padding:4px;border:1px solid #ddd;border-radius:4px;min-width:50px;";
      box.innerHTML = `
        <strong style="font-size:11px">${s}</strong>
        <input type="number" class="size-stock" data-size="${s}" min="0" value="0" style="width:50px;padding:3px;font-size:11px" placeholder="Stock"/>
      `;
      list.appendChild(box);
    });
    console.log("🔧 Talles generados:", sizes);
  };
  tr.querySelector(".sizes-generate").addEventListener("click", generate);
  tr.querySelector(".v-sizes").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      generate();
    }
  });
  // Auto SKU base when color changes (unless manually edited)
  const skuBaseEl = tr.querySelector(".v-skuBase");
  skuBaseEl?.addEventListener("input", () => (skuBaseEl.dataset.dirty = "1"));
  const colorEl = tr.querySelector(".v-color");
  const supplierEl = document.getElementById("supplier");
  const maybeFillSkuBase = async () => {
    if (!skuBaseEl) return;
    if (!skuBaseEl.dataset.dirty || skuBaseEl.value.trim() === "") {
      const handle = handleEl?.value || "";
      const color = colorEl?.value || "";
      const supplierId = supplierEl?.value || "";
      
      // Obtener código del proveedor si existe
      const supplierCode = supplierId ? await getSupplierCode(supplierId) : null;
      
      skuBaseEl.value = makeSkuBase(handle, color, supplierCode);
    }
  };
  colorEl?.addEventListener("input", maybeFillSkuBase);
  // Initial fill
  maybeFillSkuBase();

  // Color menu logic
  const menuBtn = tr.querySelector(".color-menu-btn");
  const menu = tr.querySelector(".color-menu");
  const list = tr.querySelector(".color-list");
  const rebuildList = () => {
    list.innerHTML = "";
    COLORS.forEach((c) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = c.name + (c.code ? ` (${c.code})` : "");
      b.style =
        "display:block;width:100%;text-align:left;padding:4px 6px;margin:2px 0;";
      b.addEventListener("click", () => {
        colorEl.value = c.name;
        maybeFillSkuBase();
        menu.style.display = "none";
      });
      list.appendChild(b);
    });
    if (!COLORS.length) {
      const empty = document.createElement("div");
      empty.textContent = "Sin colores cargados";
      empty.style.color = "#666";
      list.appendChild(empty);
    }
  };
  rebuildList();
  menuBtn?.addEventListener("click", () => {
    rebuildList();
    // Position menu under the button
    const rect = menuBtn.getBoundingClientRect();
    menu.style.left = rect.left + "px";
    menu.style.top = rect.bottom + window.scrollY + "px";
    menu.style.display = menu.style.display === "none" ? "block" : "none";
  });
  document.addEventListener("click", (e) => {
    if (!menu.contains(e.target) && e.target !== menuBtn)
      menu.style.display = "none";
  });
  tr.querySelector(".add-color")?.addEventListener("click", async () => {
    const name = tr.querySelector(".new-color-name").value.trim();
    let code = tr.querySelector(".new-color-code").value.trim().toUpperCase();
    if (!name) return;
    if (!code) code = colorCode(name);
    try {
      const { data, error } = await supabase
        .from("colors")
        .insert([{ name, code }])
        .select("name, code")
        .single();
      if (error) {
        statusEl.textContent = `No se pudo guardar el color: ${error.message}`;
        statusEl.style.color = "#c00";
        return;
      }
      if (data) {
        COLORS.push(data);
        refreshColorDatalist();
        colorEl.value = data.name;
        maybeFillSkuBase();
        rebuildList();
      }
    } catch (e) {
      statusEl.textContent = `Error al guardar color`;
      statusEl.style.color = "#c00";
    }
  });

  // Cost formatter
  const costEl = tr.querySelector(".v-cost");
  if (costEl) attachPriceFormatter(costEl);
  
  // Price formatter
  const priceEl = tr.querySelector(".v-price");
  if (priceEl) attachPriceFormatter(priceEl);
  
  // Función para recalcular precio recomendado
  const recalculatePrice = () => {
    const cost = parseARS(costEl?.value || "0");
    const percentage = parseFloat(document.getElementById("price-percentage")?.value || "30");
    const logisticAmount = document.getElementById("logistic-amount")?.value || "500";
    
    if (cost > 0 && priceEl) {
      const recommended = calculateRecommendedPrice(cost, percentage, logisticAmount);
      // Solo actualizar si el precio actual está vacío o coincide con un valor calculado anterior
      // Esto permite que el usuario edite manualmente el precio
      const currentPrice = parseARS(priceEl.value || "0");
      if (currentPrice === 0 || currentPrice === recommended || priceEl.dataset.autoCalculated === "true") {
        priceEl.value = formatARS(recommended);
        priceEl.dataset.autoCalculated = "true";
      }
    }
  };
  
  // Event listeners para recalcular precio
  costEl?.addEventListener("input", recalculatePrice);
  costEl?.addEventListener("blur", recalculatePrice);
  
  // Marcar precio como editado manualmente cuando el usuario lo modifica
  priceEl?.addEventListener("input", () => {
    // Si el usuario está editando, desmarcar como auto-calculado
    // pero solo si realmente está cambiando el valor
    const currentValue = parseARS(priceEl.value || "0");
    const cost = parseARS(costEl?.value || "0");
    if (cost > 0) {
      const percentage = parseFloat(document.getElementById("price-percentage")?.value || "30");
      const logisticAmount = document.getElementById("logistic-amount")?.value || "500";
      const expected = calculateRecommendedPrice(cost, percentage, logisticAmount);
      // Si el valor actual no coincide con el esperado, es una edición manual
      if (currentValue !== expected && currentValue > 0) {
        priceEl.dataset.autoCalculated = "false";
      }
    }
  });
  
  // Build images inputs UI next to textarea
  (function () {
    const oldTa = tr.querySelector(".v-images");
    if (!oldTa) return;
    const cell = oldTa.parentElement;
    const listEl = document.createElement("div");
    listEl.className = "v-images-list";
    listEl.style.display = "flex";
    listEl.style.flexDirection = "column";
    listEl.style.gap = "4px";
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "img-add";
    addBtn.textContent = "+ Agregar imagen";
    addBtn.style.padding = "4px 8px";
    addBtn.style.fontSize = "11px";
    const addImageField = (val = "") => {
      const wrap = document.createElement("div");
      wrap.style.display = "flex";
      wrap.style.gap = "4px";
      wrap.style.alignItems = "center";
      const input = document.createElement("input");
      input.type = "url";
      input.placeholder = "https://...";
      input.value = val;
      input.style.flex = "1";
      input.style.padding = "4px";
      input.style.fontSize = "11px";
      const thumb = document.createElement("img");
      thumb.style.width = "40px";
      thumb.style.height = "40px";
      thumb.style.objectFit = "cover";
      thumb.style.border = "1px solid #ddd";
      thumb.style.borderRadius = "4px";
      thumb.style.display = val ? "block" : "none";
      const rm = document.createElement("button");
      rm.type = "button";
      rm.textContent = "✕";
      rm.title = "Quitar";
      rm.style.padding = "4px 6px";
      rm.style.fontSize = "11px";
      rm.addEventListener("click", () => wrap.remove());
      const updateThumb = () => {
        const url = (input.value || "").trim();
        if (!url) {
          thumb.style.display = "none";
          return;
        }
        thumb.src = url;
        thumb.onload = () => {
          thumb.style.display = "block";
          thumb.style.borderColor = "#ddd";
        };
        thumb.onerror = () => {
          thumb.style.display = "block";
          thumb.style.borderColor = "#c00";
        };
      };
      input.addEventListener("input", updateThumb);
      updateThumb();
      wrap.appendChild(input);
      wrap.appendChild(thumb);
      wrap.appendChild(rm);
      listEl.appendChild(wrap);
    };
    const images =
      prefill && Array.isArray(prefill.images) && prefill.images.length
        ? prefill.images
        : ["", "", ""];
    images.forEach((u) => addImageField(u));
    addBtn.addEventListener("click", () => addImageField(""));
    cell.insertBefore(listEl, oldTa);
    cell.insertBefore(addBtn, oldTa.nextSibling);
    oldTa.style.display = "none";
  })();
  variantsTable.appendChild(tr);
}

addVariantBtn.addEventListener("click", () => {
  console.log("🚀 Botón Agregar variante presionado");
  addVariantRow();
});

// Función para asegurar que siempre haya al menos una variante
function ensureDefaultVariant() {
  const existingRows = variantsTable.querySelectorAll("tr");
  console.log("🔍 Verificando variantes existentes:", existingRows.length);
  if (existingRows.length === 0) {
    console.log("📝 Agregando variante por defecto");
    addVariantRow();
  } else {
    console.log("✅ Ya hay variantes existentes");
  }
}

// Función para recalcular todos los precios recomendados
function recalculateAllRecommendedPrices() {
  const percentage = parseFloat(document.getElementById("price-percentage")?.value || "30");
  const logisticAmount = document.getElementById("logistic-amount")?.value || "500";
  
  const rows = variantsTable.querySelectorAll("tr");
  rows.forEach((row) => {
    const costEl = row.querySelector(".v-cost");
    const priceEl = row.querySelector(".v-price");
    
    if (costEl && priceEl) {
      const cost = parseARS(costEl.value || "0");
      if (cost > 0) {
        const recommended = calculateRecommendedPrice(cost, percentage, logisticAmount);
        // Solo actualizar si el precio fue calculado automáticamente
        if (priceEl.dataset.autoCalculated === "true") {
          priceEl.value = formatARS(recommended);
        }
      }
    }
  });
}

// arranque con una fila
await loadColors();
await loadTags();
await loadSuppliers();

// Event listeners para campos globales de cálculo de precio
const pricePercentageEl = document.getElementById("price-percentage");
const logisticAmountEl = document.getElementById("logistic-amount");

if (pricePercentageEl) {
  pricePercentageEl.addEventListener("input", recalculateAllRecommendedPrices);
  pricePercentageEl.addEventListener("change", recalculateAllRecommendedPrices);
}

if (logisticAmountEl) {
  // Aplicar formateador de precio al monto logístico
  attachPriceFormatter(logisticAmountEl);
  logisticAmountEl.addEventListener("input", recalculateAllRecommendedPrices);
  logisticAmountEl.addEventListener("blur", recalculateAllRecommendedPrices);
}

// Función para actualizar código de proveedor existente
async function updateSupplierCode(supplierId, newCode) {
  if (!supplierId || !newCode) {
    alert("El código del proveedor es obligatorio");
    return null;
  }
  
  const code = (newCode || "").trim().toUpperCase();
  if (!code) {
    alert("El código del proveedor no puede estar vacío");
    return null;
  }
  
  try {
    // Verificar que el código no exista en otro proveedor
    const { data: existing } = await supabase
      .from("suppliers")
      .select("id, code")
      .eq("code", code)
      .neq("id", supplierId)
      .maybeSingle();
    
    if (existing) {
      alert("Ya existe otro proveedor con ese código. Por favor, usa un código diferente.");
      return null;
    }
    
    // Actualizar el código del proveedor
    const { data, error } = await supabase
      .from("suppliers")
      .update({ code: code })
      .eq("id", supplierId)
      .select("id, name, code")
      .single();
    
    if (error) {
      console.error("Error actualizando proveedor:", error);
      if (error.code === "23505") { // Violación de unicidad
        alert("Ya existe un proveedor con ese código. Por favor, ingresa un código diferente.");
      } else {
        alert(`Error al actualizar proveedor: ${error.message}`);
      }
      return null;
    }
    
    // Actualizar cache
    if (data && data.id && data.code) {
      SUPPLIERS_CACHE.set(data.id, data.code);
    }
    
    // Recargar lista de proveedores
    await loadSuppliers();
    
    // Recalcular SKU bases con el nuevo código
    await recalculateAllSkuBases();
    
    return data;
  } catch (e) {
    console.error("Error actualizando proveedor:", e);
    alert(`Error al actualizar proveedor: ${e.message}`);
    return null;
  }
}

// Event listeners para crear nuevo proveedor
const newSupplierBtn = document.getElementById("new-supplier-btn");
const newSupplierForm = document.getElementById("new-supplier-form");
const createSupplierBtn = document.getElementById("create-supplier-btn");
const cancelSupplierBtn = document.getElementById("cancel-supplier-btn");
const newSupplierName = document.getElementById("new-supplier-name");
const newSupplierCode = document.getElementById("new-supplier-code");

// Elementos para editar proveedor
const editSupplierBtn = document.getElementById("edit-supplier-btn");
const editSupplierForm = document.getElementById("edit-supplier-form");
const editSupplierCodeInput = document.getElementById("edit-supplier-code");
const saveSupplierCodeBtn = document.getElementById("save-supplier-code-btn");
const cancelEditSupplierBtn = document.getElementById("cancel-edit-supplier-btn");
const supplierSelect = document.getElementById("supplier");

// Mostrar/ocultar botón de editar según si hay proveedor seleccionado
function updateEditButtonVisibility() {
  if (editSupplierBtn && supplierSelect) {
    const hasSupplier = supplierSelect.value && supplierSelect.value !== "";
    editSupplierBtn.style.display = hasSupplier ? "block" : "none";
  }
}

// Inicializar visibilidad del botón de editar
updateEditButtonVisibility();

// Event listener para mostrar/ocultar botón de editar cuando cambia la selección
if (supplierSelect) {
  supplierSelect.addEventListener("change", () => {
    updateEditButtonVisibility();
    // Ocultar formulario de edición si se cambia el proveedor
    if (editSupplierForm) {
      editSupplierForm.style.display = "none";
    }
  });
}

// Event listener para botón de editar
if (editSupplierBtn) {
  editSupplierBtn.addEventListener("click", async () => {
    const supplierId = supplierSelect?.value;
    if (!supplierId) return;
    
    // Obtener código actual del proveedor
    const currentCode = SUPPLIERS_CACHE.get(supplierId);
    
    if (editSupplierCodeInput) {
      editSupplierCodeInput.value = currentCode || "";
    }
    
    // Mostrar formulario de edición
    if (editSupplierForm) {
      editSupplierForm.style.display = editSupplierForm.style.display === "none" ? "block" : "none";
      if (editSupplierForm.style.display === "block" && editSupplierCodeInput) {
        editSupplierCodeInput.focus();
        editSupplierCodeInput.select();
      }
    }
    
    // Ocultar formulario de nuevo proveedor si está abierto
    if (newSupplierForm) {
      newSupplierForm.style.display = "none";
    }
  });
}

// Event listener para guardar código del proveedor
if (saveSupplierCodeBtn) {
  saveSupplierCodeBtn.addEventListener("click", async () => {
    const supplierId = supplierSelect?.value;
    if (!supplierId) {
      alert("No hay proveedor seleccionado");
      return;
    }
    
    const newCode = editSupplierCodeInput?.value?.trim();
    if (!newCode) {
      alert("El código no puede estar vacío");
      return;
    }
    
    const updated = await updateSupplierCode(supplierId, newCode);
    if (updated) {
      statusEl.textContent = `Código del proveedor actualizado a "${updated.code}"`;
      statusEl.style.color = "#090";
      
      // Ocultar formulario de edición
      if (editSupplierForm) {
        editSupplierForm.style.display = "none";
      }
    }
  });
}

// Event listener para cancelar edición
if (cancelEditSupplierBtn) {
  cancelEditSupplierBtn.addEventListener("click", () => {
    if (editSupplierForm) editSupplierForm.style.display = "none";
    if (editSupplierCodeInput) editSupplierCodeInput.value = "";
  });
}

// Permitir guardar con Enter en el campo de código
if (editSupplierCodeInput) {
  editSupplierCodeInput.addEventListener("keypress", async (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (saveSupplierCodeBtn) saveSupplierCodeBtn.click();
    }
  });
}

if (newSupplierBtn) {
  newSupplierBtn.addEventListener("click", () => {
    if (newSupplierForm) {
      newSupplierForm.style.display = newSupplierForm.style.display === "none" ? "block" : "none";
      if (newSupplierForm.style.display === "block" && newSupplierName) {
        newSupplierName.focus();
      }
    }
    // Ocultar formulario de edición si está abierto
    if (editSupplierForm) {
      editSupplierForm.style.display = "none";
    }
  });
}

if (createSupplierBtn) {
  createSupplierBtn.addEventListener("click", async () => {
    const supplier = await createNewSupplier();
    if (supplier) {
      statusEl.textContent = `Proveedor "${supplier.name}" creado y seleccionado`;
      statusEl.style.color = "#090";
    }
  });
}

if (cancelSupplierBtn) {
  cancelSupplierBtn.addEventListener("click", () => {
    if (newSupplierForm) newSupplierForm.style.display = "none";
    if (newSupplierName) newSupplierName.value = "";
    if (newSupplierCode) newSupplierCode.value = "";
  });
}

// Permitir crear proveedor presionando Enter
if (newSupplierName) {
  newSupplierName.addEventListener("keypress", async (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (createSupplierBtn) createSupplierBtn.click();
    }
  });
}

if (newSupplierCode) {
  newSupplierCode.addEventListener("keypress", async (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (createSupplierBtn) createSupplierBtn.click();
    }
  });
}

// Función para recalcular todos los SKU bases cuando cambia el proveedor
async function recalculateAllSkuBases() {
  const supplierEl = document.getElementById("supplier");
  const supplierId = supplierEl?.value || "";
  const supplierCode = supplierId ? await getSupplierCode(supplierId) : null;
  
  const rows = variantsTable.querySelectorAll("tr");
  rows.forEach((row) => {
    const color = row.querySelector(".v-color")?.value || "";
    const skuBaseEl = row.querySelector(".v-skuBase");
    const handle = handleEl?.value || "";
    
    // Solo actualizar SKU bases que no fueron editados manualmente
    if (skuBaseEl && !skuBaseEl.dataset.dirty) {
      skuBaseEl.value = makeSkuBase(handle, color, supplierCode);
    }
  });
}

// Event listener para recalcular SKU bases cuando cambia el proveedor
const supplierEl = document.getElementById("supplier");
if (supplierEl) {
  supplierEl.addEventListener("change", recalculateAllSkuBases);
}

// rellenar datalist
const datalist = document.getElementById("colors-datalist");
if (datalist && COLORS.length) {
  datalist.innerHTML = COLORS.map(
    (c) => `<option value="${c.name}">${c.code || ""}</option>`
  ).join("");
}

// Asegurar que siempre haya al menos una variante
console.log("🔧 Llamando ensureDefaultVariant()");
ensureDefaultVariant();
console.log("🔧 Después de ensureDefaultVariant()");

// ----- TAGS JERÁRQUICOS UI -----
const tag1Select = document.getElementById("tag1-select");
const tag1New = document.getElementById("tag1-new");
const tag1Create = document.getElementById("tag1-create");
const tag2Select = document.getElementById("tag2-select");
const tag2New = document.getElementById("tag2-new");
const tag2Create = document.getElementById("tag2-create");
const tag3Select = document.getElementById("tag3-select");
const tag3New = document.getElementById("tag3-new");
const tag3Create = document.getElementById("tag3-create");
const tag3Chips = document.getElementById("tag3-chips");

let selectedTag1Id = null;
let selectedTag2Id = null;
let selectedTag3Ids = [];

// Variables para Details y Highlights
let selectedDetailsIds = []; // Array de uuid de tags3 seleccionados como details
let selectedHighlightsIds = []; // Array de uuid de tags3 seleccionados como highlights (máx 2)
let availableTags3Cache = []; // Cache de tags3 disponibles según contexto actual

// Obtener categoría del producto
function getProductCategory() {
  const category = document.getElementById("category").value;
  // Mapear categorías a grupos de tags
  if (category === "Calzado") return "Calzado";
  if (category === "Ropa") return "Ropa";
  if (category === "Lenceria" || category === "Marroquineria") return "Otros";
  return category || "Calzado"; // default
}

// Cargar tags1 por categoría
async function loadTags1(category) {
  if (!category) return [];
  const { data, error } = await supabase
    .from("tags")
    .select("id, name")
    .eq("category", category)
    .eq("level", 1)
    .is("parent_id", null)
    .order("name");
  return error ? [] : (data || []);
}

// Cargar tags2 por parent (tag1)
async function loadTags2(tag1Id) {
  if (!tag1Id) return [];
  const { data, error } = await supabase
    .from("tags")
    .select("id, name")
    .eq("parent_id", tag1Id)
    .eq("level", 2)
    .order("name");
  return error ? [] : (data || []);
}

// Cargar tags3 de todos los tags2 que pertenecen al tags1 seleccionado
async function loadTags3(tag1Id) {
  if (!tag1Id) return [];
  // Primero obtener todos los tags2 del tags1
  const { data: tags2, error: err2 } = await supabase
    .from("tags")
    .select("id")
    .eq("parent_id", tag1Id)
    .eq("level", 2);
  if (err2 || !tags2 || tags2.length === 0) return [];
  const tag2Ids = tags2.map(t => t.id);
  // Luego obtener todos los tags3 de esos tags2
  const { data, error } = await supabase
    .from("tags")
    .select("id, name")
    .in("parent_id", tag2Ids)
    .eq("level", 3)
    .order("name");
  return error ? [] : (data || []);
}

// Crear nuevo tag
async function createTag(name, level, category, parentId) {
  const { data, error } = await supabase
    .from("tags")
    .insert([{ name, level, category, parent_id: parentId }])
    .select("id, name")
    .single();
  if (error) {
    console.error("Error creando tag:", error);
    return null;
  }
  return data;
}

// Renderizar tags1
async function renderTags1() {
  const category = getProductCategory();
  const tags1 = await loadTags1(category);
  
  // Deduplicar por nombre (case-insensitive) - mantener el primero encontrado
  const seen = new Set();
  const uniqueTags = [];
  tags1.forEach(tag => {
    const normalized = normalizeName(tag.name);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      uniqueTags.push(tag);
    }
  });
  
  tag1Select.innerHTML = '<option value="">-- Seleccionar Tags1 --</option>';
  uniqueTags.forEach(tag => {
    const opt = document.createElement("option");
    opt.value = tag.id;
    opt.textContent = tag.name;
    tag1Select.appendChild(opt);
  });
  if (selectedTag1Id) {
    tag1Select.value = selectedTag1Id;
  }
}

// Renderizar tags2
async function renderTags2() {
  if (!selectedTag1Id) {
    tag2Select.innerHTML = '<option value="">-- Primero selecciona Tags1 --</option>';
    tag2Select.disabled = true;
    tag2New.style.display = "none";
    tag2Create.style.display = "none";
    return;
  }
  const tags2 = await loadTags2(selectedTag1Id);
  tag2Select.innerHTML = '<option value="">-- Seleccionar Tags2 --</option>';
  tags2.forEach(tag => {
    const opt = document.createElement("option");
    opt.value = tag.id;
    opt.textContent = tag.name;
    tag2Select.appendChild(opt);
  });
  tag2Select.disabled = false;
  if (selectedTag2Id) {
    tag2Select.value = selectedTag2Id;
    tag2New.style.display = "none";
    tag2Create.style.display = "none";
  } else {
    // Mostrar inputs de creación si no hay tags2 seleccionado
    tag2New.style.display = "block";
    tag2Create.style.display = "block";
  }
}

// Renderizar tags3 (de todos los tags2 del tags1 seleccionado)
async function renderTags3() {
  if (!selectedTag1Id) {
    tag3Select.innerHTML = '<option value="">-- Primero selecciona Tags1 --</option>';
    tag3Select.disabled = true;
    tag3New.style.display = "none";
    tag3Create.style.display = "none";
    renderTag3Chips();
    return;
  }
  // Cargar todos los tags3 de todos los tags2 del tags1
  const tags3 = await loadTags3(selectedTag1Id);
  tag3Select.innerHTML = "";
  tags3.forEach(tag => {
    const opt = document.createElement("option");
    opt.value = tag.id;
    opt.textContent = tag.name;
    opt.selected = selectedTag3Ids.includes(tag.id);
    tag3Select.appendChild(opt);
  });
  tag3Select.disabled = false;
  // Mostrar inputs de creación si hay tags2 seleccionado y menos de 2 tags3
  if (selectedTag2Id && selectedTag3Ids.length < 2) {
    tag3New.style.display = "block";
    tag3Create.style.display = "block";
  } else {
    tag3New.style.display = "none";
    tag3Create.style.display = "none";
  }
  renderTag3Chips();
}

// Renderizar chips de tags3 seleccionados
function renderTag3Chips() {
  if (!selectedTag1Id || selectedTag3Ids.length === 0) {
    tag3Chips.innerHTML = "";
    return;
  }
  // Cargar nombres de los tags3 seleccionados
  Promise.all(selectedTag3Ids.map(id => 
    supabase.from("tags").select("name").eq("id", id).single()
  )).then(results => {
    tag3Chips.innerHTML = "";
    results.forEach((result, idx) => {
      if (result.data) {
        const chip = document.createElement("span");
        chip.textContent = result.data.name;
        chip.style = "background:#eee;border:1px solid #ddd;border-radius:16px;padding:4px 8px;display:inline-flex;gap:6px;align-items:center;";
        const x = document.createElement("button");
        x.type = "button";
        x.textContent = "✕";
        x.style = "border:none;background:transparent;cursor:pointer;color:#666;";
        x.addEventListener("click", () => {
          selectedTag3Ids = selectedTag3Ids.filter(id => id !== selectedTag3Ids[idx]);
          renderTags3();
        });
        chip.appendChild(x);
        tag3Chips.appendChild(chip);
      }
    });
  });
}

// ========== FUNCIONES DE DETAILS Y HIGHLIGHTS ==========

// Cargar details actuales del producto
async function loadProductDetails(productId) {
  if (!productId) {
    selectedDetailsIds = [];
    return;
  }
  
  try {
    const { data, error } = await supabase
      .from("product_tag_details")
      .select("tag3_id")
      .eq("product_id", productId);
    
    if (error) {
      console.warn("Error cargando details:", error);
      selectedDetailsIds = [];
      return;
    }
    
    selectedDetailsIds = (data || []).map(d => d.tag3_id);
  } catch (e) {
    console.warn("Error cargando details:", e);
    selectedDetailsIds = [];
  }
}

// Cargar highlights actuales del producto
async function loadProductHighlights(productId) {
  if (!productId) {
    selectedHighlightsIds = [];
    return;
  }
  
  try {
    const { data: pt } = await supabase
      .from("product_tags")
      .select("tag3_ids")
      .eq("product_id", productId)
      .single();
    
    selectedHighlightsIds = pt?.tag3_ids || [];
  } catch (e) {
    console.warn("Error cargando highlights:", e);
    selectedHighlightsIds = [];
  }
}

// Cargar Tags3 disponibles según contexto (tag2_id o tag1_id)
async function loadAvailableTags3() {
  const tag2Id = selectedTag2Id;
  const tag1Id = selectedTag1Id;
  
  if (tag2Id) {
    // Caso A: Hay tag2_id -> Tags3 hijos directos
    const { data, error } = await supabase
      .from("tags")
      .select("id, name")
      .eq("level", 3)
      .eq("parent_id", tag2Id)
      .order("name");
    
    availableTags3Cache = error ? [] : (data || []);
    return availableTags3Cache;
  } else if (tag1Id) {
    // Caso B: No hay tag2_id pero hay tag1_id -> Tags3 de todos los tags2 del tag1
    const { data: tags2, error: err2 } = await supabase
      .from("tags")
      .select("id")
      .eq("parent_id", tag1Id)
      .eq("level", 2);
    
    if (err2 || !tags2 || tags2.length === 0) {
      availableTags3Cache = [];
      return availableTags3Cache;
    }
    
    const tag2Ids = tags2.map(t => t.id);
    
    const { data, error } = await supabase
      .from("tags")
      .select("id, name")
      .eq("level", 3)
      .in("parent_id", tag2Ids)
      .order("name");
    
    availableTags3Cache = error ? [] : (data || []);
    return availableTags3Cache;
  }
  
  availableTags3Cache = [];
  return availableTags3Cache;
}

// Filtrar selections inválidas cuando cambian Tag1/Tag2
// IMPORTANTE: NO filtramos selectedDetailsIds aquí porque details son GLOBALES del producto
// (pueden ser de distintas ramas tag2). Solo validamos highlights.
async function filterInvalidSelections() {
  const availableIds = new Set(availableTags3Cache.map(t => t.id));
  
  // NO filtrar details: mantener todos (son globales del producto)
  // Los details pueden ser de diferentes tag2, solo los mostramos/ocultamos según contexto
  
  // Filtrar highlights: solo mantener los que están en details Y disponibles en el contexto actual
  // Si un highlight no está disponible en el contexto actual, lo mantenemos pero no se puede editar
  const detailsSet = new Set(selectedDetailsIds);
  // No filtramos highlights aquí, solo validamos que estén en details
  // Si un highlight no está en el contexto actual, se mantiene pero no se muestra en el UI
}

// Renderizar lista de details con checkboxes y botón ⭐
async function renderDetailsList() {
  const container = document.getElementById("details-list");
  const searchInput = document.getElementById("details-search");
  const searchTerm = (searchInput?.value || "").toLowerCase().trim();
  
  if (!container) return;
  
  // Recargar disponibles si cambió el contexto
  await loadAvailableTags3();
  
  // NO filtrar selections: details son globales, solo validamos highlights
  await filterInvalidSelections();
  
  // Obtener todos los details del producto (incluso los que no están en el contexto actual)
  // para mostrarlos como "seleccionados pero fuera de contexto"
  const allDetailsIds = new Set(selectedDetailsIds);
  const availableIds = new Set(availableTags3Cache.map(t => t.id));
  
  // Separar: details disponibles en contexto vs details fuera de contexto
  const detailsInContext = selectedDetailsIds.filter(id => availableIds.has(id));
  const detailsOutOfContext = selectedDetailsIds.filter(id => !availableIds.has(id));
  
  if (availableTags3Cache.length === 0 && detailsOutOfContext.length === 0) {
    container.innerHTML = `
      <div style="color:#666;font-size:11px;text-align:center;padding:8px;">
        ${selectedTag2Id ? "No hay detalles disponibles para este atributo." : 
          selectedTag1Id ? "Selecciona un atributo (Tags2) para ver detalles disponibles." :
          "Selecciona Tags1 y Tags2 para ver detalles disponibles."}
      </div>
    `;
    return;
  }
  
  // Si hay details fuera de contexto, mostrarlos primero (solo lectura)
  let html = "";
  
  if (detailsOutOfContext.length > 0) {
    // Cargar nombres de details fuera de contexto
    const { data: outOfContextTags } = await supabase
      .from("tags")
      .select("id, name")
      .in("id", detailsOutOfContext);
    
    if (outOfContextTags && outOfContextTags.length > 0) {
      html += `<div style="margin-bottom:8px;padding:8px;background:#fff3cd;border:1px solid #ffc107;border-radius:4px;">
        <div style="font-size:11px;font-weight:600;margin-bottom:4px;color:#856404;">
          ⚠️ Detalles de otras ramas (no editables desde este contexto):
        </div>
        ${outOfContextTags.map(tag => {
          const isHighlight = selectedHighlightsIds.includes(tag.id);
          return `
            <div style="display:flex;align-items:center;gap:8px;padding:4px;font-size:11px;color:#856404;">
              <input type="checkbox" checked disabled style="cursor:not-allowed;opacity:0.6;" />
              <span style="flex:1;">${tag.name}</span>
              ${isHighlight ? '<span style="color:#3a6df0;font-size:10px;">⭐ Destacado</span>' : ''}
            </div>
          `;
        }).join("")}
      </div>`;
    }
  }
  
  // Filtrar disponibles por búsqueda
  const filtered = availableTags3Cache.filter(tag => 
    tag.name.toLowerCase().includes(searchTerm)
  );
  
  if (filtered.length === 0 && detailsOutOfContext.length === 0) {
    container.innerHTML = `
      <div style="color:#666;font-size:11px;text-align:center;padding:8px;">
        No se encontraron detalles con "${searchTerm}"
      </div>
    `;
    return;
  }
  
  html += filtered.map(tag => {
    const isDetailChecked = selectedDetailsIds.includes(tag.id);
    const isHighlight = selectedHighlightsIds.includes(tag.id);
    const canHighlight = isDetailChecked && selectedHighlightsIds.length < 2;
    const highlightDisabled = !isDetailChecked || (!isHighlight && selectedHighlightsIds.length >= 2);
    
    return `
      <div class="detail-row" 
           data-tag3-id="${tag.id}"
           style="display:flex;align-items:center;gap:8px;padding:6px;border-radius:4px;transition:background 0.2s;"
           onmouseover="this.style.background='#f0f0f0'" 
           onmouseout="this.style.background='transparent'">
        <input 
          type="checkbox" 
          class="toggle-detail"
          data-tag3-id="${tag.id}"
          ${isDetailChecked ? "checked" : ""}
          style="cursor:pointer;"
        />
        <span style="flex:1;font-size:12px;">${tag.name}</span>
        <button 
          type="button"
          class="toggle-highlight"
          data-tag3-id="${tag.id}"
          ${highlightDisabled ? "disabled" : ""}
          style="background:none;border:1px solid ${highlightDisabled ? '#ccc' : '#3a6df0'};color:${highlightDisabled ? '#999' : isHighlight ? '#fff' : '#3a6df0'};cursor:${highlightDisabled ? 'not-allowed' : 'pointer'};padding:4px 8px;border-radius:4px;font-size:11px;display:flex;align-items:center;gap:4px;background:${isHighlight ? '#3a6df0' : 'transparent'};"
          title="${highlightDisabled ? (isDetailChecked ? 'Máximo 2 destacados' : 'Selecciona el detalle primero') : (isHighlight ? 'Quitar destacado' : 'Destacar')}">
          ${isHighlight ? '⭐ Destacado' : '⭐'}
        </button>
      </div>
    `;
  }).join("");
  
  container.innerHTML = html;
  
  // Re-renderizar highlights después de actualizar details
  renderHighlights();
}

// Renderizar highlights como chips (una sola query)
async function renderHighlights() {
  const container = document.getElementById("highlights-container");
  if (!container) return;
  
  if (selectedHighlightsIds.length === 0) {
    container.innerHTML = `
      <div style="color:#666;font-size:11px;text-align:center;width:100%;padding:4px;">
        Selecciona hasta 2 detalles de los seleccionados arriba
      </div>
    `;
    return;
  }
  
  // Una sola query para todos los highlights
  const { data: highlightsData, error } = await supabase
    .from("tags")
    .select("id, name")
    .in("id", selectedHighlightsIds);
  
  if (error) {
    console.warn("Error cargando nombres de highlights:", error);
    container.innerHTML = `
      <div style="color:#c00;font-size:11px;text-align:center;width:100%;padding:4px;">
        Error cargando destacados
      </div>
    `;
    return;
  }
  
  // Crear mapa id -> name
  const highlightsMap = new Map((highlightsData || []).map(t => [t.id, t.name]));
  
  container.innerHTML = selectedHighlightsIds
    .map(id => {
      const name = highlightsMap.get(id) || `ID: ${id.substring(0, 8)}...`;
      return `
        <div class="highlight-chip" 
             style="display:inline-flex;align-items:center;gap:4px;padding:6px 10px;background:#3a6df0;color:#fff;border-radius:16px;font-size:11px;">
          <span>⭐ ${name}</span>
          <button type="button" 
                  class="remove-highlight"
                  data-tag3-id="${id}"
                  style="background:none;border:none;color:#fff;cursor:pointer;font-size:14px;line-height:1;padding:0;width:16px;height:16px;display:flex;align-items:center;justify-content:center;"
                  title="Quitar destacado">
            ×
          </button>
        </div>
      `;
    }).join("");
}

// Handler para toggle de detail (checkbox)
function handleDetailToggle(tag3Id, isChecked) {
  if (isChecked) {
    if (!selectedDetailsIds.includes(tag3Id)) {
      selectedDetailsIds.push(tag3Id);
    }
  } else {
    selectedDetailsIds = selectedDetailsIds.filter(id => id !== tag3Id);
    // Si estaba en highlights, quitarlo también
    if (selectedHighlightsIds.includes(tag3Id)) {
      selectedHighlightsIds = selectedHighlightsIds.filter(id => id !== tag3Id);
    }
  }
  renderDetailsList(); // Re-render para actualizar botones ⭐
}

// Handler para toggle de highlight (botón ⭐)
function handleHighlightToggle(tag3Id) {
  const isCurrentlyHighlight = selectedHighlightsIds.includes(tag3Id);
  
  if (isCurrentlyHighlight) {
    // Remover highlight
    selectedHighlightsIds = selectedHighlightsIds.filter(id => id !== tag3Id);
  } else {
    // Agregar highlight (validar máx 2)
    if (selectedHighlightsIds.length >= 2) {
      alert("Solo puedes destacar máximo 2 detalles");
      return;
    }
    
    if (!selectedDetailsIds.includes(tag3Id)) {
      alert("Primero debes seleccionar este detalle");
      return;
    }
    
    selectedHighlightsIds.push(tag3Id);
  }
  
  renderDetailsList(); // Re-render para actualizar botones ⭐
  renderHighlights(); // Re-render highlights
}

// Guardar details y highlights
async function saveDetailsAndHighlights(productId) {
  const statusEl = document.getElementById("details-highlights-status");
  
  if (!productId) {
    statusEl.textContent = "Error: No hay producto cargado";
    statusEl.style.color = "#c00";
    return;
  }
  
  // Validar highlights (máx 2)
  if (selectedHighlightsIds.length > 2) {
    statusEl.textContent = "Error: Máximo 2 highlights permitidos";
    statusEl.style.color = "#c00";
    return;
  }
  
  // Validar que highlights estén en details
  const invalidHighlights = selectedHighlightsIds.filter(id => !selectedDetailsIds.includes(id));
  if (invalidHighlights.length > 0) {
    statusEl.textContent = "Error: Los highlights deben estar en la lista de details";
    statusEl.style.color = "#c00";
    return;
  }
  
  statusEl.textContent = "Guardando...";
  statusEl.style.color = "inherit";
  
  try {
    // 1. Guardar Details (sincronización exacta)
    const { data: currentDetails, error: detailsError } = await supabase
      .from("product_tag_details")
      .select("tag3_id")
      .eq("product_id", productId);
    
    if (detailsError) {
      throw new Error(`Error cargando details: ${detailsError.message}`);
    }
    
    const currentIds = new Set((currentDetails || []).map(d => d.tag3_id));
    const newIds = new Set(selectedDetailsIds);
    
    // Insertar nuevos
    const toInsert = selectedDetailsIds.filter(id => !currentIds.has(id));
    if (toInsert.length > 0) {
      const { error: insertError } = await supabase
        .from("product_tag_details")
        .insert(toInsert.map(tag3_id => ({ product_id: productId, tag3_id })));
      
      if (insertError) {
        throw new Error(`Error insertando details: ${insertError.message}`);
      }
    }
    
    // Eliminar removidos
    const toDelete = Array.from(currentIds).filter(id => !newIds.has(id));
    if (toDelete.length > 0) {
      const { error: deleteError } = await supabase
        .from("product_tag_details")
        .delete()
        .eq("product_id", productId)
        .in("tag3_id", toDelete);
      
      if (deleteError) {
        throw new Error(`Error eliminando details: ${deleteError.message}`);
      }
    }
    
    // 2. Guardar Highlights
    const { error: highlightsError } = await supabase
      .from("product_tags")
      .update({ 
        tag3_ids: selectedHighlightsIds.length > 0 ? selectedHighlightsIds : null 
      })
      .eq("product_id", productId);
    
    if (highlightsError) {
      throw new Error(`Error guardando highlights: ${highlightsError.message}`);
    }
    
    statusEl.textContent = "✓ Guardado correctamente";
    statusEl.style.color = "#090";
    setTimeout(() => {
      statusEl.textContent = "";
    }, 3000);
    
  } catch (error) {
    console.error("Error guardando details/highlights:", error);
    statusEl.textContent = `Error: ${error.message}`;
    statusEl.style.color = "#c00";
  }
}

// Event listeners
tag1Select?.addEventListener("change", async (e) => {
  selectedTag1Id = e.target.value || null;
  selectedTag2Id = null;
  selectedTag3Ids = []; // Limpiar tags3 al cambiar tags1
  await renderTags2();
  await renderTags3();
  tag1New.style.display = e.target.value ? "none" : "block";
  tag1Create.style.display = e.target.value ? "none" : "block";
  
  // Actualizar UI de details (NO limpiar selectedDetailsIds - son globales)
  await renderDetailsList();
});

tag1Create?.addEventListener("click", async () => {
  const name = tag1New.value.trim();
  if (!name) return;
  const category = getProductCategory();
  const tag = await createTag(name, 1, category, null);
  if (tag) {
    selectedTag1Id = tag.id;
    tag1New.value = "";
    tag1New.style.display = "none";
    tag1Create.style.display = "none";
    await renderTags1();
  }
});

tag2Select?.addEventListener("change", async (e) => {
  selectedTag2Id = e.target.value || null;
  // No limpiar tags3 al cambiar tags2, ya que pueden compartirse
  await renderTags3();
  // Mostrar/ocultar inputs de tags2
  tag2New.style.display = e.target.value ? "none" : "block";
  tag2Create.style.display = e.target.value ? "none" : "block";
  // Mostrar/ocultar inputs de tags3 según si hay tags2 seleccionado y menos de 2 tags3
  if (selectedTag2Id && selectedTag3Ids.length < 2) {
    tag3New.style.display = "block";
    tag3Create.style.display = "block";
  } else {
    tag3New.style.display = "none";
    tag3Create.style.display = "none";
  }
  
  // Actualizar UI de details (NO limpiar selectedDetailsIds - son globales)
  await renderDetailsList();
});

tag2Create?.addEventListener("click", async () => {
  const name = tag2New.value.trim();
  if (!name || !selectedTag1Id) return;
  const category = getProductCategory();
  const tag = await createTag(name, 2, category, selectedTag1Id);
  if (tag) {
    selectedTag2Id = tag.id;
    tag2New.value = "";
    tag2New.style.display = "none";
    tag2Create.style.display = "none";
    await renderTags2();
  }
});

tag3Select?.addEventListener("change", async (e) => {
  const selected = Array.from(e.target.selectedOptions).map(opt => opt.value).filter(Boolean);
  if (selected.length > 2) {
    alert("Solo podés seleccionar hasta 2 Tags3");
    e.target.value = selectedTag3Ids[0] || "";
    return;
  }
  selectedTag3Ids = selected;
  renderTag3Chips();
  // Mostrar inputs solo si hay tags2 seleccionado y menos de 2 tags3
  if (selectedTag2Id && selected.length < 2) {
    tag3New.style.display = "block";
    tag3Create.style.display = "block";
  } else {
    tag3New.style.display = "none";
    tag3Create.style.display = "none";
  }
});

tag3Create?.addEventListener("click", async () => {
  const name = tag3New.value.trim();
  if (!name || !selectedTag2Id || selectedTag3Ids.length >= 2) return;
  const category = getProductCategory();
  const tag = await createTag(name, 3, category, selectedTag2Id);
  if (tag) {
    selectedTag3Ids.push(tag.id);
    tag3New.value = "";
    tag3New.style.display = selectedTag3Ids.length >= 2 ? "none" : "block";
    tag3Create.style.display = selectedTag3Ids.length >= 2 ? "none" : "block";
    await renderTags3();
  }
});

// Función para aplicar/remover prefijo "R " según la categoría
function updateNamePrefix() {
  const categoryEl = document.getElementById("category");
  const nameEl = document.getElementById("name");
  
  if (!categoryEl || !nameEl) return;
  
  const category = categoryEl.value;
  let currentName = nameEl.value.trim();
  
  if (category === "Ropa") {
    // Si es Ropa y el nombre no comienza con "R ", agregarlo
    if (currentName && !currentName.startsWith("R ")) {
      nameEl.value = "R " + currentName;
      // Si el handle no fue editado manualmente, actualizarlo
      if (!handleDirty) {
        handleEl.value = slugify(nameEl.value);
      }
    }
  } else {
    // Si no es Ropa y el nombre comienza con "R ", quitarlo
    if (currentName.startsWith("R ")) {
      nameEl.value = currentName.substring(2).trim();
      // Si el handle no fue editado manualmente, actualizarlo
      if (!handleDirty) {
        handleEl.value = slugify(nameEl.value);
      }
    }
  }
}

// Función para obtener el porcentaje predeterminado según la categoría
function getDefaultPercentageForCategory(category) {
  const defaults = {
    "Calzado": 30,
    "Ropa": 32,
    "Otros": 30
  };
  return defaults[category] || 30;
}

// Función para actualizar el porcentaje según la categoría seleccionada
function updatePercentageByCategory(force = false) {
  const categoryEl = document.getElementById("category");
  const pricePercentageEl = document.getElementById("price-percentage");
  
  if (!categoryEl || !pricePercentageEl) return;
  
  const category = categoryEl.value;
  const defaultPercentage = getDefaultPercentageForCategory(category);
  
  // Si force es true, siempre actualizar (útil para nuevos productos)
  // Si no, solo actualizar si el campo está vacío o tiene un valor por defecto
  const currentValue = parseFloat(pricePercentageEl.value) || 0;
  
  if (force || currentValue === 0 || currentValue === 30 || currentValue === 32) {
    pricePercentageEl.value = defaultPercentage;
    // Recalcular precios recomendados si hay costos
    recalculateAllRecommendedPrices();
  }
}

// Observar cambios en categoría para recargar tags1 y actualizar prefijo del nombre
document.getElementById("category")?.addEventListener("change", async () => {
  selectedTag1Id = null;
  selectedTag2Id = null;
  selectedTag3Ids = [];
  await renderTags1();
  await renderTags2();
  await renderTags3();
  // Actualizar prefijo del nombre según la categoría
  updateNamePrefix();
  // Actualizar porcentaje según la categoría
  updatePercentageByCategory();
});

// Inicializar tags1 al cargar
renderTags1();

async function searchProducts() {
  pResults.innerHTML = "";
  const term = (pSearch.value || "").trim();
  if (!term) return;
  const { data, error } = await supabase
    .from("products")
    .select("id, name, handle, category, status")
    .or(`name.ilike.%${term}%,handle.ilike.%${term}%`)
    .neq("status", "archived")
    .limit(50)
    .order("name");
  if (error) {
    statusEl.textContent = `Error de búsqueda: ${error.message}`;
    statusEl.style.color = "#c00";
    return;
  }
  data.forEach((p) => {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = `${p.name} — ${p.handle} (${p.category || "-"})`;
    pResults.appendChild(opt);
  });
}

// Autocompletar: sugerencias al tipear en el buscador superior
const suggestProducts = (function () {
  let t;
  return async function () {
    clearTimeout(t);
    t = setTimeout(async () => {
      const term = (pSearch.value || "").trim();
      if (!term) {
        if (productsDatalist) productsDatalist.innerHTML = "";
        return;
      }
      const { data, error } = await supabase
        .from("products")
        .select("id, name, handle, category, status")
        .or(`name.ilike.%${term}%,handle.ilike.%${term}%`)
        .neq("status", "archived")
        .limit(20)
        .order("name");
      if (error) return;
      lastProductSuggestions = (data || []).map((p) => ({
        id: p.id,
        name: p.name || "",
        label: productLabel(p),
      }));
      if (productsDatalist) {
        productsDatalist.innerHTML = lastProductSuggestions
          .map((s) => `<option value="${s.name}"></option>`)
          .join("");
      }
    }, 250);
  };
})();

async function tryLoadFromInput() {
  const label = (pSearch.value || "").trim();
  if (!label) return;
  // buscar coincidencia exacta
  let found = lastProductSuggestions.find(
    (s) => s.name.toLowerCase() === label.toLowerCase()
  );
  if (!found) {
    found = lastProductSuggestions.find(
      (s) => s.label.toLowerCase() === label.toLowerCase()
    );
  }
  if (found) {
    await loadProductById(found.id);
    return;
  }
  // si no hay sugerencias, forzar una búsqueda y probar con la primera
  await suggestProducts();
  if (lastProductSuggestions[0])
    await loadProductById(lastProductSuggestions[0].id);
}

pSearch?.addEventListener("input", suggestProducts);
pSearch?.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    tryLoadFromInput();
  }
});
pSearchBtn?.addEventListener("click", tryLoadFromInput);

async function loadProductById(id) {
  statusEl.textContent = "Cargando producto...";
  statusEl.style.color = "inherit";
  const { data: prod, error: perr } = await supabase
    .from("products")
    .select("*")
    .eq("id", id)
    .single();
  if (perr) {
    statusEl.textContent = `No se pudo cargar: ${perr.message}`;
    statusEl.style.color = "#c00";
    return;
  }
  const { data: variants, error: verr } = await supabase
    .from("product_variants")
    .select("id, sku, color, size, price, active")
    .eq("product_id", id)
    .order("sku");
  if (verr) {
    statusEl.textContent = `Error variantes: ${verr.message}`;
    statusEl.style.color = "#c00";
    return;
  }
  const vIds = variants.map((v) => v.id);
  
  // Cargar stock desde variant_warehouse_stock
  let stockMap = new Map();
  if (vIds.length > 0) {
    // Obtener el ID del almacén "general"
    const { data: warehouse } = await supabase
      .from("warehouses")
      .select("id")
      .eq("code", "general")
      .single();
    
    if (warehouse) {
      const { data: stockData } = await supabase
        .from("variant_warehouse_stock")
        .select("variant_id, stock_qty")
        .in("variant_id", vIds)
        .eq("warehouse_id", warehouse.id);
      
      if (stockData) {
        stockData.forEach(row => {
          stockMap.set(row.variant_id, row.stock_qty || 0);
        });
      }
    }
  }
  
  // Agregar stock_qty a cada variante
  variants.forEach(v => {
    v.stock_qty = stockMap.get(v.id) || 0;
  });
  
  let images = [];
  if (vIds.length) {
    const { data: imgRows } = await supabase
      .from("variant_images")
      .select("variant_id, url, position")
      .in("variant_id", vIds)
      .order("position");
    images = imgRows || [];
  }

  // Cargar tags jerárquicos del producto
  try {
    const { data: pt } = await supabase
      .from("product_tags")
      .select("tag1_id, tag2_id, tag3_ids")
      .eq("product_id", id)
      .single();
    if (pt) {
      selectedTag1Id = pt.tag1_id || null;
      selectedTag2Id = pt.tag2_id || null;
      selectedTag3Ids = pt.tag3_ids || [];
      await renderTags1();
      await renderTags2();
      await renderTags3();
    } else {
      selectedTag1Id = null;
      selectedTag2Id = null;
      selectedTag3Ids = [];
      await renderTags1();
      await renderTags2();
      await renderTags3();
    }
  } catch (e) {
    console.warn("Error cargando tags:", e);
    selectedTag1Id = null;
    selectedTag2Id = null;
    selectedTag3Ids = [];
    await renderTags1();
    await renderTags2();
    await renderTags3();
  }

  // Cargar details y highlights
  await loadProductDetails(id);
  await loadProductHighlights(id);
  await renderDetailsList();

  // Populate form
  document.getElementById("category").value = prod.category || "";
  document.getElementById("handle").value = prod.handle || "";
  document.getElementById("name").value = prod.name || "";
  document.getElementById("description").value = prod.description || "";
  document.getElementById("status").value = prod.status || "active";
  document.getElementById("supplier").value = prod.supplier_id || "";
  updateEditButtonVisibility();
  
  // Populate pricing fields
  const pricePercentageEl = document.getElementById("price-percentage");
  const logisticAmountEl = document.getElementById("logistic-amount");
  if (pricePercentageEl) {
    // Si el producto tiene porcentaje guardado, usarlo; si no, usar el por defecto de la categoría
    pricePercentageEl.value = prod.price_percentage || getDefaultPercentageForCategory(prod.category || "Calzado");
  }
  if (logisticAmountEl) {
    logisticAmountEl.value = prod.logistic_amount ? formatARS(prod.logistic_amount) : formatARS(500);
  }

  // Variants
  variantsTable.innerHTML = "";
  originalVariantIds = new Set(vIds);
  variants.forEach((v) => {
    const imgs = images
      .filter((i) => i.variant_id === v.id)
      .sort((a, b) => (a.position || 0) - (b.position || 0))
      .map((i) => i.url);
    // Pasar el costo del producto a cada variante (aunque se guarda en products, se muestra en la tabla)
    addVariantRow({ ...v, images: imgs, cost: prod.cost ? formatARS(prod.cost) : "" });
  });

  // Verificar si los precios cargados coinciden con el cálculo esperado y marcarlos como auto-calculados
  const percentage = prod.price_percentage || 30;
  const logisticAmount = prod.logistic_amount || 500;
  const cost = prod.cost || 0;
  
  if (cost > 0) {
    const expectedPrice = calculateRecommendedPrice(cost, percentage, logisticAmount);
    const rows = variantsTable.querySelectorAll("tr");
    rows.forEach((row) => {
      const priceEl = row.querySelector(".v-price");
      if (priceEl) {
        const currentPrice = parseARS(priceEl.value || "0");
        // Si el precio coincide con el esperado, marcarlo como auto-calculado
        if (currentPrice === expectedPrice && currentPrice > 0) {
          priceEl.dataset.autoCalculated = "true";
        } else {
          priceEl.dataset.autoCalculated = "false";
        }
      }
    });
  }

  // Asegurar que siempre haya al menos una variante
  ensureDefaultVariant();

  currentProductId = prod.id;
  statusEl.textContent = `Producto cargado: ${prod.name}`;
}

pSearchBtn.addEventListener("click", searchProducts);
pLoad.addEventListener("click", () => {
  const id = pResults.value;
  if (id) loadProductById(id);
});
pNew.addEventListener("click", async () => {
  // Guardar categoría actual antes de resetear
  const categoryEl = document.getElementById("category");
  const currentCategory = categoryEl?.value || "";
  
  currentProductId = null;
  originalVariantIds = new Set();
  form.reset();
  
  // Restaurar categoría después de resetear
  if (categoryEl && currentCategory) {
    categoryEl.value = currentCategory;
    // Si la categoría es Ropa, aplicar prefijo al nombre (si está vacío o no tiene "R ")
    if (currentCategory === "Ropa") {
      const nameEl = document.getElementById("name");
      if (nameEl && (!nameEl.value.trim() || !nameEl.value.trim().startsWith("R "))) {
        // No hacer nada aquí, se aplicará cuando el usuario escriba o salga del campo
      }
    }
  }
  
  variantsTable.innerHTML = "";
  selectedTag1Id = null;
  selectedTag2Id = null;
  selectedTag3Ids = [];
  selectedDetailsIds = [];
  selectedHighlightsIds = [];
  await renderTags1();
  await renderTags2();
  await renderTags3();
  await renderDetailsList();
  // Limpiar proveedor
  document.getElementById("supplier").value = "";
  updateEditButtonVisibility();
  // Inicializar valores por defecto de cálculo de precio
  const pricePercentageEl = document.getElementById("price-percentage");
  const logisticAmountEl = document.getElementById("logistic-amount");
  if (logisticAmountEl) logisticAmountEl.value = formatARS(500);
  // Actualizar porcentaje según la categoría restaurada (forzar actualización para nuevo producto)
  updatePercentageByCategory(true);
  ensureDefaultVariant(); // Usar la función que asegura al menos una variante
  statusEl.textContent = "Nuevo producto";
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (isSaving) return;
  isSaving = true;
  const saveBtn = form.querySelector('button[type="submit"]');
  if (saveBtn) saveBtn.disabled = true;

  // Verificar autenticación antes de guardar
  const isAuthenticated = await checkAuth();
  if (!isAuthenticated) {
    statusEl.textContent = "Debes estar autenticado para guardar";
    statusEl.style.color = "#c00";
    if (saveBtn) saveBtn.disabled = false;
    isSaving = false;
    return;
  }

  // Verificar que el usuario tenga permisos de admin
  console.log("🔧 Usuario autenticado:", __currentUser?.email);
  console.log("🔧 Verificando permisos de admin...");

  // Verificar sesión activa antes de continuar
  const { data: currentSession } = await supabase.auth.getSession();
  if (!currentSession?.session) {
    statusEl.textContent =
      "Sesión expirada. Por favor, inicia sesión nuevamente.";
    statusEl.style.color = "#c00";
    if (saveBtn) saveBtn.disabled = false;
    isSaving = false;
    return;
  }

  console.log("🔧 Sesión verificada:", currentSession.session.user.email);

  statusEl.textContent = "Guardando...";
  statusEl.style.color = "inherit";

  // 1) Crear o actualizar producto
  const statusValue = document.getElementById("status").value;
  const supplierValue = document.getElementById("supplier").value;
  
  // Obtener costo de la primera variante (todas comparten el mismo costo del producto)
  const firstRow = variantsTable.querySelector("tr");
  const costValue = firstRow ? parseARS(firstRow.querySelector(".v-cost")?.value || "0") : 0;
  const pricePercentageValue = parseFloat(document.getElementById("price-percentage")?.value || "30");
  const logisticAmountValue = parseARS(document.getElementById("logistic-amount")?.value || "500");
  
  const payloadProduct = {
    category: document.getElementById("category").value,
    handle: (
      document.getElementById("handle").value ||
      slugify(document.getElementById("name").value)
    ).trim(),
    name: document.getElementById("name").value.trim(),
    description: document.getElementById("description").value.trim(),
    status: statusValue || "active", // Asegurar que siempre sea 'active' por defecto
    supplier_id: supplierValue || null,
    cost: costValue > 0 ? costValue : null,
    price_percentage: pricePercentageValue || 30,
    logistic_amount: logisticAmountValue || 500,
    created_at: new Date().toISOString(),
  };

  // Log para depuración
  console.log("🔧 Guardando producto con status:", payloadProduct.status);

  if (!payloadProduct.handle || !payloadProduct.name) {
    statusEl.textContent = "Handle y Nombre son obligatorios";
    statusEl.style.color = "#c00";
    if (saveBtn) saveBtn.disabled = false;
    isSaving = false;
    return;
  }

  // Validar unicidad de handle
  const { data: dupHandle } = await supabase
    .from("products")
    .select("id")
    .eq("handle", payloadProduct.handle)
    .neq("status", "archived")
    .limit(1);
  if (dupHandle && dupHandle.length && dupHandle[0].id !== currentProductId) {
    statusEl.textContent = `El handle '${payloadProduct.handle}' ya existe. Cambialo o ajusta el nombre.`;
    statusEl.style.color = "#c00";
    if (saveBtn) saveBtn.disabled = false;
    isSaving = false;
    return;
  }

  let prodId = currentProductId;
  if (!currentProductId) {
    console.log("🔧 Creando nuevo producto:", payloadProduct);
    const { data: prod, error: prodErr } = await supabase
      .from("products")
      .insert([payloadProduct])
      .select("id")
      .single();
    if (prodErr) {
      console.error("❌ Error al crear producto:", prodErr);
      if (prodErr.message.includes("row-level security")) {
        statusEl.textContent =
          "Error de permisos: No tienes permisos para crear productos. Contacta al administrador.";
        statusEl.style.color = "#c00";
      } else {
        statusEl.textContent = `Error al crear producto: ${prodErr.message}`;
        statusEl.style.color = "#c00";
      }
      if (saveBtn) saveBtn.disabled = false;
      isSaving = false;
      return;
    }
    prodId = prod.id;
    console.log("✅ Producto creado con ID:", prodId);
  } else {
    console.log("🔧 Actualizando producto existente:", currentProductId);
    const { error: upErr } = await supabase
      .from("products")
      .update(payloadProduct)
      .eq("id", currentProductId);
    if (upErr) {
      console.error("❌ Error al actualizar producto:", upErr);
      if (upErr.message.includes("row-level security")) {
        statusEl.textContent =
          "Error de permisos: No tienes permisos para actualizar productos. Contacta al administrador.";
        statusEl.style.color = "#c00";
      } else {
        statusEl.textContent = `Error al actualizar producto: ${upErr.message}`;
        statusEl.style.color = "#c00";
      }
      if (saveBtn) saveBtn.disabled = false;
      isSaving = false;
      return;
    }
    prodId = currentProductId;
    console.log("✅ Producto actualizado");
  }

  // 2) Variantes
  const rows = Array.from(variantsTable.querySelectorAll("tr"));
  console.log("🔧 Procesando variantes:", rows.length);

  // Obtener código del proveedor para generar SKU bases si es necesario
  const supplierId = supplierValue || null;
  const supplierCode = supplierId ? (SUPPLIERS_CACHE.get(supplierId) || null) : null;

  const variants = rows
    .flatMap((row, index) => {
      const color = row.querySelector(".v-color").value.trim();
      const sizeSimple = row.querySelector(".v-size").value.trim();
      const skuBase = (
        row.querySelector(".v-skuBase")?.value ||
        makeSkuBase(payloadProduct.handle, color, supplierCode)
      ).trim();
      const price = parseARS(row.querySelector(".v-price").value || "0");
      const stockSimple = parseInt(
        row.querySelector(".v-stock").value || "0",
        10
      );
      const active = row.querySelector(".v-active").checked;
      const imagesRaw = row.querySelector(".v-images")?.value?.trim() || "";
      let images = imagesRaw
        ? imagesRaw
            .split(/\r?\n|,/) // permitir coma o salto de línea
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
      // Override with new multi-input images if present
      const imgInputs = row.querySelectorAll(".v-images-list input");
      if (imgInputs && imgInputs.length) {
        images = Array.from(imgInputs)
          .map((i) => (i.value || "").trim())
          .filter(Boolean);
      }
      const id = row.dataset.variantId || null;

      console.log(`🔧 Variante ${index + 1}:`, {
        color,
        sizeSimple,
        skuBase,
        price,
        stockSimple,
        active,
      });

      // Multi-size mode - verificar si hay talles generados
      const list = row.querySelectorAll(".sizes-list .size-stock");
      if (list.length > 0) {
        console.log(
          `🔧 Modo multi-talle detectado para variante ${index + 1}:`,
          list.length,
          "talles"
        );
        if (!skuBase) {
          statusEl.textContent =
            "Ingresá un SKU base para generar SKUs por talle";
          statusEl.style.color = "#c00";
          throw new Error("SKU base requerido para multi-talle");
        }
        const multiVariants = Array.from(list).map((inp) => {
          const size = inp.dataset.size;
          const stock_qty = parseInt(inp.value || "0", 10);
          console.log(`🔧 Talle ${size}: stock ${stock_qty}`);
          return {
            id: null,
            product_id: prodId,
            color,
            size,
            sku: `${skuBase}-${size}`,
            price,
            stock_qty,
            reserved_qty: 0,
            active,
            _images: images,
          };
        });
        console.log(`🔧 Variantes multi-talle generadas:`, multiVariants);
        return multiVariants;
      }

      // Simple mode (una sola variante)
      const sku = (row.querySelector(".v-sku")?.value || skuBase || "").trim();
      const size = sizeSimple;
      const stock_qty = stockSimple;

      console.log(`🔧 Modo simple para variante ${index + 1}:`, {
        size,
        stock_qty,
        sku,
      });

      // Validar que al menos tenga color y talle
      if (!color || !size) {
        console.warn("Variante sin color o talle:", { color, size });
        return [];
      }

      const simpleVariant = {
        id,
        product_id: prodId,
        color,
        size,
        sku,
        price,
        stock_qty,
        reserved_qty: 0,
        active,
        _images: images,
      };

      console.log(`🔧 Variante simple generada:`, simpleVariant);
      return [simpleVariant];
    })
    .flat()
    .filter((v) => v.sku && v.size);

  console.log("🔧 Total de variantes a guardar:", variants.length);
  console.log("🔧 Detalles de variantes:", variants);

  // Verificar que al menos una variante esté activa
  const activeVariants = variants.filter(v => v.active === true);
  if (activeVariants.length === 0 && variants.length > 0) {
    console.warn("⚠️ Ninguna variante está marcada como activa. Esto impedirá que el producto aparezca en el catálogo.");
    const confirm = window.confirm(
      "⚠️ Ninguna variante está marcada como activa. " +
      "El producto no aparecerá en el catálogo público. " +
      "¿Deseas continuar de todas formas?"
    );
    if (!confirm) {
      statusEl.textContent = "Guardado cancelado. Marca al menos una variante como activa.";
      statusEl.style.color = "#fa0";
      if (saveBtn) saveBtn.disabled = false;
      isSaving = false;
      return;
    }
  }

  if (variants.length === 0) {
    statusEl.textContent = "Agrega al menos una variante con SKU";
    statusEl.style.color = "#c00";
    if (saveBtn) saveBtn.disabled = false;
    isSaving = false;
    return;
  }

  // Split new vs existing
  const toInsert = variants
    .filter((v) => !v.id)
    .map(({ _images, id, ...rest }) => rest);
  const toUpdate = variants.filter((v) => v.id);

  console.log("🔧 Variantes a insertar:", toInsert.length, toInsert);
  console.log("🔧 Variantes a actualizar:", toUpdate.length, toUpdate);

  // Validar unicidad de SKUs a insertar
  if (toInsert.length) {
    const skuList = toInsert.map((v) => v.sku);
    
    // Verificar duplicados dentro de la misma operación
    const skuCounts = {};
    skuList.forEach(sku => {
      skuCounts[sku] = (skuCounts[sku] || 0) + 1;
    });
    const duplicates = Object.keys(skuCounts).filter(sku => skuCounts[sku] > 1);
    if (duplicates.length > 0) {
      statusEl.textContent = `SKUs duplicados en esta operación: ${duplicates.join(", ")}`;
      statusEl.style.color = "#c00";
      return;
    }
    
    // Verificar duplicados en la base de datos
    const { data: exist } = await supabase
      .from("product_variants")
      .select("sku, id, product_id")
      .in("sku", skuList);
    const conflict = (exist || []).filter((e) => e.product_id !== prodId);
    if (conflict.length) {
      statusEl.textContent = `Los SKU ya existen: ${conflict
        .map((c) => c.sku)
        .join(", ")}`;
      statusEl.style.color = "#c00";
      return;
    }
  }

  // Insert new variants
  let inserted = [];
  if (toInsert.length) {
    console.log("🔧 Insertando variantes en la base de datos...");
    
    // Separar stock_qty de los datos de la variante (no se guarda en product_variants)
    const variantsWithStock = toInsert.map(v => {
      const { stock_qty, ...variantData } = v;
      return { variantData, stock_qty: stock_qty || 0 };
    });
    
    // Insertar variantes sin stock_qty
    const variantsToInsert = variantsWithStock.map(v => v.variantData);
    const { data: vNew, error: varErr } = await supabase
      .from("product_variants")
      .insert(variantsToInsert)
      .select("id, sku");
    if (varErr) {
      console.error("❌ Error al insertar variantes:", varErr);
      statusEl.textContent = `Error al crear variantes: ${varErr.message}`;
      statusEl.style.color = "#c00";
      return;
    }
    inserted = vNew;
    console.log("✅ Variantes insertadas exitosamente:", inserted);
    
    // Guardar stock en variant_warehouse_stock
    if (inserted.length > 0) {
      console.log("🔧 Guardando stock en almacenes...");
      
      // Obtener el ID del almacén "general"
      const { data: warehouse, error: whErr } = await supabase
        .from("warehouses")
        .select("id")
        .eq("code", "general")
        .single();
      
      if (whErr || !warehouse) {
        console.error("❌ Error obteniendo almacén general:", whErr);
        statusEl.textContent = `Error: No se encontró el almacén general. ${whErr?.message || ""}`;
        statusEl.style.color = "#c00";
        return;
      }
      
      // Crear mapa de SKU a stock_qty
      const stockBySku = new Map();
      variantsWithStock.forEach((v, idx) => {
        const sku = v.variantData.sku;
        if (sku && v.stock_qty > 0) {
          stockBySku.set(sku, v.stock_qty);
        }
      });
      
      // Insertar stock para cada variante insertada
      const stockRecords = inserted
        .filter(v => stockBySku.has(v.sku))
        .map(v => ({
          variant_id: v.id,
          warehouse_id: warehouse.id,
          stock_qty: stockBySku.get(v.sku)
        }));
      
      if (stockRecords.length > 0) {
        const { error: stockErr } = await supabase
          .from("variant_warehouse_stock")
          .upsert(stockRecords, { onConflict: "variant_id,warehouse_id" });
        
        if (stockErr) {
          console.error("❌ Error guardando stock:", stockErr);
          statusEl.textContent = `Error guardando stock: ${stockErr.message}`;
          statusEl.style.color = "#c00";
          return;
        }
        console.log(`✅ Stock guardado para ${stockRecords.length} variantes`);
      }
    }
  }

  // Update existing variants
  for (const v of toUpdate) {
    console.log("🔧 Actualizando variante:", v.sku, v);
    const { id, _images, stock_qty, ...rest } = v;
    
    // Actualizar variante sin stock_qty
    const { error: upVarErr } = await supabase
      .from("product_variants")
      .update(rest)
      .eq("id", id);
    if (upVarErr) {
      console.error("❌ Error al actualizar variante:", upVarErr);
      statusEl.textContent = `Error actualizando variante ${v.sku}: ${upVarErr.message}`;
      statusEl.style.color = "#c00";
      return;
    }
    console.log("✅ Variante actualizada:", v.sku);
    
    // Actualizar stock en variant_warehouse_stock si se proporcionó stock_qty
    if (stock_qty !== undefined && stock_qty !== null) {
      // Obtener el ID del almacén "general"
      const { data: warehouse, error: whErr } = await supabase
        .from("warehouses")
        .select("id")
        .eq("code", "general")
        .single();
      
      if (!whErr && warehouse) {
        const { error: stockErr } = await supabase
          .from("variant_warehouse_stock")
          .upsert({
            variant_id: id,
            warehouse_id: warehouse.id,
            stock_qty: stock_qty || 0
          }, { onConflict: "variant_id,warehouse_id" });
        
        if (stockErr) {
          console.warn("⚠️ Error actualizando stock:", stockErr);
        } else {
          console.log(`✅ Stock actualizado para variante ${v.sku}: ${stock_qty}`);
        }
      }
    }
  }

  // Map for images
  const idBySku = new Map(inserted.map((r) => [r.sku, r.id]));
  const allForImages = variants.map((v) => ({
    id: v.id || idBySku.get(v.sku),
    images: v._images || [],
  }));

  // Replace images per variant
  for (const v of allForImages) {
    if (!v.id) continue;
    await supabase.from("variant_images").delete().eq("variant_id", v.id);
    const payload = v.images.slice(0, 12).map((url, idx) => ({
      variant_id: v.id,
      url,
      position: idx + 1,
      alt: null,
    }));
    if (payload.length) await supabase.from("variant_images").insert(payload);
  }

  // Delete removed variants
  const keptIds = new Set(variants.filter((v) => v.id).map((v) => v.id));
  const toDelete = Array.from(originalVariantIds).filter(
    (id) => !keptIds.has(id)
  );
  if (toDelete.length) {
    await supabase.from("variant_images").delete().in("variant_id", toDelete);
    await supabase.from("product_variants").delete().in("id", toDelete);
  }

  // 4) Sincronizar tags jerárquicos del producto (product_tags)
  try {
    const tagPayload = {
      product_id: prodId,
      tag1_id: selectedTag1Id || null,
      tag2_id: selectedTag2Id || null,
      tag3_ids: selectedTag3Ids.length > 0 ? selectedTag3Ids : null
    };
    
    // Verificar si ya existe un registro
    const { data: existing } = await supabase
      .from("product_tags")
      .select("product_id")
      .eq("product_id", prodId)
      .single();
    
    if (existing) {
      // Actualizar
      const { error: updateErr } = await supabase
        .from("product_tags")
        .update({
          tag1_id: tagPayload.tag1_id,
          tag2_id: tagPayload.tag2_id,
          tag3_ids: tagPayload.tag3_ids
        })
        .eq("product_id", prodId);
      if (updateErr) {
        console.warn("Error actualizando tags jerárquicos:", updateErr);
      }
    } else {
      // Insertar nuevo
      const { error: insertErr } = await supabase
        .from("product_tags")
        .insert([tagPayload]);
      if (insertErr) {
        console.warn("Error insertando tags jerárquicos:", insertErr);
      }
    }
  } catch (e) {
    console.warn("No se pudieron sincronizar tags jerárquicos", e);
  }

  currentProductId = prodId;
  originalVariantIds = new Set(variants.filter((v) => v.id).map((v) => v.id));

  // Verificar que las variantes se guardaron correctamente
  console.log("🔧 Verificando variantes guardadas...");
  try {
    // Consultar solo las columnas que existen en product_variants
    const { data: verifyVariants, error: verifyErr } = await supabase
      .from("product_variants")
      .select("id, sku, color, size, active, price")
      .eq("product_id", prodId);

    if (verifyErr) {
      console.warn("⚠️ Error verificando variantes:", verifyErr.message);
    } else if (verifyVariants) {
      console.log("✅ Variantes verificadas en la base de datos:", verifyVariants.length);
      console.log("📋 Variantes:", verifyVariants.map(v => ({
        sku: v.sku,
        color: v.color,
        size: v.size,
        active: v.active
      })));
      
      // El stock ahora se maneja en variant_warehouse_stock, no en product_variants directamente
      // Si necesitas verificar stock, hazlo desde variant_warehouse_stock
    }
  } catch (e) {
    console.warn("⚠️ No se pudo verificar las variantes:", e.message);
  }

  statusEl.textContent = "Producto y variantes guardados";
  statusEl.style.color = "#090";
  // mantener datos en pantalla
  if (saveBtn) saveBtn.disabled = false;
  isSaving = false;
});

// Eliminar (archivar) producto sin perder historial
pDelete?.addEventListener("click", async () => {
  if (!currentProductId) {
    statusEl.textContent = "Primero carga un producto para poder eliminarlo.";
    statusEl.style.color = "#c00";
    return;
  }
  const name = (document.getElementById("name").value || "").trim();
  const handle = (document.getElementById("handle").value || "").trim();
  const ok = confirm(
    `¿Eliminar (archivar) el producto "${name}"?\nEsto lo ocultará del catálogo/stock y podrás reutilizar el handle.\nEl historial de pedidos se mantiene.`
  );
  if (!ok) return;
  statusEl.textContent = "Archivando producto...";
  statusEl.style.color = "inherit";
  const newHandle = `${handle}__arch_${Date.now()}`;
  // Marcar producto como archived y liberar handle
  const { error: upErr } = await supabase
    .from("products")
    .update({ status: "archived", handle: newHandle })
    .eq("id", currentProductId);
  if (upErr) {
    statusEl.textContent = `No se pudo archivar: ${upErr.message}`;
    statusEl.style.color = "#c00";
    return;
  }
  // Opcional: desactivar variantes para que no aparezcan en listas antiguas
  await supabase.from("product_variants").update({ active: false }).eq("product_id", currentProductId);
  statusEl.textContent = "Producto archivado. Ya podés reutilizar el nombre/handle.";
  statusEl.style.color = "#090";
  // Limpiar formulario
  currentProductId = null;
  originalVariantIds = new Set();
  form.reset();
  variantsTable.innerHTML = "";
  selectedDetailsIds = [];
  selectedHighlightsIds = [];
  await renderDetailsList();
  ensureDefaultVariant();
});

// ========== EVENT LISTENERS PARA DETAILS Y HIGHLIGHTS ==========

// Event delegation para details-list
const detailsList = document.getElementById("details-list");
detailsList?.addEventListener("change", (e) => {
  if (e.target.classList.contains("toggle-detail")) {
    const tag3Id = e.target.dataset.tag3Id;
    handleDetailToggle(tag3Id, e.target.checked);
  }
});

detailsList?.addEventListener("click", (e) => {
  if (e.target.classList.contains("toggle-highlight") || e.target.closest(".toggle-highlight")) {
    const button = e.target.classList.contains("toggle-highlight") 
      ? e.target 
      : e.target.closest(".toggle-highlight");
    if (button && !button.disabled) {
      const tag3Id = button.dataset.tag3Id;
      handleHighlightToggle(tag3Id);
    }
  }
});

// Event delegation para highlights-container (remover highlight)
const highlightsContainer = document.getElementById("highlights-container");
highlightsContainer?.addEventListener("click", (e) => {
  if (e.target.classList.contains("remove-highlight") || e.target.closest(".remove-highlight")) {
    const button = e.target.classList.contains("remove-highlight")
      ? e.target
      : e.target.closest(".remove-highlight");
    if (button) {
      const tag3Id = button.dataset.tag3Id;
      handleHighlightToggle(tag3Id);
    }
  }
});

// Búsqueda de details
const detailsSearch = document.getElementById("details-search");
detailsSearch?.addEventListener("input", () => renderDetailsList());

// Botón guardar details/highlights
const saveDetailsHighlightsBtn = document.getElementById("save-details-highlights-btn");
saveDetailsHighlightsBtn?.addEventListener("click", () => {
  if (currentProductId) {
    saveDetailsAndHighlights(currentProductId);
  } else {
    alert("Primero carga o crea un producto");
  }
});

// ========== FUNCIONES DE AUTO-TAGS CON IA ==========

// Configuración (puede moverse a un objeto de config si crece)
const AUTO_TAGS_CONFIG = {
  timeout: 60000, // 60 segundos timeout para llamada a Edge Function
  enableLogging: true, // Logging opcional para debugging
};

// Helper: Logging condicional
function logAutoTags(...args) {
  if (AUTO_TAGS_CONFIG.enableLogging) {
    console.log("[AutoTags]", ...args);
  }
}

// Helper: Normalizar nombre para comparación case-insensitive
function normalizeName(name) {
  return (name || "").trim().toLowerCase();
}

// Helper: Fetch tags por nombres (una sola query)
async function fetchTagsByNames(names, category, level, parentId) {
  if (!names || names.length === 0) return new Map();
  
  let query = supabase
    .from("tags")
    .select("id, name, level, parent_id, category");
  
  if (category) {
    query = query.eq("category", category);
  }
  
  if (level !== null && level !== undefined) {
    query = query.eq("level", level);
  }
  
  if (parentId) {
    query = query.eq("parent_id", parentId);
  } else if (level === 1) {
    query = query.is("parent_id", null);
  }
  
  const { data, error } = await query;
  
  if (error) {
    console.warn("Error fetching tags:", error);
    return new Map();
  }
  
  // Mapear en JS usando normalizeName
  const normalizedNames = new Set(names.map(n => normalizeName(n)));
  const result = new Map();
  
  (data || []).forEach(tag => {
    const normalized = normalizeName(tag.name);
    if (normalizedNames.has(normalized)) {
      // Encontrar el nombre original que coincide
      const originalName = names.find(n => normalizeName(n) === normalized);
      if (originalName) {
        result.set(originalName, tag.id);
      }
    }
  });
  
  return result;
}

// Mapear tag1 name a ID
async function mapTag1NameToId(name, category) {
  const map = await fetchTagsByNames([name], category, 1, null);
  return map.get(name) || null;
}

// Mapear tag2 name a ID
async function mapTag2NameToId(name, tag1Id) {
  if (!tag1Id) return null;
  const map = await fetchTagsByNames([name], null, 2, tag1Id);
  return map.get(name) || null;
}

// Mapear tag3 names a IDs con validación por árbol
async function mapTag3NamesToIds(names, tag1Id, tag2Id) {
  if (!names || names.length === 0) return new Map();
  if (!tag1Id) return new Map(); // Sin tag1, no podemos validar árbol
  
  let candidateTags = [];
  
  if (tag2Id) {
    // Caso 1: Hay tag2Id -> traer tags3 hijos DIRECTOS de ese tag2
    const { data, error } = await supabase
      .from("tags")
      .select("id, name, level, parent_id")
      .eq("level", 3)
      .eq("parent_id", tag2Id);
    
    if (!error && data) {
      candidateTags = data;
    }
  } else {
    // Caso 2: No hay tag2Id pero hay tag1Id -> traer todos los tags3 del árbol del tag1
    // Primero obtener todos los tags2 del tag1
    const { data: tags2, error: err2 } = await supabase
      .from("tags")
      .select("id")
      .eq("parent_id", tag1Id)
      .eq("level", 2);
    
    if (err2 || !tags2 || tags2.length === 0) {
      return new Map();
    }
    
    const tag2Ids = tags2.map(t => t.id);
    
    // Luego obtener todos los tags3 de esos tags2
    const { data, error } = await supabase
      .from("tags")
      .select("id, name, level, parent_id")
      .eq("level", 3)
      .in("parent_id", tag2Ids);
    
    if (!error && data) {
      candidateTags = data;
    }
  }
  
  // Validar que cada tag3 pertenece al árbol correcto
  const result = new Map();
  const normalizedNames = new Set(names.map(n => normalizeName(n)));
  
  candidateTags.forEach(tag => {
    const normalized = normalizeName(tag.name);
    if (normalizedNames.has(normalized)) {
      // Verificar que el parent_id pertenece al árbol de tag1Id
      if (tag.parent_id) {
        // Si hay tag2Id, el parent debe ser exactamente tag2Id
        if (tag2Id && tag.parent_id === tag2Id) {
          const originalName = names.find(n => normalizeName(n) === normalized);
          if (originalName) {
            result.set(originalName, tag.id);
          }
        } else if (!tag2Id) {
          // Si no hay tag2Id, el parent debe ser hijo de tag1Id (ya validado por la query)
          const originalName = names.find(n => normalizeName(n) === normalized);
          if (originalName) {
            result.set(originalName, tag.id);
          }
        }
      }
    }
  });
  
  return result;
}

// Invocar Edge Function de auto-tags con timeout y mejor manejo de errores
async function invokeAutoTags(imageUrl, productName, categoryHint, description) {
  const statusEl = document.getElementById("auto-tags-status");
  
  try {
    statusEl.textContent = "Analizando con IA...";
    statusEl.style.color = "inherit";
    
    logAutoTags("Invocando Edge Function", { productName, categoryHint, hasDescription: !!description });
    
    // Crear promise con timeout
    const invokePromise = supabase.functions.invoke("auto_tags", {
      body: {
        image_url: imageUrl,
        product_name: productName,
        category_hint: categoryHint,
        description: description || null,
      },
    });
    
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error("La solicitud a la IA tardó demasiado. Por favor, intentá nuevamente."));
      }, AUTO_TAGS_CONFIG.timeout);
    });
    
    // Race entre invoke y timeout
    const { data, error } = await Promise.race([invokePromise, timeoutPromise]);
    
    if (error) {
      // Manejar diferentes tipos de errores
      let errorMessage = "Error invocando función de IA";
      
      if (error.message) {
        errorMessage = error.message;
      } else if (typeof error === "string") {
        errorMessage = error;
      } else if (error.status === 408 || error.message?.includes("timeout")) {
        errorMessage = "La solicitud tardó demasiado. Por favor, intentá nuevamente.";
      } else if (error.status === 429) {
        errorMessage = "Demasiadas solicitudes. Por favor, esperá un momento e intentá nuevamente.";
      } else if (error.status >= 500) {
        errorMessage = "Error del servidor. Por favor, intentá nuevamente más tarde.";
      }
      
      logAutoTags("Error en invokeAutoTags", error);
      throw new Error(errorMessage);
    }
    
    if (!data) {
      logAutoTags("Respuesta vacía de Edge Function");
      throw new Error("No se recibió respuesta de la IA. Por favor, intentá nuevamente.");
    }
    
    if (data.error) {
      logAutoTags("Error en respuesta de IA", data.error);
      throw new Error(data.error || "Error en respuesta de IA");
    }
    
    // Validar estructura mínima de respuesta
    if (!data.tag1 || !data.tag2) {
      logAutoTags("Respuesta incompleta de IA", data);
      throw new Error("La respuesta de la IA está incompleta. Por favor, intentá nuevamente.");
    }
    
    logAutoTags("Respuesta exitosa de IA", {
      tag1: data.tag1,
      tag2: data.tag2,
      detailsCount: data.details?.length || 0,
      highlightsCount: data.highlights?.length || 0,
    });
    
    return data;
  } catch (error) {
    logAutoTags("Error capturado en invokeAutoTags", error);
    
    // Mensajes más amigables para el usuario
    let userMessage = error.message || "Error desconocido";
    
    if (error.message?.includes("timeout") || error.message?.includes("tardó demasiado")) {
      userMessage = "La solicitud tardó demasiado. Por favor, intentá nuevamente.";
    } else if (error.message?.includes("fetch")) {
      userMessage = "Error de conexión. Verificá tu conexión a internet e intentá nuevamente.";
    }
    
    statusEl.textContent = `Error: ${userMessage}`;
    statusEl.style.color = "#c00";
    throw error;
  }
}

// Mostrar modal de resumen
function showAutoTagsSummary(aiResponse, mappedTags, warnings) {
  return new Promise((resolve) => {
    // Remover modal anterior si existe
    const existingModal = document.getElementById("auto-tags-summary-modal");
    if (existingModal) {
      existingModal.remove();
    }
    
    const modal = document.createElement("div");
    modal.id = "auto-tags-summary-modal";
    modal.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0,0,0,0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 10000;
    `;
    
    const tag1Found = mappedTags.tag1Id !== null;
    const tag2Found = mappedTags.tag2Id !== null;
    const tag1Name = aiResponse.tag1 || "N/A";
    const tag2Name = aiResponse.tag2 || "N/A";
    
    const detailsFound = mappedTags.detailsMap || new Map();
    const highlightsFound = mappedTags.highlightsMap || new Map();
    
    const warningsHtml = warnings.length > 0
      ? `<div class="warnings" style="margin-top:12px;padding:8px;background:#fff3cd;border:1px solid #ffc107;border-radius:4px;">
          <strong style="color:#856404;">⚠️ Advertencias:</strong>
          <ul style="margin:4px 0 0 0;padding-left:20px;color:#856404;">
            ${warnings.map(w => `<li>${w}</li>`).join("")}
          </ul>
        </div>`
      : "";
    
    modal.innerHTML = `
      <div style="background:white;border-radius:8px;padding:20px;max-width:500px;max-height:80vh;overflow-y:auto;box-shadow:0 4px 6px rgba(0,0,0,0.1);">
        <h3 style="margin:0 0 16px 0;font-size:16px;">🤖 IA detectó los siguientes tags:</h3>
        
        <div style="margin-bottom:12px;">
          <strong>Tipo:</strong> 
          <span style="color:${tag1Found ? "#090" : "#c00"};">
            ${tag1Name} ${tag1Found ? "✓" : "⚠️ (no encontrado)"}
          </span>
        </div>
        
        <div style="margin-bottom:12px;">
          <strong>Atributo:</strong> 
          <span style="color:${tag2Found ? "#090" : "#c00"};">
            ${tag2Name} ${tag2Found ? "✓" : "⚠️ (no encontrado)"}
          </span>
        </div>
        
        <div style="margin-bottom:12px;">
          <strong>Detalles:</strong>
          <ul style="margin:4px 0;padding-left:20px;">
            ${(aiResponse.details || []).map(detail => {
              const found = detailsFound.has(detail);
              return `<li style="color:${found ? "#090" : "#c00"};">
                ${detail} ${found ? "✓" : "⚠️ (no encontrado)"}
              </li>`;
            }).join("")}
            ${(aiResponse.details || []).length === 0 ? "<li style='color:#666;'>Ninguno</li>" : ""}
          </ul>
        </div>
        
        <div style="margin-bottom:12px;">
          <strong>Destacados:</strong>
          <ul style="margin:4px 0;padding-left:20px;">
            ${(aiResponse.highlights || []).map(highlight => {
              const found = highlightsFound.has(highlight);
              return `<li style="color:${found ? "#090" : "#c00"};">
                ${highlight} ${found ? "✓" : "⚠️ (no encontrado o fuera de details)"}
              </li>`;
            }).join("")}
            ${(aiResponse.highlights || []).length === 0 ? "<li style='color:#666;'>Ninguno</li>" : ""}
          </ul>
        </div>
        
        ${warningsHtml}
        
        <div style="margin-top:16px;display:flex;gap:8px;justify-content:flex-end;">
          <button id="cancel-auto-tags" class="btn" style="padding:6px 12px;font-size:12px;">Cancelar</button>
          <button id="apply-auto-tags" class="btn primary" style="padding:6px 12px;font-size:12px;">Aplicar</button>
        </div>
      </div>
    `;
    
    document.body.appendChild(modal);
    
    // Event listeners
    document.getElementById("apply-auto-tags").addEventListener("click", () => {
      modal.remove();
      resolve(true);
    });
    
    document.getElementById("cancel-auto-tags").addEventListener("click", () => {
      modal.remove();
      resolve(false);
    });
    
    // Cerrar al hacer click fuera
    modal.addEventListener("click", (e) => {
      if (e.target === modal) {
        modal.remove();
        resolve(false);
      }
    });
    
    // Cerrar con ESC
    const handleEsc = (e) => {
      if (e.key === "Escape") {
        modal.remove();
        document.removeEventListener("keydown", handleEsc);
        resolve(false);
      }
    };
    document.addEventListener("keydown", handleEsc);
  });
}

// Aplicar auto-tags a UI
async function applyAutoTagsToUI(aiResponse) {
  const statusEl = document.getElementById("auto-tags-status");
  const warnings = [];
  
  try {
    // 1. Mapear category (opcional, solo si cambió)
    const currentCategory = getProductCategory();
    if (aiResponse.category && aiResponse.category !== currentCategory) {
      // No forzamos cambio de categoría, solo warning
      warnings.push(`La categoría detectada por la IA ("${aiResponse.category}") difiere de la actual ("${currentCategory}"). Los tags se mapearán según la categoría actual.`);
    }
    
    // 2. Mapear tag1
    let tag1Id = null;
    let tag1Name = null;
    if (aiResponse.tag1) {
      tag1Id = await mapTag1NameToId(aiResponse.tag1, aiResponse.category || currentCategory);
      if (tag1Id) {
        tag1Name = aiResponse.tag1;
      } else {
        warnings.push(`Tipo "${aiResponse.tag1}" no encontrado en la categoría "${aiResponse.category || currentCategory}". Podés crearlo manualmente.`);
      }
    }
    
    // 3. Mapear tag2 (solo si tag1 existe)
    let tag2Id = null;
    let tag2Name = null;
    if (aiResponse.tag2 && tag1Id) {
      tag2Id = await mapTag2NameToId(aiResponse.tag2, tag1Id);
      if (tag2Id) {
        tag2Name = aiResponse.tag2;
      } else {
        warnings.push(`Atributo "${aiResponse.tag2}" no encontrado como hijo de "${aiResponse.tag1}". Podés crearlo manualmente.`);
      }
    } else if (aiResponse.tag2 && !tag1Id) {
      warnings.push(`Atributo "${aiResponse.tag2}" no se puede mapear porque el Tipo no fue encontrado.`);
    }
    
    // 4. Mapear details (solo si tag1 existe)
    const detailsMap = new Map();
    if (aiResponse.details && Array.isArray(aiResponse.details) && tag1Id) {
      const mapped = await mapTag3NamesToIds(aiResponse.details, tag1Id, tag2Id);
      mapped.forEach((id, name) => {
        detailsMap.set(name, id);
      });
      
      // Warnings para details no encontrados
      aiResponse.details.forEach(detail => {
        if (!detailsMap.has(detail)) {
          warnings.push(`Detalle "${detail}" no encontrado o no pertenece al árbol de "${aiResponse.tag1}". Verificá que esté en la rama correcta.`);
        }
      });
    } else if (aiResponse.details && !tag1Id) {
      warnings.push("Los detalles no se pueden mapear porque el Tipo no fue encontrado.");
    }
    
    // 5. Mapear highlights (validar subset de details + máx 2)
    const highlightsMap = new Map();
    let validHighlights = (aiResponse.highlights || []).filter(h => detailsMap.has(h));
    
    if (validHighlights.length > 2) {
      validHighlights = validHighlights.slice(0, 2);
      warnings.push("Los destacados fueron limitados a 2 (máximo permitido).");
    }
    
    if (validHighlights.length > 0 && tag1Id) {
      const mapped = await mapTag3NamesToIds(validHighlights, tag1Id, tag2Id);
      mapped.forEach((id, name) => {
        highlightsMap.set(name, id);
      });
      
      // Warnings para highlights no encontrados
      validHighlights.forEach(highlight => {
        if (!highlightsMap.has(highlight)) {
          warnings.push(`Destacado "${highlight}" no encontrado o no pertenece al árbol. Verificá que esté en los detalles seleccionados.`);
        }
      });
    }
    
    // Preparar datos para el modal
    const mappedTags = {
      tag1Id,
      tag2Id,
      detailsMap,
      highlightsMap,
    };
    
    // 6. Mostrar modal de resumen
    const shouldApply = await showAutoTagsSummary(aiResponse, mappedTags, warnings);
    
    if (!shouldApply) {
      statusEl.textContent = "Cancelado por el usuario";
      statusEl.style.color = "#666";
      return;
    }
    
    // 7. Aplicar cambios
    if (tag1Id) {
      selectedTag1Id = tag1Id;
      await renderTags1();
    }
    
    if (tag2Id) {
      selectedTag2Id = tag2Id;
      await renderTags2();
    }
    
    // Aplicar details
    selectedDetailsIds = Array.from(detailsMap.values());
    
    // Aplicar highlights
    selectedHighlightsIds = Array.from(highlightsMap.values());
    
    // Re-renderizar
    await renderDetailsList();
    
    statusEl.textContent = "✓ Tags aplicados. Revisá y guardá cuando estés listo.";
    statusEl.style.color = "#090";
    
    if (warnings.length > 0) {
      statusEl.textContent += ` (${warnings.length} advertencias)`;
    }
    
  } catch (error) {
    console.error("Error en applyAutoTagsToUI:", error);
    statusEl.textContent = `Error: ${error.message}`;
    statusEl.style.color = "#c00";
  }
}

// Handler principal para auto-tags
async function handleAutoTagsClick() {
  const statusEl = document.getElementById("auto-tags-status");
  const btn = document.getElementById("auto-tags-btn");
  
  // Validación inicial
  if (!currentProductId) {
    statusEl.textContent = "Error: Primero carga o crea un producto";
    statusEl.style.color = "#c00";
    return;
  }
  
  // Deshabilitar botón durante procesamiento
  const originalBtnText = btn.textContent;
  const originalBtnDisabled = btn.disabled;
  btn.disabled = true;
  btn.textContent = "⏳ Procesando...";
  
  try {
    statusEl.textContent = "Obteniendo imagen...";
    statusEl.style.color = "inherit";
    
    logAutoTags("Iniciando proceso de auto-tags", { productId: currentProductId });
    
    // 1. Obtener variant activo
    const { data: variant, error: variantError } = await supabase
      .from("product_variants")
      .select("id")
      .eq("product_id", currentProductId)
      .eq("active", true)
      .limit(1)
      .maybeSingle();
    
    if (variantError) {
      logAutoTags("Error obteniendo variant", variantError);
      throw new Error("Error al buscar variante del producto");
    }
    
    if (!variant) {
      throw new Error("No se encontró una variante activa. Asegurate de que el producto tenga al menos una variante activa.");
    }
    
    statusEl.textContent = "Buscando imagen principal...";
    
    // 2. Obtener imagen principal
    const { data: image, error: imageError } = await supabase
      .from("variant_images")
      .select("url")
      .eq("variant_id", variant.id)
      .eq("position", 1)
      .maybeSingle();
    
    if (imageError) {
      logAutoTags("Error obteniendo imagen", imageError);
      throw new Error("Error al buscar imagen del producto");
    }
    
    if (!image || !image.url) {
      throw new Error("No se encontró imagen principal. Asegurate de que la variante tenga una imagen con posición 1.");
    }
    
    // 3. Obtener contexto del form
    const productNameEl = document.getElementById("name");
    const categoryEl = document.getElementById("category");
    const descriptionEl = document.getElementById("description");
    
    const productName = productNameEl?.value?.trim() || "";
    const category = categoryEl?.value || getProductCategory();
    const description = descriptionEl?.value?.trim() || null;
    
    if (!productName) {
      throw new Error("El nombre del producto es requerido. Completá el campo 'Nombre' antes de usar auto-tags.");
    }
    
    // 4. Invocar IA
    const aiResponse = await invokeAutoTags(image.url, productName, category, description);
    
    // 5. Aplicar resultados
    await applyAutoTagsToUI(aiResponse);
    
  } catch (error) {
    logAutoTags("Error en handleAutoTagsClick", error);
    
    // Mensajes más amigables
    let userMessage = error.message || "Error desconocido";
    
    if (error.message?.includes("timeout") || error.message?.includes("tardó demasiado")) {
      userMessage = "La solicitud tardó demasiado. Por favor, intentá nuevamente.";
    } else if (error.message?.includes("fetch") || error.message?.includes("conexión")) {
      userMessage = "Error de conexión. Verificá tu conexión a internet e intentá nuevamente.";
    }
    
    statusEl.textContent = `Error: ${userMessage}`;
    statusEl.style.color = "#c00";
  } finally {
    // Restaurar botón
    btn.disabled = originalBtnDisabled;
    btn.textContent = originalBtnText;
  }
}

// Event listener para botón auto-tags
const autoTagsBtn = document.getElementById("auto-tags-btn");
autoTagsBtn?.addEventListener("click", handleAutoTagsClick);
