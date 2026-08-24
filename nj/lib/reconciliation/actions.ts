"use server";

import { revalidatePath } from "next/cache";
import { getAdminContext, hasPermission } from "@/lib/auth/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { RECONCILIATION_PERMISSION_KEY } from "@/lib/reconciliation/constants";
import { loadMatchingPools } from "@/lib/reconciliation/candidate-pool";
import {
  matchRemittanceRows,
  type RemittanceMatchRow,
} from "@/lib/reconciliation/matching";
import { pickBestAlreadyUsedMatch, type AlreadyUsedMatch } from "@/lib/reconciliation/already-used-match";
import {
  loadOccupiedCodCandidates,
  loadOrderCodOccupancyMap,
} from "@/lib/reconciliation/already-used-loader";
import { searchCodOrdersForManualAssign } from "@/lib/reconciliation/manual-search";
import type { ManualOrderHit } from "@/lib/reconciliation/manual-search";
import { resolveEffectiveSent } from "@/lib/reconciliation/queries";
import {
  computeContentHash,
  parsePasteGrid,
  parseRemittanceDate,
  parseReportedTotal,
  totalDifference,
} from "@/lib/reconciliation/parsing";

export type CreateRemittanceInput = {
  transportId: string;
  remittanceDateText: string;
  reportedTotalText: string;
  pasteText: string;
  notes?: string;
  confirmTotalDifference?: boolean;
  confirmInternalDuplicates?: boolean;
  confirmSimilarRemittance?: boolean;
};

export type SimilarRemittance = {
  id: string;
  remittanceDate: string;
  rowCount: number;
  reportedTotal: number;
  calculatedTotal: number | null;
  contentHash: string | null;
  status: string;
  matchLevel: "exact_hash" | "same_header";
};

export type CreateRemittanceResult =
  | {
      ok: true;
      remittanceId: string;
      rowCount: number;
      calculatedTotal: number;
      totalDifference: number;
    }
  | {
      ok: false;
      code:
        | "forbidden"
        | "validation"
        | "needs_confirm_total"
        | "needs_confirm_duplicates"
        | "needs_confirm_similar"
        | "rpc_error";
      message: string;
      similar?: SimilarRemittance[];
      totalDifference?: number;
      duplicateCount?: number;
    };

async function requireEdit() {
  const ctx = await getAdminContext();
  if (!ctx || !hasPermission(ctx, RECONCILIATION_PERMISSION_KEY, "edit")) {
    return null;
  }
  return ctx;
}

/** Preview solo lectura: cliente del pedido antes de «Aprobar y recordar». Sin mutaciones. */
export type AliasLinkPreview = {
  orderId: string;
  orderNumber: string | null;
  customerId: string;
  customerName: string | null;
  customerNumber: string | null;
  orderSentDate: string | null;
  expectedAmount: number | null;
};

export async function previewAliasLinkForOrder(input: {
  orderId: string;
}): Promise<
  | { ok: true; preview: AliasLinkPreview }
  | { ok: false; code: "forbidden" | "not_found" | "rpc_error"; message: string }
> {
  const ctx = await requireEdit();
  if (!ctx) return { ok: false, code: "forbidden", message: "Sin permiso de edición." };

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("orders")
    .select(
      `
      id,
      order_number,
      total_amount,
      sent_at,
      closed_at,
      customer_id,
      customers (
        id,
        full_name,
        customer_number
      )
    `
    )
    .eq("id", input.orderId)
    .maybeSingle();

  if (error) {
    return { ok: false, code: "rpc_error", message: error.message };
  }
  if (!data?.customer_id) {
    return { ok: false, code: "not_found", message: "Pedido o cliente no encontrado." };
  }

  const customerRaw = data.customers;
  const customer = Array.isArray(customerRaw) ? customerRaw[0] ?? null : customerRaw;
  const effective = resolveEffectiveSent(
    data.sent_at as string | null,
    data.closed_at as string | null
  );
  const amount = Number(data.total_amount);
  const customerNumber =
    customer &&
    (customer as { customer_number?: string | number | null }).customer_number != null
      ? String((customer as { customer_number?: string | number | null }).customer_number)
      : null;

  return {
    ok: true,
    preview: {
      orderId: data.id as string,
      orderNumber: (data.order_number as string | null) ?? null,
      customerId: data.customer_id as string,
      customerName: (customer as { full_name?: string | null } | null)?.full_name ?? null,
      customerNumber,
      orderSentDate: effective?.effectiveSentDate ?? null,
      expectedAmount: Number.isFinite(amount) ? amount : null,
    },
  };
}

