"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  bulkApproveSearchProfiles,
  setSearchProfileStatus,
} from "@/lib/admin/search-profiles-admin";
import type { SearchProfileRow } from "@/lib/search/search-profiles-types";
import styles from "@/app/admin/search/search-admin.module.css";

interface Props {
  initialRows: SearchProfileRow[];
  status: string;
  canEdit: boolean;
}

export default function SearchProfilesQueue({ initialRows, status, canEdit }: Props) {
  const router = useRouter();
  const [rows, setRows] = useState(initialRows);
  const [selected, setSelected] = useState<string[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function toggle(id: string) {
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  }

  function refresh() {
    startTransition(() => router.refresh());
  }

  async function approveOne(productId: string) {
    if (!canEdit) return;
    await setSearchProfileStatus(productId, "approved");
    setRows((r) => r.filter((x) => x.product_id !== productId));
    setMsg("Aprobado.");
    refresh();
  }

  async function rejectOne(productId: string) {
    if (!canEdit) return;
    await setSearchProfileStatus(productId, "rejected", "rechazo manual");
    setRows((r) => r.filter((x) => x.product_id !== productId));
    setMsg("Rechazado.");
    refresh();
  }

  async function approveSelected() {
    if (!canEdit || selected.length === 0) return;
    const n = await bulkApproveSearchProfiles(selected);
    setMsg(`Aprobados: ${n}`);
    setSelected([]);
    setRows((r) => r.filter((x) => !selected.includes(x.product_id)));
    refresh();
  }

  return (
    <div>
      <div className={styles.toolbar} style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        {(["draft", "approved", "rejected", "stale", "all"] as const).map((s) => (
          <a
            key={s}
            href={`/admin/search/profiles?status=${s}`}
            className={styles.pill}
            style={{ opacity: status === s ? 1 : 0.6 }}
          >
            {s}
          </a>
        ))}
        {canEdit && (
          <button type="button" className={styles.btnAccent} disabled={pending || !selected.length} onClick={approveSelected}>
            Aprobar seleccionados ({selected.length})
          </button>
        )}
      </div>
      {msg && <p className={styles.muted}>{msg}</p>}
      {rows.length === 0 ? (
        <p className={styles.muted}>No hay perfiles en este estado.</p>
      ) : (
        <table className={styles.table}>
          <thead>
            <tr>
              <th />
              <th>Artículo</th>
              <th>Términos</th>
              <th>Conf.</th>
              <th>Modelo</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.product_id}>
                <td>
                  {canEdit && r.status === "draft" && (
                    <input
                      type="checkbox"
                      checked={selected.includes(r.product_id)}
                      onChange={() => toggle(r.product_id)}
                    />
                  )}
                </td>
                <td>
                  <strong>{r.articulo}</strong>
                  <div className={styles.muted}>{r.status}</div>
                </td>
                <td style={{ fontSize: 12 }}>
                  {(r.search_terms ?? []).slice(0, 8).join(", ")}
                  {(r.color_families ?? []).length > 0 && (
                    <div className={styles.muted}>colores: {r.color_families.join(", ")}</div>
                  )}
                </td>
                <td>{r.confidence != null ? Math.round(Number(r.confidence) * 100) + "%" : "—"}</td>
                <td style={{ fontSize: 11 }}>
                  {r.provider}/{r.model}
                </td>
                <td>
                  {canEdit && r.status === "draft" && (
                    <div style={{ display: "flex", gap: 6 }}>
                      <button type="button" className={styles.btnAccent} onClick={() => approveOne(r.product_id)}>
                        Aprobar
                      </button>
                      <button type="button" className={styles.ghostBtn} onClick={() => rejectOne(r.product_id)}>
                        Rechazar
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
