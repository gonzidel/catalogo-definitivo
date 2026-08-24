"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { formatPriceAr } from "@/lib/orders/domain";
import { compensateTransportDifferences } from "@/lib/reconciliation/actions";
import {
  formatDiffDate,
  kindLabel,
  type TransportDifferenceBalance,
  type DifferenceClaimItem,
  type DifferenceCreditItem,
} from "@/lib/reconciliation/difference-queries";
import styles from "@/app/admin/conciliacion-reembolso/conciliacion.module.css";

type Tab = "claims" | "credits" | "all";

function remittanceStatusLabel(status: string | null): string {
  switch (status) {
    case "confirmed":
      return "confirmada";
    case "analyzed":
      return "analizada";
    case "draft":
      return "borrador";
    case "voided":
      return "anulada";
    default:
      return status || "—";
  }
}

export default function TransportDifferencesPanel({
  balances,
  claims,
  credits,
  canEdit,
}: {
  balances: TransportDifferenceBalance[];
  claims: DifferenceClaimItem[];
  credits: DifferenceCreditItem[];
  canEdit: boolean;
}) {
  const [tab, setTab] = useState<Tab>("all");
  const [selectedClaims, setSelectedClaims] = useState<Set<string>>(new Set());
  const [selectedAdj, setSelectedAdj] = useState<Set<string>>(new Set());
  const [selectedSurplus, setSelectedSurplus] = useState<Set<string>>(new Set());
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const totalClaimSel = useMemo(
    () =>
      claims
        .filter((c) => selectedClaims.has(c.id))
        .reduce((s, c) => s + c.remainingAmount, 0),
    [claims, selectedClaims]
  );
  const totalCreditSel = useMemo(() => {
    const adj = credits
      .filter((c) => c.sourceType === "adjustment" && selectedAdj.has(c.id))
      .reduce((s, c) => s + c.remainingAmount, 0);
    const surplus = credits
      .filter((c) => c.sourceType === "irregularity" && selectedSurplus.has(c.id))
      .reduce((s, c) => s + c.remainingAmount, 0);
    return adj + surplus;
  }, [credits, selectedAdj, selectedSurplus]);

  const willApply = Math.min(totalClaimSel, totalCreditSel);

  function toggle(set: Set<string>, id: string, setter: (s: Set<string>) => void) {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setter(next);
  }

  function onCompensate(transportId: string) {
    setMsg(null);
    startTransition(async () => {
      const res = await compensateTransportDifferences({
        transportId,
        claimIds: [...selectedClaims],
        creditAdjustmentIds: [...selectedAdj],
        creditIrregularityIds: [...selectedSurplus],
        note: note.trim() || null,
      });
      if (!res.ok) {
        setMsg(res.message);
        return;
      }
      setMsg(res.message ?? "Compensación aplicada.");
      setSelectedClaims(new Set());
      setSelectedAdj(new Set());
      setSelectedSurplus(new Set());
      setNote("");
    });
  }

  const compensateTransportId = useMemo(() => {
    const fromClaims = claims
      .filter((c) => selectedClaims.has(c.id))
      .map((c) => c.transportId);
    if (fromClaims.length) return fromClaims[0]!;
    const fromCredits = [
      ...credits.filter((c) => selectedAdj.has(c.id)),
      ...credits.filter((c) => selectedSurplus.has(c.id)),
    ].map((c) => c.transportId);
    if (fromCredits.length) return fromCredits[0]!;
    return balances[0]?.transportId ?? null;
  }, [claims, credits, selectedClaims, selectedAdj, selectedSurplus, balances]);

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>Conciliación reembolso</p>
          <h1 className={styles.title}>Diferencias del transporte</h1>
          <p className={styles.subtitle}>
            A reclamar (faltantes COD) vs a favor del transporte (créditos no COD). La
            compensación netea saldos sin simular que el transporte pagó cada pedido.
          </p>
        </div>
        <div className={styles.headerActions}>
          <Link href="/admin/conciliacion-reembolso/irregularidades?legacy=1" className={styles.btn}>
            Reclamos COD (histórico)
          </Link>
          <Link href="/admin/conciliacion-reembolso" className={styles.btnGhost}>
            Volver
          </Link>
        </div>
      </header>

      <div className={styles.secondaryRow}>
        {balances.length === 0 ? (
          <div className={styles.secondaryItem}>
            <span className={styles.muted}>Sin saldos abiertos</span>
          </div>
        ) : (
          balances.map((b) => (
            <div key={b.transportId} className={styles.secondaryItem}>
              <strong>{b.transportName}</strong>
              <div>A reclamar: {formatPriceAr(b.claimOpen)}</div>
              <div>A favor: {formatPriceAr(b.creditOpen)}</div>
              <div>
                Saldo:{" "}
                {b.netBalance > 0.004
                  ? `A reclamar ${formatPriceAr(b.netBalance)}`
                  : b.netBalance < -0.004
                    ? `A favor ${formatPriceAr(Math.abs(b.netBalance))}`
                    : "Compensado $0"}
              </div>
            </div>
          ))
        )}
      </div>

      <div className={styles.filters}>
        {(
          [
            ["all", "Todas"],
            ["claims", "A reclamar"],
            ["credits", "A favor"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={tab === id ? styles.btnPrimary : styles.btn}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {msg ? <p className={styles.infoBox}>{msg}</p> : null}

      {(tab === "all" || tab === "claims") && (
        <section className={styles.tableWrap}>
          <h2 className={styles.title} style={{ fontSize: 18 }}>
            A reclamar
          </h2>
          <table className={styles.table}>
            <thead>
              <tr>
                {canEdit ? <th /> : null}
                <th>Cliente / pedido</th>
                <th>Rendición</th>
                <th>Original</th>
                <th>Pendiente</th>
                <th>Estado</th>
              </tr>
            </thead>
            <tbody>
              {claims.map((c) => (
                <tr key={c.id}>
                  {canEdit ? (
                    <td>
                      <input
                        type="checkbox"
                        checked={selectedClaims.has(c.id)}
                        onChange={() => toggle(selectedClaims, c.id, setSelectedClaims)}
                      />
                    </td>
                  ) : null}
                  <td>
                    <div className={styles.diffTrackPrimary}>
                      {c.customerName || "Sin nombre"}
                    </div>
                    <div className={styles.muted}>
                      {c.orderNumber ? `Pedido ${c.orderNumber}` : "Sin pedido"}
                      {c.orderSentDate
                        ? ` · envío ${formatDiffDate(c.orderSentDate)}`
                        : ""}
                    </div>
                  </td>
                  <td>
                    {c.remittanceId ? (
                      <Link
                        href={`/admin/conciliacion-reembolso/remesas/${c.remittanceId}`}
                        className={styles.diffTrackLink}
                      >
                        {formatDiffDate(c.remittanceDate)}
                      </Link>
                    ) : (
                      formatDiffDate(c.remittanceDate)
                    )}
                    <div className={styles.muted}>
                      {remittanceStatusLabel(c.remittanceStatus)}
                    </div>
                  </td>
                  <td className={styles.tdNum}>{formatPriceAr(c.originalAmount)}</td>
                  <td className={styles.tdNum}>{formatPriceAr(c.remainingAmount)}</td>
                  <td>{c.status}</td>
                </tr>
              ))}
              {claims.length === 0 ? (
                <tr>
                  <td colSpan={6} className={styles.muted}>
                    Sin reclamos con saldo
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </section>
      )}

      {(tab === "all" || tab === "credits") && (
        <section className={styles.tableWrap}>
          <h2 className={styles.title} style={{ fontSize: 18 }}>
            A favor del transporte
          </h2>
          <table className={styles.table}>
            <thead>
              <tr>
                {canEdit ? <th /> : null}
                <th>Cliente</th>
                <th>Tipo</th>
                <th>Fechas</th>
                <th>Rendición</th>
                <th>Original</th>
                <th>Pendiente</th>
                <th>Estado</th>
              </tr>
            </thead>
            <tbody>
              {credits.map((c) => (
                <tr key={`${c.sourceType}-${c.id}`}>
                  {canEdit ? (
                    <td>
                      <input
                        type="checkbox"
                        checked={
                          c.sourceType === "adjustment"
                            ? selectedAdj.has(c.id)
                            : selectedSurplus.has(c.id)
                        }
                        onChange={() =>
                          c.sourceType === "adjustment"
                            ? toggle(selectedAdj, c.id, setSelectedAdj)
                            : toggle(selectedSurplus, c.id, setSelectedSurplus)
                        }
                      />
                    </td>
                  ) : null}
                  <td>
                    <div className={styles.diffTrackPrimary}>
                      {c.customerName || "Sin nombre"}
                    </div>
                    <div className={styles.muted}>
                      {c.orderNumber
                        ? `Pedido ${c.orderNumber}`
                        : c.sourceType === "adjustment"
                          ? "Sin pedido vinculado"
                          : "Sobrante COD"}
                      {c.observation ? ` · ${c.observation}` : ""}
                    </div>
                  </td>
                  <td>{kindLabel(c.kind)}</td>
                  <td>
                    <div className={styles.muted}>
                      Pago: {formatDiffDate(c.paymentDate)}
                    </div>
                    <div className={styles.muted}>
                      Alta: {formatDiffDate(c.createdAt)}
                    </div>
                  </td>
                  <td>
                    {c.remittanceId ? (
                      <Link
                        href={`/admin/conciliacion-reembolso/remesas/${c.remittanceId}`}
                        className={styles.diffTrackLink}
                      >
                        {formatDiffDate(c.remittanceDate)}
                      </Link>
                    ) : (
                      formatDiffDate(c.remittanceDate)
                    )}
                    <div className={styles.muted}>
                      {remittanceStatusLabel(c.remittanceStatus)}
                      {c.rowIndex != null ? ` · fila ${c.rowIndex + 1}` : ""}
                    </div>
                  </td>
                  <td className={styles.tdNum}>{formatPriceAr(c.originalAmount)}</td>
                  <td className={styles.tdNum}>{formatPriceAr(c.remainingAmount)}</td>
                  <td>{c.status}</td>
                </tr>
              ))}
              {credits.length === 0 ? (
                <tr>
                  <td colSpan={8} className={styles.muted}>
                    Sin créditos abiertos
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </section>
      )}

      {canEdit && compensateTransportId ? (
        <section className={styles.infoBox}>
          <p>
            A reclamar seleccionado: <strong>{formatPriceAr(totalClaimSel)}</strong>
            {" · "}
            Crédito seleccionado: <strong>{formatPriceAr(totalCreditSel)}</strong>
            {" · "}
            Se aplicará: <strong>{formatPriceAr(willApply)}</strong>
          </p>
          <p className={styles.muted}>
            Resultado previsto:{" "}
            {formatPriceAr(Math.abs(totalClaimSel - totalCreditSel))}{" "}
            {totalClaimSel - totalCreditSel > 0.004
              ? "aún a reclamar"
              : totalClaimSel - totalCreditSel < -0.004
                ? "aún a favor"
                : "saldo compensado"}
          </p>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Nota (opcional; se autocompleta si el neto queda en 0)"
            rows={2}
            style={{ width: "100%", marginTop: 8 }}
          />
          <button
            type="button"
            className={`${styles.btn} ${styles.btnConfirmFinance}`}
            disabled={pending || willApply <= 0}
            onClick={() => onCompensate(compensateTransportId)}
            style={{ marginTop: 8 }}
          >
            Compensar diferencias
          </button>
        </section>
      ) : null}
    </div>
  );
}
