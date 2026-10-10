// admin/size-charts-shared.js — RPC y editor (modal) de tablas de talles.
// Lo usan size-charts.html (gestión) y products.html (selector del producto).
// Las tablas no son accesibles por PostgREST: todo pasa por las RPC de la 378.
import { supabase } from "../scripts/supabase-client.js?v=m260607";
import {
  MAX_LABEL_LENGTH,
  MAX_NAME_LENGTH,
  MAX_NOTES_LENGTH,
  MAX_ROWS,
  MEASURE_TYPES,
  chartMeasuresChanged,
  copyName,
  formatCm,
  generateSizeRange,
  isVersionConflict,
  mergeGeneratedLabels,
  parseCm,
  sizeChartErrorMessage,
  sortSizeRows,
  validateChartForm,
} from "./size-charts-core.js?v=m260607";

export async function listSizeCharts() {
  const { data, error } = await supabase.rpc("rpc_admin_size_charts_overview");
  if (error) throw error;
  return data || [];
}

export async function getSizeChart(id) {
  const { data, error } = await supabase.rpc("rpc_admin_get_size_chart", { p_id: id });
  if (error) throw error;
  return data;
}

/** @returns {Promise<{ id: string, version: number, is_complete: boolean, rows_count: number, products_count: number }>} */
export async function saveSizeChart({ id, expectedVersion, payload }) {
  const { data, error } = await supabase.rpc("rpc_admin_save_size_chart", {
    p_id: id,
    p_expected_version: expectedVersion,
    p_name: payload.name,
    p_measure_type: payload.measureType,
    p_notes: payload.notes,
    p_rows: payload.rows,
  });
  if (error) throw error;
  return data;
}

export async function setSizeChartArchived(id, expectedVersion, archived) {
  const { data, error } = await supabase.rpc("rpc_admin_set_size_chart_archived", {
    p_id: id,
    p_expected_version: expectedVersion,
    p_archived: archived,
  });
  if (error) throw error;
  return data;
}

export async function deleteSizeChart(id, expectedVersion) {
  const { data, error } = await supabase.rpc("rpc_admin_delete_size_chart", {
    p_id: id,
    p_expected_version: expectedVersion,
  });
  if (error) throw error;
  return data;
}

const EDITOR_STYLES = `
.sc-overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:2000;display:flex;align-items:flex-start;justify-content:center;padding:16px 8px;overflow-y:auto}
.sc-modal{background:#fff;border-radius:12px;width:100%;max-width:640px;padding:16px;box-shadow:0 20px 25px -5px rgba(0,0,0,.15);font-size:14px;color:#222;box-sizing:border-box}
.sc-modal h3{margin:0 0 12px;font-size:18px}
.sc-modal label{display:flex;flex-direction:column;gap:4px;font-weight:600;font-size:13px;margin-bottom:10px}
.sc-modal input,.sc-modal select,.sc-modal textarea{padding:8px;border:1px solid #ccc;border-radius:6px;font-size:14px;font-family:inherit;box-sizing:border-box;width:100%}
.sc-modal textarea{min-height:56px;resize:vertical}
.sc-modal .sc-btn{padding:8px 12px;min-height:40px;border:1px solid #ccc;border-radius:6px;background:#fff;cursor:pointer;font-size:14px}
.sc-modal .sc-btn.sc-primary{background:#3a6df0;border-color:#2f5fe0;color:#fff}
.sc-modal .sc-btn.sc-danger{border-color:#c33;color:#c33}
.sc-modal .sc-btn:disabled{opacity:.6;cursor:not-allowed}
.sc-banner{padding:8px 10px;border-radius:6px;margin-bottom:10px;font-size:13px;line-height:1.4}
.sc-banner.sc-info{background:#eef4ff;border:1px solid #c7d7fe;color:#1e3a8a}
.sc-banner.sc-warn{background:#fff7ed;border:1px solid #fed7aa;color:#9a3412}
.sc-banner.sc-error{background:#fef2f2;border:1px solid #fecaca;color:#991b1b}
.sc-banner ul{margin:4px 0 0 18px;padding:0}
.sc-range{display:grid;grid-template-columns:repeat(3,minmax(0,1fr)) auto;gap:6px;align-items:end;padding:8px;border:1px dashed #ccc;border-radius:8px;margin-bottom:10px}
.sc-range label{margin:0;font-size:12px}
.sc-rows{width:100%;border-collapse:collapse;margin-bottom:8px}
.sc-rows th{text-align:left;font-size:12px;color:#555;padding:4px}
.sc-rows td{padding:3px 4px}
.sc-rows td:last-child{width:44px}
.sc-rows input.sc-missing{border-color:#f59e0b;background:#fffbeb}
.sc-rows input.sc-invalid{border-color:#dc2626;background:#fef2f2}
.sc-row-actions{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:10px}
.sc-counter{font-size:12px;color:#555}
.sc-footer{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap;border-top:1px solid #eee;padding-top:12px}
.sc-confirm{display:flex;flex-direction:column;gap:8px}
.sc-confirm .sc-btn{width:100%}
@media (max-width:480px){.sc-range{grid-template-columns:1fr 1fr}.sc-footer .sc-btn{flex:1 1 auto}}
`;

