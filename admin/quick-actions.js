// admin/quick-actions.js - Gestión de acciones rápidas
import { requireAuth } from "./admin-auth.js?v=m260607";
import { supabase } from "../scripts/supabase-client.js?v=m260607";
import { initCuratedBannerAdmin } from "./curated-banner-admin.js?v=m260607";
import {
  joinCommercialTags,
  normalizeCommercialTag,
  normalizeTagDisplay,
  parseTagSelectorValues,
  splitCommercialTags,
} from "../scripts/tag-normalize.js";

await requireAuth();

let actions = [];
let editingId = null;

const tbody = document.getElementById("actions-tbody");
const modal = document.getElementById("modal");
const modalTitle = document.getElementById("modal-title");
const modalClose = document.getElementById("modal-close");
const modalCancel = document.getElementById("modal-cancel");
const btnNew = document.getElementById("btn-new");
const form = document.getElementById("action-form");
const message = document.getElementById("message");

// Cargar acciones
async function loadActions() {
  try {
    const { data, error } = await supabase
      .from("quick_actions")
      .select("*")
      .order("order", { ascending: true });

    if (error) throw error;

    actions = data || [];
    renderActions();
  } catch (error) {
    console.error("Error cargando acciones:", error);
    showMessage("Error al cargar acciones: " + error.message, "error");
  }
}

