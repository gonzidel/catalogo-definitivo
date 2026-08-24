"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { formatPriceAr } from "@/lib/orders/domain";
import { updateIrregularityStatus } from "@/lib/reconciliation/actions";
import type { IrregularityDetail } from "@/lib/reconciliation/irregularity-queries";
import { amountDiffLabel } from "@/lib/reconciliation/match-presentation";
import styles from "@/app/admin/conciliacion-reembolso/conciliacion.module.css";

function formatDateAr(iso: string | null): string {
  if (!iso) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-");
  if (!y || !m || !d) return iso;
  return `${d}/${m}/${y}`;
}

function formatTs(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("es-AR");
  } catch {
    return iso;
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case "open":
      return "Abierto";
    case "in_review":
      return "En revisión";
    case "resolved":
      return "Resuelto";
    case "superseded":
      return "Invalidado";
    default:
      return status;
  }
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case "open":
      return styles.statusDraft;
    case "in_review":
      return styles.statusAnalyzed;
    case "resolved":
      return styles.statusConfirmed;
    case "superseded":
      return styles.statusVoided;
    default:
      return styles.statusDraft;
  }
}

function eventLabel(type: string): string {
  switch (type) {
    case "irregularity_created":
      return "Reclamo creado";
    case "irregularity_review_started":
      return "Pasó a revisión";
    case "irregularity_resolved":
      return "Reclamo resuelto";
    default:
      return type;
  }
}

