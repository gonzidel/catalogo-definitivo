"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { parseMoneyInput, type OrderNotesExtras } from "@/lib/orders/domain";
import { buildSpecialExtraDraftItem, type OrderEditDraftItem } from "@/lib/supabase/order-edit";

interface OrderEditExtrasPanelProps {
  notesExtras: OrderNotesExtras;
  onNotesExtrasChange: (value: OrderNotesExtras) => void;
  onAddSpecialExtra: (item: OrderEditDraftItem) => void;
  disabled?: boolean;
}

type AdjustKind = "plus" | "minus";
type NumericExtraKey = "shipping" | "discount" | "extras_amount" | "extras_percentage";

export default function OrderEditExtrasPanel({
  notesExtras,
  onNotesExtrasChange,
  onAddSpecialExtra,
  disabled = false,
}: OrderEditExtrasPanelProps) {
  const [panelOpen, setPanelOpen] = useState(false);
  const [adjustPanelOpen, setAdjustPanelOpen] = useState(false);
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [adjustKind, setAdjustKind] = useState<AdjustKind>("plus");
  const [adjustDescription, setAdjustDescription] = useState("");
  const [adjustAmount, setAdjustAmount] = useState("");
  const [adjustError, setAdjustError] = useState("");

  const hasActiveExtras =
    notesExtras.shipping > 0 ||
    notesExtras.discount > 0 ||
    notesExtras.extras_amount > 0 ||
    notesExtras.extras_percentage > 0 ||
    Boolean(String(notesExtras.extras_label || "").trim());

  const setNumericField = (key: NumericExtraKey, raw: string) => {
    const value = Math.max(0, Number(raw) || 0);
    onNotesExtrasChange({ ...notesExtras, [key]: value });
  };

  const setExtrasLabel = (raw: string) => {
    onNotesExtrasChange({ ...notesExtras, extras_label: raw });
  };

  const togglePanel = () => {
    setPanelOpen((open) => {
      if (open) setAdjustPanelOpen(false);
      return !open;
    });
  };

  const openAdjust = (kind: AdjustKind) => {
    setAdjustKind(kind);
    setAdjustDescription("");
    setAdjustAmount("");
    setAdjustError("");
    setAdjustOpen(true);
    setAdjustPanelOpen(false);
  };

  const submitAdjust = () => {
    const description = adjustDescription.trim();
    const amountValue = parseMoneyInput(adjustAmount);
    if (!description) {
      setAdjustError("Ingresá una descripción.");
      return;
    }
    if (!amountValue) {
      setAdjustError("Ingresá un monto válido mayor a 0.");
      return;
    }
    const signedAmount = adjustKind === "minus" ? -amountValue : amountValue;
    onAddSpecialExtra(buildSpecialExtraDraftItem(description, signedAmount));
    setAdjustOpen(false);
    setAdjustDescription("");
    setAdjustAmount("");
    setAdjustError("");
  };

  return (
    <>
      <section className="order-edit-extras">
        <button
          type="button"
          className={`order-edit-extras__toggle${panelOpen ? " is-open" : ""}${hasActiveExtras ? " has-values" : ""}`}
          disabled={disabled}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            togglePanel();
          }}
          aria-expanded={panelOpen}
        >
          <span>Extras</span>
          <span className="order-edit-extras__toggle-end">
            {hasActiveExtras ? <span className="order-edit-extras__toggle-dot" aria-hidden="true" /> : null}
            <span className="order-edit-extras__toggle-chevron" aria-hidden="true">
              {panelOpen ? "▾" : "▸"}
            </span>
          </span>
        </button>

        {panelOpen ? (
          <div className="order-edit-extras__body">
            <div className="order-edit-extras__grid">
              <label className="order-edit-extras__field">
                <span>Envío ($)</span>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  disabled={disabled}
                  value={notesExtras.shipping || ""}
                  onChange={(e) => setNumericField("shipping", e.target.value)}
                />
              </label>
              <label className="order-edit-extras__field">
                <span>Descuento ($)</span>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  disabled={disabled}
                  value={notesExtras.discount || ""}
                  onChange={(e) => setNumericField("discount", e.target.value)}
                />
              </label>
              <label className="order-edit-extras__field">
                <span>Extras ($)</span>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  disabled={disabled}
                  value={notesExtras.extras_amount || ""}
                  onChange={(e) => setNumericField("extras_amount", e.target.value)}
                />
              </label>
              <label className="order-edit-extras__field">
                <span>Extras (%)</span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  step="0.01"
                  disabled={disabled}
                  value={notesExtras.extras_percentage || ""}
                  onChange={(e) => setNumericField("extras_percentage", e.target.value)}
                />
              </label>
              <label className="order-edit-extras__field order-edit-extras__field--span">
                <span>Nombre del extra</span>
                <input
                  type="text"
                  disabled={disabled}
                  value={notesExtras.extras_label || ""}
                  placeholder="Ej: Joyas (opcional)"
                  maxLength={80}
                  onChange={(e) => setExtrasLabel(e.target.value)}
                />
              </label>
            </div>

            <div className="order-edit-extras__adjust">
              <button
                type="button"
                className={`order-edit-extras__adjust-toggle${adjustPanelOpen ? " is-open" : ""}`}
                disabled={disabled}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setAdjustPanelOpen((v) => !v);
                }}
                aria-expanded={adjustPanelOpen}
                title="Agregar extra o resta especial al pedido"
              >
                + / −
              </button>
              {adjustPanelOpen ? (
                <div className="order-edit-extras__adjust-panel">
                  <button
                    type="button"
                    className="order-edit-extras__adjust-btn order-edit-extras__adjust-btn--plus"
                    disabled={disabled}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      openAdjust("plus");
                    }}
                  >
                    Extra
                  </button>
                  <button
                    type="button"
                    className="order-edit-extras__adjust-btn order-edit-extras__adjust-btn--minus"
                    disabled={disabled}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      openAdjust("minus");
                    }}
                  >
                    Resta
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </section>

      {adjustOpen && typeof document !== "undefined"
        ? createPortal(
            <div
              className="order-modal-backdrop order-modal-backdrop--stack"
              role="presentation"
              onClick={() => setAdjustOpen(false)}
            >
              <div
                className={`order-modal order-modal--compact order-edit-adjust${adjustKind === "minus" ? " order-edit-adjust--minus" : " order-edit-adjust--plus"}`}
                role="dialog"
                aria-labelledby="order-edit-adjust-title"
                onClick={(e) => e.stopPropagation()}
              >
                <h3 className="order-modal__title" id="order-edit-adjust-title">
                  {adjustKind === "minus" ? "Resta al pedido" : "Extra al pedido"}
                </h3>
                <p className="order-modal__text">
                  {adjustKind === "minus"
                    ? "El monto se descontará del total del pedido."
                    : "El monto se sumará al total del pedido."}
                </p>
                <label className="order-edit-extras__field order-edit-extras__field--block">
                  <span>Descripción</span>
                  <input
                    type="text"
                    className="order-edit-modal__input"
                    value={adjustDescription}
                    disabled={disabled}
                    placeholder="Ej: Caja de regalo"
                    onChange={(e) => setAdjustDescription(e.target.value)}
                  />
                </label>
                <label className="order-edit-extras__field order-edit-extras__field--block">
                  <span>Monto ($)</span>
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    className="order-edit-modal__input"
                    value={adjustAmount}
                    disabled={disabled}
                    placeholder="1500"
                    onChange={(e) => setAdjustAmount(e.target.value)}
                  />
                </label>
                {adjustError ? <p className="order-edit-extras__error">{adjustError}</p> : null}
                <div className="order-modal__actions">
                  <button type="button" className="order-card__btn" onClick={() => setAdjustOpen(false)}>
                    Cancelar
                  </button>
                  <button
                    type="button"
                    className="order-card__btn order-card__btn--primary"
                    disabled={disabled}
                    onClick={submitAdjust}
                  >
                    {adjustKind === "minus" ? "Agregar resta" : "Agregar extra"}
                  </button>
                </div>
              </div>
            </div>,
            document.body
          )
        : null}
    </>
  );
}