// Renderizar acciones en tabla
function renderActions() {
  if (actions.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7" style="text-align: center; padding: 24px;">
          No hay acciones rápidas. Crea una nueva acción para comenzar.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = actions.map(action => `
    <tr>
      <td>${action.order}</td>
      <td style="font-size: 20px;">${action.icon || "⚡"}</td>
      <td><strong>${action.label}</strong></td>
      <td><span class="badge badge-${action.type}">${action.type}</span></td>
      <td><code style="background: #f5f5f5; padding: 2px 6px; border-radius: 3px; font-size: 12px;">${action.value}</code></td>
      <td>
        <label class="switch">
          <input type="checkbox" ${action.enabled ? "checked" : ""} onchange="toggleAction('${action.id}', this.checked)">
          <span class="slider"></span>
        </label>
      </td>
      <td class="actions-cell">
        <button class="btn btn-secondary" onclick="editAction('${action.id}')" style="font-size: 12px; padding: 4px 8px;">Editar</button>
        <button class="btn btn-danger" onclick="deleteAction('${action.id}')" style="font-size: 12px; padding: 4px 8px;">Eliminar</button>
      </td>
    </tr>
  `).join("");
}

// Toggle enabled
window.toggleAction = async function(id, enabled) {
  try {
    const { error } = await supabase
      .from("quick_actions")
      .update({ enabled })
      .eq("id", id);

    if (error) throw error;

    const action = actions.find(a => a.id === id);
    if (action) action.enabled = enabled;
    showMessage("Acción actualizada", "success");
  } catch (error) {
    console.error("Error actualizando acción:", error);
    showMessage("Error al actualizar: " + error.message, "error");
    loadActions(); // Recargar para revertir
  }
};

// Editar acción
window.editAction = function(id) {
  const action = actions.find(a => a.id === id);
  if (!action) return;

  editingId = id;
  modalTitle.textContent = "Editar Acción";
  document.getElementById("action-id").value = action.id;
  document.getElementById("action-type").value = action.type;
  document.getElementById("action-label").value = action.label;
  document.getElementById("action-value").value = action.value;
  document.getElementById("action-icon").value = action.icon || "";
  document.getElementById("action-order").value = action.order;
  document.getElementById("action-enabled").checked = action.enabled;

  modal.classList.add("active");
};

// Eliminar acción
window.deleteAction = async function(id) {
  if (!confirm("¿Estás seguro de eliminar esta acción?")) return;

  try {
    const { error } = await supabase
      .from("quick_actions")
      .delete()
      .eq("id", id);

    if (error) throw error;

    actions = actions.filter(a => a.id !== id);
    renderActions();
    showMessage("Acción eliminada", "success");
  } catch (error) {
    console.error("Error eliminando acción:", error);
    showMessage("Error al eliminar: " + error.message, "error");
  }
};

// Nueva acción
btnNew.addEventListener("click", () => {
  editingId = null;
  modalTitle.textContent = "Nueva Acción";
  form.reset();
  document.getElementById("action-order").value = actions.length > 0 
    ? Math.max(...actions.map(a => a.order)) + 1 
    : 0;
  document.getElementById("action-enabled").checked = true;
  modal.classList.add("active");
});

// Cerrar modal
modalClose.addEventListener("click", closeModal);
modalCancel.addEventListener("click", closeModal);
modal.addEventListener("click", (e) => {
  if (e.target === modal) closeModal();
});

function closeModal() {
  modal.classList.remove("active");
  form.reset();
  editingId = null;
}

// Guardar acción
form.addEventListener("submit", async (e) => {
  e.preventDefault();

  const actionData = {
    type: document.getElementById("action-type").value,
    label: document.getElementById("action-label").value.trim(),
    value: document.getElementById("action-value").value.trim(),
    icon: document.getElementById("action-icon").value.trim() || null,
    order: parseInt(document.getElementById("action-order").value) || 0,
    enabled: document.getElementById("action-enabled").checked,
  };

  try {
    if (editingId) {
      // Actualizar
      const { error } = await supabase
        .from("quick_actions")
        .update(actionData)
        .eq("id", editingId);

      if (error) throw error;
      showMessage("Acción actualizada", "success");
    } else {
      // Crear
      const { error } = await supabase
        .from("quick_actions")
        .insert([actionData]);

      if (error) throw error;
      showMessage("Acción creada", "success");
    }

    closeModal();
    await loadActions();
  } catch (error) {
    console.error("Error guardando acción:", error);
    showMessage("Error al guardar: " + error.message, "error");
  }
});

// Mostrar mensaje
function showMessage(text, type = "success") {
  message.textContent = text;
  message.className = `message ${type} show`;
  setTimeout(() => {
    message.classList.remove("show");
  }, 3000);
}

// ========== GESTIÓN DE BANNERS ==========
let currentBanner = null;
const bannerPreview = document.getElementById("banner-text-preview");
const btnEditBanner = document.getElementById("btn-edit-banner");
const bannerModal = document.getElementById("banner-modal");
const bannerModalTitle = document.getElementById("banner-modal-title");
const bannerModalClose = document.getElementById("banner-modal-close");
const bannerModalCancel = document.getElementById("banner-modal-cancel");
const bannerForm = document.getElementById("banner-form");
const bannerMessage = document.getElementById("banner-message");

// Cargar banner
async function loadBanner() {
  try {
    const { data, error } = await supabase
      .from("promotional_banners")
      .select("*")
      .eq("enabled", true)
      .order("order", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (error && error.code !== "PGRST116") {
      console.error("Error cargando banner:", error);
      bannerPreview.textContent = "Error al cargar";
      return;
    }

    currentBanner = data || null;
    updateBannerPreview();
  } catch (error) {
    console.error("Error en loadBanner:", error);
    bannerPreview.textContent = "Error al cargar";
  }
}

// Actualizar preview del banner
function updateBannerPreview() {
  if (currentBanner) {
    bannerPreview.textContent = currentBanner.text || "Sin texto";
    document.getElementById("banner-preview").style.display = "flex";
  } else {
    bannerPreview.textContent = "No hay banner configurado";
    document.getElementById("banner-preview").style.background = "#e0e0e0";
    document.getElementById("banner-preview").style.color = "#666";
  }
}

// Editar banner
if (btnEditBanner) {
  btnEditBanner.addEventListener("click", async () => {
    // Cargar todos los banners para editar
    const { data: banners } = await supabase
      .from("promotional_banners")
      .select("*")
      .order("order", { ascending: true })
      .limit(1)
      .maybeSingle();

    const banner = banners || null;

    bannerModalTitle.textContent = banner ? "Editar Banner" : "Nuevo Banner";
    document.getElementById("banner-id").value = banner?.id || "";
    document.getElementById("banner-text").value = banner?.text || "";
    document.getElementById("banner-link-type").value = banner?.link_type || "category";
    document.getElementById("banner-link").value = banner?.link || "";
    document.getElementById("banner-enabled").checked = banner?.enabled !== false;

    bannerModal.classList.add("active");
  });
}

// Cerrar modal banner
if (bannerModalClose) {
  bannerModalClose.addEventListener("click", closeBannerModal);
}
if (bannerModalCancel) {
  bannerModalCancel.addEventListener("click", closeBannerModal);
}
if (bannerModal) {
  bannerModal.addEventListener("click", (e) => {
    if (e.target === bannerModal) closeBannerModal();
  });
}

function closeBannerModal() {
  bannerModal.classList.remove("active");
  bannerForm.reset();
}

// Guardar banner
if (bannerForm) {
  bannerForm.addEventListener("submit", async (e) => {
    e.preventDefault();

    const bannerData = {
      text: document.getElementById("banner-text").value.trim(),
      link: document.getElementById("banner-link").value.trim(),
      link_type: document.getElementById("banner-link-type").value,
      enabled: document.getElementById("banner-enabled").checked,
      order: 0,
    };

    try {
      const bannerId = document.getElementById("banner-id").value;
      
      if (bannerId) {
        // Actualizar
        const { error } = await supabase
          .from("promotional_banners")
          .update(bannerData)
          .eq("id", bannerId);

        if (error) throw error;
        showBannerMessage("Banner actualizado", "success");
      } else {
        // Crear nuevo (eliminar anteriores habilitados primero)
        await supabase
          .from("promotional_banners")
          .update({ enabled: false })
          .eq("enabled", true);

        const { error } = await supabase
          .from("promotional_banners")
          .insert([bannerData]);

        if (error) throw error;
        showBannerMessage("Banner creado", "success");
      }

      closeBannerModal();
      await loadBanner();
    } catch (error) {
      console.error("Error guardando banner:", error);
      showBannerMessage("Error al guardar: " + error.message, "error");
    }
  });
}

function showBannerMessage(text, type = "success") {
  bannerMessage.textContent = text;
  bannerMessage.className = `message ${type} show`;
  setTimeout(() => {
    bannerMessage.classList.remove("show");
  }, 3000);
}

// ========== GESTIÓN DE BANNER PERSONALIZADO ==========
let currentCustomBanner = null;
const customBannerNamePreview = document.getElementById("custom-banner-name-preview");
const customBannerValuePreview = document.getElementById("custom-banner-value-preview");
const customBannerStatusPreview = document.getElementById("custom-banner-status-preview");
const btnEditCustomBanner = document.getElementById("btn-edit-custom-banner");
const customBannerModal = document.getElementById("custom-banner-modal");
const customBannerModalTitle = document.getElementById("custom-banner-modal-title");
const customBannerModalClose = document.getElementById("custom-banner-modal-close");
const customBannerModalCancel = document.getElementById("custom-banner-modal-cancel");
const customBannerForm = document.getElementById("custom-banner-form");
const customBannerMessage = document.getElementById("custom-banner-message");

// Cargar banner personalizado
async function loadCustomBanner() {
  try {
    const { data, error } = await supabase
      .from("custom_product_banners")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error && error.code !== 'PGRST116') {
      console.error("Error cargando banner personalizado:", error);
      updateCustomBannerPreview(null);
      return;
    }

    currentCustomBanner = data || null;
    updateCustomBannerPreview(currentCustomBanner);
  } catch (error) {
    console.error("Error en loadCustomBanner:", error);
    updateCustomBannerPreview(null);
  }
}

function escapeBannerTagHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;");
}