export default function IrregularityDetailView({
  detail,
  canEdit,
}: {
  detail: IrregularityDetail;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [resolveOpen, setResolveOpen] = useState(false);
  const [notes, setNotes] = useState("");

  const readOnly =
    detail.status === "resolved" || detail.status === "superseded" || !canEdit;
  const canReview = canEdit && detail.status === "open";
  const canResolve =
    canEdit && (detail.status === "open" || detail.status === "in_review");

  function markInReview() {
    setError(null);
    setInfo(null);
    startTransition(async () => {
      const res = await updateIrregularityStatus({
        irregularityId: detail.id,
        newStatus: "in_review",
      });
      if (!res.ok) {
        setError(res.message);
        return;
      }
      setInfo(res.message || "Reclamo marcado en revisión.");
      router.refresh();
    });
  }

  function resolveClaim() {
    setError(null);
    setInfo(null);
    startTransition(async () => {
      const res = await updateIrregularityStatus({
        irregularityId: detail.id,
        newStatus: "resolved",
        resolutionNotes: notes,
      });
      if (!res.ok) {
        setError(res.message);
        return;
      }
      setResolveOpen(false);
      setNotes("");
      setInfo(res.message || "Reclamo resuelto.");
      router.refresh();
    });
  }

  return (
    <div className={styles.shell}>
      <Link href="/admin/conciliacion-reembolso/irregularidades" className={styles.backLink}>
        ← Volver a irregularidades
      </Link>

      <header className={styles.header}>
        <span
          className={`${styles.statusBadge} ${styles.statusBadgeBlock} ${statusBadgeClass(detail.status)}`}
        >
          {statusLabel(detail.status)}
        </span>
        <h1 className={styles.title}>
          Reclamo · {detail.orderNumber ?? detail.orderId.slice(0, 8)}
        </h1>
        <p className={styles.subtitle}>
          {detail.customerName ?? "Sin cliente"}
          {detail.customerNumber ? ` · #${detail.customerNumber}` : ""}
          {" · "}
          {detail.transportName ?? "—"}
        </p>
      </header>

      {error ? <p className={styles.errorBox}>{error}</p> : null}
      {info ? <p className={styles.infoBox}>{info}</p> : null}

      <div className={styles.confirmHero}>
        <div className={styles.confirmHeroItem}>
          <span>Esperado</span>
          <strong>{formatPriceAr(detail.expectedAmount)}</strong>
        </div>
        <div className={styles.confirmHeroItem}>
          <span>Rendido</span>
          <strong>{formatPriceAr(detail.reportedAmount)}</strong>
        </div>
      </div>

      <div className={styles.card} style={{ marginBottom: 14 }}>
        <p className={styles.cardMeta}>
          {amountDiffLabel(detail.amountDiff).long}
          {detail.amountDiffPct != null ? ` · ${detail.amountDiffPct}%` : ""}
        </p>
        <p className={styles.cardMeta}>
          Fecha salida: {formatDateAr(detail.orderSentDate)}
        </p>
        <p className={styles.cardMeta}>
          Fecha rendición: {formatDateAr(detail.remittanceDate)}
        </p>
        <p className={styles.cardMeta}>
          Rendición:{" "}
          <Link href={`/admin/conciliacion-reembolso/remesas/${detail.remittanceId}`}>
            ver rendición
          </Link>
        </p>
        <p className={styles.cardMeta}>Creado: {formatTs(detail.createdAt)}</p>
        {detail.resolvedAt ? (
          <p className={styles.cardMeta}>Resuelto: {formatTs(detail.resolvedAt)}</p>
        ) : null}
        {detail.resolutionNote ? (
          <p className={styles.cardMeta}>
            Resolución: <em>{detail.resolutionNote}</em>
          </p>
        ) : null}
        {detail.status === "superseded" && detail.supersededReason ? (
          <p className={styles.cardHint}>
            Invalidado ({detail.supersededReason}) · {formatTs(detail.supersededAt)}
          </p>
        ) : null}
        <p className={styles.cardHint}>
          El pedido permanece conciliado. Resolver solo cierra el reclamo.
        </p>
      </div>

      {!readOnly || canReview || canResolve ? (
        <div className={styles.phase5Actions} style={{ marginBottom: 16 }}>
          {canResolve ? (
            <button
              type="button"
              className={`${styles.btn} ${styles.btnPrimary}`}
              disabled={pending}
              onClick={() => setResolveOpen(true)}
            >
              Resolver reclamo
            </button>
          ) : null}
          {canReview ? (
            <button
              type="button"
              className={styles.btn}
              disabled={pending}
              onClick={markInReview}
            >
              Marcar en revisión
            </button>
          ) : null}
        </div>
      ) : null}

      <h2 className={styles.sectionTitle}>Historial</h2>
      {detail.events.length === 0 ? (
        <p className={styles.muted}>Sin eventos registrados.</p>
      ) : (
        <ul className={styles.matchSummaryList}>
          {detail.events.map((e) => (
            <li key={e.id}>
              <strong>{eventLabel(e.eventType)}</strong>
              {e.previousStatus && e.newStatus
                ? ` · ${statusLabel(e.previousStatus)} → ${statusLabel(e.newStatus)}`
                : ""}
              {" · "}
              {formatTs(e.occurredAt)}
              {e.reason ? ` · ${e.reason}` : ""}
            </li>
          ))}
        </ul>
      )}

      {resolveOpen ? (
        <div className={styles.modalBackdrop} role="dialog" aria-modal="true">
          <div className={styles.modalCard}>
            <div className={styles.modalHeader}>
              <h3>Resolver reclamo</h3>
            </div>
            <div className={styles.modalBody}>
              <p>
                El pedido seguirá conciliado. Solo se cierra el reclamo como gestionado.
              </p>
              <div className={styles.filterGroup}>
                <label htmlFor="irr-notes">Observación / resolución (obligatoria)</label>
                <textarea
                  id="irr-notes"
                  className={styles.pasteTextarea}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  disabled={pending}
                  rows={4}
                  placeholder="Ej: SEDE reconoció la diferencia y pagó por transferencia"
                />
              </div>
            </div>
            <div className={styles.modalFooter}>
              <button
                type="button"
                className={styles.btn}
                disabled={pending}
                onClick={() => setResolveOpen(false)}
              >
                Cancelar
              </button>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnPrimary}`}
                disabled={pending || !notes.trim()}
                onClick={resolveClaim}
              >
                Confirmar resolución
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
