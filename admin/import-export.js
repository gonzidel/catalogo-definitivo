// admin/import-export.js
import { requireAuth } from "./admin-auth.js";
import { supabase } from "../scripts/supabase-client.js";
import { checkPermission, requirePermission } from "./permissions-helper.js";

await requireAuth();

// Verificar permisos de import/export
let canExport = false;
let canImport = false;

async function checkImportExportPermissions() {
  canExport = await checkPermission('export', 'view');
  canImport = await checkPermission('import', 'edit');
  
  // Ocultar botones según permisos
  const exportAllBtn = document.getElementById("export-all");
  const exportInvBtn = document.getElementById("export-inventory");
  const parseBtn = document.getElementById("parse");
  const runBtn = document.getElementById("run");
  const parseInvBtn = document.getElementById("parse-inv");
  const runInvBtn = document.getElementById("run-inv");
  const parseNewBtn = document.getElementById("parse-new");
  const runNewBtn = document.getElementById("run-new");
  
  if (!canExport) {
    if (exportAllBtn) exportAllBtn.style.display = "none";
    if (exportInvBtn) exportInvBtn.style.display = "none";
  }
  
  if (!canImport) {
    if (parseBtn) parseBtn.style.display = "none";
    if (runBtn) runBtn.style.display = "none";
    if (parseInvBtn) parseInvBtn.style.display = "none";
    if (runInvBtn) runInvBtn.style.display = "none";
    if (parseNewBtn) parseNewBtn.style.display = "none";
    if (runNewBtn) runNewBtn.style.display = "none";
    
    // Ocultar inputs de archivo
    const fileInputs = document.querySelectorAll('input[type="file"]');
    fileInputs.forEach(input => input.style.display = "none");
  }
}

await checkImportExportPermissions();

