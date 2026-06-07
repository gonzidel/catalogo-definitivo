import { supabase } from "../scripts/supabase-client.js?v=m260607";
import { requireAuth } from "./admin-auth.js?v=m260607";

const els = {
  from: document.getElementById("metrics-from"),
  to: document.getElementById("metrics-to"),
  refresh: document.getElementById("metrics-refresh"),
  status: document.getElementById("metrics-status"),
  dateContext: document.getElementById("metrics-date-context"),
  alerts: document.getElementById("metrics-alerts"),
  tabs: Array.from(document.querySelectorAll(".metrics-v2-tab")),
  panels: {
    negocio: document.getElementById("panel-negocio"),
    operacion: document.getElementById("panel-operacion"),
    producto: document.getElementById("panel-producto"),
    comportamiento: document.getElementById("panel-comportamiento"),
  },
  kpiNegocio: document.getElementById("kpi-negocio"),
  kpiOperacion: document.getElementById("kpi-operacion"),
  kpiComportamiento: document.getElementById("kpi-comportamiento"),
  tableTopProductos: document.getElementById("table-top-productos"),
  tableTopVariantes: document.getElementById("table-top-variantes"),
  tableTopTalles: document.getElementById("table-top-talles"),
  replenishmentFeedbackSection: document.getElementById("replenishment-feedback-section"),
  replenishmentFeedbackList: document.getElementById("replenishment-feedback-list"),
  learningSystemSection: document.getElementById("learning-system-section"),
  learningSystemList: document.getElementById("learning-system-list"),
  weeklyPurchasePlanSection: document.getElementById("weekly-purchase-plan-section"),
  weeklyPlanHint: document.getElementById("weekly-plan-hint"),
  weeklyPlanResumen: document.getElementById("weekly-plan-resumen"),
  weeklyPlanUrgente: document.getElementById("weekly-plan-urgente"),
  weeklyPlanRecomendada: document.getElementById("weekly-plan-recomendada"),
  weeklyPlanNoComprar: document.getElementById("weekly-plan-no-comprar"),
  suggestedSupplierOrdersSection: document.getElementById("suggested-supplier-orders-section"),
  suggestedSupplierHint: document.getElementById("suggested-supplier-hint"),
  suggestedSupplierOrdersList: document.getElementById("suggested-supplier-orders-list"),
};

function formatDateInput(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function initDefaultDates() {
  const today = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 30);
  els.from.value = formatDateInput(from);
  els.to.value = formatDateInput(today);
}

function dateLabel(yyyyMmDd) {
  if (!yyyyMmDd) return "--/--";
  const [y, m, d] = yyyyMmDd.split("-");
  return `${d}/${m}`;
}

function updateDateContext() {
  els.dateContext.textContent = `Mostrando datos del ${dateLabel(els.from.value)} al ${dateLabel(els.to.value)}`;
}

function setStatus(message, isError = false) {
  els.status.textContent = message || "";
  els.status.style.color = isError ? "#b91c1c" : "#6b7280";
}

function setLoading(loading) {
  els.refresh.disabled = loading;
  els.refresh.textContent = loading ? "Actualizando..." : "Actualizar";
}

function currency(value) {
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    maximumFractionDigits: 0,
  }).format(Number(value || 0));
}

function number(value) {
  return new Intl.NumberFormat("es-AR").format(Number(value || 0));
}

function percent(value) {
  return `${Number(value || 0).toFixed(2)}%`;
}

function hours(value) {
  return `${Number(value || 0).toFixed(2)} h`;
}

function renderKpiGrid(container, items) {
  container.innerHTML = items
    .map(
      (item) => `
      <article class="kpi-card ${item.primary ? "primary" : ""}">
        <h3>${item.label}</h3>
        <div class="value">${item.value}</div>
      </article>
    `
    )
    .join("");
}

function renderSkeletonKpis(container, count = 4) {
  const blocks = Array.from({ length: count })
    .map(() => '<article class="kpi-card skeleton" aria-hidden="true"></article>')
    .join("");
  container.innerHTML = blocks;
}

function renderSkeletonTables() {
  els.tableTopProductos.innerHTML = '<div class="kpi-card skeleton" aria-hidden="true"></div>';
  els.tableTopVariantes.innerHTML = '<div class="kpi-card skeleton" aria-hidden="true"></div>';
  els.tableTopTalles.innerHTML = '<div class="kpi-card skeleton" aria-hidden="true"></div>';
}

