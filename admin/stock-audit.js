import { requireAuth } from "./admin-auth.js";
import { supabase } from "../scripts/supabase-client.js";
import { checkPermission } from "./permissions-helper.js";

await requireAuth();

const PAGE = {
  anomalies: 200,
  snapshot: 200,
  signals: 100,
  timeline: 200,
};

const LIMITS = {
  anomalies: PAGE.anomalies,
  snapshot: PAGE.snapshot,
  signals: PAGE.signals,
  timeline: PAGE.timeline,
};

const $ = (id) => document.getElementById(id);

const els = {
  fAnomalyType: $("f-anomaly-type"),
  fSearch: $("f-search"),
  fWarehouse: $("f-warehouse"),
  fSeverity: $("f-severity"),
  fTraceStatus: $("f-trace-status"),
  fReference: $("f-reference"),
  fDateFrom: $("f-date-from"),
  fDateTo: $("f-date-to"),
  fDeltaOnly: $("f-delta-only"),
  fLegacyOnly: $("f-legacy-only"),
  btnApply: $("btn-apply-filters"),
  btnReset: $("btn-reset-filters"),

  btnReloadSummary: $("btn-reload-summary"),
  btnReloadAnomalies: $("btn-reload-anomalies"),
  btnReloadSnapshot: $("btn-reload-snapshot"),
  btnReloadSignals: $("btn-reload-signals"),
  btnReconcileStock: $("btn-reconcile-stock"),
  btnExportAnomalies: $("btn-export-anomalies"),
  btnExportSnapshot: $("btn-export-snapshot"),
  btnExportSignals: $("btn-export-signals"),
  btnMoreAnomalies: $("btn-more-anomalies"),
  btnMoreSnapshot: $("btn-more-snapshot"),
  btnMoreSignals: $("btn-more-signals"),

  kpiCritical: $("kpi-critical"),
  kpiWarning: $("kpi-warning"),
  kpiReview: $("kpi-review"),
  kpiVariants: $("kpi-variants"),

  summaryStatus: $("summary-status"),
  anomaliesStatus: $("anomalies-status"),
  snapshotStatus: $("snapshot-status"),
  signalsStatus: $("signals-status"),
  summaryError: $("summary-error"),
  anomaliesError: $("anomalies-error"),
  snapshotError: $("snapshot-error"),
  signalsError: $("signals-error"),
  timelineError: $("timeline-error"),
  anomaliesBody: $("anomalies-body"),
  snapshotBody: $("snapshot-body"),
  signalsBody: $("signals-body"),
  timelineBody: $("timeline-body"),
  timelineStatus: $("timeline-status"),
  healthBanner: $("health-banner"),
  healthMain: $("health-main"),
  healthMeta: $("health-meta"),
  footerNote: $("footer-note"),

  btnModeOps: $("btn-mode-ops"),
  btnModeAdvanced: $("btn-mode-advanced"),

  opsUpdatedAt: $("ops-updated-at"),
  opsGoCard: $("ops-go-card"),
  opsGoValue: $("ops-go-value"),
  opsGoHint: $("ops-go-hint"),
  opsStructuralCard: $("ops-structural-card"),
  opsStructuralValue: $("ops-structural-value"),
  opsCriticalCard: $("ops-critical-card"),
  opsCriticalValue: $("ops-critical-value"),
  opsTriggerCard: $("ops-trigger-card"),
  opsTriggerValue: $("ops-trigger-value"),
  opsSummaryText: $("ops-summary-text"),
  opsNextAction: $("ops-next-action"),
};

const state = {
  loading: { summary: false, anomalies: false, snapshot: false, signals: false },
  rows: { anomalies: [], snapshot: [], signals: [] },
  timelineRows: [],
  filters: {},
  health: null,
  canEdit: false,
  selectedVariantId: null,
  lastLoadedAt: null,
  mode: "ops",
};

function setMode(mode = "ops") {
  state.mode = mode === "advanced" ? "advanced" : "ops";
  const showAdvanced = state.mode === "advanced";
  document.querySelectorAll(".advanced-only").forEach((el) => {
    el.classList.toggle("hidden", !showAdvanced);
  });
  els.btnModeOps?.classList.toggle("active", !showAdvanced);
  els.btnModeAdvanced?.classList.toggle("active", showAdvanced);
}

function setDefaultDates() {
  const now = new Date();
  const to = now.toISOString().slice(0, 10);
  const fromDate = new Date(now);
  fromDate.setDate(fromDate.getDate() - 30);
  const from = fromDate.toISOString().slice(0, 10);
  els.fDateFrom.value = from;
  els.fDateTo.value = to;
}

