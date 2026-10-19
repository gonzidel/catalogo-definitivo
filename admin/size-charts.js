// admin/size-charts.js — Gestión de tablas de talles (lista, alta, edición, duplicado, archivo, borrado).
// Los permisos de la interfaz son de conveniencia: las RPC de la 378 exigen
// products:view / edit / delete en la base.
import { requireAuth } from "./admin-auth.js?v=m260607";
import { preloadAuthState, can } from "./auth-state.js?v=m260607";
import {
  deleteSizeChart,
  listSizeCharts,
  openSizeChartEditor,
  setSizeChartArchived,
} from "./size-charts-shared.js?v=m260607";
import {
  CHART_STATUS_LABELS,
  MEASURE_TYPES,
  chartStatus,
  isVersionConflict,
  sizeChartErrorMessage,
} from "./size-charts-core.js?v=m260607";

const container = document.getElementById("charts-container");
const newChartBtn = document.getElementById("new-chart-btn");
const filterButtons = Array.from(document.querySelectorAll("[data-filter]"));

const state = { charts: [], filter: "active" };
const actionsInFlight = new Set();

function showMessage(text, type = "success") {
  const box = document.getElementById("message-container");
  if (!box) return;
  const messageEl = document.createElement("div");
  messageEl.className = `message ${type}`;
  messageEl.textContent = text;
  box.replaceChildren(messageEl);
  setTimeout(() => messageEl.remove(), 6000);
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

function usageText(chart) {
  const total = Number(chart.products_count) || 0;
  const archived = Number(chart.archived_products_count) || 0;
  if (!total) return "Sin productos";
  return archived ? `${total} (${archived} archivado${archived === 1 ? "" : "s"})` : String(total);
}

function rowsText(chart) {
  const rows = Number(chart.rows_count) || 0;
  const missing = Number(chart.missing_measures_count) || 0;
  return missing ? `${rows} (${missing} sin medida)` : String(rows);
}

function actionButton(text, onClick, className = "") {
  const button = el("button", { type: "button", text, className });
  button.addEventListener("click", onClick);
  return button;
}

function renderCharts() {
  const visible = state.charts.filter((chart) =>
    state.filter === "archived" ? !!chart.archived_at : !chart.archived_at
  );
  if (!visible.length) {
    container.replaceChildren(
      el("div", {
        className: "empty-state",
        text: state.filter === "archived" ? "No hay tablas archivadas." : "Todavía no hay tablas de talles activas.",
      })
    );
    return;
  }

  const canEdit = can("products", "edit");
  const canDelete = can("products", "delete");
  const body = el("tbody");
  for (const chart of visible) {
    const status = chartStatus(chart);
    const nameCell = el("td", {}, [
      el("div", { className: "chart-name", text: chart.name }),
      chart.notes ? el("div", { className: "chart-notes", text: chart.notes }) : null,
    ]);
    const actions = el("div", { className: "row-actions" });
    if (canEdit) {
      actions.append(
        actionButton("Editar", () => openEditor({ chartId: chart.id })),
        actionButton("Duplicar", () => openEditor({ duplicateFromId: chart.id })),
        actionButton(chart.archived_at ? "Reactivar" : "Archivar", () => toggleArchived(chart))
      );
    }
    if (canDelete && !Number(chart.products_count)) {
      actions.append(actionButton("Eliminar", () => removeChart(chart), "btn-danger"));
    }
    body.appendChild(
      el("tr", {}, [
        nameCell,
        el("td", { "data-label": "Medida", text: MEASURE_TYPES[chart.measure_type] || chart.measure_type }),
        el("td", { "data-label": "Talles", text: rowsText(chart) }),
        el("td", { "data-label": "Estado" }, [
          el("span", { className: `status-badge status-${status}`, text: CHART_STATUS_LABELS[status] }),
        ]),
        el("td", { "data-label": "Productos", text: usageText(chart) }),
        el("td", {}, [actions]),
      ])
    );
  }

  container.replaceChildren(
    el("table", { className: "charts-table" }, [
      el("thead", {}, [
        el("tr", {}, ["Nombre", "Medida", "Talles", "Estado", "Productos", ""].map((text) => el("th", { text }))),
      ]),
      body,
    ])
  );
}

async function loadCharts() {
  try {
    state.charts = await listSizeCharts();
    renderCharts();
  } catch (error) {
    console.error("[size-charts] error cargando lista:", error);
    container.replaceChildren(
      el("div", { className: "message error", text: `No se pudieron cargar las tablas: ${sizeChartErrorMessage(error)}` })
    );
  }
}

function openEditor(options) {
  openSizeChartEditor({
    ...options,
    onSaved: async (saved) => {
      const draftNote = saved.is_complete ? "" : " Quedó como borrador: completá las medidas para poder asignarla.";
      showMessage(`Tabla "${saved.name}" guardada.${draftNote}`);
      await loadCharts();
    },
  });
}

async function runChartAction(chart, action, successText) {
  if (actionsInFlight.has(chart.id)) return;
  actionsInFlight.add(chart.id);
  try {
    await action();
    showMessage(successText);
  } catch (error) {
    console.error("[size-charts] error en acción:", error);
    showMessage(
      isVersionConflict(error)
        ? "Otra persona modificó esta tabla. Se recargó la lista; revisala y volvé a intentar."
        : sizeChartErrorMessage(error),
      "error"
    );
  } finally {
    actionsInFlight.delete(chart.id);
    await loadCharts();
  }
}

function toggleArchived(chart) {
  const archiving = !chart.archived_at;
  const total = Number(chart.products_count) || 0;
  const question = archiving
    ? `¿Archivar "${chart.name}"?${
        total === 1
          ? " El producto que la tiene la conserva, pero no se podrá asignar a otros."
          : total
            ? ` Los ${total} productos que la tienen la conservan, pero no se podrá asignar a otros.`
            : ""
      }`
    : `¿Reactivar "${chart.name}"? Volverá a estar disponible para asignar si está completa.`;
  if (!window.confirm(question)) return;
  runChartAction(
    chart,
    () => setSizeChartArchived(chart.id, chart.version, archiving),
    archiving ? `Tabla "${chart.name}" archivada.` : `Tabla "${chart.name}" reactivada.`
  );
}

function removeChart(chart) {
  if (!window.confirm(`¿Eliminar definitivamente "${chart.name}"? Esta acción no se puede deshacer.`)) return;
  runChartAction(chart, () => deleteSizeChart(chart.id, chart.version), `Tabla "${chart.name}" eliminada.`);
}

async function init() {
  const user = await requireAuth();
  if (!user) return;
  await preloadAuthState();

  if (!can("products", "view")) {
    container.replaceChildren(
      el("div", { className: "message error", text: "No tenés permiso para ver las tablas de talles (módulo Productos)." })
    );
    return;
  }

  newChartBtn.disabled = !can("products", "edit");
  newChartBtn.addEventListener("click", () => openEditor({}));
  filterButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.filter = button.dataset.filter;
      filterButtons.forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
      renderCharts();
    });
  });
  await loadCharts();
}

init().catch((error) => {
  console.error("[size-charts] init failed:", error);
});