// CSV helpers
function toCSV(rows) {
  const headers = Object.keys(rows[0] || {});
  const esc = (v) => {
    if (v == null) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(","), ...rows.map((r) => headers.map((h) => esc(r[h])).join(","))].join("\n");
}
function download(name, text, type = "text/csv") {
  const blob = new Blob([text], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// Normalizadores
const digitsOnly = (s) => (s || "").replace(/\D+/g, "");
const parseARS = (s) => {
  const d = digitsOnly(String(s));
  return d ? parseInt(d, 10) : 0;
};
const bool = (v) => {
  if (typeof v === "boolean") return v;
  const s = String(v || "").trim().toLowerCase();
  return s === "true" || s === "1" || s === "si" || s === "sí" || s === "yes";
};
const asArray = (val, sep = "|") => String(val || "").split(sep).map((s) => s.trim()).filter(Boolean);

// Helpers para inventario
function toCSVWithBOM(rows) {
  if (!rows || !rows.length) return "\ufeffsep=,\n";
  const csv = toCSV(rows);
  return "\ufeff" + "sep=,\n" + csv;
}
function normalizeHeaders(obj) {
  const out = {};
  Object.keys(obj).forEach((k) => {
    out[k.trim().toLowerCase()] = obj[k];
  });
  return out;
}

// Exportar (variantes)
async function exportVariants() {
  if (!canExport) {
    alert("No tienes permiso para exportar datos.");
    return;
  }
  
  const msg = document.getElementById("export-msg");
  msg.textContent = "Exportando…";
  msg.className = "message";
  try {
    const { data: variants, error } = await supabase
      .from("product_variants")
      .select(
        "id, product_id, sku, color, size, price, stock_qty, active, products(id, handle, name, category, status, description)"
      )
      .order("sku");
    if (error) throw error;

    const vIds = variants.map((v) => v.id);
    const pIds = [...new Set(variants.map((v) => v.product_id))];

    const [{ data: imgs }] = await Promise.all([
      supabase
        .from("variant_images")
        .select("variant_id, url, position")
        .in("variant_id", vIds)
        .order("position"),
    ]);

    const { data: pt } = await supabase
      .from("product_tags")
      .select("product_id, tags(name)")
      .in("product_id", pIds);

    const tagsByProduct = {};
    (pt || []).forEach((r) => {
      const n = r.tags?.name;
      if (!n) return;
      (tagsByProduct[r.product_id] ||= new Set()).add(n);
    });

    const rows = variants.map((v) => {
      const p = v.products || {};
      const images = (imgs || [])
        .filter((i) => i.variant_id === v.id)
        .sort((a, b) => (a.position || 0) - (b.position || 0))
        .map((i) => i.url)
        .join("|");
      const tags = Array.from(tagsByProduct[v.product_id] || [])
        .slice(0, 3)
        .join("|");
      return {
        handle: p.handle || "",
        name: p.name || "",
        category: p.category || "",
        status: p.status || "",
        description: p.description || "",
        sku: v.sku || "",
        color: v.color || "",
        size: v.size || "",
        price: v.price ?? 0,
        stock: v.stock_qty ?? 0,
        active: v.active ? "true" : "false",
        images,
        tags,
      };
    });

    const headers = ["handle","name","category","status","description","sku","color","size","price","stock","active","images","tags"];
    const ordered = rows.map(r => headers.reduce((o,h)=>(o[h]=r[h]??"",o),{}));
    // CSV amigable para Excel: BOM + indicador de separador
    const csvBody = toCSV(ordered);
    const content = "\ufeff" + "sep=,\n" + csvBody; // BOM + separador + CSV
    download(`catalogo_${Date.now()}.csv`, content);
    msg.textContent = `✅ Exportadas ${rows.length} variantes`;
    msg.className = "message ok";
  } catch (e) {
    msg.textContent = `❌ Error exportando: ${e.message}`;
    msg.className = "message err";
  }
}

// CSV parse
function parseCSV(text) {
  const rows = [];
  let i = 0,
    cur = "",
    inq = false,
    row = [];
  const pushCell = () => {
    row.push(cur);
    cur = "";
  };
  const pushRow = () => {
    rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const ch = text[i];
    if (inq) {
      if (ch === '"' && text[i + 1] === '"') {
        cur += '"';
        i += 2;
        continue;
      }
      if (ch === '"') {
        inq = false;
        i++;
        continue;
      }
      cur += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inq = true;
      i++;
      continue;
    }
    if (ch === ",") {
      pushCell();
      i++;
      continue;
    }
    if (ch === "\n") {
      pushCell();
      pushRow();
      i++;
      continue;
    }
    if (ch === "\r") {
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  if (cur.length || row.length) {
    pushCell();
    pushRow();
  }
  const headers = (rows.shift() || []).map((h) => h.trim());
  return rows
    .filter((r) => r.length && r.some((c) => c.trim().length))
    .map((r) => {
      const o = {};
      headers.forEach((h, idx) => (o[h] = r[idx] || ""));
      return o;
    });
}

function renderPreview(rows) {
  const prev = document.getElementById("preview");
  prev.value = rows.slice(0, 10).map((r) => JSON.stringify(r)).join("\n");
  const tableWrap = document.getElementById("table-wrap");
  const headers = [
    "handle",
    "name",
    "category",
    "status",
    "description",
    "sku",
    "color",
    "size",
    "price",
    "stock",
    "active",
    "images",
    "tags",
  ];
  const html = [
    "<table><thead><tr>",
    headers.map((h) => `<th>${h}</th>`).join(""),
    "</tr></thead><tbody>",
    ...rows
      .slice(0, 20)
      .map((r) => "<tr>" + headers.map((h) => `<td>${r[h] ?? ""}</td>`).join("") + "</tr>"),
    "</tbody></table>",
  ].join("");
  tableWrap.innerHTML = html;
}

// Unificación: botón único
const exportAllBtn = document.getElementById("export-all");
if (exportAllBtn) exportAllBtn.addEventListener("click", exportVariants);

// ----- Exportar inventario (SKU, size, stock, price, active) -----
async function exportInventory() {
  if (!canExport) {
    alert("No tienes permiso para exportar datos.");
    return;
  }
  
  const msg = document.getElementById("export-inv-msg");
  msg.textContent = "Exportando…";
  msg.className = "message";
  try {
    const { data, error } = await supabase
      .from("product_variants")
      .select("sku, size, stock_qty, price, active")
      .order("sku");
    if (error) throw error;
    const rows = (data || []).map((v) => ({
      sku: v.sku || "",
      size: v.size || "",
      stock: v.stock_qty ?? 0,
      price: v.price ?? 0,
      active: v.active ? "true" : "false",
    }));
    const content = toCSVWithBOM(rows);
    download(`inventario_${Date.now()}.csv`, content);
    msg.textContent = `✅ Exportadas ${rows.length} filas de inventario`;
    msg.className = "message ok";
  } catch (e) {
    msg.textContent = `❌ Error exportando inventario: ${e.message}`;
    msg.className = "message err";
  }
}
const exportInvBtn = document.getElementById("export-inventory");
if (exportInvBtn) exportInvBtn.addEventListener("click", exportInventory);

// Validación de datos antes de importar
function validateRows(rows) {
  const errors = [];
  const requiredFields = ['handle', 'sku'];
  
  rows.forEach((row, index) => {
    const rowNum = index + 2; // +2 porque la fila 1 es el header
    
    // Validar campos requeridos
    requiredFields.forEach(field => {
      if (!row[field] || !String(row[field]).trim()) {
        errors.push(`Fila ${rowNum}: El campo "${field}" es requerido`);
      }
    });
    
    // Validar formato de precio
    if (row.price !== undefined && row.price !== '') {
      const price = parseARS(row.price);
      if (isNaN(price) || price < 0) {
        errors.push(`Fila ${rowNum}: El precio "${row.price}" no es válido`);
      }
    }
    
    // Validar formato de stock
    if (row.stock !== undefined && row.stock !== '') {
      const stock = parseInt(row.stock, 10);
      if (isNaN(stock) || stock < 0) {
        errors.push(`Fila ${rowNum}: El stock "${row.stock}" no es válido`);
      }
    }
    
    // Validar formato de imágenes (URLs)
    if (row.images) {
      const imageUrls = asArray(row.images);
      imageUrls.forEach(url => {
        if (url && !url.match(/^https?:\/\//) && !url.match(/^\/\//)) {
          errors.push(`Fila ${rowNum}: URL de imagen inválida: "${url}"`);
        }
      });
    }
  });
  
  return errors;
}

// Validar SKUs duplicados en el CSV
function findDuplicateSKUs(rows) {
  const skuCount = new Map();
  const duplicates = [];
  
  rows.forEach((row, index) => {
    const sku = (row.sku || '').trim();
    if (sku) {
      if (!skuCount.has(sku)) {
        skuCount.set(sku, []);
      }
      skuCount.get(sku).push(index + 2); // +2 porque la fila 1 es el header
    }
  });
  
  skuCount.forEach((rowNumbers, sku) => {
    if (rowNumbers.length > 1) {
      duplicates.push({ sku, rows: rowNumbers });
    }
  });
  
  return duplicates;
}

// Mostrar errores de validación
function showValidationErrors(errors, containerId = "validation-errors") {
  const container = document.getElementById(containerId);
  if (!container) return false;
  
  if (errors.length > 0) {
    container.innerHTML = `<strong>Errores de validación encontrados:</strong><ul>${errors.map(e => `<li>${e}</li>`).join('')}</ul>`;
    container.classList.add("active");
    return true;
  } else {
    container.classList.remove("active");
    return false;
  }
}

// Mostrar SKUs duplicados
function showDuplicateSKUs(duplicates) {
  const container = document.getElementById("duplicate-skus");
  if (duplicates.length > 0) {
    container.innerHTML = `<strong>SKUs duplicados encontrados:</strong><ul>${duplicates.map(d => `<li>SKU "${d.sku}" aparece en las filas: ${d.rows.join(', ')}</li>`).join('')}</ul>`;
    container.classList.add("active");
    return true;
  } else {
    container.classList.remove("active");
    return false;
  }
}

// Actualizar barra de progreso
function updateProgress(current, total, containerId, fillId, textId) {
  const percentage = Math.round((current / total) * 100);
  const container = document.getElementById(containerId);
  const fill = document.getElementById(fillId);
  const text = document.getElementById(textId);
  
  if (container && fill && text) {
    container.classList.add("active");
    fill.style.width = `${percentage}%`;
    text.textContent = `${percentage}% (${current}/${total})`;
  }
}

// Ocultar barra de progreso
function hideProgress(containerId) {
  const container = document.getElementById(containerId);
  if (container) {
    container.classList.remove("active");
  }
}

// Modal de confirmación para reemplazar imágenes
function confirmImageReplacement() {
  return new Promise((resolve) => {
    const modal = document.getElementById("confirm-modal");
    const cancelBtn = document.getElementById("confirm-cancel");
    const okBtn = document.getElementById("confirm-ok");
    
    modal.classList.add("active");
    
    const cleanup = () => {
      modal.classList.remove("active");
      cancelBtn.removeEventListener("click", onCancel);
      okBtn.removeEventListener("click", onOk);
    };
    
    const onCancel = () => {
      cleanup();
      resolve(false);
    };
    
    const onOk = () => {
      cleanup();
      resolve(true);
    };
    
    cancelBtn.addEventListener("click", onCancel);
    okBtn.addEventListener("click", onOk);
  });
}

document.getElementById("parse").addEventListener("click", async () => {
  if (!canImport) {
    alert("No tienes permiso para importar datos.");
    return;
  }
  
  const file = document.getElementById("file").files[0];
  const msg = document.getElementById("import-msg");
  const validationErrors = document.getElementById("validation-errors");
  const duplicateSKUs = document.getElementById("duplicate-skus");
  
  // Limpiar mensajes anteriores
  validationErrors.classList.remove("active");
  duplicateSKUs.classList.remove("active");
  
  if (!file) {
    msg.textContent = "⚠️ Seleccioná un archivo CSV";
    msg.className = "message warn";
    return;
  }
  const text = await file.text();
  const rows = parseCSV(text);
  if (!rows.length) {
    msg.textContent = "⚠️ CSV vacío o inválido";
    msg.className = "message warn";
    return;
  }
  
  // Validar datos
  const errors = validateRows(rows);
  const duplicates = findDuplicateSKUs(rows);
  
  const hasErrors = showValidationErrors(errors);
  const hasDuplicates = showDuplicateSKUs(duplicates);
  
  if (hasErrors || hasDuplicates) {
    msg.textContent = "⚠️ Corregí los errores antes de importar";
    msg.className = "message warn";
    renderPreview(rows);
    return;
  }
  
  renderPreview(rows);
  const runBtn = document.getElementById("run");
  runBtn.disabled = false;
  runBtn.onclick = async () => {
    const options = {
      createTags: document.getElementById("create-tags").checked,
      createColors: document.getElementById("create-colors").checked,
      truncateImages: document.getElementById("truncate-images").checked,
    };
    
    // Confirmar antes de reemplazar imágenes
    if (options.truncateImages) {
      const confirmed = await confirmImageReplacement();
      if (!confirmed) {
        msg.textContent = "⚠️ Importación cancelada";
        msg.className = "message warn";
        return;
      }
    }
    
    try {
      await importRows(rows, options);
    } catch (e) {
      msg.textContent = `❌ Error importando: ${e.message}`;
      msg.className = "message err";
    }
  };
});

async function importRows(rows, options) {
  if (!canImport) {
    alert("No tienes permiso para importar datos.");
    return;
  }
  
  const msg = document.getElementById("import-msg");
  msg.textContent = "⏳ Importando…";
  msg.className = "message";

  // Estado para rollback
  const rollbackState = {
    createdProducts: [],
    createdVariants: [],
    createdTags: [],
    createdColors: [],
    updatedProducts: [],
    updatedVariants: [],
    deletedImages: [],
  };

  // Group by product handle
  const byHandle = new Map();
  rows.forEach((r) => {
    const h = (r.handle || "").trim();
    if (!h || !r.sku) return;
    if (!byHandle.has(h)) byHandle.set(h, []);
    byHandle.get(h).push(r);
  });

  const totalProducts = byHandle.size;
  let processedProducts = 0;

  try {
    for (const [handle, items] of byHandle.entries()) {
      const first = items[0];

      // Actualizar progreso
      processedProducts++;
      updateProgress(processedProducts, totalProducts, "progress-container", "progress-fill", "progress-text");

    // 1) Upsert product
    const { data: prodExisting } = await supabase.from("products").select("id").eq("handle", handle).maybeSingle();
      let productId = prodExisting?.id;
      let isNewProduct = false;
      
      if (!productId) {
        const { data: created, error } = await supabase
          .from("products")
          .insert([
            {
              handle,
              name: first.name || handle,
              category: first.category || "Calzado",
              status: first.status || "active",
              description: first.description || "",
            },
          ])
          .select("id")
          .single();
        if (error) throw error;
        productId = created.id;
        isNewProduct = true;
        rollbackState.createdProducts.push(productId);
      } else {
        // Guardar estado anterior para rollback
        const { data: oldProduct } = await supabase
          .from("products")
          .select("*")
          .eq("id", productId)
          .single();
        if (oldProduct) {
          rollbackState.updatedProducts.push({ id: productId, data: oldProduct });
        }
        
        const { error } = await supabase
          .from("products")
          .update({
            name: first.name || handle,
            category: first.category || "Calzado",
            status: first.status || "active",
            description: first.description || "",
          })
          .eq("id", productId);
        if (error) throw error;
      }

      // 2) Tags (máximo 3 por producto)
      const tagNames = asArray(first.tags).slice(0, 3);
      if (tagNames.length) {
        const { data: found } = await supabase.from("tags").select("id,name").in("name", tagNames);
        const foundNames = new Set((found || []).map((t) => t.name.toLowerCase()));
        const toCreate = tagNames
          .filter((n) => !foundNames.has(n.toLowerCase()))
          .map((n) => ({ name: n }));
        
        if (options.createTags && toCreate.length) {
          const { data: createdTags, error } = await supabase.from("tags").insert(toCreate).select("id");
          if (error) throw error;
          rollbackState.createdTags.push(...(createdTags || []).map(t => t.id));
        }
        
        const { data: allTags } = await supabase.from("tags").select("id,name").in("name", tagNames);
        const ids = (allTags || []).map((t) => t.id);
        const { data: currentPT } = await supabase
          .from("product_tags")
          .select("tag_id")
          .eq("product_id", productId);
        const currentSet = new Set((currentPT || []).map((r) => r.tag_id));
        const desiredSet = new Set(ids);
        const toAdd = ids.filter((id) => !currentSet.has(id)).map((id) => ({ product_id: productId, tag_id: id }));
        const toRemove = (currentPT || [])
          .filter((r) => !desiredSet.has(r.tag_id))
          .map((r) => r.tag_id);
        if (toAdd.length) {
          const { error } = await supabase.from("product_tags").insert(toAdd);
          if (error) throw error;
        }
        if (toRemove.length) {
          const { error } = await supabase.from("product_tags").delete().in("tag_id", toRemove).eq("product_id", productId);
          if (error) throw error;
        }
      }

      // 3) Variants
      for (const r of items) {
        const price = parseARS(r.price);
        const stock = parseInt(r.stock || "0", 10) || 0;
        const active = bool(r.active);
        const color = (r.color || "").trim();
        
        // Crear color si no existe (opcional)
        if (options.createColors && color) {
          const { data: foundColor } = await supabase
            .from("colors")
            .select("name")
            .eq("name", color)
            .limit(1);
          if (!foundColor || !foundColor.length) {
            try {
              const { data: createdColor, error } = await supabase.from("colors").insert([{ name: color }]).select("id").single();
              if (!error && createdColor) {
                rollbackState.createdColors.push(createdColor.id);
              }
            } catch {}
          }
        }

        const { data: existing } = await supabase
          .from("product_variants")
          .select("id")
          .eq("sku", r.sku)
          .maybeSingle();
        let variantId = existing?.id;
        let isNewVariant = false;
        
        const payload = {
          product_id: productId,
          sku: r.sku,
          color,
          size: r.size,
          price,
          stock_qty: stock,
          active,
          reserved_qty: 0,
        };
        
        if (!variantId) {
          const { data: created, error } = await supabase
            .from("product_variants")
            .insert([payload])
            .select("id")
            .single();
          if (error) throw error;
          variantId = created.id;
          isNewVariant = true;
          rollbackState.createdVariants.push(variantId);
        } else {
          // Guardar estado anterior para rollback
          const { data: oldVariant } = await supabase
            .from("product_variants")
            .select("*")
            .eq("id", variantId)
            .single();
          if (oldVariant) {
            rollbackState.updatedVariants.push({ id: variantId, data: oldVariant });
          }
          
          // Guardar imágenes existentes antes de borrarlas
          if (options.truncateImages) {
            const { data: existingImages } = await supabase
              .from("variant_images")
              .select("*")
              .eq("variant_id", variantId);
            if (existingImages && existingImages.length > 0) {
              rollbackState.deletedImages.push({ variant_id: variantId, images: existingImages });
            }
          }
          
          const { error } = await supabase
            .from("product_variants")
            .update(payload)
            .eq("id", variantId);
          if (error) throw error;
        }

        // Imágenes
        const images = asArray(r.images);
        if (variantId && options.truncateImages) {
          const { error } = await supabase.from("variant_images").delete().eq("variant_id", variantId);
          if (error) throw error;
        }
        if (variantId && images.length) {
          const payloadImgs = images
            .slice(0, 12)
            .map((url, idx) => ({ variant_id: variantId, url, position: idx + 1, alt: null }));
          const { error } = await supabase.from("variant_images").insert(payloadImgs);
          if (error) throw error;
        }
      }
    }

    hideProgress("progress-container");
    msg.textContent = `✅ Importación finalizada (${rows.length} filas)`;
    msg.className = "message ok";
  } catch (e) {
    hideProgress("progress-container");
    
    // Intentar rollback
    msg.textContent = `⚠️ Error durante la importación. Intentando revertir cambios...`;
    msg.className = "message warn";
    
    try {
      await rollbackChanges(rollbackState);
      msg.textContent = `❌ Error: ${e.message}. Los cambios han sido revertidos.`;
      msg.className = "message err";
    } catch (rollbackError) {
      msg.textContent = `❌ Error crítico: ${e.message}. Error en rollback: ${rollbackError.message}. Revisá manualmente los datos.`;
      msg.className = "message err";
    }
    throw e;
  }
}

// Función de rollback
async function rollbackChanges(state) {
  // Revertir variantes actualizadas
  for (const variant of state.updatedVariants) {
    await supabase
      .from("product_variants")
      .update(variant.data)
      .eq("id", variant.id);
  }
  
  // Eliminar variantes creadas
  if (state.createdVariants.length > 0) {
    await supabase
      .from("product_variants")
      .delete()
      .in("id", state.createdVariants);
  }
  
  // Revertir productos actualizados
  for (const product of state.updatedProducts) {
    await supabase
      .from("products")
      .update(product.data)
      .eq("id", product.id);
  }
  
  // Eliminar productos creados
  if (state.createdProducts.length > 0) {
    await supabase
      .from("products")
      .delete()
      .in("id", state.createdProducts);
  }
  
  // Restaurar imágenes eliminadas
  for (const imgData of state.deletedImages) {
    if (imgData.images && imgData.images.length > 0) {
      await supabase
        .from("variant_images")
        .insert(imgData.images);
    }
  }
  
  // Eliminar tags creados
  if (state.createdTags.length > 0) {
    await supabase
      .from("tags")
      .delete()
      .in("id", state.createdTags);
  }
  
  // Eliminar colores creados
  if (state.createdColors.length > 0) {
    await supabase
      .from("colors")
      .delete()
      .in("id", state.createdColors);
  }
}

// ----- Importar inventario (SKU) -----
function renderPreviewInv(rows) {
  const prev = document.getElementById("preview-inv");
  prev.value = rows.slice(0, 10).map((r) => JSON.stringify(r)).join("\n");
  const tableWrap = document.getElementById("table-wrap-inv");
  const headers = ["sku", "size", "stock", "price", "active"];
  const html = [
    "<table><thead><tr>",
    headers.map((h) => `<th>${h}</th>`).join(""),
    "</tr></thead><tbody>",
    ...rows.slice(0, 20).map((r) =>
      "<tr>" + headers.map((h) => `<td>${r[h] ?? ""}</td>`).join("") + "</tr>"
    ),
    "</tbody></table>",
  ].join("");
  tableWrap.innerHTML = html;
}

document.getElementById("parse-inv").addEventListener("click", async () => {
  if (!canImport) {
    alert("No tienes permiso para importar datos.");
    return;
  }
  
  const file = document.getElementById("file-inv").files[0];
  const msg = document.getElementById("import-inv-msg");
  if (!file) {
    msg.textContent = "⚠️ Seleccioná un CSV";
    msg.className = "message warn";
    return;
  }
  const text = await file.text();
  const rows = parseCSV(text).map(normalizeHeaders);
  if (!rows.length) {
    msg.textContent = "⚠️ CSV vacío o inválido";
    msg.className = "message warn";
    return;
  }
  renderPreviewInv(rows);
  const run = document.getElementById("run-inv");
  run.disabled = false;
  run.onclick = async () => {
    if (!canImport) {
      alert("No tienes permiso para importar datos.");
      return;
    }
    
    try {
      msg.textContent = "⏳ Importando inventario…";
      msg.className = "message";
      let updated = 0, notFound = 0;
      const total = rows.length;
      
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        updateProgress(i + 1, total, "progress-container-inv", "progress-fill-inv", "progress-text-inv");
        
        const sku = (r.sku || "").trim();
        if (!sku) continue;
        const price = parseARS(r.price);
        const stock = parseInt(r.stock || "0", 10) || 0;
        const active = bool(r.active);
        const { data, error } = await supabase
          .from("product_variants")
          .update({ price, stock_qty: stock, active })
          .eq("sku", sku)
          .select("id");
        if (error) throw error;
        if (data && data.length) updated++; else notFound++;
      }
      
      hideProgress("progress-container-inv");
      msg.textContent = `✅ Inventario importado. Actualizados: ${updated}. No encontrados: ${notFound}.`;
      msg.className = "message ok";
    } catch (e) {
      hideProgress("progress-container-inv");
      msg.textContent = `❌ Error importando inventario: ${e.message}`;
      msg.className = "message err";
    }
  };
});

// ========== IMPORTAR PRODUCTOS NUEVOS DESDE GOOGLE SHEETS ==========

// Generar handle único desde nombre
function generateHandle(name) {
  if (!name) return `product-${Date.now()}`;
  return String(name)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Generar handle único verificando que no exista
// Si hay problemas con RLS (error 406), usa timestamp para garantizar unicidad
async function ensureUniqueHandle(baseHandle) {
  if (!baseHandle || !baseHandle.trim()) {
    return `product-${Date.now()}`;
  }
  
  const handle = baseHandle.trim();
  
  try {
    const { data, error } = await supabase
      .from("products")
      .select("id")
      .eq("handle", handle)
      .maybeSingle();
    
    // Si hay error 406 (Not Acceptable), probablemente es problema de RLS
    // En este caso, usar timestamp para garantizar unicidad sin verificar
    if (error) {
      const status = error.status || error.statusCode || error.code;
      if (status === 406 || status === '406' || error.message?.includes('406')) {
        console.warn("Error 406 al verificar handle (posible problema RLS), usando timestamp");
        return `${handle}-${Date.now()}`;
      }
      // Para otros errores, también usar timestamp como fallback
      if (error.code !== 'PGRST116') {
        console.warn("Error verificando handle, usando timestamp:", error.message);
        return `${handle}-${Date.now()}`;
      }
    }
    
    // Si no hay datos, el handle está disponible
    if (!data) {
      return handle;
    }
    
    // Si hay datos, el handle existe, buscar uno disponible (máximo 5 intentos)
    for (let i = 1; i <= 5; i++) {
      const testHandle = `${handle}-${i}`;
      const { data: testData, error: testError } = await supabase
        .from("products")
        .select("id")
        .eq("handle", testHandle)
        .maybeSingle();
      
      // Si hay error 406, usar timestamp directamente
      if (testError) {
        const testStatus = testError.status || testError.statusCode || testError.code;
        if (testStatus === 406 || testStatus === '406' || testError.message?.includes('406')) {
          return `${handle}-${Date.now()}`;
        }
      }
      
      // Si no hay datos, este handle está disponible
      if (!testData) {
        return testHandle;
      }
    }
  } catch (e) {
    console.warn("Excepción verificando handle:", e);
  }
  
  // Si llegamos aquí (handle existe o hubo errores), usar timestamp
  return `${handle}-${Date.now()}`;
}

// Generar SKU único
function generateSKU(handle, color, size) {
  const colorCode = (color || "NONE").toUpperCase().substring(0, 5).replace(/\s+/g, '');
  const sizeCode = String(size || "").padStart(2, '0');
  return `${handle}-${colorCode}-${sizeCode}`;
}

// Validar filas de productos nuevos
function validateNewProductRows(rows) {
  const errors = [];
  const requiredFields = ['name', 'color', 'size', 'price'];
  
  rows.forEach((row, index) => {
    const rowNum = index + 2;
    
    requiredFields.forEach(field => {
      if (!row[field] || !String(row[field]).trim()) {
        errors.push(`Fila ${rowNum}: El campo "${field}" es requerido`);
      }
    });
    
    if (row.price !== undefined && row.price !== '') {
      const price = parseARS(row.price);
      if (isNaN(price) || price < 0) {
        errors.push(`Fila ${rowNum}: El precio "${row.price}" no es válido`);
      }
    }
    
    // Validar que size tenga formato correcto (números separados por comas)
    if (row.size) {
      const sizes = String(row.size).split(',').map(s => s.trim()).filter(Boolean);
      if (sizes.length === 0) {
        errors.push(`Fila ${rowNum}: El campo "size" debe contener al menos un tamaño`);
      }
      sizes.forEach(size => {
        if (isNaN(parseInt(size, 10))) {
          errors.push(`Fila ${rowNum}: El tamaño "${size}" no es válido`);
        }
      });
    }
  });
  
  return errors;
}

// Función helper para mostrar errores de validación
function showValidationErrorsNew(errors) {
  const container = document.getElementById("validation-errors-new");
  if (errors.length > 0) {
    container.innerHTML = `<strong>Errores de validación encontrados:</strong><ul>${errors.map(e => `<li>${e}</li>`).join('')}</ul>`;
    container.classList.add("active");
    return true;
  } else {
    container.classList.remove("active");
    return false;
  }
}

// Renderizar preview de productos nuevos
function renderPreviewNew(rows, category) {
  const tableWrap = document.getElementById("preview-new-wrap");
  
  // Agrupar por nombre
  const byName = new Map();
  rows.forEach((row) => {
    const name = (row.name || "").trim();
    if (!name) return;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(row);
  });
  
  // Preview tabla con resumen
  const summary = Array.from(byName.entries()).map(([name, items]) => {
    const colors = [...new Set(items.map(i => i.color))];
    const totalVariants = items.reduce((sum, item) => {
      const sizes = String(item.size || "").split(',').map(s => s.trim()).filter(Boolean);
      return sum + sizes.length;
    }, 0);
    return { name, colors, totalVariants, items };
  });
  
  const html = [
    `<div style="margin: 16px 0; padding: 16px; background: #f8f9fa; border-radius: 8px;">`,
    `<strong>Resumen de importación (${summary.length} productos):</strong>`,
    `<ul style="margin: 8px 0 0 20px;">`,
    ...summary.slice(0, 10).map(s => 
      `<li><strong>${s.name}</strong> - Colores: ${s.colors.join(", ")} - ${s.totalVariants} variantes</li>`
    ),
    summary.length > 10 ? `<li>... y ${summary.length - 10} productos más</li>` : "",
    `</ul>`,
    `</div>`,
    `<table><thead><tr>`,
    ["name", "color", "size", "price", "handle", "imágenes"].map((h) => `<th>${h}</th>`).join(""),
    `</tr></thead><tbody>`,
    ...rows.slice(0, 20).map((r) => {
      const images = Array.from({ length: 12 }, (_, i) => r[`images${i + 1}`] || "").filter(Boolean).length;
      return "<tr>" + [
        r.name || "",
        r.color || "",
        r.size || "",
        r.price || "",
        r.handle || "(auto)",
        `${images} imágenes`
      ].map((h) => `<td>${h}</td>`).join("") + "</tr>";
    }),
    "</tbody></table>",
  ].join("");
  tableWrap.innerHTML = html;
}

// Leer Google Sheet desde URL pública (solo lectura)
async function fetchGoogleSheetCSV(url, sheetName = null) {
  try {
    // Convertir URL de Google Sheets a formato CSV export
    // Formato: https://docs.google.com/spreadsheets/d/{ID}/edit#gid={GID}
    // CSV: https://docs.google.com/spreadsheets/d/{ID}/export?format=csv&gid={GID}
    
    let csvUrl = url;
    if (url.includes('/spreadsheets/d/')) {
      const match = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
      if (match) {
        const sheetId = match[1];
        // Si hay gid en la URL, usarlo; si no, usar gid=0 (primera hoja)
        const gidMatch = url.match(/[#&]gid=(\d+)/);
        const gid = gidMatch ? gidMatch[1] : '0';
        csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
      }
    }
    
    const response = await fetch(csvUrl);
    if (!response.ok) throw new Error(`Error al cargar la hoja: ${response.statusText}`);
    const text = await response.text();
    return text;
  } catch (e) {
    throw new Error(`Error al leer Google Sheet: ${e.message}`);
  }
}

// Importar productos nuevos
async function importNewProducts(rows, category) {
  if (!canImport) {
    alert("No tienes permiso para importar datos.");
    return;
  }
  
  const msg = document.getElementById("import-new-msg");
  msg.textContent = "⏳ Importando productos nuevos…";
  msg.className = "message";
  
  // Agrupar por nombre
  const byName = new Map();
  rows.forEach((row) => {
    const name = (row.name || "").trim();
    if (!name) return;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(row);
  });
  
  const totalProducts = byName.size;
  let processedProducts = 0;
  let createdProducts = 0;
  let createdVariants = 0;
  
  try {
    for (const [name, items] of byName.entries()) {
      processedProducts++;
      updateProgress(processedProducts, totalProducts, "progress-container-new", "progress-fill-new", "progress-text-new");
      
      // Generar handle único
      const baseHandle = items[0].handle?.trim() || generateHandle(name);
      let handle;
      try {
        handle = await ensureUniqueHandle(baseHandle);
      } catch (e) {
        console.error("Error generando handle único:", e);
        // Fallback: usar timestamp para garantizar unicidad
        handle = baseHandle + `-${Date.now()}`;
      }
      
      // Obtener precio (usar el primero encontrado)
      const firstItem = items[0];
      const price = parseARS(firstItem.price);
      
      // Crear producto
      const { data: createdProduct, error: prodError } = await supabase
        .from("products")
        .insert([
          {
            handle,
            name,
            category: category || "Calzado",
            status: "incomplete",
            description: "",
          },
        ])
        .select("id")
        .single();
      
      if (prodError) throw prodError;
      createdProducts++;
      const productId = createdProduct.id;
      
      // Crear variantes para cada item (color) y cada tamaño
      for (const item of items) {
        const color = (item.color || "").trim();
        const sizes = String(item.size || "").split(',').map(s => s.trim()).filter(Boolean);
        
        // Crear color si no existe
        if (color) {
          const { data: foundColor } = await supabase
            .from("colors")
            .select("name")
            .eq("name", color)
            .limit(1);
          if (!foundColor || !foundColor.length) {
            try {
              await supabase.from("colors").insert([{ name: color }]);
            } catch {}
          }
        }
        
        // Crear una variante por cada tamaño
        for (const size of sizes) {
          const sku = item.sku?.trim() || generateSKU(handle, color, size);
          
          // Verificar que el SKU no exista
          const { data: existingVariant } = await supabase
            .from("product_variants")
            .select("id")
            .eq("sku", sku)
            .maybeSingle();
          
          if (existingVariant) {
            console.warn(`SKU ${sku} ya existe, saltando...`);
            continue;
          }
          
          // Crear variante
          const { data: createdVariant, error: varError } = await supabase
            .from("product_variants")
            .insert([
              {
                product_id: productId,
                sku,
                color,
                size,
                price,
                stock_qty: 0, // Sin stock inicial
                active: true,
                reserved_qty: 0,
              },
            ])
            .select("id")
            .single();
          
          if (varError) throw varError;
          createdVariants++;
          const variantId = createdVariant.id;
          
          // Importar imágenes desde images1-images12
          const images = [];
          for (let i = 1; i <= 12; i++) {
            const imgUrl = item[`images${i}`]?.trim();
            if (imgUrl && imgUrl.match(/^https?:\/\//)) {
              images.push({ url: imgUrl, position: i });
            }
          }
          
          if (images.length > 0 && variantId) {
            const payloadImgs = images.map((img, idx) => ({
              variant_id: variantId,
              url: img.url,
              position: idx + 1,
              alt: null,
            }));
            await supabase.from("variant_images").insert(payloadImgs);
          }
        }
      }
    }
    
    hideProgress("progress-container-new");
    msg.textContent = `✅ Importación completada: ${createdProducts} productos, ${createdVariants} variantes creadas. Los productos están en estado "incomplete" y requieren completar tags y stock.`;
    msg.className = "message ok";
    
    // Redirigir a incomplete-products después de 2 segundos
    setTimeout(() => {
      window.location.href = "./incomplete-products.html";
    }, 2000);
    
  } catch (e) {
    hideProgress("progress-container-new");
    msg.textContent = `❌ Error importando: ${e.message}`;
    msg.className = "message err";
    throw e;
  }
}

// Event listener para cambiar método de importación
document.getElementById("import-method")?.addEventListener("change", (e) => {
  const method = e.target.value;
  const csvMethod = document.getElementById("csv-method");
  const urlMethod = document.getElementById("url-method");
  
  if (method === "csv") {
    csvMethod.style.display = "flex";
    urlMethod.style.display = "none";
  } else {
    csvMethod.style.display = "none";
    urlMethod.style.display = "flex";
  }
});

// Event listener para importar desde URL de Google Sheets
document.getElementById("parse-new")?.addEventListener("click", async function() {
  if (!canImport) {
    alert("No tienes permiso para importar datos.");
    return;
  }
  
  const method = document.getElementById("import-method")?.value || "csv";
  const msg = document.getElementById("import-new-msg");
  const validationErrors = document.getElementById("validation-errors-new");
  
  validationErrors.classList.remove("active");
  
  let rows = [];
  let category = "Calzado";
  
  if (method === "url") {
    const url = document.getElementById("sheet-url")?.value?.trim();
    if (!url) {
      msg.textContent = "⚠️ Ingresá la URL de Google Sheets";
      msg.className = "message warn";
      return;
    }
    
    category = document.getElementById("sheet-category")?.value || "Calzado";
    
    try {
      msg.textContent = "⏳ Cargando desde Google Sheets...";
      msg.className = "message";
      const csvText = await fetchGoogleSheetCSV(url);
      rows = parseCSV(csvText).map(normalizeHeaders);
    } catch (e) {
      msg.textContent = `❌ Error: ${e.message}`;
      msg.className = "message err";
      return;
    }
  } else {
    const file = document.getElementById("file-new")?.files[0];
    if (!file) {
      msg.textContent = "⚠️ Seleccioná un archivo CSV";
      msg.className = "message warn";
      return;
    }
    
    category = document.getElementById("sheet-category")?.value || "Calzado";
    
    const text = await file.text();
    rows = parseCSV(text).map(normalizeHeaders);
  }
  
  if (!rows.length) {
    msg.textContent = "⚠️ No se encontraron datos válidos";
    msg.className = "message warn";
    return;
  }
  
  // Validar datos
  const errors = validateNewProductRows(rows);
  if (errors.length > 0) {
    showValidationErrorsNew(errors);
    msg.textContent = "⚠️ Corregí los errores antes de importar";
    msg.className = "message warn";
    return;
  }
  
  renderPreviewNew(rows, category);
  const runBtn = document.getElementById("run-new");
  runBtn.disabled = false;
  runBtn.onclick = async () => {
    try {
      await importNewProducts(rows, category);
    } catch (e) {
      msg.textContent = `❌ Error importando: ${e.message}`;
      msg.className = "message err";
    }
  };
});