function normalizeText(value) {
  return String(value || "").trim().toLowerCase();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function buildSearchLink(basePath, term) {
  const q = String(term || "").trim();
  if (!q) return basePath;
  return `${basePath}?search=${encodeURIComponent(q)}`;
}

function renderProductLinks(row) {
  const name = escapeHtml(row.product_name || "-");
  const skuRaw = row.variant_sku || row.variant_id || "-";
  const sku = escapeHtml(skuRaw);
  const stockLink = buildSearchLink("./stock.html", row.variant_sku || row.variant_id || row.product_name);
  const productsLink = buildSearchLink("./products.html", row.variant_sku || row.product_name);
  return {
    productHtml: `<a class="link-cell" href="${stockLink}" target="_blank" rel="noopener noreferrer" title="Abrir en stock">${name}</a>`,
    variantHtml: `<a class="link-cell" href="${productsLink}" target="_blank" rel="noopener noreferrer" title="Abrir en productos">${sku}</a>`,
    variantLabel: skuRaw,
  };
}

function getFilters() {
  return {
    anomalyType: els.fAnomalyType.value.trim(),
    search: els.fSearch.value.trim(),
    warehouse: els.fWarehouse.value.trim(),
    severity: els.fSeverity.value.trim(),
    traceStatus: els.fTraceStatus.value.trim(),
    reference: els.fReference.value.trim(),
    dateFrom: els.fDateFrom.value || null,
    dateTo: els.fDateTo.value || null,
    deltaOnly: !!els.fDeltaOnly.checked,
    legacyOnly: !!els.fLegacyOnly.checked,
  };
}

function severityBadge(severity) {
  const v = normalizeText(severity);
  if (v === "critical") return `<span class="badge sev-critical">critical</span>`;
  if (v === "warning") return `<span class="badge sev-warning">warning</span>`;
  return `<span class="badge sev-review">review</span>`;
}

function traceBadge(traceStatus) {
  const v = normalizeText(traceStatus);
  if (v === "exact") return `<span class="badge trace-exact">exact</span>`;
  if (v === "partial") return `<span class="badge trace-partial">partial</span>`;
  if (v === "legacy") return `<span class="badge trace-legacy">legacy</span>`;
  return `<span class="badge trace-insufficient">insufficient</span>`;
}

function formatDelta(value) {
  const n = Number(value || 0);
  if (n > 0) return `<span class="delta-pos">${n}</span>`;
  if (n < 0) return `<span class="delta-neg">${n}</span>`;
  return `${n}`;
}

function resetErrors() {
  els.summaryError.textContent = "";
  els.anomaliesError.textContent = "";
  els.snapshotError.textContent = "";
  els.signalsError.textContent = "";
  els.timelineError.textContent = "";
}

function setStatus(block, text) {
  if (block === "summary") els.summaryStatus.textContent = text;
  if (block === "anomalies") els.anomaliesStatus.textContent = text;
  if (block === "snapshot") els.snapshotStatus.textContent = text;
  if (block === "signals") els.signalsStatus.textContent = text;
  if (block === "timeline") els.timelineStatus.textContent = text;
}

function setError(block, error) {
  const message = error?.message || String(error || "Error desconocido");
  if (block === "summary") els.summaryError.textContent = message;
  if (block === "anomalies") els.anomaliesError.textContent = message;
  if (block === "snapshot") els.snapshotError.textContent = message;
  if (block === "signals") els.signalsError.textContent = message;
  if (block === "timeline") els.timelineError.textContent = message;
}

function parseSearchMatch(row, search) {
  if (!search) return true;
  const q = normalizeText(search);
  const haystack = [
    row.product_name,
    row.variant_sku,
    row.variant_id,
    row.reference_label,
    row.reference_id,
    row.parent_reference_id,
  ].map(normalizeText).join(" ");
  return haystack.includes(q);
}

function parseReferenceMatch(row, reference) {
  if (!reference) return true;
  const q = normalizeText(reference);
  const haystack = [
    row.reference_label,
    row.reference_id,
    row.parent_reference_id,
  ].map(normalizeText).join(" ");
  return haystack.includes(q);
}

async function fetchAnomalyViews(filters) {
  const requests = [];
  if (!filters.anomalyType || filters.anomalyType === "variant_sizes_vs_sum_size_warehouse") {
    requests.push(
      supabase
        .from("vw_stock_audit_variant_sizes_diff")
        .select("*")
        .limit(LIMITS.anomalies)
    );
  }
  if (!filters.anomalyType || filters.anomalyType === "variant_warehouse_vs_sum_size_rows") {
    requests.push(
      supabase
        .from("vw_stock_audit_variant_warehouse_diff")
        .select("*")
        .limit(LIMITS.anomalies)
    );
  }
  if (!filters.anomalyType || filters.anomalyType === "orphan_size_row_missing_variant_sizes") {
    requests.push(
      supabase
        .from("vw_stock_audit_orphan_size_rows")
        .select("*")
        .limit(LIMITS.anomalies)
    );
  }

  const results = await Promise.all(requests);
  const rows = [];
  for (const r of results) {
    if (r.error) throw r.error;
    rows.push(...(r.data || []));
  }
  return rows;
}

function mapAnomalies(rawRows) {
  return rawRows.map((row) => {
    const anomalyType = row.anomaly_type || "unknown";
    if (anomalyType === "variant_sizes_vs_sum_size_warehouse") {
      return {
        ...row,
        severity: "critical",
        expected_value: Number(row.sum_size_warehouse_qty || 0),
        actual_value: Number(row.variant_sizes_qty || 0),
        delta: Number(row.delta || 0),
      };
    }
    if (anomalyType === "variant_warehouse_vs_sum_size_rows") {
      return {
        ...row,
        severity: "critical",
        size: row.size || null,
        expected_value: Number(row.sum_from_size_rows || 0),
        actual_value: Number(row.variant_warehouse_qty || 0),
        delta: Number(row.delta || 0),
      };
    }
    if (anomalyType === "orphan_size_row_missing_variant_sizes") {
      return {
        ...row,
        severity: "warning",
        expected_value: 0,
        actual_value: Number(row.size_wh_qty || 0),
        delta: Number(row.size_wh_qty || 0),
      };
    }
    return {
      ...row,
      severity: "review",
      expected_value: 0,
      actual_value: 0,
      delta: 0,
    };
  });
}

function applyAnomalyFilters(rows, filters) {
  return rows.filter((row) => {
    if (filters.warehouse && normalizeText(row.warehouse_code) !== normalizeText(filters.warehouse)) return false;
    if (filters.severity && normalizeText(row.severity) !== normalizeText(filters.severity)) return false;
    if (filters.deltaOnly && Number(row.delta || 0) === 0) return false;
    if (!parseSearchMatch(row, filters.search)) return false;
    return true;
  });
}

function bindTimelineButtons() {
  document.querySelectorAll(".js-variant-timeline").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      const variantId = btn.getAttribute("data-variant-id");
      if (variantId) showVariantTimeline(variantId);
    });
  });
}

