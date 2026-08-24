"use client";

import Link from "next/link";
import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { formatPriceAr } from "@/lib/orders/domain";
import {
  analyzeRemittance,
  approveAutoMatched,
  assignRemittanceRow,
  confirmRemittance,
  correctConfirmedAssignment,
  lookupAlreadyUsedForRow,
  markRowUnassigned,
  previewAliasLinkForOrder,
  registerTransportAdjustment,
  searchManualOrders,
  voidConfirmedRemittance,
  voidTransportAdjustment,
} from "@/lib/reconciliation/actions";
import type { AliasLinkPreview } from "@/lib/reconciliation/actions";
import type { ManualOrderHit } from "@/lib/reconciliation/manual-search";
import type { RemittanceDetail, RemittanceRowDetail } from "@/lib/reconciliation/remittance-queries";
import AlreadyUsedOrderBanner from "@/components/admin-reconciliation/AlreadyUsedOrderBanner";
import { kindLabel } from "@/lib/reconciliation/difference-queries";
import {
  parseAlreadyUsedFromBreakdown,
  type AlreadyUsedMatch,
} from "@/lib/reconciliation/already-used-match";
import {
  amountDiffLabel,
  candidateAmountDiff,
  candidateMatchByHint,
  candidatePrimaryName,
  formatDateArIso,
  formatSignedPriceAr,
  nameSourceHuman,
  signalAmount,
  signalDate,
  signalName,
  signalTransport,
  type CandidateDisplay,
} from "@/lib/reconciliation/match-presentation";
import styles from "@/app/admin/conciliacion-reembolso/conciliacion.module.css";

type FilterTab =
  | "all"
  | "auto_matched"
  | "needs_review"
  | "unassigned"
  | "approved_pending_confirmation"
  | "classified_adjustment";

type AdjustmentKind =
  | "paid_other_method"
  | "non_applicable_payment"
  | "order_not_found"
  | "foreign_client"
  | "transport_error"
  | "other";

const ADJUSTMENT_KIND_OPTIONS: { value: AdjustmentKind; label: string }[] = [
  { value: "paid_other_method", label: "Pedido pagado por otro medio" },
  { value: "non_applicable_payment", label: "Pago que no corresponde" },
  { value: "order_not_found", label: "Cliente/pedido no encontrado" },
  { value: "foreign_client", label: "Cliente ajeno a FyL" },
  { value: "transport_error", label: "Error informado por transporte" },
  { value: "other", label: "Otro" },
];

function formatDateAr(iso: string | null): string {
  if (!iso) return "—";
  const [y, m, d] = iso.split("-");
  if (!y || !m || !d) return iso;
  return `${d}/${m}/${y}`;
}

function statusLabel(status: string): string {
  switch (status) {
    case "draft":
      return "Borrador";
    case "analyzed":
      return "Analizada";
    case "confirmed":
      return "Confirmada";
    case "voided":
      return "Anulada";
    default:
      return status;
  }
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case "draft":
      return styles.statusDraft;
    case "analyzed":
      return styles.statusAnalyzed;
    case "confirmed":
      return styles.statusConfirmed;
    case "voided":
      return styles.statusVoided;
    default:
      return styles.statusDraft;
  }
}

function confidenceFromRow(row: RemittanceRowDetail): string {
  switch (row.rowStatus) {
    case "auto_matched": {
      const reason = row.matchBreakdown?.autoMatchReason;
      if (reason === "unique_financial_logistics") return "Coincidencia segura";
      if (reason === "transport_alias") return "Alias de transporte";
      return "Confianza alta";
    }
    case "needs_review":
      return "Revisión necesaria";
    case "unassigned":
      return "Sin identificar";
    case "classified_adjustment":
      return "Registrado como diferencia del transporte";
    case "approved_pending_confirmation":
      return "Aprobada (pendiente confirmar)";
    case "confirmed_matched":
      return "Confirmada exacta";
    case "confirmed_with_irregularity":
      return "Confirmada con diferencia";
    case "void":
      return "Anulada (histórica)";
    default:
      return row.rowStatus;
  }
}

function nameSourceLabel(source: string | null): string {
  switch (source) {
    case "label":
      return "rótulo";
    case "titular":
      return "titular";
    case "sub_name":
      return "sub-nombre";
    default:
      return "—";
  }
}

