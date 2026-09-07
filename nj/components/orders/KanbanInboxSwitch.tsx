"use client";

import {
  KANBAN_INBOX_OWNERS,
  type KanbanInboxView,
} from "@/lib/orders/kanban-inbox";

interface KanbanInboxSwitchProps {
  value: KanbanInboxView;
  onChange: (view: KanbanInboxView) => void;
  /** En móvil reemplaza el título; en desktop va junto al header. */
  compact?: boolean;
}

const VIEWS: { id: KanbanInboxView; label: string }[] = [
  { id: "ani", label: "Ani" },
  { id: "fati", label: "Fati" },
  { id: "general", label: "General" },
];

export default function KanbanInboxSwitch({
  value,
  onChange,
  compact = false,
}: KanbanInboxSwitchProps) {
  return (
    <div
      className={`kanban-inbox-switch${compact ? " kanban-inbox-switch--compact" : ""}`}
      role="group"
      aria-label="Vista Ani, Fati o General"
    >
      {VIEWS.map((view) => {
        const ownerMeta = KANBAN_INBOX_OWNERS.find((o) => o.id === view.id);
        const active = value === view.id;
        return (
          <button
            key={view.id}
            type="button"
            className={[
              "kanban-inbox-switch__btn",
              active ? "kanban-inbox-switch__btn--active" : "",
              view.id === "ani" ? "kanban-inbox-switch__btn--ani" : "",
              view.id === "fati" ? "kanban-inbox-switch__btn--fati" : "",
              view.id === "general" ? "kanban-inbox-switch__btn--general" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            aria-pressed={active}
            title={
              view.id === "general"
                ? "Ver todas las clientas"
                : `Solo clientas de ${view.label}`
            }
            onClick={() => onChange(view.id)}
          >
            {ownerMeta ? (
              <span
                className={`kanban-inbox-switch__dot kanban-inbox-switch__dot--${view.id}`}
                aria-hidden
              />
            ) : null}
            {view.label}
          </button>
        );
      })}
    </div>
  );
}