/** Tags nivel 3 individuales (tabla tags), sin strings CSV compuestos. */
async function loadBannerCommercialTagOptions() {
  const { data, error } = await supabase
    .from("tags")
    .select("id, name")
    .eq("level", 3)
    .order("name");

  if (error) {
    console.error("Error cargando tags nivel 3:", error);
    return [];
  }

  const seen = new Set();
  const out = [];
  for (const row of data || []) {
    const rawName = String(row?.name ?? "").trim();
    if (!rawName || /[,;|]/.test(rawName)) continue;
    for (const display of splitCommercialTags(rawName, { silent: true }).tags) {
      const key = normalizeCommercialTag(display);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push({ id: row.id, display });
    }
  }

  return out.sort((a, b) =>
    a.display.localeCompare(b.display, "es", { sensitivity: "base" })
  );
}

function formatBannerTagsPreview(tagValue) {
  const tags = parseTagSelectorValues(tagValue || "");
  return tags.length ? tags.join(", ") : "-";
}

async function renderBannerTagCheckboxList(savedTagValue = "") {
  const container = document.getElementById("custom-banner-tags-list");
  if (!container) return;

  container.innerHTML =
    '<div style="color:#666;font-size:12px;text-align:center;padding:8px;">Cargando tags...</div>';

  const savedKeys = new Set(
    parseTagSelectorValues(savedTagValue).map((t) => normalizeCommercialTag(t))
  );
  const tags = await loadBannerCommercialTagOptions();

  if (!tags.length) {
    container.innerHTML =
      '<div style="color:#666;font-size:12px;text-align:center;padding:8px;">No hay tags disponibles</div>';
    return;
  }

  container.innerHTML = tags
    .map((tag) => {
      const checked = savedKeys.has(normalizeCommercialTag(tag.display))
        ? " checked"
        : "";
      return `<label style="display:flex;align-items:center;gap:8px;margin:4px 0;font-size:13px;cursor:pointer;">
        <input type="checkbox" class="banner-tag-cb" value="${escapeBannerTagHtml(tag.display)}"${checked} />
        <span>${escapeBannerTagHtml(tag.display)}</span>
      </label>`;
    })
    .join("");
}

