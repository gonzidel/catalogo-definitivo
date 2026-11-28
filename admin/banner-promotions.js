import { supabase, supabaseReady } from "../scripts/supabase-client.js?v=m260607";

const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = ["image/jpeg", "image/jpg", "image/png", "image/webp"];

let items = [];
let editingId = null;
let existingImageUrl = null;
let imageMarkedForRemoval = false;
let searchTimer = null;

function $(id) {
  return document.getElementById(id);
}

function showMessage(message, type = "success") {
  const container = $("message-container");
  if (!container) {
    alert(message);
    return;
  }
  const box = document.createElement("div");
  box.className = `message ${type} active`;
  box.textContent = message;
  container.replaceChildren(box);
  setTimeout(() => {
    if (container.contains(box)) container.replaceChildren();
  }, 5000);
}

function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function validateImage(file) {
  if (!file) return null;
  const type = String(file.type || "").toLowerCase();
  if (type && !IMAGE_TYPES.includes(type)) return "Formato no permitido. Usá JPG, PNG o WebP.";
  const name = String(file.name || "").toLowerCase();
  if (!type && !/\.(jpe?g|png|webp)$/.test(name)) return "Formato no permitido. Usá JPG, PNG o WebP.";
  if (file.size > IMAGE_MAX_BYTES) return "La imagen supera 10 MB. Reducila e intentá de nuevo.";
  return null;
}

