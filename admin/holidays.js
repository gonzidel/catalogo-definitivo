// admin/holidays.js
//
// CRUD de public.order_deadline_holidays: fechas excluidas del cálculo de
// vencimiento de pedidos (ver fn_compute_order_deadline en
// supabase/canonical/257_order_deadline_business_days.sql). RLS restringe
// la tabla a usuarios presentes en public.admins, igual que el resto del
// panel admin.
import { requireAuth } from "./admin-auth.js?v=m260607";
import { supabase } from "../scripts/supabase-client.js?v=m260607";

const _actionInFlight = new Set();

async function initHolidays() {
  const user = await requireAuth();
  if (!user) return;

  setupEventListeners();
  await loadHolidays();
}

function waitForDOM() {
  return new Promise((resolve) => {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", resolve);
    } else {
      resolve();
    }
  });
}

waitForDOM().then(() => {
  initHolidays().catch((error) => {
    console.error("[holidays] init failed:", error);
  });
});

function setupEventListeners() {
  const form = document.getElementById("add-holiday-form");
  form?.addEventListener("submit", handleAddHoliday);
}

async function loadHolidays() {
  const container = document.getElementById("holidays-container");
  if (!container) return;

  try {
    container.innerHTML = '<div class="loading">Cargando feriados...</div>';

    const { data, error } = await supabase
      .from("order_deadline_holidays")
      .select("id, holiday_date, reason, created_at")
      .order("holiday_date", { ascending: true });

    if (error) throw error;

    if (!data || data.length === 0) {
      container.innerHTML = '<div class="empty-state"><p>No hay feriados registrados todavía.</p></div>';
      return;
    }

    container.innerHTML = renderHolidaysTable(data);
  } catch (error) {
    console.error("[holidays] error cargando:", error);
    container.innerHTML = `<div class="message error">Error al cargar feriados: ${escapeHtml(error.message)}</div>`;
  }
}

function renderHolidaysTable(holidays) {
  const rows = holidays.map((h) => {
    const info = formatHolidayDate(h.holiday_date);
    return `
      <tr data-holiday-id="${h.id}">
        <td>${escapeHtml(info.label)}<span class="holiday-year-badge">${info.year}</span></td>
        <td>${escapeHtml(h.reason || "-")}</td>
        <td>
          <button class="btn-danger" onclick="deleteHoliday('${h.id}', '${escapeHtml(info.label)}')">Eliminar</button>
        </td>
      </tr>
    `;
  }).join("");

  return `
    <table class="holidays-table">
      <thead>
        <tr>
          <th>Fecha</th>
          <th>Motivo</th>
          <th></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function formatHolidayDate(isoDate) {
  // isoDate viene como "YYYY-MM-DD" (column date). Se parsea como fecha local
  // (sin componente horario) para no correr un día por conversión de zona.
  const [year, month, day] = isoDate.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  const label = date.toLocaleDateString("es-AR", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  return { label: label.charAt(0).toUpperCase() + label.slice(1), year };
}

async function handleAddHoliday(e) {
  e.preventDefault();
  const dateInput = document.getElementById("holiday-date-input");
  const reasonInput = document.getElementById("holiday-reason-input");
  const btn = document.getElementById("add-holiday-btn");

  const holidayDate = dateInput?.value || "";
  const reason = reasonInput?.value.trim() || "";

  if (!holidayDate) {
    showMessage("Elegí una fecha", "error");
    return;
  }
  if (!reason) {
    showMessage("Ingresá un motivo (ej: Día de la Independencia)", "error");
    return;
  }

  try {
    btn.disabled = true;
    btn.textContent = "Agregando...";

    const { data: { user } } = await supabase.auth.getUser();

    const { error } = await supabase
      .from("order_deadline_holidays")
      .insert({
        holiday_date: holidayDate,
        reason,
        created_by: user?.id || null,
      });

    if (error) {
      if (error.code === "23505") {
        throw new Error("Esa fecha ya está registrada como feriado.");
      }
      throw error;
    }

    showMessage("Feriado agregado correctamente", "success");
    dateInput.value = "";
    reasonInput.value = "";
    await loadHolidays();
  } catch (error) {
    console.error("[holidays] error agregando:", error);
    showMessage(`Error: ${error.message}`, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Agregar";
  }
}

window.deleteHoliday = async function (id, label) {
  if (!confirm(`¿Eliminar el feriado "${label}"? Los pedidos que todavía no vencieron podrían recalcular su fecha de vencimiento.`)) {
    return;
  }

  if (_actionInFlight.has(id)) return;
  _actionInFlight.add(id);

  try {
    const { error } = await supabase
      .from("order_deadline_holidays")
      .delete()
      .eq("id", id);

    if (error) throw error;

    showMessage("Feriado eliminado", "success");
    await loadHolidays();
  } catch (error) {
    console.error("[holidays] error eliminando:", error);
    showMessage(`Error: ${error.message}`, "error");
  } finally {
    _actionInFlight.delete(id);
  }
};

function showMessage(message, type = "info") {
  const container = document.getElementById("message-container");
  if (!container) return;

  const messageEl = document.createElement("div");
  messageEl.className = `message ${type}`;
  messageEl.textContent = message;
  container.innerHTML = "";
  container.appendChild(messageEl);

  setTimeout(() => {
    messageEl.remove();
  }, 5000);
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text ?? "";
  return div.innerHTML;
}
