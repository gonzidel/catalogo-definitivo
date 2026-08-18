"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { PurchaseFlowInline } from "@/components/guide/PurchaseFlowGuide";
import { FLOW_STEPS, stepIndex, type FlowStepId } from "@/components/guide/purchase-guide-data";

const GUIDE_SEEN_KEY = "fyl-purchase-guide-seen-v1";

export function PurchaseGuideButton({
  className,
  label = "Ver guía rápida",
  initialStep = "cart",
}: {
  className?: string;
  label?: string;
  initialStep?: FlowStepId;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(stepIndex(initialStep));

  function openGuide() {
    setActiveIndex(stepIndex(initialStep));
    setOpen(true);
  }

  return (
    <>
      <button
        type="button"
        onClick={openGuide}
        className={["purchase-guide-trigger", className ?? ""].filter(Boolean).join(" ")}
      >
        <span className="purchase-guide-trigger__icon" aria-hidden="true">?</span>
        {label}
      </button>

      {open && (
        <PurchaseGuideModal
          activeIndex={activeIndex}
          onActiveIndexChange={setActiveIndex}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

export function PurchaseFlowNudge({ context }: { context: "cart" | "order" }) {
  const [visible, setVisible] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [guideStep, setGuideStep] = useState(0);

  const copy = useMemo(() => {
    if (context === "cart") {
      return {
        title: "Todavía no hiciste el pedido",
        text: "Estos productos siguen solo en el carrito. Para hacer el pedido, tocá “Armar mi pedido”.",
        step: "open" as FlowStepId,
        storageKey: "fyl-cart-nudge-v1",
      };
    }
    return {
      title: "Cuando cierres el pedido, empezamos a prepararlo",
      text: "Cerralo solo cuando ya llegaste al mínimo y no querés sumar más productos. Pago, envío o retiro se coordinan después.",
      step: "close" as FlowStepId,
      storageKey: "fyl-active-order-nudge-v1",
    };
  }, [context]);

  useEffect(() => {
    setMounted(true);
    try {
      const dismissed = localStorage.getItem(`${copy.storageKey}:dismissed`) === "1";
      const views = Number(localStorage.getItem(`${copy.storageKey}:views`) ?? "0");
      if (!dismissed && views < 2) {
        localStorage.setItem(`${copy.storageKey}:views`, String(views + 1));
        setVisible(true);
      }
    } catch {
      setVisible(true);
    }
  }, [copy.storageKey]);

  function dismiss() {
    setVisible(false);
    try {
      localStorage.setItem(`${copy.storageKey}:dismissed`, "1");
    } catch {
      // ignore storage failures
    }
  }

  if (!visible) return null;

  return (
    <div className="purchase-nudge">
      <div className="purchase-nudge__body">
        <div className="purchase-nudge__title">{copy.title}</div>
        <div className="purchase-nudge__text">{copy.text}</div>
        <button
          type="button"
          className="purchase-nudge__link"
          onClick={() => {
            setGuideStep(stepIndex(copy.step));
            setGuideOpen(true);
          }}
        >
          Ver guía rápida
        </button>
      </div>
      <button type="button" onClick={dismiss} className="purchase-nudge__close" aria-label="Ocultar aviso">
        ×
      </button>

      {mounted && guideOpen && (
        <PurchaseGuideModal
          activeIndex={guideStep}
          onActiveIndexChange={setGuideStep}
          onClose={() => setGuideOpen(false)}
        />
      )}
    </div>
  );
}

function PurchaseGuideModal({
  activeIndex,
  onActiveIndexChange,
  onClose,
}: {
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  onClose: () => void;
}) {
  const [mounted, setMounted] = useState(false);
  const active = FLOW_STEPS[activeIndex] ?? FLOW_STEPS[0];
  const isFirst = activeIndex === 0;
  const isLast = activeIndex === FLOW_STEPS.length - 1;

  useEffect(() => {
    setMounted(true);
    try {
      localStorage.setItem(GUIDE_SEEN_KEY, "1");
    } catch {
      // ignore storage failures
    }
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  if (!mounted) return null;

  return createPortal(
    <div className="purchase-guide-backdrop" onClick={onClose}>
      <div
        className="purchase-guide-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="purchase-guide-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="purchase-guide-sheet__top">
          <div className="purchase-guide-sheet__eyebrow">Guía rápida</div>
          <button type="button" className="purchase-guide-sheet__close" onClick={onClose} aria-label="Cerrar guía">
            ×
          </button>
        </div>

        <div className="purchase-guide-progress" aria-hidden="true">
          {FLOW_STEPS.map((step, index) => (
            <button
              key={step.id}
              type="button"
              className={[
                "purchase-guide-progress__bar",
                index <= activeIndex ? "is-filled" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              onClick={() => onActiveIndexChange(index)}
              tabIndex={-1}
            />
          ))}
        </div>

        <div className="purchase-guide-card">
          <div className="purchase-guide-card__num">{activeIndex + 1}</div>
          <h3 id="purchase-guide-title" className="purchase-guide-card__title">
            {active.title}
          </h3>
          <p className="purchase-guide-card__text">{active.text}</p>
        </div>

        <div className="purchase-guide-mini-flow">
          <PurchaseFlowInline current={active.id} />
        </div>

        <div className="purchase-guide-sheet__actions">
          <button
            type="button"
            className="purchase-guide-sheet__secondary"
            onClick={() => onActiveIndexChange(Math.max(0, activeIndex - 1))}
            disabled={isFirst}
          >
            Atrás
          </button>
          <button
            type="button"
            className="purchase-guide-sheet__primary"
            onClick={() => {
              if (isLast) onClose();
              else onActiveIndexChange(Math.min(FLOW_STEPS.length - 1, activeIndex + 1));
            }}
          >
            {isLast ? "Entendido" : "Siguiente"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
