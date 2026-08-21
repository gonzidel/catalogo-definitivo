"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { formatPriceAr } from "@/lib/orders/domain";
import {
  analyzeRemittance,
  approveAutoMatched,
  assignRemittanceRow,
  confirmRemittance,
  correctConfirmedAssignment,
  markRowUnassigned,
  previewAliasLinkForOrder,
  searchManualOrders,
  voidConfirmedRemittance,
} from "@/lib/reconciliation/actions";
import type { AliasLinkPreview } from "@/lib/reconciliation/actions";
import type { ManualOrderHit } from "@/lib/reconciliation/manual-search";
import type { RemittanceDetail, RemittanceRowDetail } from "@/lib/reconciliation/remittance-queries";
import styles from "@/app/admin/conciliacion-reembolso/conciliacion.module.css";

type FilterTab =
  | "all"
  | "auto_matched"
  | "needs_review"
  | "unassigned"
  | "approved_pending_confirmation";

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

type CandidateLite = {
  orderId?: string;
  orderNumber?: string | null;
  score?: number;
  matchedNameSource?: string | null;
  nameSource?: string | null;
};

function parseCandidates(row: RemittanceRowDetail): CandidateLite[] {
  if (!Array.isArray(row.matchCandidates)) return [];
  return row.matchCandidates as CandidateLite[];
}

