"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  addSearchAlias,
  setSearchAliasActive,
  setSearchKeywordActive,
  updateSearchAlias,
  updateSearchKeyword,
} from "@/lib/admin/search-admin-actions";
import {
  ALIAS_KIND_LABELS,
  KEYWORD_KIND_LABELS,
  SEARCH_ALIAS_KINDS,
  SEARCH_KEYWORD_KINDS,
} from "@/lib/admin/search-admin-constants";
import { formatRelativeEs } from "@/lib/admin/search-admin-usage";
import { validateAliasDraft } from "@/lib/admin/search-admin-validate";
import { normalizeText } from "@/lib/search/normalize";
import { publishSearchDictionaryChange } from "@/lib/search/dictionary-store";
import type { KeywordDetails } from "@/lib/admin/search-admin";
import type { SearchVocabLookup } from "@/lib/admin/search-admin-validate";
import shared from "@/app/admin/conciliacion-reembolso/conciliacion.module.css";
import extra from "@/app/admin/search/search-admin.module.css";

export default function KeywordDetailAdmin({
  details,
  lookup,
  canEdit,
  initialAlias = "",
}: {
  details: KeywordDetails;
  lookup: SearchVocabLookup;
  canEdit: boolean;
  initialAlias?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [warn, setWarn] = useState<string | null>(null);
  const [label, setLabel] = useState(details.keyword.displayLabel);
  const [kind, setKind] = useState(details.keyword.kind ?? "product_type");
  const [aliasValue, setAliasValue] = useState(initialAlias);
  const [aliasKind, setAliasKind] = useState("plural");
  const [editId, setEditId] = useState<string | null>(null);
  const [editAlias, setEditAlias] = useState("");
  const [editKind, setEditKind] = useState("plural");
  const [confirmAliasId, setConfirmAliasId] = useState<string | null>(null);
  const [confirmKeyword, setConfirmKeyword] = useState(false);

  const aliasNorm = normalizeText(aliasValue);
  const preview = aliasValue
    ? validateAliasDraft(aliasValue, details.keyword.canonical, aliasKind, lookup)
    : null;

  function run(action: () => Promise<{ ok: boolean; code?: string; message: string }>) {
    setError(null);
    setInfo(null);
    setWarn(null);
    startTransition(async () => {
      const res = await action();
      if (!res.ok) {
        if (res.code === "needs_confirm") {
          setWarn(res.message);
          return;
        }
        setError(res.message);
        return;
      }
      setInfo(res.message);
      publishSearchDictionaryChange();
      router.refresh();
    });
  }

  return (
    <div className={shared.shell}>
      <Link href="/admin/search" className={shared.backLink}>
        ← Vocabulario
      </Link>
      <header className={shared.header}>
        <p className={shared.eyebrow}>Keyword</p>
        <h1 className={shared.title}>{details.keyword.displayLabel}</h1>
        <p className={shared.subtitle}>
          Canonical <code>{details.keyword.canonical}</code> ·{" "}
          {details.keyword.active ? "Activa" : "Inactiva"}
        </p>
      </header>

      {error ? <p className={shared.errorBox}>{error}</p> : null}
      {warn ? <p className={extra.warnBox}>{warn}</p> : null}
      {info ? <p className={shared.infoBox}>{info}</p> : null}

      <section className={`${shared.card} ${extra.section}`}>
        <h2 className={shared.sectionTitle}>Uso operativo 30d</h2>
        <p className={shared.subtitle}>
          Resoluciones JSON, no un split de <code>query_resolved</code>. “zapatillas negras” suma 1
          a zapatilla y 1 a negro.
        </p>
        <div className={extra.statsGrid}>
          <div className={shared.secondaryItem}>
            <span>Resoluciones</span>
            <strong>{details.usage.resolutionHits}</strong>
          </div>
          <div className={shared.secondaryItem}>
            <span>Query exacta (= canonical)</span>
            <strong>{details.usage.exactResolvedHits}</strong>
          </div>
          <div className={shared.secondaryItem}>
            <span>Uso combinado</span>
            <strong>{details.usage.usage}</strong>
          </div>
        </div>
        {details.usage.topAliases.length > 0 ? (
          <p className={extra.hint}>
            Aliases más usados:{" "}
            {details.usage.topAliases
              .slice(0, 5)
              .map((a) => `${a.alias} (${a.hits})`)
              .join(" · ")}
          </p>
        ) : (
          <p className={extra.hint}>Todavía no hay resoluciones registradas para esta keyword.</p>
        )}
      </section>

      {canEdit ? (
        <section className={`${shared.card} ${extra.section}`}>
          <h2 className={shared.sectionTitle}>Editar keyword</h2>
          <div className={extra.formGrid}>
            <div className={extra.field}>
              <label htmlFor="kw-label">Display label</label>
              <input id="kw-label" value={label} onChange={(e) => setLabel(e.target.value)} />
            </div>
            <div className={extra.field}>
              <label htmlFor="kw-kind">Tipo</label>
              <select id="kw-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
                {SEARCH_KEYWORD_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {KEYWORD_KIND_LABELS[k]}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              className={`${shared.btn} ${shared.btnPrimary}`}
              disabled={pending}
              onClick={() =>
                run(() =>
                  updateSearchKeyword({
                    keywordId: details.keyword.id,
                    displayLabel: label,
                    kind,
                  })
                )
              }
            >
              Guardar
            </button>
            <button
              type="button"
              className={shared.btn}
              disabled={pending}
              onClick={() => {
                if (details.keyword.active && !confirmKeyword) {
                  setConfirmKeyword(true);
                  setWarn(
                    `Esta keyword tiene ${details.aliases.filter((a) => a.active).length} aliases activos.`
                  );
                  return;
                }
                setConfirmKeyword(false);
                run(() =>
                  setSearchKeywordActive({
                    keywordId: details.keyword.id,
                    active: !details.keyword.active,
                    confirm: true,
                  })
                );
              }}
            >
              {details.keyword.active
                ? confirmKeyword
                  ? "Confirmar desactivar"
                  : "Desactivar"
                : "Activar"}
            </button>
          </div>
        </section>
      ) : null}

      <section className={extra.section}>
        <h2 className={shared.sectionTitle}>Aliases</h2>
        {details.aliases.length === 0 ? (
          <p className={shared.empty}>No hay aliases para esta keyword.</p>
        ) : (
          <div className={shared.tableWrap}>
            <table className={shared.table}>
              <thead>
                <tr>
                  <th>Alias</th>
                  <th>Tipo</th>
                  <th>Uso 30d</th>
                  <th>Último uso</th>
                  <th>Estado</th>
                  {canEdit ? <th>Acción</th> : null}
                </tr>
              </thead>
              <tbody>
                {details.aliases.map((a) => (
                  <tr key={a.id}>
                    <td>
                      {editId === a.id ? (
                        <input value={editAlias} onChange={(e) => setEditAlias(e.target.value)} />
                      ) : (
                        <>
                          {a.alias}
                          <div className={shared.muted}>{a.aliasNormalized}</div>
                        </>
                      )}
                    </td>
                    <td>
                      {editId === a.id ? (
                        <select value={editKind} onChange={(e) => setEditKind(e.target.value)}>
                          {SEARCH_ALIAS_KINDS.map((k) => (
                            <option key={k} value={k}>
                              {ALIAS_KIND_LABELS[k]}
                            </option>
                          ))}
                        </select>
                      ) : a.kind ? (
                        ALIAS_KIND_LABELS[a.kind]
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className={shared.tdNum}>{a.usage30d}</td>
                    <td>{formatRelativeEs(a.lastUsed)}</td>
                    <td className={a.active ? undefined : extra.inactive}>
                      {a.active ? "Activo" : "Inactivo"}
                    </td>
                    {canEdit ? (
                      <td>
                        <div className={extra.rowActions}>
                          {editId === a.id ? (
                            <>
                              <button
                                type="button"
                                className={`${shared.btn} ${shared.btnPrimary}`}
                                disabled={pending}
                                onClick={() => {
                                  run(() =>
                                    updateSearchAlias({
                                      aliasId: a.id,
                                      alias: editAlias,
                                      kind: editKind,
                                    })
                                  );
                                  setEditId(null);
                                }}
                              >
                                Guardar
                              </button>
                              <button type="button" className={shared.btn} onClick={() => setEditId(null)}>
                                Cancelar
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              className={shared.btn}
                              onClick={() => {
                                setEditId(a.id);
                                setEditAlias(a.alias);
                                setEditKind(a.kind ?? "plural");
                              }}
                            >
                              Editar
                            </button>
                          )}
                          <button
                            type="button"
                            className={shared.btn}
                            disabled={pending}
                            onClick={() => {
                              if (a.active && confirmAliasId !== a.id) {
                                setConfirmAliasId(a.id);
                                setWarn(
                                  `Este alias fue usado ${a.usage30d} veces en los últimos 30 días.`
                                );
                                return;
                              }
                              setConfirmAliasId(null);
                              run(() =>
                                setSearchAliasActive({
                                  aliasId: a.id,
                                  active: !a.active,
                                  confirm: true,
                                })
                              );
                            }}
                          >
                            {a.active
                              ? confirmAliasId === a.id
                                ? "Confirmar"
                                : "Desactivar"
                              : "Activar"}
                          </button>
                        </div>
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {canEdit ? (
        <section className={`${shared.card} ${extra.section}`}>
          <h2 className={shared.sectionTitle}>Agregar alias a {details.keyword.displayLabel}</h2>
          <div className={extra.formGrid}>
            <div className={extra.field}>
              <label htmlFor="new-alias">Alias</label>
              <input
                id="new-alias"
                value={aliasValue}
                onChange={(e) => setAliasValue(e.target.value)}
                placeholder="botita"
              />
              {aliasNorm ? <span className={extra.normPreview}>Normalizado: {aliasNorm}</span> : null}
            </div>
            <div className={extra.field}>
              <label htmlFor="new-kind">Tipo</label>
              <select id="new-kind" value={aliasKind} onChange={(e) => setAliasKind(e.target.value)}>
                {SEARCH_ALIAS_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {ALIAS_KIND_LABELS[k]}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              className={`${shared.btn} ${shared.btnPrimary}`}
              disabled={pending || !aliasValue}
              onClick={() =>
                run(() =>
                  addSearchAlias({
                    alias: aliasValue,
                    kind: aliasKind,
                    destCanonical: details.keyword.canonical,
                  })
                )
              }
            >
              Guardar alias
            </button>
          </div>
          {preview && !preview.ok ? <p className={extra.hint}>{preview.message}</p> : null}
        </section>
      ) : null}

      <section className={extra.section}>
        <h2 className={shared.sectionTitle}>Zero-results relacionados</h2>
        {details.relatedZeroResults.length === 0 ? (
          <p className={shared.empty}>No hay búsquedas sin resultados ligadas a esta keyword.</p>
        ) : (
          <div className={shared.tableWrap}>
            <table className={shared.table}>
              <thead>
                <tr>
                  <th>Término</th>
                  <th>Búsquedas</th>
                  <th>Última</th>
                  <th>Resuelto</th>
                </tr>
              </thead>
              <tbody>
                {details.relatedZeroResults.map((row) => (
                  <tr key={`${row.queryNormalized}|${row.queryResolved}`}>
                    <td>{row.sampleOriginal}</td>
                    <td className={shared.tdNum}>{row.searches}</td>
                    <td>{formatRelativeEs(row.lastSeen)}</td>
                    <td className={shared.mono}>{row.queryResolved}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