function getSelectedBannerTagsFromUI() {
  return parseTagSelectorValues(
    Array.from(document.querySelectorAll(".banner-tag-cb:checked")).map(
      (el) => el.value
    )
  );
}

// Actualizar preview del banner personalizado
function updateCustomBannerPreview(banner) {
  if (banner) {
    customBannerNamePreview.textContent = banner.name || "Sin nombre";
    customBannerValuePreview.textContent = formatBannerTagsPreview(
      banner.tag_value || ""
    );
    
    if (banner.enabled) {
      customBannerStatusPreview.textContent = "Habilitado";
      customBannerStatusPreview.style.background = "#d4edda";
      customBannerStatusPreview.style.color = "#155724";
    } else {
      customBannerStatusPreview.textContent = "Deshabilitado";
      customBannerStatusPreview.style.background = "#f8d7da";
      customBannerStatusPreview.style.color = "#721c24";
    }
  } else {
    customBannerNamePreview.textContent = "No configurado";
    customBannerValuePreview.textContent = "-";
    customBannerStatusPreview.textContent = "-";
    customBannerStatusPreview.style.background = "#e0e0e0";
    customBannerStatusPreview.style.color = "#666";
  }
}

// Editar banner personalizado
if (btnEditCustomBanner) {
  btnEditCustomBanner.addEventListener("click", async () => {
    const banner = currentCustomBanner;

    customBannerModalTitle.textContent = banner ? "Editar Banner Personalizado" : "Nuevo Banner Personalizado";
    document.getElementById("custom-banner-id").value = banner?.id || "";
    document.getElementById("custom-banner-name").value = banner?.name || "";
    document.getElementById("custom-banner-enabled").checked = banner?.enabled !== false;

    await renderBannerTagCheckboxList(banner?.tag_value || "");
    customBannerModal.classList.add("active");
  });
}