function readBreakdownNum(bd: Record<string, unknown> | null, path: string[]): number | null {
  if (!bd) return null;
  let cur: unknown = bd;
  for (const key of path) {
    if (!cur || typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[key];
  }
  const n = Number(cur);
  return Number.isFinite(n) ? n : null;
}

type CandidateLite = CandidateDisplay;

function parseCandidates(row: RemittanceRowDetail): CandidateLite[] {
  if (!Array.isArray(row.matchCandidates)) return [];
  return row.matchCandidates as CandidateLite[];
}

export default function RemittanceDetailView({
  detail,
  canEdit,
  editedFlash = false,
  analysisInvalidatedFlash = false,
}: {
  detail: RemittanceDetail;
  canEdit: boolean;
  editedFlash?: boolean;
  analysisInvalidatedFlash?: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [tab, setTab] = useState<FilterTab>("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [forceWarnings, setForceWarnings] = useState<{
    rowId: string;
    orderId: string;
    warnings: Array<{ code?: string; message?: string }>;
    nameSnapshot?: string | null;
    nameSource?: "label" | "titular" | "sub_name" | null;
  } | null>(null);
  const [aliasConfirm, setAliasConfirm] = useState<{
    rowId: string;
    orderId: string;
    nameSnapshot?: string | null;
    nameSource?: "label" | "titular" | "sub_name" | null;
    rawAlias: string;
    parsedTransportDate: string | null;
    parsedAmount: number | null;
    preview: AliasLinkPreview;
  } | null>(null);
  const [searchRowId, setSearchRowId] = useState<string | null>(null);
  const [searchQ, setSearchQ] = useState("");
  const [allTransports, setAllTransports] = useState(false);
  const [hits, setHits] = useState<ManualOrderHit[]>([]);
  const [alreadyUsedByRow, setAlreadyUsedByRow] = useState<
    Record<string, AlreadyUsedMatch | null>
  >({});
  const [alreadyUsedLoading, setAlreadyUsedLoading] = useState<Record<string, boolean>>(
    {}
  );
  const [alreadyUsedError, setAlreadyUsedError] = useState<Record<string, string | null>>(
    {}
  );
  const alreadyUsedInflight = useRef<Set<string>>(new Set());
  const [correctModal, setCorrectModal] = useState<{
    row: RemittanceRowDetail;
    selected: ManualOrderHit | null;
    reason: string;
    rememberAlias: boolean;
    forceWarnings: Array<{ code?: string; message?: string }> | null;
  } | null>(null);
  const [voidModal, setVoidModal] = useState<{
    reason: string;
    confirmText: string;
  } | null>(null);
  const [adjustmentModal, setAdjustmentModal] = useState<{
    row: RemittanceRowDetail;
    kind: AdjustmentKind;
    observation: string;
  } | null>(null);

  const isConfirmed = detail.status === "confirmed";
  const isVoided = detail.status === "voided";
  const readOnly = isConfirmed || isVoided;
  const canCorrect = canEdit && isConfirmed && !isVoided;
  const canVoid = canEdit && isConfirmed && !isVoided;

  const voidPreview = useMemo(() => {
    const confirmedRows = detail.rows.filter((r) =>
      ["confirmed_matched", "confirmed_with_irregularity"].includes(r.rowStatus)
    );
    const unassigned = detail.rows.filter((r) => r.rowStatus === "unassigned").length;
    const amount = confirmedRows.reduce(
      (s, r) => s + (r.expectedAmountSnapshot ?? r.parsedAmount ?? 0),
      0
    );
    const withIrreg = confirmedRows.filter(
      (r) => r.rowStatus === "confirmed_with_irregularity"
    ).length;
    return {
      reconciledCount: confirmedRows.length,
      withIrreg,
      unassigned,
      amount,
    };
  }, [detail.rows]);
  const canAnalyze =
    canEdit &&
    !readOnly &&
    (detail.status === "draft" || detail.status === "analyzed") &&
    !detail.rows.some((r) => r.rowStatus === "approved_pending_confirmation");

  const canEditSheet =
    canEdit &&
    !readOnly &&
    (detail.status === "draft" || detail.status === "analyzed");

  const counts = useMemo(() => {
    const auto = detail.rows.filter((r) => r.rowStatus === "auto_matched").length;
    const review = detail.rows.filter((r) => r.rowStatus === "needs_review").length;
    const unassigned = detail.rows.filter((r) => r.rowStatus === "unassigned").length;
    const approved = detail.rows.filter(
      (r) => r.rowStatus === "approved_pending_confirmation"
    ).length;
    const classified = detail.rows.filter(
      (r) => r.rowStatus === "classified_adjustment"
    ).length;
    return { auto, review, unassigned, approved, classified, total: detail.rows.length };
  }, [detail.rows]);

  const preview = useMemo(() => {
    const approved = detail.rows.filter(
      (r) => r.rowStatus === "approved_pending_confirmation"
    );
    const unassigned = detail.rows.filter((r) => r.rowStatus === "unassigned");
    const classified = detail.rows.filter(
      (r) => r.rowStatus === "classified_adjustment"
    );
    let exact = 0;
    let withDiff = 0;
    let diffPos = 0;
    let diffNeg = 0;
    let assignedAmount = 0;
    let unassignedAmount = 0;
    let classifiedAmount = 0;
    for (const r of approved) {
      const expected = r.expectedAmountSnapshot ?? 0;
      const reported = r.parsedAmount ?? 0;
      assignedAmount += reported;
      const d = Math.round((reported - expected) * 100) / 100;
      if (Math.abs(d) < 0.005) exact += 1;
      else {
        withDiff += 1;
        if (d > 0) diffPos += d;
        else diffNeg += d;
      }
    }
    for (const r of unassigned) unassignedAmount += r.parsedAmount ?? 0;
    for (const r of classified) classifiedAmount += r.parsedAmount ?? 0;
    const undecided = detail.rows.filter((r) =>
      ["auto_matched", "needs_review", "pending_analysis"].includes(r.rowStatus)
    ).length;
    // classified_adjustment = crédito transporte (no COD). RPC 300 las trata
    // como ready/skip al confirmar, igual que unassigned.
    return {
      approved: approved.length,
      exact,
      withDiff,
      unassigned: unassigned.length,
      classified: classified.length,
      undecided,
      reportedTotal: detail.reportedTotal,
      assignedAmount,
      unassignedAmount,
      classifiedAmount,
      diffPos,
      diffNeg,
      net: Math.round((diffPos + diffNeg) * 100) / 100,
      canConfirm:
        detail.status === "analyzed" &&
        undecided === 0 &&
        detail.rows.every((r) =>
          [
            "approved_pending_confirmation",
            "unassigned",
            "classified_adjustment",
          ].includes(r.rowStatus)
        ),
    };
  }, [detail]);

  const filtered = useMemo(() => {
    if (tab === "all") return detail.rows;
    return detail.rows.filter((r) => r.rowStatus === tab);
  }, [detail.rows, tab]);

  const analyzed =
    detail.status === "analyzed" ||
    detail.status === "confirmed" ||
    detail.rows.some((r) => r.rowStatus !== "pending_analysis");

  function refresh() {
    router.refresh();
  }

  function toggleExpand(id: string) {
    const isOpen = expanded.has(id);
    if (isOpen) {
      setExpanded((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      return;
    }

    setExpanded((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });

    // Lazy lookup SOLO desde el handler (nunca dentro de un updater/render).
    const row = detail.rows.find((r) => r.id === id);
    const hasCachedBreakdown = row
      ? !!parseAlreadyUsedFromBreakdown(row.matchBreakdown)
      : false;
    const hasCachedLookup = Object.prototype.hasOwnProperty.call(alreadyUsedByRow, id);
    const needsLookup =
      !!row &&
      !row.matchedOrderId &&
      !hasCachedBreakdown &&
      !hasCachedLookup &&
      !alreadyUsedLoading[id] &&
      !alreadyUsedInflight.current.has(id);

    if (!needsLookup) return;

    alreadyUsedInflight.current.add(id);
    setAlreadyUsedLoading((m) => ({ ...m, [id]: true }));
    setAlreadyUsedError((m) => ({ ...m, [id]: null }));

    void (async () => {
      try {
        const res = await lookupAlreadyUsedForRow({
          remittanceId: detail.id,
          rowId: id,
        });
        if (!res.ok) {
          console.error("[alreadyUsed] lookup failed", id, res.message);
          setAlreadyUsedError((m) => ({
            ...m,
            [id]:
              res.message && !/bad request/i.test(res.message)
                ? res.message
                : "No pudimos verificar si existe una vinculación anterior.",
          }));
          setAlreadyUsedByRow((m) => ({ ...m, [id]: null }));
          return;
        }
        setAlreadyUsedByRow((m) => ({ ...m, [id]: res.hit }));
      } catch (err) {
        console.error("[alreadyUsed] lookup exception", id, err);
        setAlreadyUsedError((m) => ({
          ...m,
          [id]: "No pudimos verificar si existe una vinculación anterior.",
        }));
        setAlreadyUsedByRow((m) => ({ ...m, [id]: null }));
      } finally {
        alreadyUsedInflight.current.delete(id);
        setAlreadyUsedLoading((m) => ({ ...m, [id]: false }));
      }
    })();
  }

  function alreadyUsedForRow(row: RemittanceRowDetail): AlreadyUsedMatch | null {
    return (
      parseAlreadyUsedFromBreakdown(row.matchBreakdown) ??
      (Object.prototype.hasOwnProperty.call(alreadyUsedByRow, row.id)
        ? alreadyUsedByRow[row.id] ?? null
        : null)
    );
  }

  function run(fn: () => Promise<{ ok: boolean; message?: string; counts?: { autoMatched?: number; needsReview?: number; unassigned?: number } }>) {
    setError(null);
    setInfo(null);
    startTransition(async () => {
      const res = await fn();
      if (!res.ok) {
        setError(res.message || "Error");
        return;
      }
      if (res.message) setInfo(res.message);
      else if (res.counts) {
        setInfo(
          `Análisis listo: ${res.counts.autoMatched ?? 0} seguras · ${res.counts.needsReview ?? 0} a revisar · ${res.counts.unassigned ?? 0} sin identificar.`
        );
      }
      refresh();
    });
  }

  function onAssign(
    row: RemittanceRowDetail,
    orderId: string,
    force: boolean,
    nameSnapshot?: string | null,
    nameSource?: "label" | "titular" | "sub_name" | null,
    rememberAlias = false
  ) {
    // Recordar nombre: primero modal de vinculación explícita (nunca alias ciego).
    if (rememberAlias && !force) {
      openAliasConfirm(row, orderId, nameSnapshot, nameSource);
      return;
    }

    setError(null);
    setInfo(null);
    startTransition(async () => {
      const res = await assignRemittanceRow({
        remittanceId: detail.id,
        rowId: row.id,
        orderId,
        force,
        matchedNameSnapshot: nameSnapshot ?? row.matchedNameSnapshot,
        matchedNameSource: (nameSource ?? row.matchedNameSource) as
          | "label"
          | "titular"
          | "sub_name"
          | null,
        rememberAlias,
        rawAliasText: row.rawCustomerNameText,
      });
      if (!res.ok && res.code === "needs_force") {
        // Sin remember: modal force normal. Con remember no debería llegar aquí
        // (confirmamos con force tras el modal de vinculación).
        if (rememberAlias) {
          openAliasConfirm(row, orderId, nameSnapshot, nameSource);
          return;
        }
        setForceWarnings({
          rowId: row.id,
          orderId,
          warnings: res.warnings ?? [],
          nameSnapshot: nameSnapshot ?? row.matchedNameSnapshot,
          nameSource: (nameSource ?? row.matchedNameSource) as
            | "label"
            | "titular"
            | "sub_name"
            | null,
        });
        return;
      }
      if (!res.ok) {
        setError(res.message);
        return;
      }
      setForceWarnings(null);
      setAliasConfirm(null);
      setSearchRowId(null);
      let msg = res.message || "Pedido aprobado.";
      if (rememberAlias && res.ok && detail.transportName && msg.includes("este transporte")) {
        msg = msg.replace("este transporte", detail.transportName);
      }
      setInfo(msg);
      refresh();
    });
  }

  function openAliasConfirm(
    row: RemittanceRowDetail,
    orderId: string,
    nameSnapshot?: string | null,
    nameSource?: "label" | "titular" | "sub_name" | null
  ) {
    setError(null);
    setInfo(null);
    startTransition(async () => {
      const res = await previewAliasLinkForOrder({ orderId });
      if (!res.ok) {
        setError(res.message || "No se pudo cargar el cliente del pedido.");
        return;
      }
      setForceWarnings(null);
      setAliasConfirm({
        rowId: row.id,
        orderId,
        nameSnapshot: nameSnapshot ?? row.matchedNameSnapshot,
        nameSource: (nameSource ?? row.matchedNameSource) as
          | "label"
          | "titular"
          | "sub_name"
          | null,
        rawAlias: row.rawCustomerNameText,
        parsedTransportDate: row.parsedTransportDate,
        parsedAmount: row.parsedAmount,
        preview: res.preview,
      });
    });
  }

  function confirmAliasLink() {
    if (!aliasConfirm) return;
    const row = detail.rows.find((r) => r.id === aliasConfirm.rowId);
    if (!row) return;
    // Confirmación humana del vínculo = force explícito + remember.
    onAssign(
      row,
      aliasConfirm.orderId,
      true,
      aliasConfirm.nameSnapshot,
      aliasConfirm.nameSource,
      true
    );
  }

  function onSearch(rowId: string) {
    setError(null);
    startTransition(async () => {
      const res = await searchManualOrders({
        remittanceId: detail.id,
        rowId,
        query: searchQ,
        allTransports,
      });
      if (!res.ok) {
        setError(res.message);
        setHits([]);
        return;
      }
      setHits(res.hits);
    });
  }

  function openCorrectModal(row: RemittanceRowDetail) {
    setError(null);
    setInfo(null);
    setHits([]);
    setSearchQ(row.rawCustomerNameText);
    setAllTransports(false);
    setCorrectModal({
      row,
      selected: null,
      reason: "",
      rememberAlias: false,
      forceWarnings: null,
    });
  }

  function runCorrect(force: boolean) {
    if (!correctModal?.selected) return;
    const reason = correctModal.reason.trim();
    if (!reason) {
      setError("Indicá el motivo de la corrección.");
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await correctConfirmedAssignment({
        remittanceId: detail.id,
        rowId: correctModal.row.id,
        newOrderId: correctModal.selected!.id,
        reason,
        force,
        matchedNameSnapshot:
          correctModal.selected!.labelName ||
          correctModal.selected!.titularName ||
          null,
        matchedNameSource: correctModal.selected!.labelName
          ? "label"
          : correctModal.selected!.titularName
            ? "titular"
            : null,
        rememberAlias: correctModal.rememberAlias,
        rawAliasText: correctModal.row.rawCustomerNameText,
      });
      if (!res.ok) {
        if (res.code === "needs_force") {
          setCorrectModal({
            ...correctModal,
            forceWarnings: res.warnings ?? [],
          });
          return;
        }
        setError(res.message || "No se pudo corregir.");
        return;
      }
      setCorrectModal(null);
      setHits([]);
      setInfo(res.message || "Asignación corregida.");
      refresh();
    });
  }

  function runVoid() {
    if (!voidModal) return;
    const reason = voidModal.reason.trim();
    if (!reason) {
      setError("Indicá el motivo de la anulación.");
      return;
    }
    if (voidModal.confirmText.trim().toUpperCase() !== "ANULAR") {
      setError('Para confirmar, escribí ANULAR en el campo de confirmación.');
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await voidConfirmedRemittance({
        remittanceId: detail.id,
        reason,
      });
      if (!res.ok) {
        setError(res.message || "No se pudo anular.");
        return;
      }
      setVoidModal(null);
      setInfo(res.message || "Rendición anulada.");
      refresh();
    });
  }

  return (
    <div className={styles.shell}>
      <Link href="/admin/conciliacion-reembolso" className={styles.backLink}>
        ← Volver al dashboard
      </Link>
      <header className={styles.header}>
        <span className={`${styles.statusBadge} ${styles.statusBadgeBlock} ${statusBadgeClass(detail.status)}`}>
          {statusLabel(detail.status)}
        </span>
        <h1 className={styles.title}>
          {detail.transportName ?? "Transporte"} · {formatDateAr(detail.remittanceDate)}
        </h1>
        <p className={styles.subtitle}>
          {isConfirmed
            ? "Rendición confirmada. Los pagos ya no figuran como pendientes."
            : isVoided
              ? "Rendición anulada (solo lectura)."
              : analyzed
                ? "Revisión y aprobación. Sin efecto financiero hasta confirmar."
                : "Borrador. Analizá para buscar coincidencias."}
        </p>
        {detail.sheetRevision > 1 ? (
          <p className={styles.cardHint}>
            Revisión de planilla {detail.sheetRevision}
            {detail.sheetEditCount > 0 ? ` · ${detail.sheetEditCount} edición(es)` : ""}
          </p>
        ) : null}
      </header>

      {editedFlash ? (
        <div className={styles.matchSummary} style={{ marginBottom: 14 }} role="status">
          <p className={styles.matchSummaryTitle}>Planilla actualizada</p>
          <p className={styles.cardHint}>
            Se creó una nueva revisión. Volvé a analizar coincidencias.
          </p>
        </div>
      ) : null}

      {analysisInvalidatedFlash && !editedFlash ? (
        <div className={styles.matchSummary} style={{ marginBottom: 14 }} role="status">
          <p className={styles.matchSummaryTitle}>Análisis invalidado</p>
          <p className={styles.cardHint}>Hay que volver a analizar tras editar la planilla.</p>
        </div>
      ) : null}

      {isConfirmed ? (
        <div className={styles.matchSummary} style={{ marginBottom: 14 }}>
          <p className={styles.matchSummaryTitle}>Rendición confirmada</p>
          <div className={styles.confirmHero}>
            <div className={styles.confirmHeroItem}>
              <span>Pagos conciliados</span>
              <strong>
                {detail.rows.filter((r) =>
                  ["confirmed_matched", "confirmed_with_irregularity"].includes(r.rowStatus)
                ).length || detail.rowCount}
              </strong>
            </div>
            <div className={styles.confirmHeroItem}>
              <span>Total</span>
              <strong>{formatPriceAr(detail.reportedTotal)}</strong>
            </div>
          </div>
          {canVoid ? (
            <div className={styles.phase5Actions} style={{ marginTop: 12 }}>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnGhost}`}
                disabled={pending}
                onClick={() => setVoidModal({ reason: "", confirmText: "" })}
              >
                Anular rendición
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {isVoided ? (
        <div className={styles.errorBox} style={{ marginBottom: 14 }}>
          <p>
            <strong>Rendición anulada</strong>
          </p>
          <p className={styles.cardHint}>
            {detail.voidedAt
              ? `Fecha: ${new Date(detail.voidedAt).toLocaleString("es-AR")}`
              : null}
            {detail.voidReason ? ` · Motivo: ${detail.voidReason}` : null}
          </p>
          <p className={styles.cardHint}>
            Los pagos de esta planilla ya no cuentan como conciliados. Solo lectura.
          </p>
        </div>
      ) : null}

      <div className={styles.secondaryRow}>
        <div className={styles.secondaryItem}>
          <span>Filas</span>
          <strong>{detail.rowCount}</strong>
        </div>
        <div className={styles.secondaryItem}>
          <span>Total informado</span>
          <strong>{formatPriceAr(detail.reportedTotal)}</strong>
        </div>
        <div className={styles.secondaryItem}>
          <span>Total calculado</span>
          <strong>{formatPriceAr(detail.calculatedTotal ?? 0)}</strong>
        </div>
      </div>

      {canAnalyze || canEditSheet ? (
        <div className={styles.analyzeBar}>
          {canEditSheet ? (
            <Link
              href={`/admin/conciliacion-reembolso/remesas/${detail.id}/editar`}
              className={styles.btn}
            >
              Editar planilla
            </Link>
          ) : null}
          {canAnalyze ? (
            <button
              type="button"
              className={`${styles.btn} ${styles.btnPrimary}`}
              disabled={pending}
              onClick={() => run(() => analyzeRemittance(detail.id))}
            >
              {pending ? "Analizando…" : analyzed ? "Reanalizar" : "Analizar coincidencias"}
            </button>
          ) : null}
        </div>
      ) : null}

      {error ? <p className={styles.errorText}>{error}</p> : null}
      {info ? <p className={styles.cardHint}>{info}</p> : null}

      {analyzed ? (
        <>
          <div className={styles.matchSummary}>
            <p className={styles.matchSummaryTitle}>{counts.total} registros</p>
            <ul className={styles.matchSummaryList}>
              <li>✅ {counts.auto} seguras</li>
              <li>⚠️ {counts.review} para revisar</li>
              <li>❌ {counts.unassigned} sin identificar</li>
              <li>☑️ {counts.approved} aprobadas (pend. confirmar)</li>
              {counts.classified > 0 ? (
                <li>🧾 {counts.classified} diferencia del transporte</li>
              ) : null}
            </ul>
          </div>

          {canEdit && !readOnly ? (
            <div className={styles.analyzeBar}>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnPrimary}`}
                disabled={pending || counts.auto === 0}
                onClick={() => run(() => approveAutoMatched(detail.id))}
              >
                Aprobar seguras ({counts.auto})
              </button>
            </div>
          ) : null}

          {canEdit && !readOnly && preview.canConfirm ? (
            <div className={styles.confirmPreview}>
              <p className={styles.matchSummaryTitle}>Resumen previo a confirmar</p>
              <div className={styles.confirmHero}>
                <div className={styles.confirmHeroItem}>
                  <span>Pagos a conciliar</span>
                  <strong>{preview.approved}</strong>
                </div>
                <div className={styles.confirmHeroItem}>
                  <span>Monto</span>
                  <strong>{formatPriceAr(preview.assignedAmount)}</strong>
                </div>
              </div>
              <ul className={styles.matchSummaryList}>
                <li>
                  {preview.exact} exactos · {preview.withDiff} con diferencia ·{" "}
                  {preview.unassigned} sin identificar
                  {preview.classified > 0
                    ? ` · ${preview.classified} diferencia transporte`
                    : ""}
                </li>
                <li>
                  A favor: +{formatPriceAr(preview.diffPos)} · En contra:{" "}
                  {formatPriceAr(preview.diffNeg)} · Neto: {formatPriceAr(preview.net)}
                </li>
              </ul>
              <p className={styles.cardHint}>
                Al confirmar, estos pagos se marcarán como conciliados y dejarán de figurar como
                pendientes.
                {preview.classified > 0
                  ? " Las filas de diferencia del transporte no se confirman como COD: quedan como crédito a favor del transporte."
                  : ""}
              </p>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnConfirmFinance}`}
                disabled={pending}
                onClick={() => setConfirmOpen(true)}
              >
                CONFIRMAR RENDICIÓN
              </button>
            </div>
          ) : null}

          {confirmOpen ? (
            <div className={styles.modalBackdrop} role="dialog" aria-modal="true">
              <div className={styles.modalCard}>
                <div className={styles.modalHeader}>
                  <h3>Confirmar rendición</h3>
                </div>
                <div className={styles.modalBody}>
                  <p>
                    Al confirmar: <strong>{preview.approved}</strong> pagos quedarán vinculados
                    definitivamente; <strong>{preview.withDiff}</strong> generarán reclamos;{" "}
                    <strong>{preview.unassigned}</strong> permanecerán sin identificar
                    {preview.classified > 0 ? (
                      <>
                        ; <strong>{preview.classified}</strong> quedan como diferencia del
                        transporte (no COD)
                      </>
                    ) : null}
                    .
                  </p>
                  <p className={styles.cardHint}>
                    Esta es la acción financiera definitiva. Los pagos dejarán de figurar como
                    pendientes.
                  </p>
                </div>
                <div className={styles.modalFooter}>
                  <button
                    type="button"
                    className={styles.btn}
                    disabled={pending}
                    onClick={() => setConfirmOpen(false)}
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnConfirmFinance}`}
                    disabled={pending}
                    onClick={() => {
                      setConfirmOpen(false);
                      run(() => confirmRemittance(detail.id));
                    }}
                  >
                    Confirmar {preview.approved} pagos
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          {forceWarnings ? (
            <div className={styles.modalBackdrop} role="dialog" aria-modal="true">
              <div className={styles.modalCard}>
                <div className={styles.modalHeader}>
                  <h3>Asignar igualmente</h3>
                </div>
                <div className={styles.modalBody}>
                  <ul>
                    {forceWarnings.warnings.map((w, i) => (
                      <li key={i}>{w.message || w.code}</li>
                    ))}
                  </ul>
                </div>
                <div className={styles.modalFooter}>
                  <button
                    type="button"
                    className={styles.btn}
                    onClick={() => setForceWarnings(null)}
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnPrimary}`}
                    disabled={pending}
                    onClick={() => {
                      const row = detail.rows.find((r) => r.id === forceWarnings.rowId);
                      if (!row) return;
                      onAssign(
                        row,
                        forceWarnings.orderId,
                        true,
                        forceWarnings.nameSnapshot,
                        forceWarnings.nameSource,
                        false
                      );
                    }}
                  >
                    Asignar igualmente
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          {aliasConfirm ? (
            <div className={styles.modalBackdrop} role="dialog" aria-modal="true">
              <div className={`${styles.modalCard} ${styles.aliasConfirmCard}`}>
                <div className={styles.modalHeader}>
                  <h3>Confirmar vinculación</h3>
                </div>
                <div className={styles.modalBody}>
                <div className={styles.aliasBlock}>
                  <p className={styles.aliasBlockLabel}>
                    Informado por {detail.transportName ?? "el transporte"}
                  </p>
                  <p className={styles.aliasBlockTitle}>{aliasConfirm.rawAlias}</p>
                  <p className={styles.cardHint}>
                    {formatDateAr(aliasConfirm.parsedTransportDate)}
                    {aliasConfirm.parsedAmount != null
                      ? ` · ${formatPriceAr(aliasConfirm.parsedAmount)}`
                      : ""}
                  </p>
                </div>

                <p className={styles.aliasArrow} aria-hidden>
                  ↓
                </p>

                <div className={styles.aliasBlock}>
                  <p className={styles.aliasBlockLabel}>Vincular con</p>
                  <p className={styles.aliasBlockTitle}>
                    {aliasConfirm.preview.customerName ?? "—"}
                  </p>
                  <p className={styles.cardHint}>
                    Cliente #
                    {aliasConfirm.preview.customerNumber ??
                      aliasConfirm.preview.customerId.slice(0, 8).toUpperCase()}
                    {" · "}
                    Pedido {aliasConfirm.preview.orderNumber ?? "—"}
                  </p>
                  <p className={styles.cardHint}>
                    {aliasConfirm.preview.orderSentDate
                      ? formatDateAr(aliasConfirm.preview.orderSentDate)
                      : "—"}
                    {aliasConfirm.preview.expectedAmount != null
                      ? ` · ${formatPriceAr(aliasConfirm.preview.expectedAmount)}`
                      : ""}
                  </p>
                </div>

                <ul className={styles.aliasMetaList}>
                  {aliasConfirm.parsedAmount != null &&
                  aliasConfirm.preview.expectedAmount != null ? (
                    <li>
                      {
                        amountDiffLabel(
                          Math.round(
                            (aliasConfirm.parsedAmount -
                              aliasConfirm.preview.expectedAmount) *
                              100
                          ) / 100
                        ).long
                      }
                    </li>
                  ) : null}
                  {aliasConfirm.parsedAmount != null &&
                  aliasConfirm.preview.expectedAmount != null &&
                  Math.abs(
                    aliasConfirm.parsedAmount - aliasConfirm.preview.expectedAmount
                  ) >= 0.005 ? (
                    <li>
                      Al confirmar la rendición se generará un reclamo por esta diferencia.
                    </li>
                  ) : (
                    <li>✓ Monto exacto — sin reclamo por diferencia.</li>
                  )}
                </ul>

                <p className={styles.aliasFootnote}>
                  Si marcás recordar, «{aliasConfirm.rawAlias}» quedará como alias COD de este
                  cliente para {detail.transportName ?? "este transporte"} (aparte de
                  sub-nombres del maestro).
                </p>
                </div>
                <div className={styles.modalFooter}>
                  <button
                    type="button"
                    className={styles.btn}
                    disabled={pending}
                    onClick={() => setAliasConfirm(null)}
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnPrimary}`}
                    disabled={pending}
                    onClick={() => confirmAliasLink()}
                  >
                    Aprobar y recordar
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          <div className={styles.tabs} role="tablist">
            {(
              [
                ["all", "Todas", counts.total] as const,
                ["auto_matched", "Seguras", counts.auto] as const,
                ["needs_review", "Revisar", counts.review] as const,
                ["unassigned", "Sin identificar", counts.unassigned] as const,
                ["approved_pending_confirmation", "Aprobadas", counts.approved] as const,
                ...(counts.classified > 0
                  ? ([["classified_adjustment", "Diferencias", counts.classified] as const])
                  : []),
              ]
            ).map(([key, label, count]) => (
              <button
                key={key}
                type="button"
                role="tab"
                className={tab === key ? styles.tabActive : styles.tab}
                aria-selected={tab === key}
                onClick={() => setTab(key)}
              >
                {label}
                <span className={styles.tabCount}>{count}</span>
              </button>
            ))}
          </div>

          <div className={styles.matchList}>
            {filtered.map((r) => {
              const open = expanded.has(r.id);
              const candidates = parseCandidates(r);
              const namePts = readBreakdownNum(r.matchBreakdown, ["name", "points"]);
              const datePts = readBreakdownNum(r.matchBreakdown, ["date", "points"]);
              const amountPts = readBreakdownNum(r.matchBreakdown, ["amount", "points"]);
              const transportPts = readBreakdownNum(r.matchBreakdown, ["transport", "points"]);
              const editableRow =
                canEdit &&
                !readOnly &&
                ["auto_matched", "needs_review", "unassigned", "approved_pending_confirmation"].includes(
                  r.rowStatus
                );

              return (
                <article key={r.id} className={styles.matchCard}>
                  <button
                    type="button"
                    className={styles.matchCardHead}
                    onClick={() => toggleExpand(r.id)}
                    aria-expanded={open}
                  >
                    <div>
                      <p className={styles.matchCardTitle}>{r.rawCustomerNameText}</p>
                      <p className={styles.matchCardMeta}>
                        {formatDateAr(r.parsedTransportDate)} ·{" "}
                        {r.parsedAmount != null ? formatPriceAr(r.parsedAmount) : "—"}
                        {r.orderNumberSnapshot ? (
                          <>
                            <span className={styles.matchArrow}>→</span>
                            {r.orderNumberSnapshot}
                          </>
                        ) : null}
                      </p>
                    </div>
                    <span
                      className={
                        r.rowStatus === "auto_matched" || r.rowStatus === "confirmed_matched"
                          ? styles.badgeOk
                          : r.rowStatus === "needs_review" ||
                              r.rowStatus === "approved_pending_confirmation"
                            ? styles.badgeWarn
                            : styles.badgeDanger
                      }
                    >
                      {confidenceFromRow(r)}
                    </span>
                  </button>

                  {open ? (
                    <div className={styles.matchCardBody}>
                      <p>
                        <strong>{r.rawCustomerNameText}</strong>
                      </p>
                      <p className={styles.cardHint}>
                        Fecha: {formatDateAr(r.parsedTransportDate)} · Monto:{" "}
                        {r.parsedAmount != null ? formatPriceAr(r.parsedAmount) : "—"}
                        {detail.transportName ? ` · ${detail.transportName}` : ""}
                      </p>
                      {alreadyUsedLoading[r.id] ? (
                        <p className={styles.cardHint}>
                          Buscando coincidencias ya conciliadas…
                        </p>
                      ) : null}
                      {alreadyUsedError[r.id] ? (
                        <p className={styles.cardHint}>{alreadyUsedError[r.id]}</p>
                      ) : null}
                      {(() => {
                        const alreadyUsed = alreadyUsedForRow(r);
                        if (!alreadyUsed) return null;
                        return (
                          <AlreadyUsedOrderBanner
                            hit={alreadyUsed}
                            remittanceId={detail.id}
                            rowId={r.id}
                            rowParsedAmount={r.parsedAmount}
                            remittanceStatus={detail.status}
                            onApproved={() => {
                              router.refresh();
                            }}
                          />
                        );
                      })()}

                      {r.matchedOrderId ? (
                        <div className={styles.linkExplain}>
                          <p className={styles.linkExplainLabel}>Nombre informado por el transporte</p>
                          <p className={styles.linkExplainName}>{r.rawCustomerNameText}</p>
                          <p className={styles.linkExplainArrow} aria-hidden="true">
                            ↓
                          </p>
                          <p className={styles.linkExplainLabel}>Posible vinculación</p>
                          <p className={styles.linkExplainName}>
                            {r.orderNumberSnapshot ?? "—"} ·{" "}
                            {(() => {
                              const main = parseCandidates(r).find(
                                (c) => c.orderId === r.matchedOrderId
                              );
                              return main
                                ? candidatePrimaryName(main)
                                : r.matchedNameSnapshot ?? "Cliente del pedido";
                            })()}
                          </p>
                          <p className={styles.cardHint}>
                            {r.matchedNameSource === "sub_name"
                              ? `✓ Sub-nombre reconocido: ${r.matchedNameSnapshot}`
                              : r.matchBreakdown?.["autoMatchReason"] === "transport_alias" &&
                                  r.matchBreakdown?.["aliasRaw"]
                                ? `✓ Nombre reconocido para este cliente en ${
                                    detail.transportName ?? "transporte"
                                  }: ${String(r.matchBreakdown["aliasRaw"])}`
                                : r.matchedNameSnapshot &&
                                    r.matchedNameSource &&
                                    r.matchedNameSource !== "titular"
                                  ? `Coincidencia por: ${r.matchedNameSnapshot}`
                                  : `Match por ${nameSourceHuman(r.matchedNameSource)}`}
                            {r.matchBreakdown?.["rescueReason"] ===
                            "strong_identity_weak_amount"
                              ? " · ⚠ Revisión obligatoria (monto distinto)"
                              : ""}
                          </p>
                          <p className={styles.cardHint}>
                            Fecha pedido: {formatDateAr(r.orderSentDateSnapshot)} · Monto pedido:{" "}
                            {r.expectedAmountSnapshot != null
                              ? formatPriceAr(r.expectedAmountSnapshot)
                              : "—"}
                            {r.transportNameSnapshot
                              ? ` · ${r.transportNameSnapshot}`
                              : detail.transportName
                                ? ` · ${detail.transportName}`
                                : ""}
                          </p>
                          <ul className={styles.signalList}>
                            <li>
                              {signalName(namePts, r.matchedNameSource)}
                              {namePts != null ? (
                                <span className={styles.signalPts}> {namePts}/40</span>
                              ) : null}
                            </li>
                            <li>
                              {signalDate(
                                datePts,
                                readBreakdownNum(r.matchBreakdown, ["date", "dayDiff"])
                              )}
                              {datePts != null ? (
                                <span className={styles.signalPts}> {datePts}/30</span>
                              ) : null}
                            </li>
                            <li>
                              {signalAmount(
                                amountPts,
                                r.expectedAmountSnapshot != null &&
                                  r.parsedAmount != null &&
                                  Math.abs(r.parsedAmount - r.expectedAmountSnapshot) < 0.005,
                                r.expectedAmountSnapshot != null && r.parsedAmount != null
                                  ? Math.round(
                                      (r.parsedAmount - r.expectedAmountSnapshot) * 100
                                    ) / 100
                                  : null
                              )}
                              {amountPts != null ? (
                                <span className={styles.signalPts}> {amountPts}/25</span>
                              ) : null}
                            </li>
                            <li>
                              {signalTransport(
                                transportPts,
                                Boolean(r.transportMismatch),
                                r.transportNameSnapshot ?? detail.transportName
                              )}
                            </li>
                          </ul>
                          {r.matchScore != null ? (
                            <p className={styles.cardHint}>Score (secundario): {r.matchScore}</p>
                          ) : null}
                          {r.willCreateIrregularity &&
                          r.expectedAmountSnapshot != null &&
                          r.parsedAmount != null ? (
                            <div className={styles.irregularityHint}>
                              <p>
                                Esperado: {formatPriceAr(r.expectedAmountSnapshot)} · Informado:{" "}
                                {formatPriceAr(r.parsedAmount)}
                              </p>
                              <p>
                                {
                                  amountDiffLabel(
                                    Math.round(
                                      (r.parsedAmount - r.expectedAmountSnapshot) * 100
                                    ) / 100
                                  ).long
                                }
                              </p>
                              <p className={styles.cardHint}>
                                Al confirmar la rendición se generará un reclamo por esta diferencia.
                              </p>
                            </div>
                          ) : null}
                        </div>
                      ) : alreadyUsedForRow(r) ? (
                        <p className={styles.cardHint}>
                          No hay candidato seleccionable: el pedido más compatible ya está
                          vinculado (ver aviso arriba). Los TOP de abajo son solo pedidos
                          disponibles.
                        </p>
                      ) : (
                        <p>Sin candidato principal.</p>
                      )}

                      {candidates.length > 0 ? (
                        <div className={styles.candidateList}>
                          <p className={styles.cardLabel}>TOP candidatos</p>
                          {candidates.slice(0, 3).map((c, idx) => {
                            const diff = candidateAmountDiff(c, r.parsedAmount);
                            const diffLab = amountDiffLabel(diff);
                            const matchHint = candidateMatchByHint(c, {
                              transportName: c.transportName ?? detail.transportName,
                              aliasRaw:
                                r.matchedOrderId === c.orderId &&
                                r.matchBreakdown?.["autoMatchReason"] === "transport_alias"
                                  ? String(r.matchBreakdown?.["aliasRaw"] ?? "")
                                  : null,
                            });
                            return (
                              <div key={`${c.orderId}-${idx}`} className={styles.candidateCard}>
                                <div className={styles.candidateCardMain}>
                                  <p className={styles.candidateOrder}>
                                    {c.orderNumber ?? c.orderId?.slice(0, 8) ?? "—"}
                                  </p>
                                  <p className={styles.candidateName}>
                                    {candidatePrimaryName(c)}
                                  </p>
                                  {matchHint ? (
                                    <p className={styles.cardHint}>{matchHint}</p>
                                  ) : null}
                                  <p className={styles.cardHint}>
                                    {formatDateArIso(c.effectiveSentDate)} ·{" "}
                                    {c.expectedAmount != null
                                      ? formatPriceAr(c.expectedAmount)
                                      : "—"}
                                    {c.transportName ? ` · ${c.transportName}` : ""}
                                  </p>
                                  {diff != null && diffLab.kind !== "exact" ? (
                                    <p className={styles.candidateDiff}>
                                      {diffLab.short}
                                      {r.parsedAmount != null ? (
                                        <span>
                                          {" "}
                                          (inf. {formatPriceAr(r.parsedAmount)})
                                        </span>
                                      ) : null}
                                    </p>
                                  ) : null}
                                  {c.score != null ? (
                                    <p className={styles.candidateScore}>Score {c.score}</p>
                                  ) : null}
                                </div>
                                {editableRow &&
                                c.orderId &&
                                !c.warningApprovedElsewhere &&
                                !(idx === 0 && r.matchedOrderId === c.orderId) ? (
                                  <button
                                    type="button"
                                    className={styles.btn}
                                    disabled={pending}
                                    onClick={() => onAssign(r, c.orderId!, false)}
                                  >
                                    Elegir este
                                  </button>
                                ) : c.warningApprovedElsewhere ? (
                                  <span className={styles.muted}>En otra rendición</span>
                                ) : null}
                              </div>
                            );
                          })}
                        </div>
                      ) : null}

                      {editableRow ? (
                        <div className={styles.phase5Actions}>
                          {r.matchedOrderId &&
                          (r.rowStatus === "auto_matched" ||
                            r.rowStatus === "needs_review") ? (
                            <>
                              <button
                                type="button"
                                className={`${styles.btn} ${styles.btnPrimary}`}
                                disabled={pending}
                                onClick={() => onAssign(r, r.matchedOrderId!, false)}
                              >
                                Aprobar candidato
                              </button>
                              <button
                                type="button"
                                className={styles.btn}
                                disabled={pending}
                                onClick={() =>
                                  onAssign(r, r.matchedOrderId!, false, undefined, undefined, true)
                                }
                                title={`Recordar «${r.rawCustomerNameText}» para este cliente en ${detail.transportName ?? "este transporte"}`}
                              >
                                Aprobar y recordar nombre
                              </button>
                            </>
                          ) : null}
                          <button
                            type="button"
                            className={styles.btn}
                            disabled={pending}
                            onClick={() => {
                              setSearchRowId(r.id);
                              setSearchQ("");
                              setHits([]);
                            }}
                          >
                            Buscar / asignar pedido
                          </button>
                          <button
                            type="button"
                            className={styles.btn}
                            disabled={pending}
                            onClick={() =>
                              run(() => markRowUnassigned(detail.id, r.id))
                            }
                          >
                            Dejar sin identificar
                          </button>
                          <button
                            type="button"
                            className={styles.btn}
                            disabled={pending}
                            onClick={() =>
                              setAdjustmentModal({
                                row: r,
                                kind: "paid_other_method",
                                observation: "",
                              })
                            }
                          >
                            Registrar incongruencia
                          </button>
                        </div>
                      ) : null}

                      {r.rowStatus === "classified_adjustment" ? (
                        <div className={styles.infoBox}>
                          <p>
                            <strong>Registrado como diferencia del transporte</strong>
                          </p>
                          <p>
                            A favor de {detail.transportName ?? "transporte"}
                            {r.parsedAmount != null ? ` · ${formatPriceAr(r.parsedAmount)}` : ""}
                          </p>
                          {r.activeAdjustmentKind ? (
                            <p>Motivo: {kindLabel(r.activeAdjustmentKind)}</p>
                          ) : null}
                          <p className={styles.muted}>
                            No es pago COD. Sin asignar / sin identificar / complementary mientras
                            el ajuste esté activo.
                          </p>
                          {canEdit && r.activeAdjustmentId ? (
                            <button
                              type="button"
                              className={styles.btn}
                              disabled={pending}
                              onClick={() =>
                                run(() =>
                                  voidTransportAdjustment({
                                    adjustmentId: r.activeAdjustmentId!,
                                    remittanceId: detail.id,
                                    reason: "Reclasificación V1",
                                  })
                                )
                              }
                            >
                              Anular clasificación
                            </button>
                          ) : null}
                        </div>
                      ) : null}

                      {canCorrect &&
                      (r.rowStatus === "confirmed_matched" ||
                        r.rowStatus === "confirmed_with_irregularity") ? (
                        <div className={styles.phase5Actions}>
                          <button
                            type="button"
                            className={`${styles.btn} ${styles.btnGhost}`}
                            disabled={pending}
                            onClick={() => openCorrectModal(r)}
                          >
                            Corregir asignación
                          </button>
                        </div>
                      ) : null}

                      {searchRowId === r.id ? (
                        <div className={styles.manualSearch}>
                          <p className={styles.cardHint}>
                            Buscá por nombre o por Nº de pedido exacto (ej. A54945).
                          </p>
                          <div className={styles.manualSearchRow}>
                            <input
                              value={searchQ}
                              onChange={(e) => setSearchQ(e.target.value)}
                              placeholder="Nombre o Nº pedido (ej. A54945)"
                              disabled={pending}
                              autoCapitalize="characters"
                            />
                            <label className={styles.muted}>
                              <input
                                type="checkbox"
                                checked={allTransports}
                                onChange={(e) => setAllTransports(e.target.checked)}
                              />{" "}
                              Todos los transportes
                            </label>
                            <button
                              type="button"
                              className={styles.btn}
                              disabled={pending || !searchQ.trim()}
                              onClick={() => onSearch(r.id)}
                            >
                              Buscar
                            </button>
                          </div>
                          {hits.length === 0 && searchQ.trim() ? (
                            <p className={styles.cardHint}>
                              Sin resultados todavía — pulsá Buscar.
                            </p>
                          ) : null}
                          {hits.map((h) => {
                            const displayName =
                              h.titularName || h.labelName || "Cliente sin nombre";
                            const diff =
                              r.parsedAmount != null
                                ? Math.round((r.parsedAmount - h.expectedAmount) * 100) /
                                  100
                                : null;
                            const diffLab = amountDiffLabel(diff);
                            return (
                              <div key={h.id} className={styles.candidateCard}>
                                <div className={styles.candidateCardMain}>
                                  <p className={styles.candidateOrder}>
                                    {h.orderNumber ?? "—"} · {displayName}
                                  </p>
                                  {h.customerNumber ? (
                                    <p className={styles.cardHint}>
                                      Cliente #{h.customerNumber}
                                    </p>
                                  ) : null}
                                  <p className={styles.cardHint}>
                                    Fecha pedido: {formatDateAr(h.effectiveSentDate)}
                                  </p>
                                  <p className={styles.cardHint}>
                                    Monto pedido: {formatPriceAr(h.expectedAmount)}
                                  </p>
                                  <p className={styles.cardHint}>
                                    Transporte: {h.transportName ?? "—"}
                                  </p>
                                  {r.parsedAmount != null ? (
                                    <p className={styles.cardHint}>
                                      Informado: {formatPriceAr(r.parsedAmount)}
                                      {diff != null && diffLab.kind !== "exact"
                                        ? ` · Diferencia: ${formatSignedPriceAr(diff)}`
                                        : diffLab.kind === "exact"
                                          ? " · Monto exacto"
                                          : ""}
                                    </p>
                                  ) : null}
                                  {h.assignmentBlocked ? (
                                    <p className={styles.diffAlert}>
                                      {h.blockReason === "not_cod"
                                        ? `No asignable: ${h.warnings[0] ?? "fuera del universo COD"}`
                                        : h.blockReason === "already_confirmed"
                                          ? "⚠ Ya rendido — no se puede asignar de nuevo"
                                          : h.blockReason === "approved_pending"
                                            ? "⚠ Ya aprobado en otra rendición"
                                            : `⚠ ${h.warnings.join(" · ") || "No asignable"}`}
                                      {h.occupancy?.otherRemittanceDate
                                        ? ` · Rendición ${formatDateAr(h.occupancy.otherRemittanceDate)}`
                                        : ""}
                                      {h.occupancy?.otherReportedAmount != null
                                        ? ` · Informado ${formatPriceAr(h.occupancy.otherReportedAmount)}`
                                        : ""}
                                    </p>
                                  ) : h.warnings.length ? (
                                    <p className={styles.cardHint}>
                                      ⚠ {h.warnings.join(", ")}
                                    </p>
                                  ) : null}
                                </div>
                                {!h.assignmentBlocked ? (
                                  <>
                                    <button
                                      type="button"
                                      className={styles.btn}
                                      disabled={pending}
                                      onClick={() => onAssign(r, h.id, false)}
                                    >
                                      Asignar
                                    </button>
                                    <button
                                      type="button"
                                      className={styles.btn}
                                      disabled={pending}
                                      onClick={() =>
                                        onAssign(r, h.id, false, undefined, undefined, true)
                                      }
                                      title={`Recordar «${r.rawCustomerNameText}» para este cliente en ${detail.transportName ?? "este transporte"}`}
                                    >
                                      Asignar y recordar
                                    </button>
                                  </>
                                ) : (
                                  <span className={styles.muted}>No asignable</span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </article>
              );
            })}
          </div>
        </>
      ) : (
        <>
          <h2 className={styles.sectionTitle}>Filas originales</h2>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>#</th>
                  <th>Fecha</th>
                  <th>Nombre</th>
                  <th>Monto</th>
                </tr>
              </thead>
              <tbody>
                {detail.rows.map((r) => (
                  <tr key={r.id}>
                    <td className={styles.mono}>{r.rowIndex + 1}</td>
                    <td>{r.rawTransportDateText}</td>
                    <td>{r.rawCustomerNameText}</td>
                    <td className={styles.mono}>{r.rawAmountText}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {correctModal ? (
        <div className={styles.modalBackdrop} role="dialog" aria-modal="true">
          <div className={styles.modalCard}>
            <div className={styles.modalHeader}>
              <h3>Corregir pago asignado</h3>
            </div>
            <div className={styles.modalBody}>
              <p className={styles.cardHint}>
                Esto cambia qué pedido se considera pagado. El anterior vuelve a pendiente.
              </p>
              <p>
                <strong>Actualmente vinculado a</strong>
              </p>
              <p>
                Pedido {correctModal.row.orderNumberSnapshot ?? "—"}
                {correctModal.row.expectedAmountSnapshot != null
                  ? ` · Esperado ${formatPriceAr(correctModal.row.expectedAmountSnapshot)}`
                  : ""}
                {correctModal.row.parsedAmount != null
                  ? ` · Informado ${formatPriceAr(correctModal.row.parsedAmount)}`
                  : ""}
              </p>
              <p className={styles.cardHint}>{correctModal.row.rawCustomerNameText}</p>

              {!correctModal.selected ? (
                <>
                  <p className={styles.cardLabel}>Cambiar a</p>
                  <div className={styles.manualSearchRow}>
                    <input
                      value={searchQ}
                      onChange={(e) => setSearchQ(e.target.value)}
                      placeholder="Nombre o Nº pedido (ej. A54945)"
                      disabled={pending}
                    />
                    <label className={styles.muted}>
                      <input
                        type="checkbox"
                        checked={allTransports}
                        onChange={(e) => setAllTransports(e.target.checked)}
                      />{" "}
                      Todos los transportes
                    </label>
                    <button
                      type="button"
                      className={styles.btn}
                      disabled={pending || !searchQ.trim()}
                      onClick={() => onSearch(correctModal.row.id)}
                    >
                      Buscar
                    </button>
                  </div>
                  {hits.map((h) => (
                    <div key={h.id} className={styles.candidateRow}>
                      <span>
                        {h.orderNumber} · {h.titularName || h.labelName || "—"} ·{" "}
                        {formatPriceAr(h.expectedAmount)} ·{" "}
                        {formatDateAr(h.effectiveSentDate)} · {h.transportName ?? "—"}
                        {h.assignmentBlocked
                          ? ` · ⛔ ${h.warnings[0] ?? "No asignable"}`
                          : h.warnings.length
                            ? ` · ⚠ ${h.warnings.join(", ")}`
                            : ""}
                      </span>
                      <button
                        type="button"
                        className={styles.btn}
                        disabled={
                          pending ||
                          h.assignmentBlocked ||
                          h.id === correctModal.row.matchedOrderId
                        }
                        onClick={() =>
                          setCorrectModal({
                            ...correctModal,
                            selected: h,
                            forceWarnings: null,
                          })
                        }
                      >
                        {h.assignmentBlocked ? "No asignable" : "Elegir"}
                      </button>
                    </div>
                  ))}
                </>
              ) : (
                <>
                  <p>
                    <strong>Nuevo pedido</strong>
                  </p>
                  <p>
                    {correctModal.selected.orderNumber} · Esperado{" "}
                    {formatPriceAr(correctModal.selected.expectedAmount)} · Informado{" "}
                    {correctModal.row.parsedAmount != null
                      ? formatPriceAr(correctModal.row.parsedAmount)
                      : "—"}
                  </p>
                  {correctModal.row.parsedAmount != null &&
                  Math.abs(
                    correctModal.row.parsedAmount - correctModal.selected.expectedAmount
                  ) >= 0.005 ? (
                    <div className={styles.irregularityHint}>
                      <p>
                        Esta corrección generará una irregularidad de{" "}
                        {formatPriceAr(
                          Math.round(
                            (correctModal.row.parsedAmount -
                              correctModal.selected.expectedAmount) *
                              100
                          ) / 100
                        )}
                        .
                      </p>
                    </div>
                  ) : null}
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnGhost}`}
                    disabled={pending}
                    onClick={() =>
                      setCorrectModal({
                        ...correctModal,
                        selected: null,
                        forceWarnings: null,
                      })
                    }
                  >
                    Cambiar pedido
                  </button>
                  <label className={styles.cardLabel} htmlFor="correct-reason">
                    Motivo de corrección (obligatorio)
                  </label>
                  <textarea
                    id="correct-reason"
                    value={correctModal.reason}
                    onChange={(e) =>
                      setCorrectModal({ ...correctModal, reason: e.target.value })
                    }
                    rows={3}
                    disabled={pending}
                    placeholder="Ej.: Pago vinculado al pedido equivocado; correspondía al A59025."
                    style={{ width: "100%", marginTop: 6 }}
                  />
                  <label className={styles.muted} style={{ display: "block", marginTop: 10 }}>
                    <input
                      type="checkbox"
                      checked={correctModal.rememberAlias}
                      onChange={(e) =>
                        setCorrectModal({
                          ...correctModal,
                          rememberAlias: e.target.checked,
                        })
                      }
                      disabled={pending}
                    />{" "}
                    Recordar este nombre para este cliente
                  </label>
                  {correctModal.forceWarnings ? (
                    <div className={styles.irregularityHint} style={{ marginTop: 10 }}>
                      <p>
                        <strong>Advertencias</strong>
                      </p>
                      <ul>
                        {correctModal.forceWarnings.map((w, i) => (
                          <li key={i}>{w.message || w.code}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </>
              )}
            </div>
            <div className={styles.modalFooter}>
              <button
                type="button"
                className={styles.btn}
                disabled={pending}
                onClick={() => {
                  setCorrectModal(null);
                  setHits([]);
                }}
              >
                Cancelar
              </button>
              {correctModal.selected ? (
                <button
                  type="button"
                  className={`${styles.btn} ${styles.btnPrimary}`}
                  disabled={pending || !correctModal.reason.trim()}
                  onClick={() => runCorrect(!!correctModal.forceWarnings)}
                >
                  {correctModal.forceWarnings
                    ? "Confirmar igualmente"
                    : "Confirmar corrección"}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {voidModal ? (
        <div className={styles.modalBackdrop} role="dialog" aria-modal="true">
          <div className={styles.modalCard}>
            <div className={styles.modalHeader}>
              <h3>Anular rendición</h3>
            </div>
            <div className={styles.modalBody}>
              <p>
                Esta acción hará que los pagos de esta rendición dejen de considerarse
                conciliados y los pedidos vuelvan a figurar como pendientes.
              </p>
              <p className={styles.cardHint}>
                {detail.transportName ?? "Transporte"} · {formatDateAr(detail.remittanceDate)}
              </p>
              <ul>
                <li>
                  Pagos conciliados: <strong>{voidPreview.reconciledCount}</strong>
                </li>
                <li>
                  Monto conciliado (esperado):{" "}
                  <strong>{formatPriceAr(voidPreview.amount)}</strong>
                </li>
                <li>
                  Con irregularidad: <strong>{voidPreview.withIrreg}</strong>
                </li>
                <li>
                  Sin identificar: <strong>{voidPreview.unassigned}</strong>
                </li>
              </ul>
              <label className={styles.cardLabel} htmlFor="void-reason">
                Motivo de anulación (obligatorio)
              </label>
              <textarea
                id="void-reason"
                value={voidModal.reason}
                onChange={(e) => setVoidModal({ ...voidModal, reason: e.target.value })}
                rows={3}
                disabled={pending}
                placeholder="Ej.: Planilla cargada dos veces por error."
                style={{ width: "100%", marginTop: 6 }}
              />
              <label className={styles.cardLabel} htmlFor="void-confirm" style={{ marginTop: 12 }}>
                Escribí ANULAR para confirmar
              </label>
              <input
                id="void-confirm"
                value={voidModal.confirmText}
                onChange={(e) =>
                  setVoidModal({ ...voidModal, confirmText: e.target.value })
                }
                disabled={pending}
                placeholder="ANULAR"
                style={{ width: "100%", marginTop: 6 }}
                autoComplete="off"
              />
            </div>
            <div className={styles.modalFooter}>
              <button
                type="button"
                className={styles.btn}
                disabled={pending}
                onClick={() => setVoidModal(null)}
              >
                Cancelar
              </button>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnPrimary}`}
                disabled={
                  pending ||
                  !voidModal.reason.trim() ||
                  voidModal.confirmText.trim().toUpperCase() !== "ANULAR"
                }
                onClick={() => runVoid()}
              >
                Anular rendición
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {adjustmentModal ? (
        <div className={styles.modalBackdrop} role="dialog" aria-modal="true" aria-labelledby="adj-modal-title">
          <div className={styles.modalCard}>
            <div className={styles.modalHeader}>
              <h3 id="adj-modal-title">Registrar incongruencia</h3>
            </div>
            <div className={styles.modalBody}>
              <p>
                <strong>{adjustmentModal.row.rawCustomerNameText}</strong>
                {adjustmentModal.row.parsedAmount != null
                  ? ` · ${formatPriceAr(adjustmentModal.row.parsedAmount)}`
                  : ""}
              </p>
              <p className={styles.cardHint}>
                Se registrará a favor de {detail.transportName ?? "el transporte"}. No modifica el
                pedido ni lo marca como Contra Reembolso.
              </p>
              <label className={styles.cardLabel} htmlFor="adj-kind" style={{ display: "block", marginTop: 12 }}>
                Tipo
              </label>
              <select
                id="adj-kind"
                value={adjustmentModal.kind}
                disabled={pending}
                onChange={(e) =>
                  setAdjustmentModal({
                    ...adjustmentModal,
                    kind: e.target.value as AdjustmentKind,
                  })
                }
                style={{ width: "100%", marginTop: 6, padding: "8px 10px" }}
              >
                {ADJUSTMENT_KIND_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <label
                className={styles.cardLabel}
                htmlFor="adj-obs"
                style={{ display: "block", marginTop: 12 }}
              >
                Observación (opcional)
              </label>
              <textarea
                id="adj-obs"
                value={adjustmentModal.observation}
                onChange={(e) =>
                  setAdjustmentModal({
                    ...adjustmentModal,
                    observation: e.target.value,
                  })
                }
                rows={3}
                disabled={pending}
                placeholder="Ej: pedido Pagado / cliente ajeno / error de planilla"
                style={{ width: "100%", marginTop: 6 }}
              />
            </div>
            <div className={styles.modalFooter}>
              <button
                type="button"
                className={styles.btn}
                disabled={pending}
                onClick={() => setAdjustmentModal(null)}
              >
                Cancelar
              </button>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnPrimary}`}
                disabled={pending}
                onClick={() => {
                  const row = adjustmentModal.row;
                  const kind = adjustmentModal.kind;
                  const observation = adjustmentModal.observation;
                  setAdjustmentModal(null);
                  run(() =>
                    registerTransportAdjustment({
                      remittanceId: detail.id,
                      rowId: row.id,
                      kind,
                      observation,
                      orderId: row.matchedOrderId,
                    })
                  );
                }}
              >
                Registrar a favor del transporte
                {adjustmentModal.row.parsedAmount != null
                  ? ` · ${formatPriceAr(adjustmentModal.row.parsedAmount)}`
                  : ""}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
