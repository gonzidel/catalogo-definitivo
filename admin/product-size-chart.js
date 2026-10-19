// admin/product-size-chart.js — Selector "Tabla de talles" del formulario de producto.
// Regla clave: size_chart_id entra al payload solo si el selector cargó bien;
// si la carga falla no se envía y la asignación existente no se toca.
import { listSizeCharts, openSizeChartEditor } from "./size-charts-shared.js?v=m260607";
import {
  MEASURE_TYPES,
  chartStatus,
  isAssignable,
  sizeChartErrorMessage,
} from "./size-charts-core.js?v=m260607";

/** Mensaje para errores al guardar el producto (el trigger de la 378 rechaza tablas no asignables). */
export function productSaveErrorMessage(error) {
  const message = String(error?.message ?? "");
  return /SIZE_CHART_/.test(message) ? `Tabla de talles: ${sizeChartErrorMessage(error)}` : message;
}

/**
 * @param {{ getCategory: () => string, canEdit: () => boolean }} deps
 */
export function createProductSizeChartControl({ getCategory, canEdit }) {
  const field = document.getElementById("size-chart-field");
  const select = document.getElementById("size-chart");
  const hint = document.getElementById("size-chart-hint");
  const newBtn = document.getElementById("size-chart-new-btn");
  const editBtn = document.getElementById("size-chart-edit-btn");
  const duplicateBtn = document.getElementById("size-chart-duplicate-btn");
  const retryBtn = document.getElementById("size-chart-retry-btn");

  const state = {
    loaded: false,
    loadError: null,
    charts: [],
    originalId: null,
    selectedId: null,
    notice: "",
  };

  const findChart = (id) => state.charts.find((chart) => chart.id === id) || null;

  function chartOptionLabel(chart) {
    const status = chartStatus(chart);
    if (status === "complete") return chart.name;
    return `${chart.name} (${status === "archived" ? "archivada" : "incompleta"})`;
  }

  function renderOptions() {
    if (!select) return;
    select.replaceChildren();
    if (!state.loaded) {
      select.appendChild(new Option(state.loadError ? "No disponible" : "Cargando…", ""));
      select.disabled = true;
      return;
    }
    select.appendChild(new Option("Sin tabla", ""));
    for (const chart of state.charts) {
      const status = chartStatus(chart);
      if (status === "archived" && chart.id !== state.selectedId) continue;
      const option = new Option(chartOptionLabel(chart), chart.id);
      option.disabled = !isAssignable(chart);
      select.appendChild(option);
    }
    if (state.selectedId && !findChart(state.selectedId)) {
      const option = new Option("(tabla no encontrada)", state.selectedId);
      option.disabled = true;
      select.appendChild(option);
    }
    select.disabled = !canEdit();
    select.value = state.selectedId || "";
  }

  function renderHint() {
    if (!hint) return;
    if (!state.loaded) {
      hint.textContent = state.loadError
        ? `No se pudo cargar: ${state.loadError} La tabla asignada no se modificará.`
        : "";
      return;
    }
    const chart = findChart(state.selectedId);
    const parts = [];
    if (chart) {
      parts.push(`${MEASURE_TYPES[chart.measure_type] || chart.measure_type} · ${chart.rows_count} talles.`);
      if (chartStatus(chart) === "archived") {
        parts.push("Archivada: el producto la conserva, pero no se puede volver a elegir.");
      }
    } else if (!state.selectedId) {
      parts.push("Guía de medidas orientativa. No cambia talles ni stock.");
    }
    if (state.notice) parts.push(state.notice);
    hint.textContent = parts.join(" ");
  }

  function renderButtons() {
    const editable = state.loaded && canEdit();
    if (newBtn) newBtn.disabled = !editable;
    if (editBtn) editBtn.disabled = !editable || !findChart(state.selectedId);
    if (duplicateBtn) duplicateBtn.disabled = !editable || !findChart(state.selectedId);
    if (retryBtn) retryBtn.style.display = state.loadError ? "" : "none";
  }

  function refreshVisibility() {
    if (!field) return;
    const visible = getCategory() === "Calzado" || !!state.originalId || !!state.selectedId;
    field.style.display = visible ? "" : "none";
  }

  function render() {
    renderOptions();
    renderHint();
    renderButtons();
    refreshVisibility();
  }

  async function load() {
    state.loadError = null;
    state.loaded = false;
    render();
    try {
      state.charts = await listSizeCharts();
      state.loaded = true;
    } catch (error) {
      console.warn("[size-charts] no se pudo cargar el selector:", error);
      state.charts = [];
      state.loadError = sizeChartErrorMessage(error);
    }
    render();
  }

  /** Después de guardar desde el editor: recarga y selecciona la tabla si se puede asignar. */
  async function afterEditorSave(saved, { select: shouldSelect }) {
    await load();
    const chart = findChart(saved.id);
    state.notice = "";
    if (shouldSelect) {
      if (chart && isAssignable(chart)) {
        state.selectedId = chart.id;
        state.notice = "Tabla guardada y seleccionada. Guardá el producto para asignarla.";
      } else {
        state.notice = "Tabla guardada como borrador: completá todas las medidas para poder asignarla.";
      }
    } else if (state.selectedId === saved.id && chart && !isAssignable(chart) && state.selectedId !== state.originalId) {
      state.selectedId = null;
      state.notice = "La tabla quedó incompleta y se quitó la selección.";
    }
    render();
  }

  select?.addEventListener("change", () => {
    state.selectedId = select.value || null;
    state.notice = "";
    renderHint();
    renderButtons();
  });
  select?.form?.addEventListener("reset", () => {
    setTimeout(() => {
      state.originalId = null;
      state.selectedId = null;
      state.notice = "";
      render();
    });
  });
  retryBtn?.addEventListener("click", load);
  newBtn?.addEventListener("click", () =>
    openSizeChartEditor({ onSaved: (saved) => afterEditorSave(saved, { select: true }) })
  );
  editBtn?.addEventListener("click", () => {
    if (!state.selectedId) return;
    openSizeChartEditor({
      chartId: state.selectedId,
      onSaved: (saved) => afterEditorSave(saved, { select: false }),
    });
  });
  duplicateBtn?.addEventListener("click", () => {
    if (!state.selectedId) return;
    openSizeChartEditor({
      duplicateFromId: state.selectedId,
      onSaved: (saved) => afterEditorSave(saved, { select: true }),
    });
  });

  return {
    init: load,
    refreshVisibility,

    /** Producto cargado desde la base. */
    setProduct(sizeChartId) {
      state.originalId = sizeChartId || null;
      state.selectedId = state.originalId;
      state.notice = "";
      render();
    },

    resetForNew() {
      state.originalId = null;
      state.selectedId = null;
      state.notice = "";
      render();
    },

    /** Clonar: conserva la tabla solo si sigue activa y completa. Devuelve un aviso o "". */
    prepareClone() {
      state.originalId = null;
      let warning = "";
      if (state.selectedId) {
        if (!state.loaded) {
          warning = "No se pudieron cargar las tablas de talles: el clon queda sin tabla.";
        } else {
          const chart = findChart(state.selectedId);
          if (!chart || !isAssignable(chart)) {
            const reason = !chart ? "no disponible" : chartStatus(chart) === "archived" ? "archivada" : "incompleta";
            warning = `El clon queda sin tabla de talles porque la original está ${reason}.`;
            state.selectedId = null;
          }
        }
      }
      state.notice = warning;
      render();
      return warning;
    },

    /** Campos a sumar al insert/update de products. */
    payloadField() {
      if (!state.loaded || !select) return {};
      return { size_chart_id: select.value || null };
    },
  };
}