// Cerrar modal banner personalizado
if (customBannerModalClose) {
  customBannerModalClose.addEventListener("click", closeCustomBannerModal);
}
if (customBannerModalCancel) {
  customBannerModalCancel.addEventListener("click", closeCustomBannerModal);
}
if (customBannerModal) {
  customBannerModal.addEventListener("click", (e) => {
    if (e.target === customBannerModal) closeCustomBannerModal();
  });
}

function closeCustomBannerModal() {
  customBannerModal.classList.remove("active");
  customBannerForm.reset();
}

// Guardar banner personalizado
if (customBannerForm) {
  customBannerForm.addEventListener("submit", async (e) => {
    e.preventDefault();

    const selectedTags = getSelectedBannerTagsFromUI();

    if (selectedTags.length === 0) {
      showCustomBannerMessage("Selecciona al menos un tag", "error");
      return;
    }

    const tagValueToSave = joinCommercialTags(selectedTags);
    console.log("[QuickActions] guardando banner tag_value", {
      parsed: selectedTags,
      normalized: selectedTags.map(normalizeCommercialTag),
      tag_value: tagValueToSave,
    });

    const bannerData = {
      name: document.getElementById("custom-banner-name").value.trim(),
      tag_value: tagValueToSave,
      enabled: document.getElementById("custom-banner-enabled").checked,
    };
    
    // No incluimos tag_filter ya que está deprecado y tiene una restricción CHECK
    // que puede causar errores. Si necesitas limpiar valores antiguos, hazlo directamente en la BD.

    try {
      const bannerId = document.getElementById("custom-banner-id").value;
      
      if (bannerId) {
        // Actualizar
        const { error } = await supabase
          .from("custom_product_banners")
          .update(bannerData)
          .eq("id", bannerId);

        if (error) throw error;
        showCustomBannerMessage("Banner personalizado actualizado", "success");
      } else {
        // Crear nuevo (deshabilitar anteriores primero)
        await supabase
          .from("custom_product_banners")
          .update({ enabled: false })
          .eq("enabled", true);

        const { error } = await supabase
          .from("custom_product_banners")
          .insert([bannerData]);

        if (error) throw error;
        showCustomBannerMessage("Banner personalizado creado", "success");
      }

      closeCustomBannerModal();
      await loadCustomBanner();
    } catch (error) {
      console.error("Error guardando banner personalizado:", error);
      showCustomBannerMessage("Error al guardar: " + error.message, "error");
    }
  });
}

function showCustomBannerMessage(text, type = "success") {
  customBannerMessage.textContent = text;
  customBannerMessage.className = `message ${type} show`;
  setTimeout(() => {
    customBannerMessage.classList.remove("show");
  }, 3000);
}

// ========== CATÁLOGO PÚBLICO (snapshot) ==========
const catalogSnapshotMetaEl = document.getElementById("catalog-snapshot-meta");
const catalogSnapshotMsgEl = document.getElementById("catalog-snapshot-message");
const btnRefreshCatalogSnapshot = document.getElementById("btn-refresh-catalog-snapshot");

function showCatalogSnapshotMessage(text, type = "success") {
  if (!catalogSnapshotMsgEl) return;
  catalogSnapshotMsgEl.textContent = text;
  catalogSnapshotMsgEl.className = `message ${type} show`;
  setTimeout(() => catalogSnapshotMsgEl.classList.remove("show"), 6000);
}

