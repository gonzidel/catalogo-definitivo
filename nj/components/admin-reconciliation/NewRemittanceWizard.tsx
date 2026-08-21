"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { formatPriceAr } from "@/lib/orders/domain";
import {
  parsePasteGrid,
  parseRemittanceDate,
  parseReportedTotal,
  totalDifference,
  type PasteParseResult,
} from "@/lib/reconciliation/parsing";
import {
  createCodRemittanceDraft,
  type CreateRemittanceResult,
} from "@/lib/reconciliation/actions";
import styles from "@/app/admin/conciliacion-reembolso/conciliacion.module.css";

type Transport = { id: string; name: string };

export default function NewRemittanceWizard({ transports }: { transports: Transport[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [transportId, setTransportId] = useState("");
  const [remittanceDateText, setRemittanceDateText] = useState("");
  const [reportedTotalText, setReportedTotalText] = useState("");
  const [pasteText, setPasteText] = useState("");
  const [pasteCollapsed, setPasteCollapsed] = useState(false);
  const [notes, setNotes] = useState("");

  const [confirmTotalDifference, setConfirmTotalDifference] = useState(false);
  const [confirmInternalDuplicates, setConfirmInternalDuplicates] = useState(false);
  const [confirmSimilarRemittance, setConfirmSimilarRemittance] = useState(false);

  const [feedback, setFeedback] = useState<CreateRemittanceResult | null>(null);

  const grid: PasteParseResult | null = useMemo(() => {
    if (!pasteText.trim()) return null;
    return parsePasteGrid(pasteText);
  }, [pasteText]);

  const reportedParsed = useMemo(
    () => (reportedTotalText.trim() ? parseReportedTotal(reportedTotalText) : null),
    [reportedTotalText]
  );
  const dateParsed = useMemo(
    () => (remittanceDateText.trim() ? parseRemittanceDate(remittanceDateText) : null),
    [remittanceDateText]
  );

  const calculated = grid?.calculatedTotal ?? 0;
  const reported = reportedParsed?.ok ? reportedParsed.value : null;
  const diff =
    reported != null && grid ? totalDifference(calculated, reported) : null;

  const canTrySave =
    !!transportId &&
    dateParsed?.ok &&
    reportedParsed?.ok &&
    (grid?.validRows.length ?? 0) > 0 &&
    (grid?.invalidRows.length ?? 0) === 0;

  const onSave = () => {
    setFeedback(null);
    startTransition(async () => {
      const result = await createCodRemittanceDraft({
        transportId,
        remittanceDateText,
        reportedTotalText,
        pasteText,
        notes,
        confirmTotalDifference,
        confirmInternalDuplicates,
        confirmSimilarRemittance,
      });
      setFeedback(result);
      if (result.ok) {
        router.push(`/admin/conciliacion-reembolso/remesas/${result.remittanceId}`);
      }
      if (result.ok === false && result.code === "needs_confirm_total") {
        setConfirmTotalDifference(false);
      }
    });
  };

  const validCount = grid?.validRows.length ?? 0;
  const invalidCount = grid?.invalidRows.length ?? 0;

  return (
    <div className={styles.wizardLayout}>
      <div className={styles.shellScroll}>
        <Link href="/admin/conciliacion-reembolso" className={styles.backLink}>
          ← Volver al dashboard
        </Link>
        <header className={styles.header}>
          <p className={styles.eyebrow}>Rendiciones</p>
          <h1 className={styles.title}>Nueva rendición</h1>
          <p className={styles.subtitle}>
            Guardar solo crea un borrador. No concilia pagos ni afecta pendientes.
          </p>
        </header>

        <section className={`${styles.card} ${styles.wizardStep}`}>
          <p className={styles.wizardStepTitle}>1. Datos de rendición</p>
          <div className={styles.filters} style={{ marginBottom: 0 }}>
            <div className={styles.filterGroup}>
              <label htmlFor="nr-transport">Transporte</label>
              <select
                id="nr-transport"
                value={transportId}
                onChange={(e) => setTransportId(e.target.value)}
                disabled={pending}
              >
                <option value="">Elegir…</option>
                {transports.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
            <div className={styles.filterGroup}>
              <label htmlFor="nr-date">Fecha de rendición</label>
              <input
                id="nr-date"
                value={remittanceDateText}
                onChange={(e) => setRemittanceDateText(e.target.value)}
                placeholder="18/08/2026"
                disabled={pending}
              />
            </div>
            <div className={styles.filterGroup}>
              <label htmlFor="nr-total">Total informado</label>
              <input
                id="nr-total"
                value={reportedTotalText}
                onChange={(e) => {
                  setReportedTotalText(e.target.value);
                  setConfirmTotalDifference(false);
                }}
                placeholder="8.452.000"
                disabled={pending}
              />
            </div>
          </div>
          {dateParsed && !dateParsed.ok ? (
            <p className={styles.cardHint} style={{ color: "var(--danger)" }}>
              {dateParsed.error}
            </p>
          ) : null}
          {reportedParsed && !reportedParsed.ok ? (
            <p className={styles.cardHint} style={{ color: "var(--danger)" }}>
              {reportedParsed.error}
            </p>
          ) : null}
        </section>

        <section className={`${styles.card} ${styles.wizardStep}`}>
          <div className={styles.sectionHead}>
            <p className={styles.wizardStepTitle} style={{ margin: 0 }}>
              2. Pegar planilla
            </p>
            {grid && grid.rows.length > 0 ? (
              <button
                type="button"
                className={`${styles.btn} ${styles.btnGhost}`}
                onClick={() => setPasteCollapsed((v) => !v)}
                disabled={pending}
              >
                {pasteCollapsed ? "Expandir planilla" : "Contraer planilla"}
              </button>
            ) : null}
          </div>
          <p className={styles.cardHint} style={{ marginTop: 0, marginBottom: 8 }}>
            Fechas: 20/07/2026, 20-07-2026 o 20 jul 2026
          </p>
          {!pasteCollapsed ? (
            <textarea
              className={styles.pasteTextarea}
              value={pasteText}
              onChange={(e) => {
                setPasteText(e.target.value);
                setConfirmInternalDuplicates(false);
                setConfirmSimilarRemittance(false);
                setConfirmTotalDifference(false);
                setFeedback(null);
              }}
              disabled={pending}
              rows={8}
              placeholder={"20 jul 2026\tGOMEZ MARIA\t152000\n04/08/2026\tANA LOPEZ\t87500"}
            />
          ) : (
            <p className={styles.muted} style={{ margin: "4px 0 0" }}>
              Planilla contraída ({pasteText.split(/\n/).filter((l) => l.trim()).length} líneas). El
              texto pegado se conserva.
            </p>
          )}
        </section>

        {grid ? (
          <section className={`${styles.card} ${styles.wizardStep}`}>
            <p className={styles.wizardStepTitle}>3. Validación</p>
            <div className={styles.secondaryRow} style={{ marginBottom: 0 }}>
              <div className={styles.secondaryItem}>
                <span>Filas válidas</span>
                <strong>{validCount}</strong>
              </div>
              <div className={styles.secondaryItem}>
                <span>Inválidas</span>
                <strong>{invalidCount}</strong>
              </div>
              <div className={styles.secondaryItem}>
                <span>Vacías ignoradas</span>
                <strong>{grid.emptyIgnored}</strong>
              </div>
            </div>
          </section>
        ) : null}

        {grid && grid.rows.length > 0 ? (
          <section className={styles.wizardStep}>
            <h2 className={styles.sectionTitle}>4. Vista previa</h2>
            <div className={styles.previewWrap}>
              <table className={styles.previewTable}>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Fecha</th>
                    <th>Nombre</th>
                    <th>Monto</th>
                    <th>Estado</th>
                  </tr>
                </thead>
                <tbody>
                  {grid.rows.map((r) => (
                    <tr key={r.rowIndex}>
                      <td className={styles.mono}>{r.rowIndex + 1}</td>
                      <td className={styles.mono}>{r.rawTransportDateText}</td>
                      <td>{r.rawCustomerNameText}</td>
                      <td className={styles.mono}>{r.rawAmountText}</td>
                      <td>
                        {r.errors.length > 0 ? (
                          <span
                            className={styles.badge}
                            style={{ background: "var(--danger-soft)", color: "var(--danger)" }}
                          >
                            {r.errors.join(" · ")}
                          </span>
                        ) : r.isDuplicate ? (
                          <span className={styles.badge}>Posible duplicado</span>
                        ) : (
                          <span className={styles.muted}>OK</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}

        <section className={`${styles.card} ${styles.wizardStep}`}>
          <p className={styles.wizardStepTitle}>5. Guardar borrador</p>
          <p className={styles.cardMeta}>
            Informado: {reported != null ? formatPriceAr(reported) : "—"}
          </p>
          <p className={styles.cardMeta}>Calculado: {formatPriceAr(calculated)}</p>
          <p
            className={`${styles.cardMeta}${diff != null && diff !== 0 ? ` ${styles.diffAlert}` : ""}`}
          >
            Diferencia (calculado − informado):{" "}
            {diff == null ? "—" : `${diff > 0 ? "+" : ""}${formatPriceAr(diff)}`}
          </p>
          {diff != null && diff !== 0 ? (
            <label
              style={{
                display: "flex",
                gap: 8,
                alignItems: "flex-start",
                marginTop: 10,
                fontSize: 13,
              }}
            >
              <input
                type="checkbox"
                checked={confirmTotalDifference}
                onChange={(e) => setConfirmTotalDifference(e.target.checked)}
                disabled={pending}
              />
              <span>
                Entiendo que hay diferencia de total y quiero guardar el borrador igual.
              </span>
            </label>
          ) : null}
          {(grid?.validRows.some((r) => r.isDuplicate) ?? false) ? (
            <label
              style={{
                display: "flex",
                gap: 8,
                alignItems: "flex-start",
                marginTop: 10,
                fontSize: 13,
              }}
            >
              <input
                type="checkbox"
                checked={confirmInternalDuplicates}
                onChange={(e) => setConfirmInternalDuplicates(e.target.checked)}
                disabled={pending}
              />
              <span>
                Hay posibles duplicados internos; confirmo que pueden ser legítimos y quiero
                guardar.
              </span>
            </label>
          ) : null}
        </section>

        <div className={styles.filterGroup} style={{ marginBottom: 14 }}>
          <label htmlFor="nr-notes">Notas (opcional)</label>
          <input
            id="nr-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            disabled={pending}
          />
        </div>

        {feedback && !feedback.ok ? (
          <div className={styles.errorBox}>
            <div>{feedback.message}</div>
            {feedback.code === "needs_confirm_similar" ? (
              <label style={{ display: "flex", gap: 8, marginTop: 10, fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={confirmSimilarRemittance}
                  onChange={(e) => setConfirmSimilarRemittance(e.target.checked)}
                />
                <span>
                  Confirmo que quiero guardar otra rendición similar / posiblemente idéntica.
                </span>
              </label>
            ) : null}
            {feedback.similar?.length ? (
              <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 12.5 }}>
                {feedback.similar.map((s) => (
                  <li key={s.id}>
                    {s.remittanceDate} · {s.rowCount} filas · {formatPriceAr(s.reportedTotal)} ·{" "}
                    {s.status} ({s.matchLevel === "exact_hash" ? "mismo hash" : "misma cabecera"})
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        {(grid?.invalidRows.length ?? 0) > 0 ? (
          <div className={styles.errorBox}>
            Hay filas inválidas. Corregilas o borrá esas líneas del pegado antes de guardar
            (estrategia V1: no se guardan drafts con filas inválidas).
          </div>
        ) : null}
      </div>

      <div className={styles.actionsBar}>
        <div className={styles.actionsBarInner}>
          <div
            className={`${styles.actionsMeta}${diff != null && diff !== 0 ? ` ${styles.actionsMetaWarn}` : ""}`}
          >
            <span>
              Filas <strong>{validCount}</strong>
              {invalidCount > 0 ? ` · inválidas ${invalidCount}` : ""}
            </span>
            <span>
              Total informado{" "}
              <strong>{reported != null ? formatPriceAr(reported) : "—"}</strong>
            </span>
            <span>
              Total calculado <strong>{formatPriceAr(calculated)}</strong>
            </span>
            <span>
              Diferencia{" "}
              <strong>
                {diff == null ? "—" : `${diff > 0 ? "+" : ""}${formatPriceAr(diff)}`}
              </strong>
            </span>
          </div>
          <div className={styles.filterActions}>
            <Link href="/admin/conciliacion-reembolso" className={styles.btn}>
              Cancelar
            </Link>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnPrimary}`}
              disabled={pending || !canTrySave}
              onClick={onSave}
            >
              {pending ? "Guardando…" : "Guardar borrador"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