function renderAnomalies(rows) {
  if (!rows.length) {
    els.anomaliesBody.innerHTML = `<tr><td colspan="9" class="muted">Sin resultados para los filtros actuales.</td></tr>`;
    return;
  }
  els.anomaliesBody.innerHTML = rows.map((r) => {
    const links = renderProductLinks(r);
    return `
    <tr>
      <td>${severityBadge(r.severity)}</td>
      <td>${escapeHtml(r.anomaly_type || "-")}</td>
      <td title="${escapeHtml(r.product_name || "")}">${links.productHtml}</td>
      <td>
        ${links.variantHtml}
        <button class="btn-small js-variant-timeline" data-variant-id="${escapeHtml(r.variant_id || "")}">Timeline</button>
      </td>
      <td>${escapeHtml(r.size || "-")}</td>
      <td>${escapeHtml(r.warehouse_code || "-")}</td>
      <td class="num">${r.expected_value ?? "-"}</td>
      <td class="num">${r.actual_value ?? "-"}</td>
      <td class="num">${formatDelta(r.delta)}</td>
    </tr>
  `;
  }).join("");
  bindTimelineButtons();
}

async function loadAnomalies() {
  state.loading.anomalies = true;
  setStatus("anomalies", "Cargando inconsistencias...");
  setError("anomalies", "");
  try {
    const raw = await fetchAnomalyViews(state.filters);
    const mapped = mapAnomalies(raw);
    const filtered = applyAnomalyFilters(mapped, state.filters);
    state.rows.anomalies = filtered;
    renderAnomalies(filtered);
    setStatus("anomalies", `Mostrando ${filtered.length} filas (límite actual ${LIMITS.anomalies}).`);
  } catch (error) {
    setError("anomalies", error);
    setStatus("anomalies", "No se pudo cargar el bloque.");
  } finally {
    state.loading.anomalies = false;
  }
}