function ensureEditorStyles() {
  if (document.getElementById("size-chart-editor-styles")) return;
  const style = document.createElement("style");
  style.id = "size-chart-editor-styles";
  style.textContent = EDITOR_STYLES;
  document.head.appendChild(style);
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === "className") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) if (child) node.appendChild(child);
  return node;
}

function productUsageText(chart) {
  const total = Number(chart.products_count) || 0;
  const archived = Number(chart.archived_products_count) || 0;
  const base = `Usada por ${total} producto${total === 1 ? "" : "s"}`;
  return archived ? `${base} (${archived} archivado${archived === 1 ? "" : "s"})` : base;
}

/**
 * Abre el editor. `chartId` edita; `duplicateFromId` crea una copia; sin ninguno crea una tabla nueva.
 * `onSaved` recibe { id, version, is_complete, name } después de guardar.
 */
export async function openSizeChartEditor({ chartId = null, duplicateFromId = null, onSaved } = {}) {
  ensureEditorStyles();

  const state = {
    id: null,
    version: null,
    original: null,
    productsCount: 0,
    saving: false,
    dirty: false,
    pendingConfirm: false,
  };

  const title = el("h3");
  const banners = el("div");
  const nameInput = el("input", { type: "text", maxLength: MAX_NAME_LENGTH, autocomplete: "off" });
  nameInput.placeholder = "Ej: Horma normal";
  const typeSelect = el("select", {}, [
    el("option", { value: "", text: "Elegí qué se mide" }),
    ...Object.entries(MEASURE_TYPES).map(([value, text]) => el("option", { value, text })),
  ]);
  const notesInput = el("textarea", { maxLength: MAX_NOTES_LENGTH });
  notesInput.placeholder = "Opcional (ej: fábrica, horma)";

  const rangeFrom = el("input", { type: "number", min: 1, step: 1, inputMode: "numeric" });
  const rangeTo = el("input", { type: "number", min: 1, step: 1, inputMode: "numeric" });
  const rangeMode = el("select", {}, [
    el("option", { value: "single", text: "Simples (35, 36…)" }),
    el("option", { value: "double", text: "Dobles (35/36…)" }),
  ]);
  const rangeBtn = el("button", { type: "button", className: "sc-btn", text: "Generar" });
  const rangeBox = el("div", { className: "sc-range" }, [
    el("label", { text: "Desde" }, [rangeFrom]),
    el("label", { text: "Hasta" }, [rangeTo]),
    el("label", { text: "Tipo" }, [rangeMode]),
    rangeBtn,
  ]);

  const rowsBody = el("tbody");
  const rowsTable = el("table", { className: "sc-rows" }, [
    el("thead", {}, [
      el("tr", {}, [
        el("th", { text: "Talle" }),
        el("th", { text: "Medida (cm)" }),
        el("th", { text: "" }),
      ]),
    ]),
    rowsBody,
  ]);
  const addRowBtn = el("button", { type: "button", className: "sc-btn", text: "+ Agregar fila" });
  const sortBtn = el("button", { type: "button", className: "sc-btn", text: "Ordenar por talle" });
  const counter = el("span", { className: "sc-counter" });

  const messages = el("div");
  const confirmBox = el("div", { className: "sc-banner sc-warn" });
  confirmBox.style.display = "none";

  const cancelBtn = el("button", { type: "button", className: "sc-btn", text: "Cancelar" });
  const saveBtn = el("button", { type: "button", className: "sc-btn sc-primary", text: "Guardar tabla" });

  const modal = el("div", { className: "sc-modal", role: "dialog", "aria-modal": "true" }, [
    title,
    banners,
    el("label", { text: "Nombre" }, [nameInput]),
    el("label", { text: "Qué representa la medida" }, [typeSelect]),
    el("label", { text: "Notas" }, [notesInput]),
    rangeBox,
    rowsTable,
    el("div", { className: "sc-row-actions" }, [addRowBtn, sortBtn, counter]),
    messages,
    confirmBox,
    el("div", { className: "sc-footer" }, [cancelBtn, saveBtn]),
  ]);
  const overlay = el("div", { className: "sc-overlay" }, [modal]);

  function showMessage(kind, text, items = []) {
    messages.replaceChildren();
    if (!text && !items.length) return;
    const box = el("div", { className: `sc-banner sc-${kind}`, text });
    if (items.length) box.appendChild(el("ul", {}, items.map((item) => el("li", { text: item }))));
    messages.appendChild(box);
  }

  function renderBanners() {
    banners.replaceChildren();
    if (state.original?.archived_at) {
      banners.appendChild(
        el("div", {
          className: "sc-banner sc-warn",
          text: "Tabla archivada: los productos que ya la tienen la conservan, pero no se puede asignar a otros.",
        })
      );
    }
    if (state.id && state.productsCount > 0) {
      banners.appendChild(
        el("div", {
          className: "sc-banner sc-info",
          text: `${productUsageText(state.original)}. Los cambios de medidas se aplican a todos; para no afectarlos, duplicala.`,
        })
      );
    }
  }

  function setTitle(text) {
    title.textContent = text;
  }

  function addRow(row = { size_label: "", measure_text: "" }) {
    const labelInput = el("input", {
      type: "text",
      value: row.size_label,
      maxLength: MAX_LABEL_LENGTH,
      autocomplete: "off",
      className: "sc-label",
    });
    labelInput.placeholder = "35 o 35/36";
    const measureInput = el("input", {
      type: "text",
      value: row.measure_text,
      inputMode: "decimal",
      autocomplete: "off",
      className: "sc-measure",
    });
    measureInput.placeholder = "22,5";
    const removeBtn = el("button", { type: "button", className: "sc-btn sc-danger", text: "×", title: "Quitar fila" });
    const tr = el("tr", {}, [el("td", {}, [labelInput]), el("td", {}, [measureInput]), el("td", {}, [removeBtn])]);
    removeBtn.addEventListener("click", () => {
      tr.remove();
      markDirty();
    });
    rowsBody.appendChild(tr);
    return tr;
  }

  function readRows() {
    return Array.from(rowsBody.querySelectorAll("tr")).map((tr) => ({
      size_label: tr.querySelector(".sc-label").value,
      measure_text: tr.querySelector(".sc-measure").value,
    }));
  }

  function setRows(rows) {
    rowsBody.replaceChildren();
    rows.forEach((row) => addRow(row));
    refreshRowHints();
  }

  function refreshRowHints() {
    let filled = 0;
    let missing = 0;
    rowsBody.querySelectorAll("tr").forEach((tr) => {
      const label = tr.querySelector(".sc-label").value.trim();
      const measureInput = tr.querySelector(".sc-measure");
      const parsed = parseCm(measureInput.value);
      measureInput.classList.toggle("sc-invalid", !parsed.ok);
      measureInput.classList.toggle("sc-missing", parsed.ok && parsed.value === null && !!label);
      if (!label) return;
      filled += 1;
      if (!parsed.ok || parsed.value === null) missing += 1;
    });
    counter.textContent = missing
      ? `${filled} talle${filled === 1 ? "" : "s"} · ${missing} sin medida válida (se guarda como borrador)`
      : `${filled} talle${filled === 1 ? "" : "s"}`;
  }

  function markDirty() {
    state.dirty = true;
    hideConfirm();
    refreshRowHints();
  }

  function close() {
    overlay.remove();
    document.removeEventListener("keydown", onKeydown);
  }

  function requestClose() {
    if (state.saving) return;
    if (state.dirty && !window.confirm("Hay cambios sin guardar en la tabla de talles. ¿Descartarlos?")) return;
    close();
  }

  function onKeydown(event) {
    if (event.key === "Escape") requestClose();
  }

  function hideConfirm() {
    state.pendingConfirm = false;
    confirmBox.style.display = "none";
    confirmBox.replaceChildren();
  }

  function switchToCopy() {
    state.id = null;
    state.version = null;
    state.original = null;
    state.productsCount = 0;
    nameInput.value = copyName(nameInput.value);
    setTitle("Duplicar tabla de talles");
    renderBanners();
    hideConfirm();
    state.dirty = true;
    showMessage("info", "Estás editando una copia nueva. La tabla original y sus productos no cambian.");
    nameInput.focus();
    nameInput.select();
  }

  function showInUseConfirm() {
    state.pendingConfirm = true;
    const count = state.productsCount;
    const applyBtn = el("button", {
      type: "button",
      className: "sc-btn sc-primary",
      text: count === 1 ? "Aplicar al producto" : `Aplicar a los ${count} productos`,
    });
    const duplicateBtn = el("button", { type: "button", className: "sc-btn", text: "Duplicar y editar la copia" });
    const backBtn = el("button", { type: "button", className: "sc-btn", text: "Cancelar" });
    applyBtn.addEventListener("click", () => save({ confirmed: true }));
    duplicateBtn.addEventListener("click", switchToCopy);
    backBtn.addEventListener("click", hideConfirm);
    confirmBox.replaceChildren(
      el("div", {
        text: `Esta tabla está asignada a ${count} producto${count === 1 ? "" : "s"}. Los cambios de talles, medidas o tipo se van a ver en todos.`,
      }),
      el("div", { className: "sc-confirm" }, [applyBtn, duplicateBtn, backBtn])
    );
    confirmBox.style.display = "";
    applyBtn.focus();
  }

  function showConflict() {
    const reloadBtn = el("button", { type: "button", className: "sc-btn", text: "Recargar tabla" });
    reloadBtn.addEventListener("click", async () => {
      if (!window.confirm("Se descartan tus cambios y se carga la versión actual. ¿Continuar?")) return;
      await loadChart(state.id, false);
    });
    messages.replaceChildren(
      el("div", { className: "sc-banner sc-error" }, [
        el("div", { text: "Otra persona modificó esta tabla mientras la editabas. Recargala y volvé a aplicar tus cambios." }),
        reloadBtn,
      ])
    );
  }

  function fillForm(chart, { asCopy }) {
    nameInput.value = asCopy ? copyName(chart.name) : chart.name;
    typeSelect.value = chart.measure_type;
    notesInput.value = chart.notes || "";
    setRows(
      (chart.rows || []).map((row) => ({ size_label: row.size_label, measure_text: formatCm(row.measure_cm) }))
    );
  }

  async function loadChart(id, asCopy) {
    showMessage("info", "Cargando tabla…");
    const chart = await getSizeChart(id);
    if (asCopy) {
      state.id = null;
      state.version = null;
      state.original = null;
      state.productsCount = 0;
      setTitle("Duplicar tabla de talles");
    } else {
      state.id = chart.id;
      state.version = chart.version;
      state.original = chart;
      state.productsCount = Number(chart.products_count) || 0;
      setTitle("Editar tabla de talles");
    }
    fillForm(chart, { asCopy });
    renderBanners();
    hideConfirm();
    state.dirty = asCopy;
    showMessage("", "");
  }

  async function save({ confirmed = false } = {}) {
    if (state.saving) return;
    const result = validateChartForm({
      name: nameInput.value,
      measureType: typeSelect.value,
      notes: notesInput.value,
      rows: readRows(),
    });
    if (!result.ok) {
      hideConfirm();
      showMessage("error", "Revisá la tabla:", result.errors);
      return;
    }
    if (state.id && state.productsCount > 0 && !confirmed && chartMeasuresChanged(state.original, result.payload)) {
      showMessage("", "");
      showInUseConfirm();
      return;
    }

    state.saving = true;
    saveBtn.disabled = true;
    saveBtn.textContent = "Guardando…";
    try {
      const saved = await saveSizeChart({ id: state.id, expectedVersion: state.version, payload: result.payload });
      state.dirty = false;
      close();
      onSaved?.({ ...saved, name: result.payload.name });
    } catch (error) {
      console.error("[size-charts] error guardando:", error);
      hideConfirm();
      if (isVersionConflict(error)) showConflict();
      else showMessage("error", sizeChartErrorMessage(error));
    } finally {
      state.saving = false;
      saveBtn.disabled = false;
      saveBtn.textContent = "Guardar tabla";
    }
  }

  rangeBtn.addEventListener("click", () => {
    const range = generateSizeRange(rangeFrom.value, rangeTo.value, rangeMode.value);
    if (!range.ok) {
      showMessage("error", range.error);
      return;
    }
    const current = readRows().filter((row) => row.size_label.trim() || row.measure_text.trim());
    const merged = mergeGeneratedLabels(current, range.labels);
    if (merged.rows.length > MAX_ROWS) {
      showMessage("error", `Máximo ${MAX_ROWS} talles por tabla.`);
      return;
    }
    setRows(merged.rows);
    markDirty();
    showMessage(
      "info",
      merged.addedCount
        ? `Se agregaron ${merged.addedCount} talle${merged.addedCount === 1 ? "" : "s"}. Completá las medidas que informa la fábrica.`
        : "Esos talles ya estaban en la tabla."
    );
  });
  addRowBtn.addEventListener("click", () => {
    if (rowsBody.children.length >= MAX_ROWS) {
      showMessage("error", `Máximo ${MAX_ROWS} talles por tabla.`);
      return;
    }
    addRow().querySelector(".sc-label").focus();
    markDirty();
  });
  sortBtn.addEventListener("click", () => {
    setRows(sortSizeRows(readRows().filter((row) => row.size_label.trim() || row.measure_text.trim())));
    markDirty();
  });
  modal.addEventListener("input", markDirty);
  cancelBtn.addEventListener("click", requestClose);
  saveBtn.addEventListener("click", () => save());
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) requestClose();
  });
  document.addEventListener("keydown", onKeydown);

  setTitle("Nueva tabla de talles");
  refreshRowHints();
  document.body.appendChild(overlay);

  const sourceId = chartId || duplicateFromId;
  if (sourceId) {
    try {
      await loadChart(sourceId, !chartId);
    } catch (error) {
      console.error("[size-charts] error cargando:", error);
      showMessage("error", `No se pudo cargar la tabla: ${sizeChartErrorMessage(error)}`);
      saveBtn.disabled = true;
      return;
    }
  }
  nameInput.focus();
}
