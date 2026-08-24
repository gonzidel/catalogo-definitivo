"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { formatPriceAr } from "@/lib/orders/domain";
import {
  assignConfirmedUnassignedRow,
  previewAliasLinkForOrder,
  searchManualOrders,
  type AliasLinkPreview,
} from "@/lib/reconciliation/actions";
import type { ManualOrderHit } from "@/lib/reconciliation/manual-search";
import type { UnassignedConfirmedRow } from "@/lib/reconciliation/unassigned-queries";
import styles from "@/app/admin/conciliacion-reembolso/conciliacion.module.css";

function formatDateAr(iso: string | null): string {
  if (!iso) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-");
  if (!y || !m || !d) return iso;
  return `${d}/${m}/${y}`;
}

type AssignTarget = {
  row: UnassignedConfirmedRow;
  hit: ManualOrderHit;
  rememberAlias: boolean;
  preview: AliasLinkPreview | null;
};

export default function UnassignedPaymentsPanel({
  items,
  canEdit,
}: {
  items: UnassignedConfirmedRow[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  const [activeRowId, setActiveRowId] = useState<string | null>(null);
  const [searchQ, setSearchQ] = useState("");
  const [allTransports, setAllTransports] = useState(false);
  const [hits, setHits] = useState<ManualOrderHit[]>([]);

  const [confirm, setConfirm] = useState<AssignTarget | null>(null);
  const [forceWarnings, setForceWarnings] = useState<{
    target: AssignTarget;
    warnings: Array<{ code?: string; message?: string }>;
  } | null>(null);

  function openSearch(row: UnassignedConfirmedRow) {
    setActiveRowId(row.id);
    setSearchQ(row.rawCustomerNameText);
    setHits([]);
    setError(null);
    setInfo(null);
  }

  function runSearch(row: UnassignedConfirmedRow) {
    setError(null);
    startTransition(async () => {
      const res = await searchManualOrders({
        remittanceId: row.remittanceId,
        rowId: row.id,
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

  function openConfirm(
    row: UnassignedConfirmedRow,
    hit: ManualOrderHit,
    rememberAlias: boolean
  ) {
    setError(null);
    startTransition(async () => {
      let preview: AliasLinkPreview | null = null;
      if (rememberAlias) {
        const prev = await previewAliasLinkForOrder({ orderId: hit.id });
        if (!prev.ok) {
          setError(prev.message || "No se pudo cargar el cliente.");
          return;
        }
        preview = prev.preview;
      }
      setConfirm({ row, hit, rememberAlias, preview });
    });
  }

  function doAssign(target: AssignTarget, force: boolean) {
    setError(null);
    setInfo(null);
    startTransition(async () => {
      const res = await assignConfirmedUnassignedRow({
        remittanceId: target.row.remittanceId,
        rowId: target.row.id,
        orderId: target.hit.id,
        force,
        rememberAlias: target.rememberAlias,
        rawAliasText: target.row.rawCustomerNameText,
      });

      if (!res.ok && res.code === "needs_force") {
        setConfirm(null);
        setForceWarnings({ target, warnings: res.warnings ?? [] });
        return;
      }
      if (!res.ok) {
        setError(res.message);
        return;
      }

      setConfirm(null);
      setForceWarnings(null);
      setActiveRowId(null);
      setHits([]);
      setInfo(res.message || "Pago asignado.");
      router.refresh();
    });
  }

  const amountDiff =
    confirm && confirm.row.parsedAmount != null
      ? Math.round((confirm.row.parsedAmount - confirm.hit.expectedAmount) * 100) / 100
      : null;

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <p className={styles.eyebrow}>Admin · Contra reembolso</p>
        <h1 className={styles.title}>Pagos sin identificar</h1>
        <p className={styles.subtitle}>
          Filas de rendiciones ya confirmadas que quedaron sin pedido. Asignarlas concilia el pago
          de inmediato.
        </p>
        <div className={styles.headerActions}>
          <Link href="/admin/conciliacion-reembolso" className={styles.btn}>
            Volver al dashboard
          </Link>
        </div>
      </header>

      {error ? <p className={styles.errorBox}>{error}</p> : null}
      {info ? <p className={styles.infoBox}>{info}</p> : null}

      {items.length === 0 ? (
        <div className={`${styles.tableWrap} ${styles.empty}`}>
          No hay pagos sin identificar en rendiciones confirmadas.
        </div>
      ) : (
        <div className={styles.matchList}>
          {items.map((row) => (
            <article key={row.id} className={styles.matchCard}>
              <div className={styles.matchCardHead} style={{ cursor: "default" }}>
                <div>
                  <p className={styles.matchCardTitle}>{row.rawCustomerNameText}</p>
                  <p className={styles.matchCardMeta}>
                    {formatDateAr(row.parsedTransportDate)} ·{" "}
                    {row.parsedAmount != null ? formatPriceAr(row.parsedAmount) : row.rawAmountText}
                    {" · "}
                    {row.transportName ?? "—"}
                  </p>
                  <p className={styles.cardHint}>
                    Rendición {formatDateAr(row.remittanceDate)} · fila #{row.rowIndex + 1} ·{" "}
                    <Link href={`/admin/conciliacion-reembolso/remesas/${row.remittanceId}`}>
                      ver rendición
                    </Link>
                  </p>
                </div>
                {canEdit ? (
                  <button
                    type="button"
                    className={`${styles.btn} ${styles.btnPrimary}`}
                    disabled={pending}
                    onClick={() => openSearch(row)}
                  >
                    Asignar a pedido
                  </button>
                ) : null}
              </div>

              {activeRowId === row.id ? (
                <div className={styles.matchCardBody}>
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
                      onClick={() => runSearch(row)}
                    >
                      Buscar
                    </button>
                  </div>

                  {hits.map((h) => (
                    <div key={h.id} className={styles.candidateRow}>
                      <span>
                        {h.orderNumber} · {h.titularName || h.labelName || "—"}
                        {h.customerNumber ? ` · #${h.customerNumber}` : ""} ·{" "}
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
                        className={`${styles.btn} ${styles.btnPrimary}`}
                        disabled={pending || h.assignmentBlocked}
                        onClick={() => openConfirm(row, h, false)}
                      >
                        {h.assignmentBlocked ? "No asignable" : "Asignar pago"}
                      </button>
                      {!h.assignmentBlocked ? (
                        <button
                          type="button"
                          className={styles.btn}
                          disabled={pending}
                          onClick={() => openConfirm(row, h, true)}
                        >
                          Asignar y recordar
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}
            </article>
          ))}
        </div>
      )}

      {confirm ? (
        <div className={styles.modalBackdrop} role="dialog" aria-modal="true">
          <div className={`${styles.modalCard} ${styles.aliasConfirmCard}`}>
            <div className={styles.modalHeader}>
              <h3>Asignar pago</h3>
            </div>
            <div className={styles.modalBody}>
              <div className={styles.aliasBlock}>
                <p className={styles.aliasBlockLabel}>Nombre informado por el transporte</p>
                <p className={styles.aliasBlockTitle}>{confirm.row.rawCustomerNameText}</p>
                <p className={styles.cardHint}>
                  {formatDateAr(confirm.row.parsedTransportDate)} ·{" "}
                  {confirm.row.parsedAmount != null
                    ? formatPriceAr(confirm.row.parsedAmount)
                    : "—"}
                </p>
              </div>
              <p className={styles.aliasArrow} aria-hidden>
                ↓
              </p>
              <div className={styles.aliasBlock}>
                <p className={styles.aliasBlockLabel}>Se asignará a</p>
                <p className={styles.aliasBlockTitle}>
                  Pedido {confirm.hit.orderNumber ?? confirm.hit.id.slice(0, 8)}
                </p>
                <p className={styles.cardHint}>
                  Cliente:{" "}
                  {confirm.preview?.customerName ??
                    confirm.hit.titularName ??
                    confirm.hit.labelName ??
                    "—"}
                </p>
                <p className={styles.cardHint}>
                  Esperado: {formatPriceAr(confirm.hit.expectedAmount)} · Informado:{" "}
                  {confirm.row.parsedAmount != null
                    ? formatPriceAr(confirm.row.parsedAmount)
                    : "—"}
                </p>
              </div>
              {amountDiff != null && Math.abs(amountDiff) >= 0.005 ? (
                <p className={styles.irregularityHint}>
                  Se generará una irregularidad de{" "}
                  {amountDiff > 0 ? "+" : ""}
                  {formatPriceAr(amountDiff)}.
                </p>
              ) : null}
              {confirm.rememberAlias ? (
                <p className={styles.aliasFootnote}>
                  También se recordará «{confirm.row.rawCustomerNameText}» para{" "}
                  {confirm.row.transportName ?? "este transporte"}.
                </p>
              ) : null}
              <p className={styles.cardHint}>
                Esta acción concilia el pedido de inmediato. La rendición sigue confirmada.
              </p>
            </div>
            <div className={styles.modalFooter}>
              <button
                type="button"
                className={styles.btn}
                disabled={pending}
                onClick={() => setConfirm(null)}
              >
                Cancelar
              </button>
              <button
                type="button"
                className={`${styles.btn} ${styles.btnPrimary}`}
                disabled={pending}
                onClick={() => doAssign(confirm, false)}
              >
                Asignar pago
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
              <p className={styles.cardHint}>
                Confirmá solo si el pedido es el correcto. La conciliación será inmediata.
              </p>
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
                onClick={() => doAssign(forceWarnings.target, true)}
              >
                Asignar igualmente
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