function applySnapshotFilters(rows, filters) {
  return rows.filter((row) => {
    if (filters.warehouse && normalizeText(row.warehouse_code) !== normalizeText(filters.warehouse)) return false;
    if (filters.deltaOnly && Number(row.delta_variant_sizes_vs_row || 0) === 0 && Number(row.delta_variant_warehouse_vs_sum_by_wh || 0) === 0) return false;
    if (!parseSearchMatch(row, filters.search)) return false;
    return true;
  });
}

function renderSnapshot(rows) {
  if (!rows.length) {
    els.snapshotBody.innerHTML = `<tr><td colspan="9" class="muted">Sin resultados para los filtros actuales.</td></tr>`;
    return;
  }
  els.snapshotBody.innerHTML = rows.map((r) => {
    const links = renderProductLinks(r);
    return `
    <tr>
      <td title="${escapeHtml(r.product_name || "")}">${links.productHtml}</td>
      <td>
        ${links.variantHtml}
        <button class="btn-small js-variant-timeline" data-variant-id="${escapeHtml(r.variant_id || "")}">Timeline</button>
      </td>
      <td>${escapeHtml(r.size || "-")}</td>
      <td>${escapeHtml(r.warehouse_code || "-")}</td>
      <td class="num">${Number(r.size_wh_qty || 0)}</td>
      <td class="num">${Number(r.variant_sizes_qty || 0)}</td>
      <td class="num">${Number(r.variant_warehouse_qty || 0)}</td>
      <td class="num">${formatDelta(r.delta_variant_sizes_vs_row)}</td>
      <td class="num">${formatDelta(r.delta_variant_warehouse_vs_sum_by_wh)}</td>
    </tr>
  `;
  }).join("");
  bindTimelineButtons();
}

async function loadSnapshot() {
  state.loading.snapshot = true;
  setStatus("snapshot", "Cargando snapshot...");
  setError("snapshot", "");
  try {
    let query = supabase
      .from("vw_stock_audit_snapshot")
      .select("*")
      .limit(LIMITS.snapshot);

    if (state.filters.warehouse) query = query.eq("warehouse_code", state.filters.warehouse);
    if (state.filters.search) {
      const q = state.filters.search.replace(/,/g, " ");
      query = query.or(`product_name.ilike.%${q}%,variant_sku.ilike.%${q}%`);
    }

    const { data, error } = await query;
    if (error) throw error;
    const filtered = applySnapshotFilters(data || [], state.filters);
    state.rows.snapshot = filtered;
    renderSnapshot(filtered);
    setStatus("snapshot", `Mostrando ${filtered.length} filas (límite actual ${LIMITS.snapshot}).`);
  } catch (error) {
    setError("snapshot", error);
    setStatus("snapshot", "No se pudo cargar el bloque.");
  } finally {
    state.loading.snapshot = false;
  }
}

function applySignalsFilters(rows, filters) {
  return rows.filter((row) => {
    if (filters.warehouse && normalizeText(row.warehouse_code) !== normalizeText(filters.warehouse)) return false;
    if (filters.severity && normalizeText(row.severity) !== normalizeText(filters.severity)) return false;
    if (filters.traceStatus && normalizeText(row.trace_status) !== normalizeText(filters.traceStatus)) return false;
    if (filters.legacyOnly) {
      const isLegacy = normalizeText(row.trace_status) === "legacy" || normalizeText(row.trace_reason).includes("legacy") || normalizeText(row.trace_reason).includes("fallback");
      if (!isLegacy) return false;
    }
    if (!parseSearchMatch(row, filters.search)) return false;
    if (!parseReferenceMatch(row, filters.reference)) return false;
    return true;
  });
}

function renderSignals(rows) {
  if (!rows.length) {
    els.signalsBody.innerHTML = `<tr><td colspan="11" class="muted">Sin resultados para los filtros actuales.</td></tr>`;
    return;
  }
  els.signalsBody.innerHTML = rows.map((r) => `
    <tr>
      <td>${severityBadge(r.severity)}</td>
      <td>${traceBadge(r.trace_status)}</td>
      <td>${escapeHtml(r.signal_source || "-")}</td>
      <td title="${escapeHtml(r.reference_label || "")}">${escapeHtml(r.reference_label || "-")}</td>
      <td>${escapeHtml(r.document_status || "-")}</td>
      <td>${r.event_at ? new Date(r.event_at).toLocaleString("es-AR") : "-"}</td>
      <td><button class="btn-small js-variant-timeline" data-variant-id="${escapeHtml(r.variant_id || "")}">${escapeHtml(r.variant_sku || r.variant_id || "-")}</button></td>
      <td>${escapeHtml(r.size || "-")}</td>
      <td>${escapeHtml(r.warehouse_code || "-")}</td>
      <td class="num">${Number(r.qty || 0)}</td>
      <td>${escapeHtml(r.trace_reason || "-")}</td>
    </tr>
  `).join("");
  bindTimelineButtons();
}