export async function findSimilarRemittances(input: {
  transportId: string;
  remittanceDateIso: string;
  rowCount: number;
  reportedTotal: number;
  contentHash: string;
}): Promise<SimilarRemittance[]> {
  const ctx = await getAdminContext();
  if (!ctx || !hasPermission(ctx, RECONCILIATION_PERMISSION_KEY, "view")) {
    return [];
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("cod_remittances")
    .select("id, remittance_date, row_count, reported_total, calculated_total, content_hash, status")
    .eq("transport_id", input.transportId)
    .eq("remittance_date", input.remittanceDateIso)
    .neq("status", "voided")
    .limit(20);

  if (error || !data) return [];

  const out: SimilarRemittance[] = [];
  for (const r of data) {
    const reported = Number(r.reported_total) || 0;
    const sameCounts =
      Number(r.row_count) === input.rowCount &&
      Math.abs(reported - input.reportedTotal) < 0.005;
    const exactHash =
      !!r.content_hash && r.content_hash === input.contentHash;

    if (!sameCounts && !exactHash) continue;

    out.push({
      id: r.id,
      remittanceDate: r.remittance_date,
      rowCount: Number(r.row_count) || 0,
      reportedTotal: reported,
      calculatedTotal: r.calculated_total != null ? Number(r.calculated_total) : null,
      contentHash: r.content_hash,
      status: r.status,
      matchLevel: exactHash ? "exact_hash" : "same_header",
    });
  }
  return out;
}

export async function createCodRemittanceDraft(
  input: CreateRemittanceInput
): Promise<CreateRemittanceResult> {
  const ctx = await requireEdit();
  if (!ctx) {
    return { ok: false, code: "forbidden", message: "No tenés permiso para crear rendiciones." };
  }

  if (!input.transportId?.trim()) {
    return { ok: false, code: "validation", message: "Elegí un transporte." };
  }

  const dateParsed = parseRemittanceDate(input.remittanceDateText);
  if (!dateParsed.ok) {
    return { ok: false, code: "validation", message: `Fecha de rendición: ${dateParsed.error}` };
  }

  const totalParsed = parseReportedTotal(input.reportedTotalText);
  if (!totalParsed.ok) {
    return { ok: false, code: "validation", message: `Total informado: ${totalParsed.error}` };
  }

  const grid = parsePasteGrid(input.pasteText);
  if (grid.validRows.length === 0) {
    return { ok: false, code: "validation", message: "Pegá al menos una fila válida." };
  }

  // Estrategia A: bloquear si hay inválidas
  if (grid.invalidRows.length > 0) {
    return {
      ok: false,
      code: "validation",
      message: `Hay ${grid.invalidRows.length} fila(s) inválida(s). Corregilas o elimínárlas antes de guardar.`,
    };
  }

  const dupCount = grid.validRows.filter((r) => r.isDuplicate).length;
  if (dupCount > 0 && !input.confirmInternalDuplicates) {
    return {
      ok: false,
      code: "needs_confirm_duplicates",
      message: `Hay ${dupCount} fila(s) marcadas como posible duplicado interno. Confirmá para guardar igual.`,
      duplicateCount: dupCount,
    };
  }

  const diff = totalDifference(grid.calculatedTotal, totalParsed.value);
  if (diff !== 0 && !input.confirmTotalDifference) {
    return {
      ok: false,
      code: "needs_confirm_total",
      message: `El total calculado difiere del informado (${diff > 0 ? "+" : ""}${diff}). Confirmá para guardar el borrador igual.`,
      totalDifference: diff,
    };
  }

  const contentHash = await computeContentHash(grid.contentHashInput);
  const similar = await findSimilarRemittances({
    transportId: input.transportId,
    remittanceDateIso: dateParsed.value,
    rowCount: grid.validRows.length,
    reportedTotal: totalParsed.value,
    contentHash,
  });

  if (similar.length > 0 && !input.confirmSimilarRemittance) {
    return {
      ok: false,
      code: "needs_confirm_similar",
      message:
        "Ya existe una rendición muy similar o posiblemente idéntica (mismo transporte/fecha y total o hash). Confirmá para continuar.",
      similar,
    };
  }

  const rowsPayload = grid.validRows.map((r) => ({
    row_index: r.rowIndex,
    raw_line: r.rawLine,
    raw_transport_date_text: r.rawTransportDateText,
    raw_customer_name_text: r.rawCustomerNameText,
    raw_amount_text: r.rawAmountText,
    parsed_transport_date: r.parsedTransportDate,
    parsed_amount: r.parsedAmount,
  }));

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("rpc_cod_create_remittance", {
    p_transport_id: input.transportId,
    p_remittance_date: dateParsed.value,
    p_reported_total: totalParsed.value,
    p_content_hash: contentHash,
    p_rows: rowsPayload,
    p_notes: input.notes?.trim() || null,
  });

  if (error) {
    return {
      ok: false,
      code: "rpc_error",
      message: error.message || "No se pudo guardar la rendición.",
    };
  }

  const payload = data as {
    ok?: boolean;
    remittance_id?: string;
    row_count?: number;
    calculated_total?: number;
  } | null;

  if (!payload?.ok || !payload.remittance_id) {
    return {
      ok: false,
      code: "rpc_error",
      message: "Respuesta inesperada al guardar la rendición.",
    };
  }

  revalidatePath("/admin/conciliacion-reembolso");
  revalidatePath("/admin/conciliacion-reembolso/remesas");
  revalidatePath(`/admin/conciliacion-reembolso/remesas/${payload.remittance_id}`);

  return {
    ok: true,
    remittanceId: payload.remittance_id,
    rowCount: Number(payload.row_count) || rowsPayload.length,
    calculatedTotal: Number(payload.calculated_total) || grid.calculatedTotal,
    totalDifference: diff,
  };
}

export type AnalyzeRemittanceResult =
  | {
      ok: true;
      remittanceId: string;
      analyzedAt: string;
      counts: { autoMatched: number; needsReview: number; unassigned: number };
      timings: {
        fetchMs: number;
        scoreMs: number;
        persistMs: number;
        totalMs: number;
        needsStageB: boolean;
        poolASize: number;
        poolBSize: number;
        rowCount: number;
      };
    }
  | {
      ok: false;
      code: "forbidden" | "validation" | "rpc_error" | "not_found";
      message: string;
    };

/**
 * Fase 4 — Analizar rendición draft/analyzed.
 * Matching en TS; persistencia vía rpc_cod_save_analysis.
 * Sin efecto financiero.
 */
export async function analyzeRemittance(
  remittanceId: string
): Promise<AnalyzeRemittanceResult> {
  const tTotal = Date.now();
  const ctx = await requireEdit();
  if (!ctx) {
    return { ok: false, code: "forbidden", message: "No tenés permiso para analizar rendiciones." };
  }

  if (!remittanceId?.trim()) {
    return { ok: false, code: "validation", message: "Falta el id de la rendición." };
  }

  const supabase = await createSupabaseServerClient();
  const { data: rem, error: remError } = await supabase
    .from("cod_remittances")
    .select("id, transport_id, status, sheet_revision")
    .eq("id", remittanceId)
    .maybeSingle();

  if (remError) {
    return { ok: false, code: "rpc_error", message: remError.message };
  }
  if (!rem) {
    return { ok: false, code: "not_found", message: "Rendición no encontrada." };
  }
  if (rem.status === "confirmed" || rem.status === "voided") {
    return {
      ok: false,
      code: "validation",
      message: `No se puede analizar una rendición en estado «${rem.status}».`,
    };
  }
  if (rem.status !== "draft" && rem.status !== "analyzed") {
    return {
      ok: false,
      code: "validation",
      message: `Estado no analizable: ${rem.status}`,
    };
  }

  const sheetRevision = Number(rem.sheet_revision) || 1;

  const { count: approvedCount } = await supabase
    .from("cod_remittance_rows")
    .select("id", { count: "exact", head: true })
    .eq("remittance_id", remittanceId)
    .eq("sheet_revision", sheetRevision)
    .eq("row_status", "approved_pending_confirmation");
  if ((approvedCount ?? 0) > 0) {
    return {
      ok: false,
      code: "validation",
      message: "Hay filas ya aprobadas. No se puede reanalizar.",
    };
  }

  let { data: rowData, error: rowsError } = await supabase
    .from("cod_remittance_rows")
    .select(
      "id, row_index, raw_customer_name_text, parsed_transport_date, parsed_amount"
    )
    .eq("remittance_id", remittanceId)
    .eq("sheet_revision", sheetRevision)
    .order("row_index", { ascending: true });

  // Fallback si sheet_revision aún no está en cache/schema del cliente
  if (rowsError && /sheet_revision|does not exist|schema cache/i.test(rowsError.message)) {
    ({ data: rowData, error: rowsError } = await supabase
      .from("cod_remittance_rows")
      .select(
        "id, row_index, raw_customer_name_text, parsed_transport_date, parsed_amount"
      )
      .eq("remittance_id", remittanceId)
      .order("row_index", { ascending: true }));
  }

  if (rowsError) {
    return { ok: false, code: "rpc_error", message: rowsError.message };
  }
  if (!rowData?.length) {
    return { ok: false, code: "validation", message: "La rendición no tiene filas." };
  }

  const rows: RemittanceMatchRow[] = rowData.map((r) => ({
    id: r.id,
    rowIndex: r.row_index,
    rawCustomerNameText: r.raw_customer_name_text,
    parsedTransportDate: r.parsed_transport_date,
    parsedAmount: r.parsed_amount != null ? Number(r.parsed_amount) : null,
  }));

  const pools = await loadMatchingPools(supabase, rem.transport_id);
  const tScore = Date.now();

  // Una sola pasada: Etapa A = pool mismo transporte; Etapa B = resto del universo.
  const poolBOnly = pools.poolAll.filter(
    (c) => c.effectiveTransportId !== rem.transport_id
  );
  const matched = matchRemittanceRows({
    remittanceTransportId: rem.transport_id,
    rows,
    poolA: pools.poolA,
    poolB: poolBOnly,
    approvedWarnings: pools.approvedWarnings,
    aliasesByNormalized: pools.aliasesByNormalized,
  });

  // Pedidos ya usados (confirmados / approved) — informativos, no seleccionables
  let occupancyByOrderId = new Map();
  let occupiedCandidates: Awaited<
    ReturnType<typeof loadOccupiedCodCandidates>
  >["candidates"] = [];
  let customerNumberByOrderId = new Map<string, string | null>();
  try {
    occupancyByOrderId = await loadOrderCodOccupancyMap(supabase);
    const occupiedIds = new Set(occupancyByOrderId.keys());
    const transportNames = new Map(
      pools.poolAll
        .filter((c) => c.effectiveTransportId && c.transportName)
        .map((c) => [c.effectiveTransportId!, c.transportName!])
    );
    // Completar nombres de transporte por si el pool operativo no los tiene
    const { data: tr } = await supabase.from("transports").select("id, name");
    for (const t of tr ?? []) transportNames.set(t.id, t.name);
    const occupied = await loadOccupiedCodCandidates(
      supabase,
      occupiedIds,
      transportNames
    );
    occupiedCandidates = occupied.candidates;
    customerNumberByOrderId = occupied.customerNumberByOrderId;
  } catch (e) {
    // Si falla la carga informativa, el análisis operativo sigue.
    console.error("[analyzeRemittance] already-used load failed", e);
  }

  const scoreMs = Date.now() - tScore;
  const rowById = new Map(rows.map((x) => [x.id, x]));

  const rowsPayload = matched.results.map((r) => {
    const src = rowById.get(r.rowId);
    const alreadyUsed =
      occupiedCandidates.length > 0 && src
        ? pickBestAlreadyUsedMatch({
            row: src,
            remittanceTransportId: rem.transport_id,
            candidates: occupiedCandidates,
            occupancyByOrderId,
            customerNumberByOrderId,
            currentRemittanceId: rem.id,
            currentRowId: src.id,
          })
        : null;

    const breakdown = {
      ...r.matchBreakdown,
      ...(alreadyUsed ? { alreadyUsedOrder: alreadyUsed } : {}),
    };

    return {
      row_id: r.rowId,
      row_status: r.rowStatus,
      matched_order_id: r.rowStatus === "unassigned" ? null : r.matchedOrderId,
      match_score: r.matchScore,
      match_breakdown: breakdown,
      match_candidates: r.matchCandidates,
      matched_via_broadened_search: r.matchedViaBroadenedSearch,
      transport_mismatch: r.transportMismatch,
      will_create_irregularity: r.willCreateIrregularity,
      order_number_snapshot: r.orderNumberSnapshot,
      matched_name_snapshot: r.matchedNameSnapshot,
      matched_name_source: r.matchedNameSource,
      transport_name_snapshot: r.transportNameSnapshot,
      order_sent_date_snapshot: r.orderSentDateSnapshot,
      order_sent_date_origin: r.orderSentDateOrigin,
      expected_amount_snapshot: r.expectedAmountSnapshot,
    };
  });

  const tPersist = Date.now();
  const { data, error } = await supabase.rpc("rpc_cod_save_analysis", {
    p_remittance_id: remittanceId,
    p_rows: rowsPayload,
    p_summary: {
      needs_stage_b: matched.needsStageB,
      pool_a_size: pools.poolA.length,
      pool_b_size: poolBOnly.length,
      fetch_ms: pools.timings.fetchMs,
      score_ms: scoreMs,
      row_count: rows.length,
    },
  });
  const persistMs = Date.now() - tPersist;

  if (error) {
    return {
      ok: false,
      code: "rpc_error",
      message: mapRpcError(
        error.message ||
          "No se pudo guardar el análisis. ¿Está aplicada la migración 278 (rpc_cod_save_analysis)?"
      ),
    };
  }

  const payload = data as {
    ok?: boolean;
    analyzed_at?: string;
    counts?: { auto_matched?: number; needs_review?: number; unassigned?: number };
  } | null;

  if (!payload?.ok) {
    return { ok: false, code: "rpc_error", message: "Respuesta inesperada al guardar el análisis." };
  }

  revalidatePath("/admin/conciliacion-reembolso");
  revalidatePath(`/admin/conciliacion-reembolso/remesas/${remittanceId}`);

  return {
    ok: true,
    remittanceId,
    analyzedAt: payload.analyzed_at ?? new Date().toISOString(),
    counts: {
      autoMatched: Number(payload.counts?.auto_matched) || matched.autoMatched,
      needsReview: Number(payload.counts?.needs_review) || matched.needsReview,
      unassigned: Number(payload.counts?.unassigned) || matched.unassigned,
    },
    timings: {
      fetchMs: pools.timings.fetchMs,
      scoreMs,
      persistMs,
      totalMs: Date.now() - tTotal,
      needsStageB: matched.needsStageB,
      poolASize: pools.poolA.length,
      poolBSize: matched.needsStageB ? poolBOnly.length : 0,
      rowCount: rows.length,
    },
  };
}

// ─── Fase 5 — aprobación / asignación / confirmación ─────────────────────────

export type Phase5Result =
  | { ok: true; message?: string; data?: Record<string, unknown> }
  | {
      ok: false;
      code: "forbidden" | "validation" | "rpc_error" | "needs_force";
      message: string;
      warnings?: Array<{ code?: string; message?: string }>;
      data?: Record<string, unknown>;
    };

function mapRpcError(message: string): string {
  if (message.includes("order_confirmed_elsewhere")) {
    const m = message.match(/order=([^\s]+)/);
    const order = m?.[1] ?? "X";
    return `El pedido ${order} fue conciliado por otra rendición mientras esta estaba en revisión. Revisá la fila y volvé a intentar.`;
  }
  if (message.includes("order_amount_changed_since_approval")) {
    return "El monto del pedido cambió desde la aprobación. Reanalizá o revisá la fila antes de confirmar.";
  }
  if (message.includes("rows_not_ready_for_confirm")) {
    return "Todavía hay filas sin decidir (seguras o para revisar). Aprobalas o dejálas sin identificar.";
  }
  if (message.includes("remittance_already_confirmed")) {
    return "Esta rendición ya está confirmada.";
  }
  if (message.includes("remittance_voided")) {
    return "No se puede confirmar una rendición anulada.";
  }
  if (message.includes("remittance_has_approved_rows")) {
    return "Hay filas ya aprobadas. No se puede reanalizar.";
  }
  if (message.includes("matched_name_not_in_order_identities")) {
    return "El análisis propuso un nombre que no coincide con el label/titular del pedido. Reintentá; si persiste, avisá.";
  }
  if (message.includes("matched_name_source_snapshot_mismatch")) {
    return "Inconsistencia en el nombre del match (source/snapshot). Reintentá el análisis.";
  }
  if (message.includes("resolution_notes_required")) {
    return "Para resolver el reclamo necesitás una observación.";
  }
  if (message.includes("invalid_transition")) {
    return "Esa transición de estado no está permitida.";
  }
  if (message.includes("irregularity_already_resolved")) {
    return "Este reclamo ya está resuelto.";
  }
  if (message.includes("irregularity_superseded")) {
    return "Este reclamo está invalidado y no se puede modificar.";
  }
  if (message.includes("forbidden")) {
    return "No tenés permiso para editar reclamos.";
  }
  if (message.includes("not_authenticated")) {
    return "Sesión expirada. Volvé a ingresar.";
  }
  if (message.includes("remittance_not_confirmed")) {
    return "La rendición debe estar confirmada para asignar este pago.";
  }
  if (message.includes("row_not_unassigned")) {
    return "Solo se pueden asignar filas sin identificar.";
  }
  if (message.includes("matched_order_not_in_cod_universe")) {
    return "El pedido no pertenece al universo COD conciliable.";
  }
  if (message.includes("matched_order_already_confirmed") || message.includes("order_confirmed_elsewhere")) {
    return "Ese pedido ya está conciliado.";
  }
  if (message.includes("row_missing_parsed_amount")) {
    return "La fila no tiene monto informado válido.";
  }
  if (message.includes("reason_required")) {
    return "Indicá el motivo de la corrección.";
  }
  if (message.includes("row_not_confirmed_assignment")) {
    return "Solo se pueden corregir filas ya confirmadas.";
  }
  if (message.includes("same_order")) {
    return "Elegí un pedido distinto al actualmente vinculado.";
  }
  if (message.includes("row_assignment_changed_concurrently")) {
    return "La asignación cambió mientras corregías. Recargá e intentá de nuevo.";
  }
  if (message.includes("remittance_already_voided")) {
    return "Esta rendición ya está anulada.";
  }
  if (message.includes("remittance_void_failed_concurrently") || message.includes("remittance_state_changed_concurrently")) {
    return "El estado de la rendición cambió. Recargá e intentá de nuevo.";
  }
  if (message.includes("row_state_changed_concurrently")) {
    return "Una fila cambió mientras anulabas. Recargá e intentá de nuevo.";
  }
  if (message.includes("remittance_has_unexpected_row_states")) {
    return "La rendición tiene filas en estados inesperados. No se puede anular hasta revisarlas.";
  }
  if (message.includes("confirmed_row_missing_order")) {
    return "Hay pagos confirmados sin pedido vinculado. No se puede anular.";
  }
  if (message.includes("matched_order_missing")) {
    return "Un pedido vinculado ya no existe. No se puede anular (rollback).";
  }
  if (message.includes("remittance_has_compensated_adjustments")) {
    return "No se puede anular: hay diferencias del transporte ya compensadas en esta rendición.";
  }
  if (message.includes("adjustment_has_compensations")) {
    return "Este crédito ya se usó en una compensación. No se puede anular.";
  }
  if (message.includes("row_already_confirmed_cod")) {
    return "La fila ya está confirmada como COD. No se puede registrar como diferencia.";
  }
  if (message.includes("row_is_supplementary")) {
    return "Los pagos complementarios no se registran como diferencia del transporte.";
  }
  if (message.includes("adjustment_already_active_for_row")) {
    return "Esta fila ya tiene una diferencia registrada.";
  }
  if (message.includes("cross_transport_not_allowed")) {
    return "No se pueden compensar movimientos de transportes distintos.";
  }
  if (message.includes("parsed_amount_invalid")) {
    return "La fila no tiene un monto válido para registrar.";
  }
  if (message.includes("row_not_in_current_sheet_revision")) {
    return "La fila no pertenece a la revisión actual de la planilla.";
  }
  return message;
}

export async function approveAutoMatched(
  remittanceId: string
): Promise<Phase5Result> {
  const ctx = await requireEdit();
  if (!ctx) return { ok: false, code: "forbidden", message: "Sin permiso de edición." };

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("rpc_cod_approve_auto_matched", {
    p_remittance_id: remittanceId,
  });
  if (error) {
    return { ok: false, code: "rpc_error", message: mapRpcError(error.message) };
  }
  const payload = data as { ok?: boolean; approved_count?: number } | null;
  revalidatePath("/admin/conciliacion-reembolso");
  revalidatePath(`/admin/conciliacion-reembolso/remesas/${remittanceId}`);
  return {
    ok: true,
    message: `Se aprobaron ${Number(payload?.approved_count) || 0} coincidencias seguras.`,
    data: payload ?? undefined,
  };
}

export async function assignRemittanceRow(input: {
  remittanceId: string;
  rowId: string;
  orderId: string;
  force?: boolean;
  matchedNameSnapshot?: string | null;
  matchedNameSource?: "label" | "titular" | "sub_name" | null;
  /** Acción humana explícita: recordar raw de la fila para el customer del pedido */
  rememberAlias?: boolean;
  rawAliasText?: string | null;
}): Promise<Phase5Result> {
  const ctx = await requireEdit();
  if (!ctx) return { ok: false, code: "forbidden", message: "Sin permiso de edición." };

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("rpc_cod_assign_row", {
    p_remittance_id: input.remittanceId,
    p_row_id: input.rowId,
    p_order_id: input.orderId,
    p_force: !!input.force,
    p_matched_name_snapshot: input.matchedNameSnapshot ?? null,
    p_matched_name_source: input.matchedNameSource ?? null,
  });
  if (error) {
    return { ok: false, code: "rpc_error", message: mapRpcError(error.message) };
  }
  const payload = data as {
    ok?: boolean;
    code?: string;
    warnings?: Array<{ code?: string; message?: string }>;
  } | null;

  if (payload && payload.ok === false && payload.code === "needs_force") {
    return {
      ok: false,
      code: "needs_force",
      message: "Esta asignación tiene advertencias. Confirmá para asignar igualmente.",
      warnings: payload.warnings ?? [],
      data: payload as Record<string, unknown>,
    };
  }

  revalidatePath("/admin/conciliacion-reembolso");
  revalidatePath(`/admin/conciliacion-reembolso/remesas/${input.remittanceId}`);

  if (!input.rememberAlias) {
    return { ok: true, message: "Pedido aprobado." };
  }

  // Assign OK — alias es operación separada; no revertir si falla.
  const aliasResult = await rememberAliasAfterAssign(supabase, {
    remittanceId: input.remittanceId,
    rowId: input.rowId,
    orderId: input.orderId,
    rawAliasText: input.rawAliasText,
  });

  if (!aliasResult.ok) {
    return {
      ok: true,
      code: "assign_ok_alias_failed",
      message: `Pedido aprobado, pero no se pudo recordar el nombre. ${aliasResult.message}`,
      data: { aliasError: aliasResult },
    };
  }

  return {
    ok: true,
    message: "Pedido aprobado y nombre recordado para este transporte.",
    data: { alias: aliasResult.data },
  };
}

async function rememberAliasAfterAssign(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
  input: {
    remittanceId: string;
    rowId: string;
    orderId: string;
    rawAliasText?: string | null;
  }
): Promise<{ ok: boolean; message: string; data?: Record<string, unknown> }> {
  const [{ data: rem }, { data: order }, { data: row }] = await Promise.all([
    supabase
      .from("cod_remittances")
      .select("transport_id")
      .eq("id", input.remittanceId)
      .maybeSingle(),
    supabase.from("orders").select("customer_id").eq("id", input.orderId).maybeSingle(),
    supabase
      .from("cod_remittance_rows")
      .select("raw_customer_name_text")
      .eq("id", input.rowId)
      .maybeSingle(),
  ]);

  const transportId = rem?.transport_id as string | undefined;
  const customerId = order?.customer_id as string | undefined;
  const rawAlias =
    (input.rawAliasText && String(input.rawAliasText).trim()) ||
    (row?.raw_customer_name_text as string | undefined) ||
    "";

  if (!transportId || !customerId || !rawAlias) {
    return {
      ok: false,
      message: "Faltan datos para guardar el alias (transporte, cliente o nombre).",
    };
  }

  const { data, error } = await supabase.rpc("rpc_cod_remember_transport_alias", {
    p_transport_id: transportId,
    p_customer_id: customerId,
    p_raw_alias: rawAlias,
    p_source_remittance_row_id: input.rowId,
    p_notes: null,
  });

  if (error) {
    return { ok: false, message: mapRpcError(error.message) };
  }

  const payload = data as {
    ok?: boolean;
    code?: string;
    message?: string;
  } | null;

  if (payload && payload.ok === false) {
    if (payload.code === "alias_conflict") {
      return {
        ok: false,
        message:
          payload.message ||
          "Este nombre de este transporte ya está vinculado a otro cliente.",
        data: payload as Record<string, unknown>,
      };
    }
    return {
      ok: false,
      message: payload.message || payload.code || "No se pudo guardar el alias.",
      data: payload as Record<string, unknown>,
    };
  }

  return { ok: true, message: "Alias guardado.", data: (payload as Record<string, unknown>) ?? undefined };
}

export async function setTransportAliasActive(input: {
  aliasId: string;
  isActive: boolean;
  reason?: string | null;
}): Promise<Phase5Result> {
  const ctx = await requireEdit();
  if (!ctx) return { ok: false, code: "forbidden", message: "Sin permiso de edición." };

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("rpc_cod_set_transport_alias_active", {
    p_alias_id: input.aliasId,
    p_is_active: input.isActive,
    p_reason: input.reason ?? null,
  });
  if (error) {
    return { ok: false, code: "rpc_error", message: mapRpcError(error.message) };
  }
  revalidatePath("/admin/conciliacion-reembolso");
  revalidatePath("/admin/conciliacion-reembolso/aliases");
  return {
    ok: true,
    message: input.isActive ? "Alias reactivado." : "Alias desactivado.",
    data: (data as Record<string, unknown>) ?? undefined,
  };
}

// ─── Fase 6B — asignar unassigned post-confirmación ──────────────────────────

export async function assignConfirmedUnassignedRow(input: {
  remittanceId: string;
  rowId: string;
  orderId: string;
  force?: boolean;
  matchedNameSnapshot?: string | null;
  matchedNameSource?: "label" | "titular" | "sub_name" | null;
  rememberAlias?: boolean;
  rawAliasText?: string | null;
}): Promise<Phase5Result> {
  const ctx = await requireEdit();
  if (!ctx) return { ok: false, code: "forbidden", message: "Sin permiso de edición." };

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("rpc_cod_assign_confirmed_unassigned_row", {
    p_remittance_id: input.remittanceId,
    p_row_id: input.rowId,
    p_order_id: input.orderId,
    p_force: !!input.force,
    p_matched_name_snapshot: input.matchedNameSnapshot ?? null,
    p_matched_name_source: input.matchedNameSource ?? null,
  });

  if (error) {
    return { ok: false, code: "rpc_error", message: mapRpcError(error.message) };
  }

  const payload = data as {
    ok?: boolean;
    code?: string;
    warnings?: Array<{ code?: string; message?: string }>;
    row_status?: string;
    amount_diff?: number;
    irregularity_id?: string | null;
  } | null;

  if (payload && payload.ok === false && payload.code === "needs_force") {
    return {
      ok: false,
      code: "needs_force",
      message: "Esta asignación tiene advertencias. Confirmá para asignar el pago.",
      warnings: payload.warnings ?? [],
      data: payload as Record<string, unknown>,
    };
  }

  revalidatePath("/admin/conciliacion-reembolso");
  revalidatePath("/admin/conciliacion-reembolso/sin-identificar");
  revalidatePath(`/admin/conciliacion-reembolso/remesas/${input.remittanceId}`);
  revalidatePath("/admin/conciliacion-reembolso/irregularidades");

  const baseMsg =
    payload?.row_status === "confirmed_with_irregularity"
      ? "Pago asignado. Se generó una irregularidad por diferencia de monto."
      : "Pago asignado y conciliado.";

  if (!input.rememberAlias) {
    return { ok: true, message: baseMsg, data: (payload as Record<string, unknown>) ?? undefined };
  }

  const aliasResult = await rememberAliasAfterAssign(supabase, {
    remittanceId: input.remittanceId,
    rowId: input.rowId,
    orderId: input.orderId,
    rawAliasText: input.rawAliasText,
  });

  if (!aliasResult.ok) {
    return {
      ok: true,
      code: "assign_ok_alias_failed",
      message: `Pago asignado, pero no se pudo guardar el alias. ${aliasResult.message}`,
      data: { assign: payload, aliasError: aliasResult },
    };
  }

  return {
    ok: true,
    message: `${baseMsg} Nombre recordado para este transporte.`,
    data: { assign: payload, alias: aliasResult.data },
  };
}

// ─── Fase 6C — corregir asignación confirmada (A → B) ────────────────────────

export async function correctConfirmedAssignment(input: {
  remittanceId: string;
  rowId: string;
  newOrderId: string;
  reason: string;
  force?: boolean;
  matchedNameSnapshot?: string | null;
  matchedNameSource?: "label" | "titular" | "sub_name" | null;
  rememberAlias?: boolean;
  rawAliasText?: string | null;
}): Promise<Phase5Result> {
  const ctx = await requireEdit();
  if (!ctx) return { ok: false, code: "forbidden", message: "Sin permiso de edición." };

  const reason = (input.reason ?? "").trim();
  if (!reason) {
    return { ok: false, code: "validation", message: "Indicá el motivo de la corrección." };
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("rpc_cod_correct_confirmed_assignment", {
    p_remittance_id: input.remittanceId,
    p_row_id: input.rowId,
    p_new_order_id: input.newOrderId,
    p_reason: reason,
    p_force: !!input.force,
    p_matched_name_snapshot: input.matchedNameSnapshot ?? null,
    p_matched_name_source: input.matchedNameSource ?? null,
  });

  if (error) {
    return { ok: false, code: "rpc_error", message: mapRpcError(error.message) };
  }

  const payload = data as {
    ok?: boolean;
    code?: string;
    warnings?: Array<{ code?: string; message?: string }>;
    row_status?: string;
    amount_diff?: number;
    irregularity_id?: string | null;
    old_order_id?: string;
    new_order_id?: string;
  } | null;

  if (payload && payload.ok === false && payload.code === "needs_force") {
    return {
      ok: false,
      code: "needs_force",
      message: "Esta corrección tiene advertencias. Confirmá para continuar.",
      warnings: payload.warnings ?? [],
      data: payload as Record<string, unknown>,
    };
  }

  revalidatePath("/admin/conciliacion-reembolso");
  revalidatePath(`/admin/conciliacion-reembolso/remesas/${input.remittanceId}`);
  revalidatePath("/admin/conciliacion-reembolso/irregularidades");
  revalidatePath("/admin/conciliacion-reembolso/sin-identificar");

  const baseMsg =
    payload?.row_status === "confirmed_with_irregularity"
      ? "Asignación corregida. Se generó una irregularidad por diferencia de monto."
      : "Asignación corregida.";

  if (!input.rememberAlias) {
    return { ok: true, message: baseMsg, data: (payload as Record<string, unknown>) ?? undefined };
  }

  const aliasResult = await rememberAliasAfterAssign(supabase, {
    remittanceId: input.remittanceId,
    rowId: input.rowId,
    orderId: input.newOrderId,
    rawAliasText: input.rawAliasText,
  });

  if (!aliasResult.ok) {
    return {
      ok: true,
      message: `Asignación corregida, pero no se pudo guardar el alias. ${aliasResult.message}`,
      data: { correct: payload, aliasError: aliasResult },
    };
  }

  return {
    ok: true,
    message: `${baseMsg} Nombre recordado para este transporte.`,
    data: { correct: payload, alias: aliasResult.data },
  };
}

// ─── Fase 6D — anular rendición confirmada ───────────────────────────────────

export async function voidConfirmedRemittance(input: {
  remittanceId: string;
  reason: string;
}): Promise<Phase5Result> {
  const ctx = await requireEdit();
  if (!ctx) return { ok: false, code: "forbidden", message: "Sin permiso de edición." };

  const reason = (input.reason ?? "").trim();
  if (!reason) {
    return { ok: false, code: "validation", message: "Indicá el motivo de la anulación." };
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("rpc_cod_void_confirmed_remittance", {
    p_remittance_id: input.remittanceId,
    p_reason: reason,
  });

  if (error) {
    return { ok: false, code: "rpc_error", message: mapRpcError(error.message) };
  }

  const payload = data as {
    ok?: boolean;
    rows_voided?: number;
    orders_returned_to_pending?: number;
    irregularities_superseded?: number;
  } | null;

  revalidatePath("/admin/conciliacion-reembolso");
  revalidatePath(`/admin/conciliacion-reembolso/remesas/${input.remittanceId}`);
  revalidatePath("/admin/conciliacion-reembolso/irregularidades");
  revalidatePath("/admin/conciliacion-reembolso/sin-identificar");

  const rowsVoided = Number(payload?.rows_voided) || 0;
  const ordersBack = Number(payload?.orders_returned_to_pending) || 0;

  return {
    ok: true,
    message:
      rowsVoided > 0
        ? `Rendición anulada: ${rowsVoided} pagos dejaron de estar conciliados (${ordersBack} pedidos vuelven a pendientes).`
        : "Rendición anulada.",
    data: (payload as Record<string, unknown>) ?? undefined,
  };
}


export async function markRowUnassigned(
  remittanceId: string,
  rowId: string
): Promise<Phase5Result> {
  const ctx = await requireEdit();
  if (!ctx) return { ok: false, code: "forbidden", message: "Sin permiso de edición." };

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.rpc("rpc_cod_mark_row_unassigned", {
    p_remittance_id: remittanceId,
    p_row_id: rowId,
  });
  if (error) {
    return { ok: false, code: "rpc_error", message: mapRpcError(error.message) };
  }
  revalidatePath("/admin/conciliacion-reembolso");
  revalidatePath(`/admin/conciliacion-reembolso/remesas/${remittanceId}`);
  return { ok: true, message: "Pedido dejado sin identificar." };
}

export async function confirmRemittance(remittanceId: string): Promise<Phase5Result> {
  const ctx = await requireEdit();
  if (!ctx) return { ok: false, code: "forbidden", message: "Sin permiso de edición." };

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("rpc_cod_confirm_remittance", {
    p_remittance_id: remittanceId,
  });
  if (error) {
    return { ok: false, code: "rpc_error", message: mapRpcError(error.message) };
  }
  revalidatePath("/admin/conciliacion-reembolso");
  revalidatePath(`/admin/conciliacion-reembolso/remesas/${remittanceId}`);
  const confirmedCount = Number(
    (data as { confirmed_count?: number; approved_count?: number } | null)?.confirmed_count ??
      (data as { confirmed_count?: number; approved_count?: number } | null)?.approved_count
  );
  return {
    ok: true,
    message: Number.isFinite(confirmedCount) && confirmedCount > 0
      ? `Rendición confirmada: ${confirmedCount} pagos conciliados.`
      : "Rendición confirmada: los pagos aprobados ya no figuran como pendientes.",
    data: (data as Record<string, unknown>) ?? undefined,
  };
}

/**
 * Lookup on-demand de pedido ya usado (para filas analizadas antes del enrichment).
 * No muta datos. No vuelve el pedido seleccionable.
 */
export async function lookupAlreadyUsedForRow(input: {
  remittanceId: string;
  rowId: string;
}): Promise<
  | { ok: true; hit: AlreadyUsedMatch | null }
  | { ok: false; message: string }
> {
  const ctx = await requireEdit();
  if (!ctx) return { ok: false, message: "Sin permiso." };

  const supabase = await createSupabaseServerClient();
  const { data: rem } = await supabase
    .from("cod_remittances")
    .select("id, transport_id, status, sheet_revision")
    .eq("id", input.remittanceId)
    .maybeSingle();
  if (!rem) return { ok: false, message: "Rendición no encontrada." };

  const sheetRevision = Number(rem.sheet_revision) || 1;
  const { data: row } = await supabase
    .from("cod_remittance_rows")
    .select(
      "id, row_index, raw_customer_name_text, parsed_transport_date, parsed_amount, sheet_revision"
    )
    .eq("id", input.rowId)
    .eq("remittance_id", input.remittanceId)
    .eq("sheet_revision", sheetRevision)
    .maybeSingle();
  if (!row) return { ok: false, message: "Fila no encontrada." };

  try {
    const occupancyByOrderId = await loadOrderCodOccupancyMap(supabase);
    const occupiedIds = new Set(occupancyByOrderId.keys());
    const { data: tr } = await supabase.from("transports").select("id, name");
    const transportNames = new Map((tr ?? []).map((t) => [t.id as string, t.name as string]));
    const occupied = await loadOccupiedCodCandidates(supabase, occupiedIds, transportNames);
    const hit = pickBestAlreadyUsedMatch({
      row: {
        id: row.id,
        rowIndex: row.row_index,
        rawCustomerNameText: row.raw_customer_name_text,
        parsedTransportDate: row.parsed_transport_date,
        parsedAmount: row.parsed_amount != null ? Number(row.parsed_amount) : null,
      },
      remittanceTransportId: rem.transport_id,
      candidates: occupied.candidates,
      occupancyByOrderId,
      customerNumberByOrderId: occupied.customerNumberByOrderId,
      currentRemittanceId: rem.id,
      currentRowId: row.id,
    });
    return { ok: true, hit };
  } catch (e) {
    console.error("[lookupAlreadyUsedForRow]", {
      remittanceId: input.remittanceId,
      rowId: input.rowId,
      error: e instanceof Error ? e.message : e,
    });
    return {
      ok: false,
      message: "No pudimos verificar si existe una vinculación anterior.",
    };
  }
}

/**
 * Aprueba pago complementario (sin efecto financiero).
 * Requiere migraciones 292/293 aplicadas. Confirmar rendición aplica el saldo (294).
 */
export async function approveComplementaryPayment(input: {
  remittanceId: string;
  rowId: string;
  orderId: string;
  reason?: string;
}): Promise<{ ok: true; message: string } | { ok: false; message: string }> {
  const ctx = await requireEdit();
  if (!ctx) return { ok: false, message: "Sin permiso." };

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("rpc_cod_approve_complementary_payment", {
    p_remittance_id: input.remittanceId,
    p_row_id: input.rowId,
    p_order_id: input.orderId,
    p_reason: input.reason ?? null,
  });

  if (error) {
    console.error("[approveComplementaryPayment]", error.message);
    const msg = error.message || "";
    if (/payment_exceeds_remaining_balance/i.test(msg)) {
      return {
        ok: false,
        message:
          "El pago informado supera el saldo pendiente. Revisá la planilla antes de continuar.",
      };
    }
    if (/active_shortage_irregularity_not_found/i.test(msg)) {
      return {
        ok: false,
        message: "No hay un reclamo de faltante activo para este pedido.",
      };
    }
    if (/multiple_active_shortage_irregularities/i.test(msg)) {
      return {
        ok: false,
        message:
          "Hay más de un reclamo de faltante activo. Revisá irregularidades antes de continuar.",
      };
    }
    if (/shortage_balance_mismatch/i.test(msg)) {
      return {
        ok: false,
        message:
          "El saldo calculado no coincide con el reclamo activo. Requiere revisión manual.",
      };
    }
    if (/remaining_balance_not_positive|balance_already_settled/i.test(msg)) {
      return { ok: false, message: "Este pedido ya no tiene saldo pendiente." };
    }
    if (/Could not find the function|PGRST202/i.test(msg)) {
      return {
        ok: false,
        message:
          "La función de pago complementario aún no está aplicada en la base (292/293).",
      };
    }
    return {
      ok: false,
      message: "No se pudo aprobar el pago complementario.",
    };
  }

  const payload = data as { ok?: boolean } | null;
  if (!payload?.ok) {
    return { ok: false, message: "Respuesta inesperada al aprobar complemento." };
  }

  revalidatePath(`/admin/conciliacion-reembolso/remesas/${input.remittanceId}`);
  return {
    ok: true,
    message: "Pago complementario aprobado · pendiente de confirmar la rendición.",
  };
}

export async function searchManualOrders(input: {
  remittanceId: string;
  rowId: string;
  query: string;
  allTransports: boolean;
}): Promise<{ ok: true; hits: ManualOrderHit[] } | { ok: false; message: string }> {
  const ctx = await requireEdit();
  if (!ctx) return { ok: false, message: "Sin permiso." };

  const supabase = await createSupabaseServerClient();
  const { data: rem } = await supabase
    .from("cod_remittances")
    .select("id, transport_id, status")
    .eq("id", input.remittanceId)
    .maybeSingle();
  if (!rem || rem.status === "voided") {
    return { ok: false, message: "Rendición no encontrada o anulada." };
  }

  const { data: row } = await supabase
    .from("cod_remittance_rows")
    .select("id, parsed_transport_date, parsed_amount, row_status")
    .eq("id", input.rowId)
    .eq("remittance_id", input.remittanceId)
    .maybeSingle();
  if (!row) return { ok: false, message: "Fila no encontrada." };

  // Fase 5: analyzed. Fase 6B: confirmed + unassigned. Fase 6C: confirmed + confirmed_*.
  if (rem.status === "confirmed") {
    const okForSearch =
      row.row_status === "unassigned" ||
      row.row_status === "confirmed_matched" ||
      row.row_status === "confirmed_with_irregularity";
    if (!okForSearch) {
      return {
        ok: false,
        message: "Solo se pueden buscar pedidos para filas sin identificar o para corregir una asignación confirmada.",
      };
    }
  } else if (rem.status !== "analyzed") {
    return { ok: false, message: "Rendición no editable." };
  }

  try {
    const hits = await searchCodOrdersForManualAssign(supabase, {
      remittanceTransportId: rem.transport_id,
      query: input.query,
      parsedDate: row.parsed_transport_date,
      parsedAmount: row.parsed_amount != null ? Number(row.parsed_amount) : null,
      allTransports: input.allTransports,
    });
    return { ok: true, hits };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Error de búsqueda." };
  }
}

// ─── Fase 6A — irregularidades / reclamos ────────────────────────────────────

export async function updateIrregularityStatus(input: {
  irregularityId: string;
  newStatus: "in_review" | "resolved";
  resolutionNotes?: string | null;
}): Promise<Phase5Result> {
  const ctx = await requireEdit();
  if (!ctx) return { ok: false, code: "forbidden", message: "Sin permiso de edición." };

  if (input.newStatus === "resolved") {
    const notes = (input.resolutionNotes ?? "").trim();
    if (!notes) {
      return {
        ok: false,
        code: "validation",
        message: "Para resolver el reclamo necesitás una observación.",
      };
    }
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("rpc_cod_update_irregularity_status", {
    p_irregularity_id: input.irregularityId,
    p_new_status: input.newStatus,
    p_resolution_notes: input.resolutionNotes?.trim() || null,
  });

  if (error) {
    return { ok: false, code: "rpc_error", message: mapRpcError(error.message) };
  }

  const payload = data as { ok?: boolean; new_status?: string } | null;
  revalidatePath("/admin/conciliacion-reembolso");
  revalidatePath("/admin/conciliacion-reembolso/irregularidades");
  revalidatePath(`/admin/conciliacion-reembolso/irregularidades/${input.irregularityId}`);

  if (input.newStatus === "in_review") {
    return {
      ok: true,
      message: "Reclamo marcado en revisión.",
      data: (payload as Record<string, unknown>) ?? undefined,
    };
  }

  return {
    ok: true,
    message: "Reclamo resuelto.",
    data: (payload as Record<string, unknown>) ?? undefined,
  };
}

export type ReplaceUnconfirmedSheetInput = {
  remittanceId: string;
  reason: string;
  remittanceDateText: string;
  reportedTotalText: string;
  pasteText: string;
  notes?: string;
  confirmTotalDifference?: boolean;
  confirmInternalDuplicates?: boolean;
};

export type ReplaceUnconfirmedSheetResult =
  | {
      ok: true;
      remittanceId: string;
      newSheetRevision: number;
      oldRowCount: number;
      newRowCount: number;
      message: string;
    }
  | {
      ok: false;
      code: "forbidden" | "validation" | "needs_confirm_total" | "rpc_error" | "not_found";
      message: string;
      totalDifference?: number;
    };

/**
 * Reemplazo total de planilla PRE-confirm (nueva sheet_revision, sin DELETE).
 */
export async function replaceUnconfirmedRemittanceSheet(
  input: ReplaceUnconfirmedSheetInput
): Promise<ReplaceUnconfirmedSheetResult> {
  const ctx = await requireEdit();
  if (!ctx) {
    return { ok: false, code: "forbidden", message: "No tenés permiso para editar rendiciones." };
  }

  const reason = input.reason?.trim();
  if (!reason) {
    return { ok: false, code: "validation", message: "El motivo de corrección es obligatorio." };
  }
  if (!input.remittanceId?.trim()) {
    return { ok: false, code: "validation", message: "Falta el id de la rendición." };
  }

  const dateParsed = parseRemittanceDate(input.remittanceDateText);
  if (!dateParsed.ok) {
    return { ok: false, code: "validation", message: dateParsed.error };
  }
  const totalParsed = parseReportedTotal(input.reportedTotalText);
  if (!totalParsed.ok) {
    return { ok: false, code: "validation", message: totalParsed.error };
  }

  const grid = parsePasteGrid(input.pasteText);
  if (grid.invalidRows.length > 0) {
    return {
      ok: false,
      code: "validation",
      message: `Hay ${grid.invalidRows.length} fila(s) inválida(s). Corregilas antes de guardar.`,
    };
  }
  if (grid.validRows.length === 0) {
    return { ok: false, code: "validation", message: "La planilla no puede estar vacía." };
  }

  const dupCount = grid.validRows.filter((r) => r.isDuplicate).length;
  if (dupCount > 0 && !input.confirmInternalDuplicates) {
    return {
      ok: false,
      code: "validation",
      message: `Hay ${dupCount} posible(s) duplicado(s) interno(s). Confirmá para guardar igual.`,
    };
  }

  const diff = totalDifference(grid.calculatedTotal, totalParsed.value);
  if (diff !== 0 && !input.confirmTotalDifference) {
    return {
      ok: false,
      code: "needs_confirm_total",
      message: `El total calculado difiere del informado (${diff > 0 ? "+" : ""}${diff}). Confirmá para guardar.`,
      totalDifference: diff,
    };
  }

  const contentHash = await computeContentHash(grid.contentHashInput);
  const rowsPayload = grid.validRows.map((r) => ({
    row_index: r.rowIndex,
    raw_line: r.rawLine,
    raw_transport_date_text: r.rawTransportDateText,
    raw_customer_name_text: r.rawCustomerNameText,
    raw_amount_text: r.rawAmountText,
    parsed_transport_date: r.parsedTransportDate,
    parsed_amount: r.parsedAmount,
  }));

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("rpc_cod_replace_unconfirmed_remittance_sheet", {
    p_remittance_id: input.remittanceId,
    p_reason: reason,
    p_remittance_date: dateParsed.value,
    p_reported_total: totalParsed.value,
    p_content_hash: contentHash,
    p_rows: rowsPayload,
    p_notes: input.notes?.trim() || null,
  });

  if (error) {
    const msg = error.message || "";
    if (msg.includes("remittance_confirmed_immutable")) {
      return {
        ok: false,
        code: "validation",
        message: "Esta rendición ya fue confirmada. No se puede editar la planilla.",
      };
    }
    if (msg.includes("remittance_voided_immutable")) {
      return {
        ok: false,
        code: "validation",
        message: "Esta rendición está anulada. Solo lectura.",
      };
    }
    if (msg.includes("reason_required")) {
      return { ok: false, code: "validation", message: "El motivo es obligatorio." };
    }
    return {
      ok: false,
      code: "rpc_error",
      message:
        msg ||
        "No se pudo guardar. ¿Están aplicadas las migraciones 289/290 (revisiones de planilla)?",
    };
  }

  const payload = data as {
    ok?: boolean;
    new_sheet_revision?: number;
    old_row_count?: number;
    new_row_count?: number;
  } | null;

  if (!payload?.ok) {
    return { ok: false, code: "rpc_error", message: "Respuesta inesperada al reemplazar planilla." };
  }

  revalidatePath("/admin/conciliacion-reembolso");
  revalidatePath(`/admin/conciliacion-reembolso/remesas/${input.remittanceId}`);
  revalidatePath(`/admin/conciliacion-reembolso/remesas/${input.remittanceId}/editar`);

  return {
    ok: true,
    remittanceId: input.remittanceId,
    newSheetRevision: Number(payload.new_sheet_revision) || 0,
    oldRowCount: Number(payload.old_row_count) || 0,
    newRowCount: Number(payload.new_row_count) || rowsPayload.length,
    message: "Planilla actualizada. Debés analizar nuevamente las coincidencias.",
  };
}

// ─── Diferencias del transporte (295–299) ────────────────────────────────────

export async function registerTransportAdjustment(input: {
  remittanceId: string;
  rowId: string;
  kind:
    | "paid_other_method"
    | "non_applicable_payment"
    | "order_not_found"
    | "foreign_client"
    | "transport_error"
    | "other";
  observation?: string | null;
  orderId?: string | null;
  customerId?: string | null;
}): Promise<Phase5Result> {
  const ctx = await requireEdit();
  if (!ctx) return { ok: false, code: "forbidden", message: "Sin permiso de edición." };

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("rpc_cod_register_transport_adjustment", {
    p_remittance_id: input.remittanceId,
    p_row_id: input.rowId,
    p_kind: input.kind,
    p_observation: input.observation?.trim() || null,
    p_order_id: input.orderId || null,
    p_customer_id: input.customerId || null,
  });

  if (error) {
    return { ok: false, code: "rpc_error", message: mapRpcError(error.message) };
  }

  revalidatePath("/admin/conciliacion-reembolso");
  revalidatePath(`/admin/conciliacion-reembolso/remesas/${input.remittanceId}`);
  revalidatePath("/admin/conciliacion-reembolso/irregularidades");
  revalidatePath("/admin/conciliacion-reembolso/sin-identificar");

  const payload = (data ?? {}) as Record<string, unknown>;
  const amount = Number(payload.original_amount);
  return {
    ok: true,
    message:
      Number.isFinite(amount) && amount > 0
        ? `Registrado a favor del transporte: $${amount.toLocaleString("es-AR")}.`
        : "Diferencia del transporte registrada.",
    data: payload,
  };
}

export async function voidTransportAdjustment(input: {
  adjustmentId: string;
  remittanceId?: string;
  reason?: string | null;
}): Promise<Phase5Result> {
  const ctx = await requireEdit();
  if (!ctx) return { ok: false, code: "forbidden", message: "Sin permiso de edición." };

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("rpc_cod_void_transport_adjustment", {
    p_adjustment_id: input.adjustmentId,
    p_reason: input.reason?.trim() || null,
  });

  if (error) {
    return { ok: false, code: "rpc_error", message: mapRpcError(error.message) };
  }

  revalidatePath("/admin/conciliacion-reembolso");
  revalidatePath("/admin/conciliacion-reembolso/irregularidades");
  if (input.remittanceId) {
    revalidatePath(`/admin/conciliacion-reembolso/remesas/${input.remittanceId}`);
  }

  return {
    ok: true,
    message: "Crédito anulado. La fila volvió a sin identificar.",
    data: (data as Record<string, unknown>) ?? undefined,
  };
}

export async function compensateTransportDifferences(input: {
  transportId: string;
  claimIds: string[];
  creditAdjustmentIds?: string[];
  creditIrregularityIds?: string[];
  note?: string | null;
}): Promise<Phase5Result> {
  const ctx = await requireEdit();
  if (!ctx) return { ok: false, code: "forbidden", message: "Sin permiso de edición." };

  if (!input.claimIds.length) {
    return { ok: false, code: "validation", message: "Seleccioná al menos un reclamo a compensar." };
  }
  const credits =
    (input.creditAdjustmentIds?.length ?? 0) + (input.creditIrregularityIds?.length ?? 0);
  if (credits === 0) {
    return { ok: false, code: "validation", message: "Seleccioná al menos un crédito a favor." };
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.rpc("rpc_cod_compensate_transport_differences", {
    p_transport_id: input.transportId,
    p_claim_ids: input.claimIds,
    p_credit_adjustment_ids: input.creditAdjustmentIds?.length
      ? input.creditAdjustmentIds
      : null,
    p_credit_irregularity_ids: input.creditIrregularityIds?.length
      ? input.creditIrregularityIds
      : null,
    p_note: input.note?.trim() || null,
  });

  if (error) {
    return { ok: false, code: "rpc_error", message: mapRpcError(error.message) };
  }

  revalidatePath("/admin/conciliacion-reembolso");
  revalidatePath("/admin/conciliacion-reembolso/irregularidades");

  const payload = (data ?? {}) as Record<string, unknown>;
  const applied = Number(payload.total_applied);
  return {
    ok: true,
    message: Number.isFinite(applied)
      ? `Compensación aplicada: $${applied.toLocaleString("es-AR")}.`
      : "Compensación aplicada.",
    data: payload,
  };
}
