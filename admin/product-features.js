// admin/product-features.js — Características de Calzado (capellada / base / altura).
import { supabase } from "../scripts/supabase-client.js?v=m260607";

const KINDS = [
  {
    kind: "capellada_material",
    selectId: "feat-capellada",
    createBtnId: "feat-capellada-create",
    newInputId: "feat-capellada-new",
    defaultBtnId: null,
    label: "Material de la capellada",
  },
  {
    kind: "base_material",
    selectId: "feat-base-material",
    createBtnId: "feat-base-material-create",
    newInputId: "feat-base-material-new",
    defaultBtnId: "feat-base-material-default",
    label: "Material de la base",
  },
  {
    kind: "base_altura",
    selectId: "feat-base-altura",
    createBtnId: "feat-base-altura-create",
    newInputId: "feat-base-altura-new",
    defaultBtnId: null,
    label: "Altura de la base",
  },
];

/**
 * @param {{ getCategory: () => string, canEdit: () => boolean }} deps
 */
export function createProductFeaturesControl({ getCategory, canEdit, isNewProduct = () => false }) {
  const field = document.getElementById("product-features-field");
  const state = {
    loaded: false,
    loadError: null,
    optionsByKind: {
      capellada_material: [],
      base_material: [],
      base_altura: [],
    },
    selected: {
      capellada_material: null,
      base_material: null,
      base_altura: null,
    },
  };

  function el(id) {
    return document.getElementById(id);
  }

  function isCalzado() {
    return getCategory() === "Calzado";
  }

  async function refreshVisibility() {
    if (!field) return;
    field.style.display = isCalzado() ? "" : "none";
    if (!isCalzado()) {
      renderAll();
      return;
    }
    if (!state.loaded && !state.loadError) {
      await loadOptions();
    } else {
      renderAll();
    }
    applyDefaultsIfPristineNew();
  }

  /** Producto nuevo de Calzado sin nada elegido: deja seleccionados los materiales predeterminados. */
  function applyDefaultsIfPristineNew() {
    if (!isCalzado() || !isNewProduct() || !state.loaded) return;
    const s = state.selected;
    if (s.capellada_material || s.base_material || s.base_altura) return;
    applyDefaultsForNewProduct();
  }

  function optionLabel(opt) {
    return opt.is_default ? `★ ${opt.name}` : opt.name;
  }

  function renderSelect(cfg) {
    const select = el(cfg.selectId);
    if (!select) return;
    const list = state.optionsByKind[cfg.kind] || [];
    const selectedId = state.selected[cfg.kind];
    select.replaceChildren();
    select.appendChild(new Option(`-- ${cfg.label} --`, ""));
    for (const opt of list) {
      select.appendChild(new Option(optionLabel(opt), opt.id));
    }
    if (selectedId && !list.some((o) => o.id === selectedId)) {
      const orphan = new Option("(opción no encontrada)", selectedId);
      orphan.disabled = true;
      select.appendChild(orphan);
    }
    select.value = selectedId || "";
    select.disabled = !canEdit() || !state.loaded;
    const createBtn = el(cfg.createBtnId);
    const newInput = el(cfg.newInputId);
    if (createBtn) createBtn.disabled = !canEdit();
    if (newInput) newInput.disabled = !canEdit();
    const defaultBtn = cfg.defaultBtnId ? el(cfg.defaultBtnId) : null;
    if (defaultBtn) {
      const current = list.find((o) => o.id === select.value);
      defaultBtn.disabled = !canEdit() || !current;
      defaultBtn.title = current?.is_default
        ? "Ya es el material de base predeterminado"
        : "Marcar como predeterminado (estrella)";
      defaultBtn.textContent = current?.is_default ? "★ Default" : "☆ Default";
    }
  }

  function renderAll() {
    for (const cfg of KINDS) renderSelect(cfg);
  }

  async function loadOptions() {
    try {
      const { data, error } = await supabase
        .from("product_feature_options")
        .select("id, category, kind, name, is_default")
        .eq("category", "Calzado")
        .order("name");
      if (error) throw error;
      state.optionsByKind = {
        capellada_material: [],
        base_material: [],
        base_altura: [],
      };
      for (const row of data || []) {
        if (state.optionsByKind[row.kind]) state.optionsByKind[row.kind].push(row);
      }
      state.loaded = true;
      state.loadError = null;
    } catch (e) {
      console.warn("product_feature_options:", e);
      state.loaded = false;
      state.loadError = e?.message || String(e);
    }
    renderAll();
  }

  function defaultIdFor(kind) {
    const list = state.optionsByKind[kind] || [];
    const marked = list.find((o) => o.is_default);
    if (marked) return marked.id;
    if (kind === "capellada_material") {
      const cuero = list.find((o) => /cuero\s*sint[eé]tico/i.test(o.name));
      return cuero?.id || null;
    }
    return null;
  }

  function applyDefaultsForNewProduct() {
    if (!isCalzado()) {
      clearSelection();
      return;
    }
    state.selected.capellada_material = defaultIdFor("capellada_material");
    state.selected.base_material = defaultIdFor("base_material");
    state.selected.base_altura = null;
    renderAll();
  }

  function clearSelection() {
    state.selected = {
      capellada_material: null,
      base_material: null,
      base_altura: null,
    };
    renderAll();
  }

  async function setProduct(prod = {}) {
    state.selected = {
      capellada_material: prod.capellada_material_id || null,
      base_material: prod.base_material_id || null,
      base_altura: prod.base_altura_id || null,
    };
    await refreshVisibility();
    renderAll();
  }

  /** Solo envía FKs cuando la categoría es Calzado; si no, limpia. */
  function payloadField() {
    if (!isCalzado()) {
      return {
        capellada_material_id: null,
        base_material_id: null,
        base_altura_id: null,
      };
    }
    if (state.loadError) {
      // No pisar valores existentes si no cargó el catálogo
      return {};
    }
    return {
      capellada_material_id: state.selected.capellada_material || null,
      base_material_id: state.selected.base_material || null,
      base_altura_id: state.selected.base_altura || null,
    };
  }

  async function createOption(kind, rawName) {
    const name = String(rawName || "").trim();
    if (!name) return null;
    const { data, error } = await supabase
      .from("product_feature_options")
      .insert([{ category: "Calzado", kind, name, is_default: false }])
      .select("id, category, kind, name, is_default")
      .single();
    if (error) {
      // Duplicado: buscar existente
      if (String(error.message || "").toLowerCase().includes("duplicate") || error.code === "23505") {
        const { data: existing } = await supabase
          .from("product_feature_options")
          .select("id, category, kind, name, is_default")
          .eq("category", "Calzado")
          .eq("kind", kind)
          .ilike("name", name)
          .maybeSingle();
        if (existing) {
          await loadOptions();
          return existing;
        }
      }
      throw error;
    }
    await loadOptions();
    return data;
  }

  async function setAsDefault(optionId) {
    const { data, error } = await supabase.rpc("rpc_admin_set_feature_option_default", {
      p_option_id: optionId,
    });
    if (error) throw error;
    await loadOptions();
    return data;
  }

  function bind() {
    for (const cfg of KINDS) {
      el(cfg.selectId)?.addEventListener("change", (e) => {
        state.selected[cfg.kind] = e.target.value || null;
        renderSelect(cfg);
      });
      el(cfg.createBtnId)?.addEventListener("click", async () => {
        const input = el(cfg.newInputId);
        const name = input?.value?.trim();
        if (!name) return;
        try {
          const created = await createOption(cfg.kind, name);
          if (created) {
            state.selected[cfg.kind] = created.id;
            if (input) input.value = "";
            renderAll();
          }
        } catch (e) {
          alert(`${cfg.label}: no se pudo crear — ${e?.message || e}`);
        }
      });
      if (cfg.defaultBtnId) {
        el(cfg.defaultBtnId)?.addEventListener("click", async () => {
          const id = state.selected[cfg.kind];
          if (!id) return;
          try {
            await setAsDefault(id);
            renderAll();
          } catch (e) {
            alert(`No se pudo marcar default: ${e?.message || e}`);
          }
        });
      }
    }
  }

  function prepareClone() {
    // Conserva la selección actual del formulario (ya está en state.selected)
    return "";
  }

  bind();

  return {
    init: () => {
      refreshVisibility();
    },
    refreshVisibility,
    /** Vuelve a pintar habilitando o apagando según el permiso actual. */
    refreshEditable: () => renderAll(),
    setProduct,
    applyDefaultsForNewProduct,
    clearSelection,
    payloadField,
    prepareClone,
    loadOptions,
  };
}