export default function RemittanceDetailView({
  detail,
  canEdit,
}: {
  detail: RemittanceDetail;
  canEdit: boolean;
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

  const counts = useMemo(() => {
    const auto = detail.rows.filter((r) => r.rowStatus === "auto_matched").length;
    const review = detail.rows.filter((r) => r.rowStatus === "needs_review").length;
    const unassigned = detail.rows.filter((r) => r.rowStatus === "unassigned").length;
    const approved = detail.rows.filter(
      (r) => r.rowStatus === "approved_pending_confirmation"
    ).length;
    return { auto, review, unassigned, approved, total: detail.rows.length };
  }, [detail.rows]);

  const preview = useMemo(() => {
    const approved = detail.rows.filter(
      (r) => r.rowStatus === "approved_pending_confirmation"
    );
    const unassigned = detail.rows.filter((r) => r.rowStatus === "unassigned");
    let exact = 0;
    let withDiff = 0;
    let diffPos = 0;
    let diffNeg = 0;
    let assignedAmount = 0;
    let unassignedAmount = 0;
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
    const undecided = detail.rows.filter((r) =>
      ["auto_matched", "needs_review", "pending_analysis"].includes(r.rowStatus)
    ).length;
    return {
      approved: approved.length,
      exact,
      withDiff,
      unassigned: unassigned.length,
      undecided,
      reportedTotal: detail.reportedTotal,
      assignedAmount,
      unassignedAmount,
      diffPos,
      diffNeg,
      net: Math.round((diffPos + diffNeg) * 100) / 100,
      canConfirm:
        detail.status === "analyzed" &&
        undecided === 0 &&
        detail.rows.every((r) =>
          ["approved_pending_confirmation", "unassigned"].includes(r.rowStatus)
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
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
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
      </header>

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

      {canAnalyze ? (
        <div className={styles.analyzeBar}>
          <button
            type="button"
            className={`${styles.btn} ${styles.btnPrimary}`}
            disabled={pending}
            onClick={() => run(() => analyzeRemittance(detail.id))}
          >
            {pending ? "Analizando…" : analyzed ? "Reanalizar" : "Analizar coincidencias"}
          </button>
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
                </li>
                <li>
                  A favor: +{formatPriceAr(preview.diffPos)} · En contra:{" "}
                  {formatPriceAr(preview.diffNeg)} · Neto: {formatPriceAr(preview.net)}
                </li>
              </ul>
              <p className={styles.cardHint}>
                Al confirmar, estos pagos se marcarán como conciliados y dejarán de figurar como
                pendientes.
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
                    <strong>{preview.unassigned}</strong> permanecerán sin identificar.
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
                  <p className={styles.aliasBlockLabel}>Nombre informado por el transporte</p>
                  <p className={styles.aliasBlockTitle}>{aliasConfirm.rawAlias}</p>
                  <p className={styles.cardHint}>
                    Transporte: {detail.transportName ?? "—"}
                  </p>
                </div>

                <p className={styles.aliasArrow} aria-hidden>
                  ↓
                </p>

                <div className={styles.aliasBlock}>
                  <p className={styles.aliasBlockLabel}>Se vinculará con</p>
                  <p className={styles.aliasBlockTitle}>
                    {aliasConfirm.preview.customerName ?? "—"}
                  </p>
                  <p className={styles.cardHint}>
                    Cliente: #
                    {aliasConfirm.preview.customerNumber ??
                      aliasConfirm.preview.customerId.slice(0, 8).toUpperCase()}
                  </p>
                  <p className={styles.cardHint}>
                    Pedido: {aliasConfirm.preview.orderNumber ?? "—"}
                  </p>
                </div>

                <ul className={styles.aliasMetaList}>
                  <li>
                    Fecha planilla: {formatDateAr(aliasConfirm.parsedTransportDate)}
                  </li>
                  <li>
                    Monto informado:{" "}
                    {aliasConfirm.parsedAmount != null
                      ? formatPriceAr(aliasConfirm.parsedAmount)
                      : "—"}
                  </li>
                  {aliasConfirm.preview.orderSentDate ? (
                    <li>
                      Fecha pedido: {formatDateAr(aliasConfirm.preview.orderSentDate)}
                      {aliasConfirm.parsedTransportDate ===
                      aliasConfirm.preview.orderSentDate
                        ? " ✓"
                        : ""}
                    </li>
                  ) : null}
                  {aliasConfirm.preview.expectedAmount != null ? (
                    <li>
                      Monto pedido: {formatPriceAr(aliasConfirm.preview.expectedAmount)}
                      {aliasConfirm.parsedAmount != null &&
                      Math.abs(
                        aliasConfirm.parsedAmount - aliasConfirm.preview.expectedAmount
                      ) < 0.005
                        ? " ✓"
                        : ""}
                    </li>
                  ) : null}
                </ul>

                <p className={styles.aliasFootnote}>
                  Esta vinculación quedará guardada para futuras rendiciones de{" "}
                  {detail.transportName ?? "este transporte"}.
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
                ["all", "Todas", counts.total],
                ["auto_matched", "Seguras", counts.auto],
                ["needs_review", "Revisar", counts.review],
                ["unassigned", "Sin identificar", counts.unassigned],
                ["approved_pending_confirmation", "Aprobadas", counts.approved],
              ] as const
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
                      {r.matchedOrderId ? (
                        <>
                          {r.rowStatus === "auto_matched" &&
                          r.matchBreakdown?.autoMatchReason === "transport_alias" ? (
                            <div className={styles.irregularityHint}>
                              <p>
                                <strong>Nombre reconocido por alias</strong>
                              </p>
                              <p>
                                {String(r.matchBreakdown.aliasRaw ?? r.rawCustomerNameText)} →
                                cliente vinculado
                              </p>
                              <p className={styles.cardHint}>
                                Pedido: {r.orderNumberSnapshot ?? "—"}
                              </p>
                            </div>
                          ) : r.rowStatus === "auto_matched" &&
                            r.matchBreakdown?.autoMatchReason ===
                              "unique_financial_logistics" ? (
                            <div className={styles.irregularityHint}>
                              <p>
                                <strong>Coincidencia segura</strong>
                              </p>
                              <p>Monto, fecha y transporte exactos · único pedido compatible</p>
                              {r.matchedNameSnapshot ? (
                                <p className={styles.cardHint}>
                                  Nombre similar: {r.rawCustomerNameText} → {r.matchedNameSnapshot}
                                </p>
                              ) : null}
                              <p className={styles.cardHint}>
                                Pedido: {r.orderNumberSnapshot ?? "—"}
                              </p>
                            </div>
                          ) : (
                            <p>
                              Candidato: <strong>{r.orderNumberSnapshot ?? "—"}</strong> · Match
                              por {nameSourceLabel(r.matchedNameSource)}
                            </p>
                          )}
                          <ul className={styles.scoreLines}>
                            <li>Nombre: {namePts ?? "—"}/40</li>
                            <li>Fecha: {datePts ?? "—"}/30</li>
                            <li>Monto: {amountPts ?? "—"}/25</li>
                            <li>Transporte: {transportPts ?? "—"}</li>
                          </ul>
                          {r.matchScore != null ? (
                            <p className={styles.cardHint}>Score: {r.matchScore}</p>
                          ) : null}
                          {r.willCreateIrregularity &&
                          r.expectedAmountSnapshot != null &&
                          r.parsedAmount != null ? (
                            <div className={styles.irregularityHint}>
                              <p>Esperado: {formatPriceAr(r.expectedAmountSnapshot)}</p>
                              <p>Informado: {formatPriceAr(r.parsedAmount)}</p>
                              <p>
                                Diferencia:{" "}
                                {formatPriceAr(
                                  Math.round(
                                    (r.parsedAmount - r.expectedAmountSnapshot) * 100
                                  ) / 100
                                )}
                              </p>
                            </div>
                          ) : null}
                        </>
                      ) : (
                        <p>Sin candidato principal.</p>
                      )}

                      {candidates.length > 0 ? (
                        <div className={styles.candidateList}>
                          <p className={styles.cardLabel}>TOP candidatos</p>
                          {candidates.slice(0, 3).map((c, idx) => (
                            <div key={`${c.orderId}-${idx}`} className={styles.candidateRow}>
                              <span>
                                {c.orderNumber ?? c.orderId?.slice(0, 8)} · score {c.score ?? "—"}
                              </span>
                              {editableRow &&
                              c.orderId &&
                              !(idx === 0 && r.matchedOrderId === c.orderId) ? (
                                <button
                                  type="button"
                                  className={styles.btn}
                                  disabled={pending}
                                  onClick={() => onAssign(r, c.orderId!, false)}
                                >
                                  Elegir este
                                </button>
                              ) : null}
                            </div>
                          ))}
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
                              setSearchQ(r.rawCustomerNameText);
                              setHits([]);
                            }}
                          >
                            Buscar manualmente
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
                          <div className={styles.manualSearchRow}>
                            <input
                              value={searchQ}
                              onChange={(e) => setSearchQ(e.target.value)}
                              placeholder="Nombre o N° pedido"
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
                              onClick={() => onSearch(r.id)}
                            >
                              Buscar
                            </button>
                          </div>
                          {hits.map((h) => (
                            <div key={h.id} className={styles.candidateRow}>
                              <span>
                                {h.orderNumber} · {formatPriceAr(h.expectedAmount)} ·{" "}
                                {formatDateAr(h.effectiveSentDate)} · {h.transportName ?? "—"}
                                {h.warnings.length
                                  ? ` · ⚠ ${h.warnings.join(", ")}`
                                  : ""}
                              </span>
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
                            </div>
                          ))}
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
                      placeholder="Nombre o N° pedido"
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
                        {h.orderNumber} · {formatPriceAr(h.expectedAmount)} ·{" "}
                        {formatDateAr(h.effectiveSentDate)} · {h.transportName ?? "—"}
                        {h.warnings.length ? ` · ⚠ ${h.warnings.join(", ")}` : ""}
                      </span>
                      <button
                        type="button"
                        className={styles.btn}
                        disabled={pending || h.id === correctModal.row.matchedOrderId}
                        onClick={() =>
                          setCorrectModal({
                            ...correctModal,
                            selected: h,
                            forceWarnings: null,
                          })
                        }
                      >
                        Elegir
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
    </div>
  );
}
