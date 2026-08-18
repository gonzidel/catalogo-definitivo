"use client";

interface KanbanColumnSearchProps {
  value: string;
  onChange: (value: string) => void;
  columnLabel: string;
}

export default function KanbanColumnSearch({
  value,
  onChange,
  columnLabel,
}: KanbanColumnSearchProps) {
  return (
    <label className="kanban-column__search">
      <span className="sr-only">Buscar clientas en {columnLabel}</span>
      <input
        type="search"
        className="kanban-column__search-input"
        value={value}
        placeholder="Buscar nombre, DNI, teléfono…"
        autoComplete="off"
        enterKeyHint="search"
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