function renderAllSkeletons() {
  renderSkeletonKpis(els.kpiNegocio, 5);
  renderSkeletonKpis(els.kpiOperacion, 8);
  renderSkeletonKpis(els.kpiComportamiento, 3);
  renderSkeletonTables();
}

function renderTable(container, columns, rows) {
  if (!rows || rows.length === 0) {
    container.innerHTML = '<div class="empty">Sin datos de productos.</div>';
    return;
  }

  const header = columns
    .map((c) => `<th class="${c.right ? "text-right" : ""}">${c.label}</th>`)
    .join("");
  const body = rows
    .map((row) => {
      const cells = columns
        .map((c) => `<td class="${c.right ? "text-right" : ""}">${c.render(row)}</td>`)
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");

  container.innerHTML = `
    <table class="simple-table">
      <thead><tr>${header}</tr></thead>
      <tbody>${body}</tbody>
    </table>
  `;
}

function normalizePayload(data) {
  if (!data) return {};
  if (data.data && typeof data.data === "object") return data.data;
  return data;
}

function normalizeComparePayload(data) {
  if (!data || typeof data !== "object") {
    return { current: {}, previous: {} };
  }
  return {
    current: normalizePayload(data.current || {}),
    previous: normalizePayload(data.previous || {}),
  };
}

function generateAlerts(data) {
  const d = normalizePayload(data);
  const alerts = [];
  const ticketThreshold = 25000;

  if (Number(d.tasa_cancelacion || 0) > 10) {
    alerts.push({ type: "warning", priority: 30, message: "⚠️ Alta tasa de cancelación" });
  }
  if (Number(d.tasa_devolucion || 0) > 5) {
    alerts.push({ type: "warning", priority: 30, message: "⚠️ Devoluciones elevadas" });
  }
  if (Number(d.ventas_netas || 0) === 0) {
    alerts.push({ type: "critical", priority: 20, message: "⚠️ No hubo ventas en el período" });
  }
  if (Number(d.pedidos_enviados || 0) < 5) {
    alerts.push({ type: "warning", priority: 30, message: "⚠️ Bajo volumen de pedidos" });
  }
  if (Number(d.ticket_promedio || 0) < ticketThreshold) {
    alerts.push({ type: "warning", priority: 30, message: "⚠️ Ticket promedio bajo" });
  }

  return alerts;
}

function percentageChange(current, previous) {
  const c = Number(current || 0);
  const p = Number(previous || 0);
  if (p === 0) {
    if (c === 0) return 0;
    return 100;
  }
  return ((c - p) / p) * 100;
}

function generateComparativeAlerts(current, previous) {
  const alerts = [];

  const ventasChange = percentageChange(current.ventas_netas, previous.ventas_netas);
  const cancelChange = percentageChange(current.tasa_cancelacion, previous.tasa_cancelacion);
  const pedidosChange = percentageChange(current.pedidos_enviados, previous.pedidos_enviados);
  const ticketChange = percentageChange(current.ticket_promedio, previous.ticket_promedio);
  const nuevosChange = percentageChange(current.clientes_nuevos, previous.clientes_nuevos);

  if (ventasChange < -20) {
    alerts.push({
      type: "critical",
      priority: 10,
      message: `🔴 Ventas cayeron ${Math.abs(ventasChange).toFixed(1)}% vs período anterior`,
    });
  }

  if (cancelChange > 30) {
    alerts.push({
      type: "critical",
      priority: 10,
      message: `🔴 Cancelaciones aumentaron ${cancelChange.toFixed(1)}%`,
    });
  }

  if (pedidosChange < -20) {
    alerts.push({
      type: "critical",
      priority: 10,
      message: `🔴 Caída de pedidos (${Math.abs(pedidosChange).toFixed(1)}%)`,
    });
  }

  if (ticketChange < -15) {
    alerts.push({
      type: "warning",
      priority: 11,
      message: `🟡 Ticket promedio bajando (${Math.abs(ticketChange).toFixed(1)}%)`,
    });
  }

  if (nuevosChange < -20) {
    alerts.push({
      type: "warning",
      priority: 11,
      message: `🟡 Menos clientes nuevos (${Math.abs(nuevosChange).toFixed(1)}%)`,
    });
  }

  if (ventasChange > 30) {
    alerts.push({
      type: "positive",
      priority: 12,
      message: `🟢 Fuerte crecimiento (+${ventasChange.toFixed(1)}%)`,
    });
  }

  return alerts;
}

function generateProductAlerts(data) {
  const d = data && typeof data === "object" ? data : {};
  const alerts = [];
  const seen = new Set();

  const stockCritico = Array.isArray(d.stock_critico) ? d.stock_critico : [];
  const tallesCriticos = Array.isArray(d.talles_criticos) ? d.talles_criticos : [];
  const productosDominantes = Array.isArray(d.productos_dominantes) ? d.productos_dominantes : [];
  const productosLentos = Array.isArray(d.productos_lentos) ? d.productos_lentos : [];
  const productosTendencia = Array.isArray(d.productos_tendencia) ? d.productos_tendencia : [];

  const toNum = (v) => Number(v);
  const isFiniteNum = (v) => Number.isFinite(Number(v));
  const pushUnique = (alert, key) => {
    if (!alert || !key || seen.has(key)) return;
    seen.add(key);
    alerts.push(alert);
  };

  // Orden por impacto: units/revenue descendente
  const stockSorted = [...stockCritico].sort((a, b) => toNum(b.units) - toNum(a.units));
  const tallesSorted = [...tallesCriticos].sort((a, b) => toNum(b.units) - toNum(a.units));
  const lentosSorted = [...productosLentos].sort((a, b) => toNum(b.stock_total) - toNum(a.stock_total));
  const dominantesSorted = [...productosDominantes].sort((a, b) => toNum(b.revenue) - toNum(a.revenue));
  const tendenciaSorted = [...productosTendencia].sort((a, b) => toNum(b.units) - toNum(a.units));

  // 🔴 STOCK CRÍTICO (cobertura real)
  let stockCount = 0;
  stockSorted.forEach((item) => {
    if (stockCount >= 2) return;
    const units = toNum(item.units);
    const cobertura = toNum(item.cobertura);
    if (!Number.isFinite(units) || units < 5) return;
    if (!isFiniteNum(cobertura) || cobertura >= 3) return;

    const cov = cobertura.toFixed(1);
    const urgencia = cobertura < 1 ? "🔥 URGENTE" : (cobertura < 2 ? "⚠️ Alta prioridad" : "🔴");
    pushUnique(
      {
        type: "critical",
        priority: 1,
        message: `${urgencia} ${item.product_name} con stock para ${cov} días (${Math.round(units)} ventas)`,
      },
      `stock:${item.product_id || item.product_name}:${cov}`
    );
    stockCount += 1;
  });

  // 🔴 TALLES CRÍTICOS (cobertura real por variant+size)
  let tallesCount = 0;
  tallesSorted.forEach((item) => {
    if (tallesCount >= 2) return;
    const units = toNum(item.units);
    const cobertura = toNum(item.cobertura);
    if (!Number.isFinite(units) || units < 3) return;
    if (!isFiniteNum(cobertura) || cobertura >= 3) return;

    pushUnique(
      {
        type: "critical",
        priority: 1,
        message: `🔴 Talle ${item.size} crítico en ${item.product_name} (${cobertura.toFixed(1)} días)`,
      },
      `talle:${item.variant_id || item.product_name}:${item.size}:${cobertura.toFixed(1)}`
    );
    tallesCount += 1;
  });

  // 🟡 PRODUCTOS LENTOS (rotación real)
  let lentosCount = 0;
  lentosSorted.forEach((item) => {
    if (lentosCount >= 2) return;
    const stock = toNum(item.stock_total);
    const rot = toNum(item.rotacion);
    if (!Number.isFinite(stock) || stock < 20) return;
    if (!isFiniteNum(rot) || rot >= 0.1) return;

    pushUnique(
      {
        type: "warning",
        priority: 2,
        message: `🟡 ${item.product_name} baja rotación (${rot.toFixed(2)}) con stock ${Math.round(stock)}`,
      },
      `lento:${item.product_id || item.product_name}:${rot.toFixed(2)}:${Math.round(stock)}`
    );
    lentosCount += 1;
  });

  // 🟡 PRODUCTOS DOMINANTES
  let dominantesCount = 0;
  dominantesSorted.forEach((item) => {
    if (dominantesCount >= 2) return;
    const share = toNum(item.revenue_share_percent);
    if (!isFiniteNum(share)) return;

    pushUnique(
      {
        type: "warning",
        priority: 2,
        message: `⚠️ ${item.product_name} concentra ${share.toFixed(0)}% de ventas`,
      },
      `dominante:${item.product_id || item.product_name}:${share.toFixed(0)}`
    );
    dominantesCount += 1;
  });

  // 🟢 PRODUCTOS EN CRECIMIENTO REAL
  let tendenciaCount = 0;
  tendenciaSorted.forEach((item) => {
    if (tendenciaCount >= 2) return;
    const growth = toNum(item.growth_percent);
    const units = toNum(item.units);
    if (!isFiniteNum(growth) || !Number.isFinite(units) || units < 5) return;

    pushUnique(
      {
        type: "positive",
        priority: 3,
        message: `🟢 ${item.product_name} creciendo ${growth.toFixed(1)}%`,
      },
      `trend:${item.product_id || item.product_name}:${growth.toFixed(1)}:${Math.round(units)}`
    );
    tendenciaCount += 1;
  });

  // 🟢 NUEVO PRODUCTO CON TRACCIÓN
  let nuevosCount = 0;
  tendenciaSorted.forEach((item) => {
    if (nuevosCount >= 2) return;
    const units = toNum(item.units);
    const revenuePrev = toNum(item.revenue_prev);
    if (!Number.isFinite(units) || units < 5) return;
    if (!Number.isFinite(revenuePrev) || revenuePrev !== 0) return;

    pushUnique(
      {
        type: "positive",
        priority: 3,
        message: `🚀 Nuevo producto con tracción: ${item.product_name} (${Math.round(units)} ventas)`,
      },
      `nuevo:${item.product_id || item.product_name}:${Math.round(units)}`
    );
    nuevosCount += 1;
  });

  // Priorizar críticas > warnings > positivas
  return alerts.sort((a, b) => a.priority - b.priority);
}

function generateReplenishmentInsights(data) {
  const d = data && typeof data === "object" ? data : {};
  const alerts = [];

  const urgentes = Array.isArray(d.reposicion_urgente) ? d.reposicion_urgente : [];
  const medias = Array.isArray(d.reposicion_media) ? d.reposicion_media : [];
  const sobrestock = Array.isArray(d.sobrestock) ? d.sobrestock : [];

  urgentes.slice(0, 2).forEach((item) => {
    const qty = Number(item.cantidad_reponer || 0);
    const cobertura = Number(item.cobertura || 0);
    if (!Number.isFinite(qty) || qty <= 0) return;
    if (!Number.isFinite(cobertura)) return;
    alerts.push({
      type: "critical",
      priority: 0,
      message: `🔴 Reponer ${Math.round(qty)} unidades de ${item.product_name} (stock para ${cobertura.toFixed(1)} días)`,
    });
  });

  medias.slice(0, 1).forEach((item) => {
    const cobertura = Number(item.cobertura || 0);
    if (!Number.isFinite(cobertura)) return;
    alerts.push({
      type: "warning",
      priority: 4,
      message: `🟡 Considerar reposición de ${item.product_name} (${cobertura.toFixed(1)} días)`,
    });
  });

  sobrestock.slice(0, 1).forEach((item) => {
    const exceso = Number(item.cantidad_reponer || 0);
    if (!Number.isFinite(exceso) || exceso <= 0) return;
    alerts.push({
      type: "warning",
      priority: 4,
      message: `⚠️ Sobrestock en ${item.product_name} (${Math.round(exceso)} unidades)`,
    });
  });

  return alerts;
}

function generateReplenishmentFeedback(data) {
  const d = data && typeof data === "object" ? data : {};
  const out = [];
  const efectivas = Array.isArray(d.reposicion_efectiva) ? d.reposicion_efectiva : [];
  const ineficientes = Array.isArray(d.reposicion_ineficiente) ? d.reposicion_ineficiente : [];
  const quiebres = Array.isArray(d.quiebres_no_evitatados) ? d.quiebres_no_evitatados : [];

  efectivas.slice(0, 2).forEach((item) => {
    out.push({
      type: "positive",
      priority: 0,
      message: `✔ Reposición efectiva en ${item.product_name}`,
    });
  });

  ineficientes.slice(0, 2).forEach((item) => {
    out.push({
      type: "warning",
      priority: 0,
      message: `⚠️ Sobrestock generado en ${item.product_name}`,
    });
  });

  quiebres.slice(0, 2).forEach((item) => {
    out.push({
      type: "critical",
      priority: 0,
      message: `🔴 Quiebre no evitado en ${item.product_name}`,
    });
  });

  return out;
}

function generateLearningAdjustments(data) {
  const d = data && typeof data === "object" ? data : {};
  const ajustes = Array.isArray(d.ajustes_modelo) ? d.ajustes_modelo : [];
  return ajustes.slice(0, 4).map((item) => {
    const factor = Number(item.factor_ajuste || 1);
    let message = `✔ Mantener parámetros en ${item.product_name}`;
    let type = "positive";
    let priority = 0;

    if (item.ajuste_sugerido === "aumentar buffer de seguridad") {
      const pct = Math.round((factor - 1) * 100);
      message = `🔴 Aumentar stock de seguridad en ${item.product_name} (+${pct}%)`;
      type = "critical";
      priority = 0;
    } else if (item.ajuste_sugerido === "reducir sobrestock") {
      const pct = Math.round((1 - factor) * 100);
      message = `⚠️ Reducir reposición en ${item.product_name} (-${pct}%)`;
      type = "warning";
      priority = 0;
    }

    return {
      type,
      priority,
      message,
      motivo: item.motivo || "",
    };
  });
}

function renderReplenishmentFeedback(data) {
  const feedback = generateReplenishmentFeedback(data);
  if (!feedback.length) {
    els.replenishmentFeedbackSection.style.display = "none";
    els.replenishmentFeedbackList.innerHTML = '<div class="empty">Sin feedback de reposición para este rango.</div>';
    return;
  }

  els.replenishmentFeedbackSection.style.display = "block";
  els.replenishmentFeedbackList.innerHTML = feedback
    .slice(0, 4)
    .map((f) => {
      const style = getAlertStyle(f.type);
      return `<div class="metrics-v2-alert" style="background:${style.background};border-color:${style.border};color:${style.text};margin-bottom:8px;">${f.message}</div>`;
    })
    .join("");
}

function renderWeeklyPurchasePlan(data) {
  const d = data && typeof data === "object" ? data : {};
  const urgente = Array.isArray(d.compra_urgente) ? d.compra_urgente : [];
  const recomendada = Array.isArray(d.compra_recomendada) ? d.compra_recomendada : [];
  const noComprar = Array.isArray(d.no_comprar) ? d.no_comprar : [];
  const resumen = d.resumen && typeof d.resumen === "object" ? d.resumen : {};

  const hasAny = urgente.length > 0 || recomendada.length > 0 || noComprar.length > 0;
  const totalU = Number(resumen.total_unidades_a_comprar || 0);
  const nProd = Number(resumen.cantidad_productos || 0);

  if (!hasAny && totalU === 0 && nProd === 0) {
    els.weeklyPurchasePlanSection.style.display = "none";
    return;
  }

  els.weeklyPurchasePlanSection.style.display = "block";
  els.weeklyPlanHint.textContent =
    "Basado en reposición del período seleccionado (ideal: última semana). Máx. 10 ítems por categoría.";

  const invAvail = resumen.estimacion_inversion_disponible === true;
  const invVal = resumen.estimacion_inversion;
  const invLine =
    invAvail && invVal != null
      ? `<div><strong>Estimación inversión (costo registrado):</strong> ${currency(invVal)}</div>`
      : '<div><strong>Estimación inversión:</strong> sin costo en productos para calcular.</div>';

  const top5 = Array.isArray(resumen.top_5_productos_criticos) ? resumen.top_5_productos_criticos : [];
  const top5Html =
    top5.length > 0
      ? `<div><strong>Top críticos:</strong> ${top5
          .map((t) => `${t.product_name || "—"} (${number(t.cantidad_comprar)} u.)`)
          .join(" · ")}</div>`
      : "";

  els.weeklyPlanResumen.innerHTML = `
    <div><strong>Unidades a comprar:</strong> ${number(totalU)}</div>
    <div><strong>Productos distintos:</strong> ${number(nProd)}</div>
    ${top5Html}
    ${invLine}
  `;

  const listHtml = (rows, renderRow) => {
    if (!rows.length) return '<div class="empty">Nada en esta categoría.</div>';
    return `<ul class="weekly-plan-list">${rows.map(renderRow).join("")}</ul>`;
  };

  els.weeklyPlanUrgente.innerHTML = `
    <h3>🔴 Comprar YA</h3>
    ${listHtml(urgente, (r) => {
      const q = Math.round(Number(r.cantidad_comprar || 0));
      return `<li><strong>${r.product_name || "—"}</strong> → ${number(q)} u.</li>`;
    })}
  `;

  els.weeklyPlanRecomendada.innerHTML = `
    <h3>🟡 Comprar (recomendado)</h3>
    ${listHtml(recomendada, (r) => {
      const q = Math.round(Number(r.cantidad_comprar || 0));
      return `<li><strong>${r.product_name || "—"}</strong> → ${number(q)} u.</li>`;
    })}
  `;

  els.weeklyPlanNoComprar.innerHTML = `
    <h3>⚠️ No comprar</h3>
    ${listHtml(noComprar, (r) => {
      const st = Number(r.sell_through || 0);
      return `<li><strong>${r.product_name || "—"}</strong> (sobrestock, sell-through ${(st * 100).toFixed(1)}%)</li>`;
    })}
  `;
}

function renderSuggestedSupplierOrders(data) {
  const d = data && typeof data === "object" ? data : {};
  const proveedores = Array.isArray(d.proveedores) ? d.proveedores : [];

  if (!proveedores.length) {
    els.suggestedSupplierOrdersSection.style.display = "none";
    return;
  }

  els.suggestedSupplierOrdersSection.style.display = "block";
  els.suggestedSupplierHint.textContent =
    "Agrupado por proveedor del catálogo. Cantidades redondeadas a pack (MOQ). Máx. 5 proveedores.";

  els.suggestedSupplierOrdersList.innerHTML = proveedores
    .map((prov) => {
      const nombre = prov.supplier_name || "Proveedor";
      const critico = prov.prioridad === "alta";
      const productos = Array.isArray(prov.productos) ? prov.productos : [];
      const totalU = Number(prov.total_unidades || 0);
      const costo = prov.total_costo_estimado;
      const tieneCosto = costo != null && Number(costo) > 0;
      const costoLine = tieneCosto
        ? `<div><strong>Costo estimado:</strong> ${currency(costo)}</div>`
        : '<div><strong>Costo estimado:</strong> sin costo cargado</div>';

      const lista =
        productos.length > 0
          ? `<ul class="weekly-plan-list">${productos
              .map((p) => {
                const q = Math.round(Number(p.cantidad_final ?? p.cantidad_comprar ?? 0));
                const badge = p.origen === "urgente" ? " 🔴" : "";
                return `<li><strong>${p.product_name || "—"}</strong>${badge} → ${number(q)} u.</li>`;
              })
              .join("")}</ul>`
          : '<div class="empty">Sin líneas.</div>';

      return `
        <div class="supplier-order-card ${critico ? "critical" : ""}">
          <h3>${critico ? "🔴 " : ""}${nombre}</h3>
          <div class="supplier-order-meta">
            <div><strong>Total:</strong> ${number(totalU)} unidades</div>
            ${costoLine}
          </div>
          ${lista}
        </div>
      `;
    })
    .join("");
}

function renderLearningSystem(data) {
  const items = generateLearningAdjustments(data);
  if (!items.length) {
    els.learningSystemSection.style.display = "none";
    els.learningSystemList.innerHTML = '<div class="empty">Sin ajustes sugeridos.</div>';
    return;
  }

  els.learningSystemSection.style.display = "block";
  els.learningSystemList.innerHTML = items
    .map((item) => {
      const style = getAlertStyle(item.type);
      const motivo = item.motivo ? `<div style="font-size:12px;opacity:.85;margin-top:4px;">${item.motivo}</div>` : "";
      return `<div class="metrics-v2-alert" style="background:${style.background};border-color:${style.border};color:${style.text};margin-bottom:8px;">${item.message}${motivo}</div>`;
    })
    .join("");
}

function getAlertStyle(type) {
  if (type === "critical") {
    return {
      background: "#fee2e2",
      border: "#ef4444",
      text: "#991b1b",
    };
  }
  if (type === "positive") {
    return {
      background: "#dcfce7",
      border: "#16a34a",
      text: "#166534",
    };
  }
  return {
    background: "#fff7cc",
    border: "#f59e0b",
    text: "#7c4a03",
  };
}

function renderAlerts(payload, productAlertsPayload, replenishmentPayload, replenishmentEffectivenessPayload) {
  const normalized = normalizeComparePayload(payload);
  const replenishmentAlerts = generateReplenishmentInsights(replenishmentPayload);
  const learningAlerts = generateLearningAdjustments(replenishmentEffectivenessPayload);
  const replenishmentFeedbackAlerts = generateReplenishmentFeedback(replenishmentEffectivenessPayload);
  const productAlerts = generateProductAlerts(productAlertsPayload);
  const baseAlerts = generateAlerts(normalized.current);
  const comparativeAlerts = generateComparativeAlerts(normalized.current, normalized.previous);
  const merged = [...learningAlerts, ...replenishmentFeedbackAlerts, ...replenishmentAlerts, ...productAlerts, ...comparativeAlerts, ...baseAlerts]
    .sort((a, b) => a.priority - b.priority)
    .slice(0, 4);

  const alerts = merged;
  if (!alerts.length) {
    els.alerts.style.display = "none";
    els.alerts.innerHTML = "";
    return;
  }
  els.alerts.innerHTML = alerts
    .map((alert) => {
      const style = getAlertStyle(alert.type);
      return `<div class="metrics-v2-alert" style="background:${style.background};border-color:${style.border};color:${style.text}">${alert.message}</div>`;
    })
    .join("");
  els.alerts.style.display = "flex";
}

function renderAll(payload) {
  const d = normalizePayload(payload);

  renderKpiGrid(els.kpiNegocio, [
    { label: "Ventas Netas", value: currency(d.ventas_netas), primary: true },
    { label: "Pedidos Enviados", value: number(d.pedidos_enviados) },
    { label: "Ticket Promedio", value: currency(d.ticket_promedio) },
    { label: "Clientes Nuevos", value: number(d.clientes_nuevos) },
    { label: "Clientes Recurrentes", value: number(d.clientes_recurrentes) },
  ]);

  renderKpiGrid(els.kpiOperacion, [
    { label: "Pedidos Activos", value: number(d.pedidos_activos) },
    { label: "Pedidos Apartados", value: number(d.pedidos_apartados) },
    { label: "Pedidos Cerrados", value: number(d.pedidos_cerrados) },
    { label: "Pedidos Cancelados", value: number(d.pedidos_cancelados) },
    { label: "Pedidos Devueltos", value: number(d.pedidos_devueltos) },
    { label: "Tasa de Cancelación", value: percent(d.tasa_cancelacion) },
    { label: "Tasa de Devolución", value: percent(d.tasa_devolucion) },
    { label: "Tiempo Promedio Cierre", value: hours(d.tiempo_promedio_cierre) },
  ]);

  renderKpiGrid(els.kpiComportamiento, [
    { label: "Clientes Totales", value: number(d.clientes_totales) },
    { label: "Clientes que Volvieron", value: number(d.clientes_que_volvieron) },
    { label: "Frecuencia Compra Promedio", value: Number(d.frecuencia_compra_promedio || 0).toFixed(2) },
  ]);

  renderTable(
    els.tableTopProductos,
    [
      { label: "Producto", render: (r) => r.product_name || "-" },
      { label: "Unidades", right: true, render: (r) => number(r.units_neta) },
      { label: "Revenue", right: true, render: (r) => currency(r.revenue_neta) },
    ],
    Array.isArray(d.top_productos) ? d.top_productos : []
  );

  renderTable(
    els.tableTopVariantes,
    [
      { label: "SKU", render: (r) => r.sku || "-" },
      { label: "Color", render: (r) => r.color || "-" },
      { label: "Talle", render: (r) => r.talle || "-" },
      { label: "Unidades", right: true, render: (r) => number(r.units_neta) },
      { label: "Revenue", right: true, render: (r) => currency(r.revenue_neta) },
    ],
    Array.isArray(d.top_variantes) ? d.top_variantes : []
  );

  renderTable(
    els.tableTopTalles,
    [
      { label: "Talle", render: (r) => r.talle || "-" },
      { label: "Unidades", right: true, render: (r) => number(r.units_neta) },
      { label: "Revenue", right: true, render: (r) => currency(r.revenue_neta) },
    ],
    Array.isArray(d.top_talles) ? d.top_talles : []
  );
}

async function loadMetrics() {
  const fromDate = els.from.value;
  const toDate = els.to.value;

  if (!fromDate || !toDate) {
    setStatus("Seleccioná ambas fechas.", true);
    return;
  }
  if (fromDate > toDate) {
    setStatus("El rango de fechas no es válido.", true);
    return;
  }

  setLoading(true);
  setStatus("Consultando métricas...");
  updateDateContext();
  renderAllSkeletons();

  try {
    const [
      { data: compareData, error: compareError },
      { data: productData, error: productError },
      { data: replenishmentData, error: replenishmentError },
      { data: replenishmentEffectivenessData, error: replenishmentEffectivenessError },
      { data: weeklyPlanData, error: weeklyPlanError },
      { data: purchaseBySupplierData, error: purchaseBySupplierError },
    ] = await Promise.all([
      supabase.rpc("metrics_dashboard_compare", {
        p_from: fromDate,
        p_to: toDate,
      }),
      supabase.rpc("metrics_product_alerts", {
        p_from: fromDate,
        p_to: toDate,
      }),
      supabase.rpc("metrics_replenishment", {
        p_from: fromDate,
        p_to: toDate,
      }),
      supabase.rpc("metrics_replenishment_effectiveness", {
        p_from: fromDate,
        p_to: toDate,
      }),
      supabase.rpc("metrics_weekly_purchase_plan", {
        p_from: fromDate,
        p_to: toDate,
      }),
      supabase.rpc("metrics_purchase_by_supplier", {
        p_from: fromDate,
        p_to: toDate,
      }),
    ]);

    if (compareError) throw compareError;
    if (productError) throw productError;
    if (replenishmentError) throw replenishmentError;
    if (replenishmentEffectivenessError) throw replenishmentEffectivenessError;
    if (weeklyPlanError) throw weeklyPlanError;
    if (purchaseBySupplierError) throw purchaseBySupplierError;
    const normalized = normalizeComparePayload(compareData || {});
    renderAll(normalized.current || {});
    renderAlerts(normalized, productData || {}, replenishmentData || {}, replenishmentEffectivenessData || {});
    renderReplenishmentFeedback(replenishmentEffectivenessData || {});
    renderLearningSystem(replenishmentEffectivenessData || {});
    renderWeeklyPurchasePlan(weeklyPlanData || {});
    renderSuggestedSupplierOrders(purchaseBySupplierData || {});
    setStatus(`Actualizado: ${new Date().toLocaleTimeString("es-AR")}`);
  } catch (err) {
    console.error("Error cargando metrics_dashboard_compare:", err);
    setStatus(`Error: ${err.message || "No se pudieron cargar métricas."}`, true);
    els.alerts.style.display = "none";
    els.alerts.innerHTML = "";
    els.kpiNegocio.innerHTML = '<div class="empty">No hay movimiento en este rango.</div>';
    els.kpiOperacion.innerHTML = '<div class="empty">No hay movimiento en este rango.</div>';
    els.kpiComportamiento.innerHTML = '<div class="empty">Sin ventas en este período.</div>';
    els.tableTopProductos.innerHTML = '<div class="empty">Sin datos de productos.</div>';
    els.tableTopVariantes.innerHTML = '<div class="empty">Sin datos de productos.</div>';
    els.tableTopTalles.innerHTML = '<div class="empty">Sin datos de productos.</div>';
    els.replenishmentFeedbackSection.style.display = "none";
    els.learningSystemSection.style.display = "none";
    els.weeklyPurchasePlanSection.style.display = "none";
    els.suggestedSupplierOrdersSection.style.display = "none";
  } finally {
    setLoading(false);
  }
}

function setupTabs() {
  els.tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const panelId = tab.dataset.panel;
      els.tabs.forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");

      Object.entries(els.panels).forEach(([key, panel]) => {
        panel.classList.toggle("active", key === panelId);
      });
    });
  });
}

async function init() {
  const user = await requireAuth();
  if (!user) return;

  initDefaultDates();
  updateDateContext();
  setupTabs();
  els.refresh.addEventListener("click", loadMetrics);
  els.from.addEventListener("change", updateDateContext);
  els.to.addEventListener("change", updateDateContext);

  await loadMetrics();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
