import { FLOW_STEPS, stepIndex, type FlowStepId } from "@/components/guide/purchase-guide-data";

export function PurchaseFlowInline({ current = "cart" }: { current?: FlowStepId }) {
  const currentIndex = stepIndex(current);

  return (
    <div className="purchase-flow" aria-label="Estado del flujo de compra">
      {FLOW_STEPS.map((step, index) => {
        const state =
          index < currentIndex ? "is-done" : index === currentIndex ? "is-current" : "";
        return (
          <div key={step.id} className={["purchase-flow__step", state].filter(Boolean).join(" ")}>
            <span className="purchase-flow__dot" aria-hidden="true">
              {index + 1}
            </span>
            <span className="purchase-flow__label">{step.label}</span>
          </div>
        );
      })}
    </div>
  );
}