async function loadSignals() {
  state.loading.signals = true;
  setStatus("signals", "Cargando señales...");
  setError("signals", "");
  try {
    let query = supabase
      .from("vw_stock_audit_reference_signals")
      .select("*")
      .order("event_at", { ascending: false })
      .limit(LIMITS.signals);

    if (state.filters.dateFrom) query = query.gte("event_at", `${state.filters.dateFrom}T00:00:00`);
    if (state.filters.dateTo) query = query.lte("event_at", `${state.filters.dateTo}T23:59:59`);
    if (state.filters.warehouse) query = query.eq("warehouse_code", state.filters.warehouse);
    if (state.filters.severity) query = query.eq("severity", state.filters.severity);
    if (state.filters.traceStatus) query = query.eq("trace_status", state.filters.traceStatus);
    if (state.filters.reference) {
      const q = state.filters.reference.replace(/,/g, " ");
      query = query.ilike("reference_label", `%${q}%`);
    }
    if (state.filters.search) {
      const q = state.filters.search.replace(/,/g, " ");
      query = query.or(`reference_label.ilike.%${q}%,trace_reason.ilike.%${q}%`);
    }

    const { data, error } = await query;
    if (error) throw error;
    const filtered = applySignalsFilters(data || [], state.filters);
    state.rows.signals = filtered;
    renderSignals(filtered);
    setStatus("signals", `Mostrando ${filtered.length} filas (límite actual ${LIMITS.signals}).`);
  } catch (error) {
    setError("signals", error);
    setStatus("signals", "No se pudo cargar el bloque.");
  } finally {
    state.loading.signals = false;
  }
}

function renderSummary() {
  const health = state.health || {};
  const critical = Number(health.variant_sizes_diffs || 0)
    + Number(health.variant_warehouse_diffs || 0)
    + Number(health.critical_signals || 0);
  const warning = Number(health.orphan_rows || 0) + Number(health.warning_signals || 0);
  const review = Number(health.review_signals || 0);
  const variants = Number(health.affected_variants || 0);
  els.kpiCritical.textContent = String(critical);
  els.kpiWarning.textContent = String(warning);
  els.kpiReview.textContent = String(review);
  els.kpiVariants.textContent = String(variants);

  const dateInfo = state.filters.dateFrom && state.filters.dateTo
    ? `Señales entre ${state.filters.dateFrom} y ${state.filters.dateTo}.`
    : "Señales sin rango explícito.";
  const decision = String(health.release_decision || "").toLowerCase();
  const gateLabel = decision === "go" ? "GO" : "NO-GO";
  els.summaryStatus.textContent = `${dateInfo} KPIs calculados desde SQL (${health.release_decision ? "vw_stock_audit_release_gate" : "vw_stock_audit_health_score"}) · Gate: ${gateLabel}.`;
}

function renderHealthBanner() {
  const h = state.health;
  if (!h) return;
  const totalStructural = Number(h.variant_sizes_diffs || 0) + Number(h.variant_warehouse_diffs || 0) + Number(h.orphan_rows || 0);
  const allGood = totalStructural === 0 && Number(h.critical_signals || 0) === 0;
  const triggersOk = !!h.trigger_84_active && !!h.trigger_145_active;
  const gateReady = typeof h.go_live_ready === "boolean"
    ? h.go_live_ready
    : (allGood && triggersOk);
  const blockingReasons = Array.isArray(h.blocking_reasons)
    ? h.blocking_reasons.filter(Boolean)
    : [];

  els.healthBanner.classList.remove("health-banner-ok", "health-banner-warn", "health-banner-critical");
  if (!gateReady) {
    els.healthBanner.classList.add("health-banner-critical");
    els.healthMain.textContent = `Gate NO-GO: ${totalStructural} inconsistencias estructurales`;
  } else if (!allGood) {
    els.healthBanner.classList.add("health-banner-warn");
    els.healthMain.textContent = "Sin inconsistencias estructurales, revisar señales críticas";
  } else {
    els.healthBanner.classList.add("health-banner-ok");
    els.healthMain.textContent = "Gate GO: stock sincronizado y sin inconsistencias críticas";
  }

  const triggerText = triggersOk
    ? "Triggers 84 y 145 activos"
    : `ALERTA triggers: 84=${h.trigger_84_active ? "ok" : "faltante"}, 145=${h.trigger_145_active ? "ok" : "faltante"}`;
  const reasonsText = blockingReasons.length ? ` · Bloqueos: ${blockingReasons.join(", ")}` : "";
  els.healthMeta.textContent = `${triggerText} · Diffs talle=${h.variant_sizes_diffs || 0}, diffs depósito=${h.variant_warehouse_diffs || 0}, orphan=${h.orphan_rows || 0}, critical signals=${h.critical_signals || 0}${reasonsText}`;

  const showReconcile = state.canEdit && totalStructural > 0;
  els.btnReconcileStock.classList.toggle("hidden", !showReconcile);
}

