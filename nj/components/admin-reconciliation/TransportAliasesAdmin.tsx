"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { setTransportAliasActive } from "@/lib/reconciliation/actions";
import type { TransportAliasListItem } from "@/lib/reconciliation/alias-queries";
import styles from "@/app/admin/conciliacion-reembolso/conciliacion.module.css";

function formatTs(iso: string): string {
  try {
    return new Date(iso).toLocaleString("es-AR");
  } catch {
    return iso;
  }
}

export default function TransportAliasesAdmin({
  aliases,
  canEdit,
}: {
  aliases: TransportAliasListItem[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  function toggle(alias: TransportAliasListItem) {
    setError(null);
    setInfo(null);
    startTransition(async () => {
      const res = await setTransportAliasActive({
        aliasId: alias.id,
        isActive: !alias.isActive,
        reason: alias.isActive ? "admin_deactivate" : "admin_reactivate",
      });
      if (!res.ok) {
        setError(res.message || "Error");
        return;
      }
      setInfo(
        alias.isActive
          ? "Alias desactivado. Ya no se usará en el matching."
          : "Alias reactivado."
      );
      router.refresh();
    });
  }

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <p className={styles.eyebrow}>Admin · Contra reembolso</p>
        <h1 className={styles.title}>Alias aprendidos del transporte</h1>
        <p className={styles.subtitle}>
          Nombres que un transporte utiliza para identificar clientes y que el sistema puede
          reconocer en futuras rendiciones. No son sub-nombres del cliente.
        </p>
        <div className={styles.headerActions}>
          <Link href="/admin/conciliacion-reembolso" className={styles.btn}>
            Volver al dashboard
          </Link>
        </div>
      </header>

      {error ? <p className={styles.errorBox}>{error}</p> : null}
      {info ? <p className={styles.infoBox}>{info}</p> : null}

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th>Transporte</th>
              <th>Nombre informado</th>
              <th>Cliente vinculado</th>
              <th>Nº cliente</th>
              <th>Estado</th>
              <th>Fecha</th>
              {canEdit ? <th></th> : null}
            </tr>
          </thead>
          <tbody>
            {aliases.length === 0 ? (
              <tr>
                <td colSpan={canEdit ? 7 : 6} className={styles.muted}>
                  Todavía no hay aliases. Se crean con «Aprobar y recordar nombre» en una
                  rendición.
                </td>
              </tr>
            ) : (
              aliases.map((a) => (
                <tr key={a.id}>
                  <td>{a.transportName ?? "—"}</td>
                  <td>
                    <div>{a.rawAlias}</div>
                    <div className={styles.muted}>{a.normalizedAlias}</div>
                  </td>
                  <td>{a.customerName ?? "—"}</td>
                  <td className={styles.mono}>
                    {a.customerNumber ? `#${a.customerNumber}` : "—"}
                  </td>
                  <td>{a.isActive ? "Activo" : "Inactivo"}</td>
                  <td className={styles.mono}>{formatTs(a.updatedAt)}</td>
                  {canEdit ? (
                    <td>
                      <button
                        type="button"
                        className={styles.btn}
                        disabled={pending}
                        onClick={() => toggle(a)}
                      >
                        {a.isActive ? "Desactivar" : "Reactivar"}
                      </button>
                    </td>
                  ) : null}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
