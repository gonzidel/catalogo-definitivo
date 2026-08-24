"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { formatPriceAr } from "@/lib/orders/domain";
import type { AlreadyUsedMatch } from "@/lib/reconciliation/already-used-match";
import {
  amountDiffLabel,
  formatDateArIso,
  nameSourceHuman,
} from "@/lib/reconciliation/match-presentation";
import { approveComplementaryPayment } from "@/lib/reconciliation/actions";
import styles from "@/app/admin/conciliacion-reembolso/conciliacion.module.css";

function irregLabel(status: AlreadyUsedMatch["irregularityStatus"]): string {
  switch (status) {
    case "open":
      return "Abierto";
    case "in_review":
      return "En revisión";
    case "resolved":
      return "Resuelto";
    case "superseded":
      return "Invalidado";
    case null:
      return "—";
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

function statusHuman(hit: AlreadyUsedMatch): string {
  if (hit.kind === "approved_pending") {
    return "Aprobado, pendiente de confirmar";
  }
  if (hit.kind === "confirmed_with_diff") {
    return "Conciliado con diferencia";
  }
  return "Conciliado correctamente";
}

export default function AlreadyUsedOrderBanner({
  hit,
  remittanceId,
  rowId,
  rowParsedAmount,
  remittanceStatus,
  onApproved,
}: {
  hit: AlreadyUsedMatch;
  remittanceId?: string;
  rowId?: string;
  rowParsedAmount?: number | null;
  remittanceStatus?: string;
  onApproved?: () => void;
}) {
  const same = hit.sameRemittance;
  const diffLab = amountDiffLabel(hit.amountDiff);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [approvedLocal, setApprovedLocal] = useState(false);

  const remaining = hit.remainingBalance;
  const reportedAccum = hit.activeReportedTotal;
  const expectedTotal = hit.expectedTotal ?? hit.expectedAmount;
  const thisPayment = rowParsedAmount ?? null;
  const hasShortage =
    remaining != null &&
    remaining > 0.005 &&
    hit.kind === "confirmed_with_diff" &&
    (hit.irregularityStatus === "open" || hit.irregularityStatus === "in_review");

  const exactComplement =
    hasShortage &&
    thisPayment != null &&
    Math.abs(thisPayment - remaining) < 0.005;
  const partialComplement =
    hasShortage &&
    thisPayment != null &&
    thisPayment > 0.005 &&
    thisPayment < remaining - 0.005;
  const excessComplement =
    hasShortage &&
    thisPayment != null &&
    thisPayment - remaining >= 0.005;

  const canShowCta =
    hasShortage &&
    !!remittanceId &&
    !!rowId &&
    remittanceStatus === "analyzed" &&
    !excessComplement &&
    thisPayment != null &&
    thisPayment > 0.005;

  const title = hasShortage
    ? "Pedido parcialmente rendido"
    : hit.kind === "approved_pending"
      ? "Pedido encontrado — ya vinculado (pendiente de confirmar)"
      : remaining != null && remaining <= 0.005
        ? "Pedido completamente rendido"
        : "Pedido encontrado — ya vinculado";

  let message: string;
  if (hit.kind === "approved_pending") {
    message = same
      ? "Este pedido ya está vinculado en una planilla pendiente de confirmar (esta misma planilla)."
      : "Este pedido ya está vinculado en una planilla pendiente de confirmar (otra planilla).";
  } else if (hasShortage) {
    message = same
      ? "Ya fue rendido parcialmente en esta misma planilla."
      : "Ya fue rendido parcialmente en otra planilla.";
  } else if (same) {
    message =
      hit.otherRowIndex != null
        ? `Ya fue rendido en esta misma planilla (fila #${hit.otherRowIndex}).`
        : "Ya fue rendido en esta misma planilla.";
  } else {
    message = "Ya fue rendido en otra planilla.";
  }

  function onApply() {
    if (!remittanceId || !rowId) return;
    setError(null);
    startTransition(async () => {
      const res = await approveComplementaryPayment({
        remittanceId,
        rowId,
        orderId: hit.orderId,
      });
      if (!res.ok) {
        setError(res.message);
        return;
      }
      setApprovedLocal(true);
      onApproved?.();
    });
  }

  return (
    <div className={styles.alreadyUsedBox} role="status">
      <p className={styles.alreadyUsedTitle}>{title}</p>

      <p className={styles.alreadyUsedOrder}>
        {hit.orderNumber ?? "—"}
        {hit.customerName ? ` · ${hit.customerName}` : ""}
      </p>
      <p className={styles.cardHint}>
        {hit.customerNumber ? `Cliente #${hit.customerNumber}` : "Cliente —"}
        {" · "}
        {formatDateArIso(hit.orderSentDate)}
        {hit.transportName ? ` · ${hit.transportName}` : ""}
      </p>

      <div className={styles.alreadyUsedMeta}>
        <p>
          <strong>Total pedido:</strong> {formatPriceAr(expectedTotal)}
        </p>
        <p>
          <strong>Rendido acumulado:</strong>{" "}
          {reportedAccum != null ? formatPriceAr(reportedAccum) : "—"}
        </p>
        <p>
          <strong>Saldo pendiente:</strong>{" "}
          {remaining != null ? formatPriceAr(Math.max(0, remaining)) : "—"}
        </p>
        {thisPayment != null ? (
          <p>
            <strong>Esta fila:</strong> {formatPriceAr(thisPayment)}
          </p>
        ) : null}
      </div>

      {exactComplement ? (
        <p className={styles.alreadyUsedMsg}>
          ✓ Completa exactamente el saldo pendiente
        </p>
      ) : null}
      {partialComplement && remaining != null && thisPayment != null ? (
        <p className={styles.alreadyUsedMsg}>
          Pago complementario parcial. Luego quedarán{" "}
          {formatPriceAr(Math.round((remaining - thisPayment) * 100) / 100)}{" "}
          pendientes.
        </p>
      ) : null}
      {excessComplement && remaining != null && thisPayment != null ? (
        <p className={styles.diffAlert}>
          El pago informado supera el saldo pendiente en{" "}
          {formatPriceAr(Math.round((thisPayment - remaining) * 100) / 100)}.
          Revisá la planilla antes de continuar.
        </p>
      ) : null}

      {hit.nameSource === "sub_name" && hit.matchedNameSnapshot ? (
        <p className={styles.cardHint}>
          ✓ Sub-nombre reconocido: {hit.matchedNameSnapshot}
        </p>
      ) : hit.nameSource ? (
        <p className={styles.cardHint}>
          Coincidencia por {nameSourceHuman(hit.nameSource)}
        </p>
      ) : null}

      <p className={styles.alreadyUsedMsg}>{message}</p>

      {same && hit.otherRowIndex != null ? (
        <div className={styles.alreadyUsedMeta}>
          <p>
            <strong>Fila #{hit.otherRowIndex}</strong>
            {hit.otherRawCustomerName ? ` · ${hit.otherRawCustomerName}` : ""}
            {hit.otherReportedAmount != null
              ? ` · ${formatPriceAr(hit.otherReportedAmount)}`
              : ""}
          </p>
        </div>
      ) : null}

      <div className={styles.alreadyUsedMeta}>
        {same ? (
          <p>
            <strong>Esta planilla:</strong>{" "}
            {formatDateArIso(hit.otherRemittanceDate)}
            {hit.otherTransportName ? ` · ${hit.otherTransportName}` : ""}
          </p>
        ) : (
          <>
            <p>
              <strong>Otra planilla:</strong>{" "}
              {formatDateArIso(hit.otherRemittanceDate)}
              {hit.otherTransportName ? ` · ${hit.otherTransportName}` : ""}
            </p>
            {hit.otherRemittanceId ? (
              <p>
                <Link
                  href={`/admin/conciliacion-reembolso/remesas/${hit.otherRemittanceId}`}
                >
                  Ver rendición
                </Link>
              </p>
            ) : null}
          </>
        )}

        <p>
          <strong>Estado:</strong> {statusHuman(hit)}
        </p>

        {(hit.kind === "confirmed_with_diff" ||
          (hit.amountDiff != null && Math.abs(hit.amountDiff) >= 0.005)) && (
          <>
            <p>
              Esperado: {formatPriceAr(hit.expectedAmount)}
              {hit.otherReportedAmount != null
                ? ` · Rendido: ${formatPriceAr(hit.otherReportedAmount)}`
                : ""}
            </p>
            {diffLab.kind === "faltante" || diffLab.kind === "sobrante" ? (
              <p className={styles.diffAlert}>{diffLab.long}</p>
            ) : null}
          </>
        )}

        {hit.irregularityStatus ? (
          <p>
            <strong>Reclamo:</strong> {irregLabel(hit.irregularityStatus)}
          </p>
        ) : null}
      </div>

      {approvedLocal ? (
        <p className={styles.alreadyUsedMsg}>
          Pago complementario aprobado · pendiente de confirmar la rendición.
        </p>
      ) : canShowCta ? (
        <div className={styles.alreadyUsedMeta}>
          <button
            type="button"
            className={styles.btnPrimary}
            disabled={pending}
            onClick={onApply}
          >
            {pending ? "Aplicando…" : "Aplicar al saldo pendiente"}
          </button>
          <p className={styles.cardHint}>
            No produce efecto financiero hasta Confirmar rendición.
          </p>
        </div>
      ) : null}

      {error ? <p className={styles.diffAlert}>{error}</p> : null}

      <p className={styles.cardHint}>
        No se puede elegir este pedido con “Elegir este”.
      </p>
    </div>
  );
}