function renderOpsPanel() {
  const h = state.health || {};
  const structural = Number(h.variant_sizes_diffs || 0) + Number(h.variant_warehouse_diffs || 0) + Number(h.orphan_rows || 0);
  const criticalSignals = Number(h.critical_signals || 0);
  const triggersOk = !!h.trigger_84_active && !!h.trigger_145_active;
  const decision = String(h.release_decision || "").toLowerCase();
  const goLive = typeof h.go_live_ready === "boolean"
    ? h.go_live_ready
    : decision
      ? decision === "go"
      : (structural === 0 && criticalSignals === 0 && triggersOk);

  const clearOpsCardClass = (el) => {
    el?.classList.remove("ops-ok", "ops-warn", "ops-bad");
  };
  [els.opsGoCard, els.opsStructuralCard, els.opsCriticalCard, els.opsTriggerCard].forEach(clearOpsCardClass);

  els.opsGoValue.textContent = goLive ? "GO" : "NO-GO";
  els.opsGoHint.textContent = goLive
    ? "Apto para lanzamiento según métricas actuales."
    : "No apto para lanzamiento hasta resolver bloqueadores.";
  els.opsGoCard.classList.add(goLive ? "ops-ok" : "ops-bad");

  els.opsStructuralValue.textContent = String(structural);
  els.opsStructuralCard.classList.add(structural === 0 ? "ops-ok" : (structural <= 5 ? "ops-warn" : "ops-bad"));

  els.opsCriticalValue.textContent = String(criticalSignals);
  els.opsCriticalCard.classList.add(criticalSignals === 0 ? "ops-ok" : "ops-bad");

  els.opsTriggerValue.textContent = triggersOk ? "OK" : "ALERTA";
  els.opsTriggerCard.classList.add(triggersOk ? "ops-ok" : "ops-bad");

  const measuredAt = h.measured_at ? new Date(h.measured_at).toLocaleString("es-AR") : null;
  const loadedAt = state.lastLoadedAt ? state.lastLoadedAt.toLocaleString("es-AR") : null;
  els.opsUpdatedAt.textContent = measuredAt
    ? `Health SQL: ${measuredAt}`
    : loadedAt
      ? `Última carga: ${loadedAt}`
      : "Sin datos";

  if (goLive) {
    els.opsSummaryText.textContent = "El stock está sincronizado en lo estructural y no hay señales críticas activas. Podés avanzar con control funcional final.";
    els.opsNextAction.textContent = "Ejecutá smoke test E2E (checkout, cancelación, devolución, void) y si permanece en GO, aprobar release.";
    return;
  }

  if (structural > 0) {
    els.opsSummaryText.textContent = `Hay ${structural} inconsistencias estructurales (diffs talle/deposito/huérfanos). Esto puede causar números distintos entre pantallas.`;
    els.opsNextAction.textContent = state.canEdit
      ? "Revisá bloque ‘Inconsistencias estructurales’, exportá CSV y ejecutá reconciliación solo después de validar causa."
      : "Pedí a un admin con permiso de edición que revise anomalías y ejecute reconciliación controlada.";
    return;
  }

  if (criticalSignals > 0) {
    els.opsSummaryText.textContent = `No hay diffs estructurales, pero existen ${criticalSignals} señales críticas de trazabilidad operativa.`;
    els.opsNextAction.textContent = "Entrá al bloque ‘Señales de trazabilidad’, filtrá severity=critical y resolvé cada referencia antes de liberar.";
    return;
  }

  if (!triggersOk) {
    els.opsSummaryText.textContent = "Falta al menos un trigger crítico de sincronización (84/145).";
    els.opsNextAction.textContent = "No lanzar hasta restaurar triggers 84 y 145; luego volver a medir health score.";
    return;
  }

  els.opsSummaryText.textContent = "Estado operativo indeterminado, revisar bloques avanzados para confirmar.";
  els.opsNextAction.textContent = "Recargá panel y verificá resumen/anomalías para definir acción.";
}