function normalize(str) {
  return String(str || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function scoreMatch(text, term) {
  const needle = normalize(term);
  const hay = normalize(text);
  if (!needle || !hay) return -1;
  if (hay === needle) return 100;
  if (hay.startsWith(needle)) return 80;
  if (hay.includes(needle)) return 50;
  return -1;
}

function rank(list, term, getText) {
  return list
    .map((item) => ({ item, score: scoreMatch(getText(item), term) }))
    .filter((row) => row.score >= 0)
    .sort((a, b) => b.score - a.score)
    .map((row) => row.item);
}

function permanentChecked() {
  return Boolean($("bp-permanent")?.checked);
}

function syncPermanentUi() {
  const group = $("bp-end-date-group");
  const label = $("bp-permanent-text");
  const permanent = permanentChecked();
  if (group) group.style.display = permanent ? "none" : "";
  if (label) label.textContent = permanent ? "Sin fecha límite" : "Con fecha límite";
}

function syncStatusUi() {
  const label = $("bp-status-text");
  if (label) label.textContent = $("bp-status")?.checked ? "Activa" : "Inactiva";
}

function renderItems() {
  const box = $("bp-selected-items");
  if (!box) return;
  if (items.length === 0) {
    box.innerHTML = '<p style="color: #999; margin: 0;">No hay items seleccionados</p>';
    return;
  }
  box.innerHTML = items
    .map(
      (item, index) => `
      <span class="selected-item">
        ${escapeHtml(item.name)} (${item.type === "product" ? "Producto" : "Variante"})
        <button type="button" data-bp-remove="${index}">×</button>
      </span>`
    )
    .join("");
}

function resetForm() {
  editingId = null;
  existingImageUrl = null;
  imageMarkedForRemoval = false;
  items = [];
  const title = $("bp-title");
  if (title) title.value = "";
  const permanent = $("bp-permanent");
  if (permanent) permanent.checked = true;
  const endDate = $("bp-end-date");
  if (endDate) endDate.value = "";
  const status = $("bp-status");
  if (status) status.checked = true;
  const input = $("bp-image-input");
  if (input) input.value = "";
  const preview = $("bp-image-preview");
  if (preview) preview.style.display = "none";
  const previewImg = $("bp-image-preview-img");
  if (previewImg) previewImg.src = "";
  const save = $("bp-save");
  if (save) save.textContent = "Crear promoción";
  const cancel = $("bp-cancel");
  if (cancel) cancel.style.display = "none";
  const heading = $("bp-form-title");
  if (heading) heading.textContent = "Crear promoción";
  syncPermanentUi();
  syncStatusUi();
  renderItems();
}

async function uploadImage(file) {
  const ext = String(file.name.split(".").pop() || "jpg").toLowerCase();
  const path = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { error } = await supabase.storage.from("promo-images").upload(path, file, {
    cacheControl: "3600",
    upsert: false,
  });
  if (error) throw error;
  const { data } = supabase.storage.from("promo-images").getPublicUrl(path);
  return data?.publicUrl || null;
}

async function searchItems(term) {
  const suggestions = $("bp-item-suggestions");
  if (!suggestions) return;
  const { data: productsRaw, error: productsError } = await supabase
    .from("products")
    .select("id, name")
    .ilike("name", `%${term}%`)
    .eq("status", "active")
    .limit(30);
  if (productsError) throw productsError;
  const products = rank(productsRaw || [], term, (product) => product.name).slice(0, 5);

  const { data: variantsBySkuRaw } = await supabase
    .from("product_variants")
    .select("id, sku, color, products!inner(id, name)")
    .ilike("sku", `%${term}%`)
    .eq("active", true)
    .limit(30);
  const matching = rank(productsRaw || [], term, (product) => product.name).slice(0, 10);
  let variantsByName = [];
  if (matching.length > 0) {
    const { data } = await supabase
      .from("product_variants")
      .select("id, sku, color, products!inner(id, name)")
      .in("product_id", matching.map((product) => product.id))
      .eq("active", true)
      .limit(30);
    variantsByName = data || [];
  }
  const variantMap = new Map();
  for (const variant of [...(variantsBySkuRaw || []), ...variantsByName]) {
    variantMap.set(variant.id, variant);
  }
  const variants = rank(
    [...variantMap.values()],
    term,
    (variant) => `${variant.sku || ""} ${variant.products?.name || ""}`
  ).slice(0, 5);

  suggestions.replaceChildren();
  for (const product of products) {
    const option = document.createElement("option");
    option.value = `${product.name} (Producto)`;
    option.dataset.type = "product";
    option.dataset.id = product.id;
    option.dataset.name = product.name;
    suggestions.appendChild(option);
  }
  for (const variant of variants) {
    const label = `${variant.products.name} - ${variant.color} (${variant.sku})`;
    const option = document.createElement("option");
    option.value = label;
    option.dataset.type = "variant";
    option.dataset.id = variant.id;
    option.dataset.name = `${variant.products.name} - ${variant.color}`;
    suggestions.appendChild(option);
  }
}

function addItem(term) {
  const suggestions = $("bp-item-suggestions");
  const selected = suggestions
    ? [...suggestions.options].find((option) => option.value === term)
    : null;
  if (!selected?.dataset.type || !selected.dataset.id || !selected.dataset.name) {
    showMessage("Seleccioná un producto de la lista", "error");
    return;
  }
  if (items.some((item) => item.type === selected.dataset.type && item.id === selected.dataset.id)) {
    showMessage("Ese item ya está agregado", "error");
    return;
  }
  items.push({
    type: selected.dataset.type,
    id: selected.dataset.id,
    name: selected.dataset.name,
  });
  renderItems();
  const search = $("bp-item-search");
  if (search) search.value = "";
  if (suggestions) suggestions.replaceChildren();
}

async function savePromotion() {
  const title = $("bp-title")?.value.trim() || "";
  if (!title) {
    showMessage("Poné un nombre a la promoción", "error");
    return;
  }
  const permanent = permanentChecked();
  const endDate = $("bp-end-date")?.value || "";
  if (!permanent && !endDate) {
    showMessage("Elegí la fecha límite o marcala como permanente", "error");
    return;
  }
  if (items.length === 0) {
    showMessage("Agregá al menos un producto", "error");
    return;
  }

  const file = $("bp-image-input")?.files?.[0] || null;
  if (file) {
    const validationError = validateImage(file);
    if (validationError) {
      showMessage(validationError, "error");
      return;
    }
  }

  try {
    let imageUrl = existingImageUrl;
    if (file) {
      imageUrl = await uploadImage(file);
      if (!imageUrl) throw new Error("No se pudo subir la imagen");
    } else if (imageMarkedForRemoval) {
      imageUrl = null;
    }

    const row = {
      title,
      status: $("bp-status")?.checked ? "active" : "inactive",
      end_date: permanent ? null : endDate,
      image_url: imageUrl,
      updated_at: new Date().toISOString(),
    };

    let promotionId = editingId;
    if (editingId) {
      const { error } = await supabase.from("banner_promotions").update(row).eq("id", editingId);
      if (error) throw error;
      const { error: deleteError } = await supabase
        .from("banner_promotion_items")
        .delete()
        .eq("banner_promotion_id", editingId);
      if (deleteError) throw deleteError;
    } else {
      const { data, error } = await supabase.from("banner_promotions").insert(row).select("id").single();
      if (error) throw error;
      promotionId = data.id;
    }

    const payload = items.map((item) => ({
      banner_promotion_id: promotionId,
      product_id: item.type === "product" ? item.id : null,
      variant_id: item.type === "variant" ? item.id : null,
    }));
    const { error: itemsError } = await supabase.from("banner_promotion_items").insert(payload);
    if (itemsError) throw itemsError;

    showMessage(editingId ? "Promoción actualizada" : "Promoción creada", "success");
    resetForm();
    await loadList();
  } catch (error) {
    showMessage("No se pudo guardar: " + (error?.message || error), "error");
  }
}

function itemLabel(item) {
  if (item.product_id && item.products) return item.products.name;
  if (item.variant_id && item.variants?.products) {
    return `${item.variants.products.name} - ${item.variants.color || ""}`.trim();
  }
  return "Producto";
}

async function loadList() {
  const list = $("bp-list");
  if (!list) return;
  const { data, error } = await supabase
    .from("banner_promotions")
    .select("*")
    .order("updated_at", { ascending: false })
    .limit(100);
  if (error) {
    list.textContent = "No se pudieron cargar las promociones: " + error.message;
    return;
  }
  if (!data || data.length === 0) {
    list.textContent = "No hay promociones creadas";
    return;
  }

  const blocks = [];
  for (const promo of data) {
    const { data: promoItems } = await supabase
      .from("banner_promotion_items")
      .select("product_id, variant_id, products:product_id(name), variants:variant_id(color, products!inner(name))")
      .eq("banner_promotion_id", promo.id);
    const names = (promoItems || []).map(itemLabel).filter(Boolean);
    const until = promo.end_date ? `Hasta ${promo.end_date.split("-").reverse().join("/")}` : "Permanente";
    const active = promo.status === "active" ? "Activa" : "Inactiva";
    const imageNote = promo.image_url ? "Con imagen" : "Sin imagen: no se muestra en el banner";
    blocks.push(`
      <div class="list-item">
        <div class="list-item-info">
          <h4>${escapeHtml(promo.title)}</h4>
          <p><strong>${escapeHtml(active)}</strong> · ${escapeHtml(until)} · ${escapeHtml(imageNote)}</p>
          <p><strong>Items (${names.length}):</strong> ${escapeHtml(names.join(", ") || "—")}</p>
        </div>
        <div class="list-item-actions">
          <button type="button" class="btn btn-secondary" data-bp-edit="${promo.id}">Editar</button>
          <button type="button" class="btn btn-danger" data-bp-delete="${promo.id}">Eliminar</button>
        </div>
      </div>`);
  }
  list.innerHTML = blocks.join("");
}

async function editPromotion(id) {
  const { data, error } = await supabase.from("banner_promotions").select("*").eq("id", id).single();
  if (error || !data) {
    showMessage("No se pudo abrir la promoción", "error");
    return;
  }
  const { data: promoItems, error: itemsError } = await supabase
    .from("banner_promotion_items")
    .select("product_id, variant_id, products:product_id(name), variants:variant_id(color, products!inner(name))")
    .eq("banner_promotion_id", id);
  if (itemsError) {
    showMessage("No se pudieron leer los productos", "error");
    return;
  }

  editingId = id;
  existingImageUrl = data.image_url || null;
  imageMarkedForRemoval = false;
  $("bp-title").value = data.title || "";
  $("bp-status").checked = data.status === "active";
  $("bp-permanent").checked = !data.end_date;
  $("bp-end-date").value = data.end_date || "";
  items = (promoItems || []).map((item) => ({
    type: item.product_id ? "product" : "variant",
    id: item.product_id || item.variant_id,
    name: itemLabel(item),
  }));
  const preview = $("bp-image-preview");
  const previewImg = $("bp-image-preview-img");
  const input = $("bp-image-input");
  if (input) input.value = "";
  if (existingImageUrl && preview && previewImg) {
    previewImg.src = existingImageUrl;
    preview.style.display = "block";
  } else if (preview) {
    preview.style.display = "none";
  }
  $("bp-save").textContent = "Guardar cambios";
  $("bp-cancel").style.display = "";
  $("bp-form-title").textContent = "Editar promoción";
  syncPermanentUi();
  syncStatusUi();
  renderItems();
  $("bp-title")?.scrollIntoView({ behavior: "smooth", block: "center" });
}

async function deletePromotion(id) {
  if (!confirm("¿Eliminar esta promoción?")) return;
  const { error } = await supabase.from("banner_promotions").delete().eq("id", id);
  if (error) {
    showMessage("No se pudo eliminar: " + error.message, "error");
    return;
  }
  if (editingId === id) resetForm();
  showMessage("Promoción eliminada", "success");
  await loadList();
}

function init() {
  $("bp-permanent")?.addEventListener("change", syncPermanentUi);
  $("bp-status")?.addEventListener("change", syncStatusUi);
  $("bp-image-input")?.addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const validationError = validateImage(file);
    if (validationError) {
      showMessage(validationError, "error");
      event.target.value = "";
      return;
    }
    imageMarkedForRemoval = false;
    const reader = new FileReader();
    reader.onload = () => {
      const preview = $("bp-image-preview");
      const previewImg = $("bp-image-preview-img");
      if (previewImg) previewImg.src = String(reader.result || "");
      if (preview) preview.style.display = "block";
    };
    reader.readAsDataURL(file);
  });
  $("bp-remove-image")?.addEventListener("click", () => {
    const input = $("bp-image-input");
    if (input) input.value = "";
    const preview = $("bp-image-preview");
    if (preview) preview.style.display = "none";
    const previewImg = $("bp-image-preview-img");
    if (previewImg) previewImg.src = "";
    imageMarkedForRemoval = true;
    existingImageUrl = null;
  });
  $("bp-item-search")?.addEventListener("input", (event) => {
    clearTimeout(searchTimer);
    const term = event.target.value.trim();
    const suggestions = $("bp-item-suggestions");
    const exact = suggestions && [...suggestions.options].some((option) => option.value === term);
    if (exact) return;
    if (term.length < 2) {
      if (suggestions) suggestions.replaceChildren();
      return;
    }
    searchTimer = setTimeout(() => {
      searchItems(term).catch((error) => showMessage("Error al buscar: " + error.message, "error"));
    }, 300);
  });
  $("bp-add-item")?.addEventListener("click", () => {
    const term = $("bp-item-search")?.value.trim();
    if (term) addItem(term);
  });
  $("bp-selected-items")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-bp-remove]");
    if (!button) return;
    items.splice(Number(button.dataset.bpRemove), 1);
    renderItems();
  });
  $("bp-save")?.addEventListener("click", () => savePromotion());
  $("bp-cancel")?.addEventListener("click", () => resetForm());
  $("bp-list")?.addEventListener("click", (event) => {
    const edit = event.target.closest("[data-bp-edit]");
    if (edit) {
      editPromotion(edit.dataset.bpEdit);
      return;
    }
    const remove = event.target.closest("[data-bp-delete]");
    if (remove) deletePromotion(remove.dataset.bpDelete);
  });
  syncPermanentUi();
  syncStatusUi();
  loadList();
}

async function start() {
  await supabaseReady;
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
}

start();