async function loadCatalogSnapshotMeta() {
  if (!catalogSnapshotMetaEl || !btnRefreshCatalogSnapshot) return;

  try {
    const { data: isAdmin, error: adminErr } = await supabase.rpc("is_admin");
    if (adminErr) {
      catalogSnapshotMetaEl.textContent =
        "No se pudo verificar permisos de administrador.";
      console.warn("[QuickActions] is_admin RPC:", adminErr);
      return;
    }
    if (!isAdmin) {
      catalogSnapshotMetaEl.textContent =
        "Tu usuario no está en la lista de administradores (tabla admins): no podés refrescar el catálogo desde acá.";
      btnRefreshCatalogSnapshot.disabled = true;
      btnRefreshCatalogSnapshot.title =
        "Solo usuarios en public.admins pueden ejecutar el refresh.";
      return;
    }

    btnRefreshCatalogSnapshot.disabled = false;
    btnRefreshCatalogSnapshot.title = "";

    const { data: meta, error: metaErr } = await supabase
      .from("catalog_public_snapshot_meta")
      .select("refreshed_at, row_count")
      .eq("id", true)
      .maybeSingle();

    if (metaErr || !meta) {
      catalogSnapshotMetaEl.textContent =
        metaErr?.message || "Sin datos de última actualización.";
      return;
    }

    const when = meta.refreshed_at
      ? new Date(meta.refreshed_at).toLocaleString("es-AR", {
          dateStyle: "short",
          timeStyle: "short",
        })
      : "—";
    catalogSnapshotMetaEl.textContent = `Última copia: ${when} · ${meta.row_count ?? "?" } artículos-fila`;
  } catch (e) {
    catalogSnapshotMetaEl.textContent =
      "Error cargando estado del catálogo público.";
    console.warn("[QuickActions] loadCatalogSnapshotMeta:", e);
  }
}

function parseRefreshSnapshotRpcPayload(data) {
  if (data != null && typeof data === "object" && "row_count" in data) {
    return { row_count: data.row_count };
  }
  if (typeof data === "string") {
    try {
      const o = JSON.parse(data);
      if (o && typeof o.row_count === "number") return { row_count: o.row_count };
    } catch (_) {
      /* PostgREST a veces devuelve json ya parseado; a veces string */
    }
  }
  return { row_count: null };
}

if (btnRefreshCatalogSnapshot) {
  btnRefreshCatalogSnapshot.addEventListener("click", async () => {
    btnRefreshCatalogSnapshot.disabled = true;
    showCatalogSnapshotMessage("Actualizando catálogo público…", "success");
    try {
      const { data, error } = await supabase.rpc(
        "rpc_refresh_catalog_public_snapshot"
      );
      if (error) throw error;
      const { row_count } = parseRefreshSnapshotRpcPayload(data);
      const rowsLabel = row_count != null ? row_count : "?";
      showCatalogSnapshotMessage(
        `Listo. Copia regenerada (${rowsLabel} filas). Recargá el catálogo en otra pestaña para ver cambios.`,
        "success"
      );
      await loadCatalogSnapshotMeta();
    } catch (err) {
      console.error("[QuickActions] refresh snapshot:", err);
      showCatalogSnapshotMessage(
        err?.message ||
          "No se pudo actualizar. ¿Tu usuario está en public.admins?",
        "error"
      );
    } finally {
      btnRefreshCatalogSnapshot.disabled = false;
    }
  });
}

// Inicializar
loadActions();
loadBanner();
loadCustomBanner();
loadCatalogSnapshotMeta();

const curatedRoot = document.getElementById("curated-banner-admin-root");
if (curatedRoot) {
  initCuratedBannerAdmin({
    supabase,
    root: curatedRoot,
    messageEl: document.getElementById("curated-banner-message"),
    preset: "curated",
  });
}

const specialBannerRoot = document.getElementById("special-banner-admin-root");
if (specialBannerRoot) {
  initCuratedBannerAdmin({
    supabase,
    root: specialBannerRoot,
    messageEl: document.getElementById("special-banner-message"),
    preset: "special",
  });
}