function renderTimeline(rows, variantId = null) {
  if (!rows.length) {
    els.timelineBody.innerHTML = `<tr><td colspan="8" class="muted">Sin eventos para la variante seleccionada.</td></tr>`;
    return;
  }
  els.timelineBody.innerHTML = rows.map((r) => `
    <tr>
      <td>${r.event_at ? new Date(r.event_at).toLocaleString("es-AR") : "-"}</td>
      <td>${escapeHtml(r.signal_source || "-")}</td>
      <td>${traceBadge(r.trace_status)}</td>
      <td title="${escapeHtml(r.reference_label || "")}">${escapeHtml(r.reference_label || "-")}</td>
      <td>${escapeHtml(r.warehouse_code || "-")}</td>
      <td>${escapeHtml(r.size || "-")}</td>
      <td class="num">${Number(r.qty || 0)}</td>
      <td>${escapeHtml(r.trace_reason || "-")}</td>
    </tr>
  `).join("");
  els.timelineStatus.textContent = variantId
    ? `Timeline de variante ${variantId}: ${rows.length} eventos`
    : `Timeline: ${rows.length} eventos`;
}

async function showVariantTimeline(variantId) {
  if (!variantId) return;
  state.selectedVariantId = variantId;
  setError("timeline", "");
  setStatus("timeline", `Cargando timeline de ${variantId}...`);
  try {
    let query = supabase
      .from("vw_stock_audit_reference_signals")
      .select("*")
      .eq("variant_id", variantId)
      .order("event_at", { ascending: false })
      .limit(LIMITS.timeline);

    if (state.filters.dateFrom) query = query.gte("event_at", `${state.filters.dateFrom}T00:00:00`);
    if (state.filters.dateTo) query = query.lte("event_at", `${state.filters.dateTo}T23:59:59`);
    const { data, error } = await query;
    if (error) throw error;
    state.timelineRows = data || [];
    renderTimeline(state.timelineRows, variantId);
  } catch (error) {
    setError("timeline", error);
    setStatus("timeline", "No se pudo cargar timeline.");
    renderTimeline([], variantId);
  }
}

function exportCSV(rows, filename) {
  if (!rows?.length) {
    alert("No hay datos para exportar.");
    return;
  }
  const keys = Array.from(
    rows.reduce((acc, row) => {
      Object.keys(row || {}).forEach((k) => acc.add(k));
      return acc;
    }, new Set())
  );
  const esc = (v) => `"${String(v ?? "").replaceAll("\"", "\"\"")}"`;
  const lines = [
    keys.join(","),
    ...rows.map((row) => keys.map((k) => esc(row[k])).join(",")),
  ];
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function reconcileStock() {
  if (!state.canEdit) return;
  if (!confirm("Esta acción reconciliará stock derivado desde variant_size_warehouse_stock. ¿Continuar?")) return;
  els.btnReconcileStock.disabled = true;
  const prevText = els.btnReconcileStock.textContent;
  els.btnReconcileStock.textContent = "Reconciliando...";
  try {
    const { data, error } = await supabase.rpc("rpc_reconcile_stock");
    if (error) throw error;
    const after = data?.after || {};
    alert(
      `Reconciliación completada.\n` +
      `Después: talla=${after.variant_sizes_diffs ?? "?"}, depósito=${after.variant_warehouse_diffs ?? "?"}, orphan=${after.orphan_rows ?? "?"}`
    );
    await loadAllInOrder();
  } catch (error) {
    alert(`Error al reconciliar stock: ${error?.message || error}`);
  } finally {
    els.btnReconcileStock.disabled = false;
    els.btnReconcileStock.textContent = prevText;
  }
}

async function fetchHealthGateOrFallback() {
  const gate = await supabase
    .from("vw_stock_audit_release_gate")
    .select("*")
    .limit(1)
    .maybeSingle();
  if (!gate.error && gate.data) return gate.data;

  const health = await supabase
    .from("vw_stock_audit_health_score")
    .select("*")
    .limit(1)
    .maybeSingle();
  if (health.error) throw health.error;
  return health.data || null;
}

async function loadSummaryOnly() {
  state.loading.summary = true;
  setStatus("summary", "Calculando resumen...");
  setError("summary", "");
  try {
    state.health = await fetchHealthGateOrFallback();
    renderSummary();
    renderHealthBanner();
    renderOpsPanel();
    setStatus("summary", "Resumen actualizado.");
  } catch (error) {
    setError("summary", error);
    setStatus("summary", "No se pudo calcular resumen.");
  } finally {
    state.loading.summary = false;
  }
}

async function loadAllInOrder() {
  state.lastLoadedAt = new Date();
  resetErrors();
  await loadSummaryOnly();
  await loadAnomalies();
  await loadSummaryOnly();
  await loadSnapshot();
  await loadSignals();
  if (state.selectedVariantId) {
    await showVariantTimeline(state.selectedVariantId);
  }
  await loadSummaryOnly();
  els.footerNote.textContent = `Última carga: ${state.lastLoadedAt.toLocaleString("es-AR")}. Cobertura V2: health score, export CSV, timeline y reconciliación controlada.`;
}

function resetLimits() {
  LIMITS.anomalies = PAGE.anomalies;
  LIMITS.snapshot = PAGE.snapshot;
  LIMITS.signals = PAGE.signals;
  LIMITS.timeline = PAGE.timeline;
}

function applyFiltersAndReload({ resetPage = true } = {}) {
  state.filters = getFilters();
  if (resetPage) resetLimits();
  loadAllInOrder().catch((err) => {
    setError("summary", err);
  });
}

function debounce(fn, ms = 300) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function bindEvents() {
  els.btnModeOps?.addEventListener("click", () => setMode("ops"));
  els.btnModeAdvanced?.addEventListener("click", () => setMode("advanced"));

  els.btnApply.addEventListener("click", () => applyFiltersAndReload({ resetPage: true }));
  els.btnReset.addEventListener("click", () => {
    els.fAnomalyType.value = "";
    els.fSearch.value = "";
    els.fWarehouse.value = "";
    els.fSeverity.value = "";
    els.fTraceStatus.value = "";
    els.fReference.value = "";
    els.fDeltaOnly.checked = true;
    els.fLegacyOnly.checked = false;
    setDefaultDates();
    applyFiltersAndReload({ resetPage: true });
  });

  const debouncedApply = debounce(() => applyFiltersAndReload({ resetPage: true }), 300);
  els.fSearch.addEventListener("input", debouncedApply);
  els.fReference.addEventListener("input", debouncedApply);
  els.fDateFrom.addEventListener("change", debouncedApply);
  els.fDateTo.addEventListener("change", debouncedApply);
  [els.fAnomalyType, els.fWarehouse, els.fSeverity, els.fTraceStatus, els.fDeltaOnly, els.fLegacyOnly]
    .forEach((el) => el.addEventListener("change", () => applyFiltersAndReload({ resetPage: true })));

  els.btnReloadSummary.addEventListener("click", () => loadSummaryOnly());
  els.btnReloadAnomalies.addEventListener("click", () => loadAnomalies().then(loadSummaryOnly));
  els.btnReloadSnapshot.addEventListener("click", () => loadSnapshot());
  els.btnReloadSignals.addEventListener("click", () => loadSignals().then(loadSummaryOnly));
  els.btnExportAnomalies.addEventListener("click", () => exportCSV(state.rows.anomalies, "stock-audit-anomalias.csv"));
  els.btnExportSnapshot.addEventListener("click", () => exportCSV(state.rows.snapshot, "stock-audit-snapshot.csv"));
  els.btnExportSignals.addEventListener("click", () => exportCSV(state.rows.signals, "stock-audit-signals.csv"));
  els.btnReconcileStock.addEventListener("click", reconcileStock);

  els.btnMoreAnomalies.addEventListener("click", async () => {
    LIMITS.anomalies += PAGE.anomalies;
    await loadAnomalies();
    await loadSummaryOnly();
  });
  els.btnMoreSnapshot.addEventListener("click", async () => {
    LIMITS.snapshot += PAGE.snapshot;
    await loadSnapshot();
  });
  els.btnMoreSignals.addEventListener("click", async () => {
    LIMITS.signals += PAGE.signals;
    await loadSignals();
    await loadSummaryOnly();
  });
}

async function init() {
  const canView = await checkPermission("stock-audit", "view");
  if (!canView) {
    alert("No tienes permiso para ver el módulo de auditoría de stock.");
    window.location.href = "./index.html";
    return;
  }
  state.canEdit = await checkPermission("stock-audit", "edit");
  setDefaultDates();
  setMode("ops");
  bindEvents();
  state.filters = getFilters();
  await loadAllInOrder();
}

init().catch((err) => {
  setError("summary", err);
  setStatus("summary", "Falló la inicialización.");
});
