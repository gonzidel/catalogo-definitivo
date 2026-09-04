"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  addSearchAlias,
  createSearchKeyword,
  ignoreSearchCandidate,
  restoreIgnoredSearchCandidate,
  setSearchKeywordActive,
} from "@/lib/admin/search-admin-actions";
import {
  ALIAS_KIND_LABELS,
  KEYWORD_KIND_LABELS,
  SEARCH_ADMIN_DAY_OPTIONS,
  SEARCH_ALIAS_KINDS,
  SEARCH_KEYWORD_KINDS,
  type SearchAdminDays,
} from "@/lib/admin/search-admin-constants";
import { formatRelativeEs } from "@/lib/admin/search-admin-usage";
import { validateAliasDraft } from "@/lib/admin/search-admin-validate";
import { normalizeText } from "@/lib/search/normalize";
import { publishSearchDictionaryChange } from "@/lib/search/dictionary-store";
import type { SearchAdminDashboard } from "@/lib/admin/search-admin";
import shared from "@/app/admin/conciliacion-reembolso/conciliacion.module.css";
import extra from "@/app/admin/search/search-admin.module.css";

function afterMutation() {
  publishSearchDictionaryChange();
}

export default function SearchAdminDashboard({
  data,
  canEdit,
  initialAlias = "",
}: {
  data: SearchAdminDashboard;
  canEdit: boolean;
  initialAlias?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [warn, setWarn] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [aliasValue, setAliasValue] = useState(initialAlias);
  const [aliasKind, setAliasKind] = useState("plural");
  const [aliasDest, setAliasDest] = useState("");
  const [kwCanonical, setKwCanonical] = useState("");
  const [kwLabel, setKwLabel] = useState("");
  const [kwKind, setKwKind] = useState("product_type");
  const [confirmKeywordId, setConfirmKeywordId] = useState<string | null>(null);

  const keywords = useMemo(() => {
    const q = normalizeText(filter);
    if (!q) return data.keywords;
    return data.keywords.filter(
      (k) =>
        normalizeText(k.displayLabel).includes(q) ||
        k.canonical.includes(q) ||
        (k.kind && k.kind.includes(q))
    );
  }, [data.keywords, filter]);

  const aliasNorm = normalizeText(aliasValue);
  const aliasPreview = aliasValue
    ? validateAliasDraft(aliasValue, aliasDest, aliasKind, data.lookup)
    : null;

  function run(action: () => Promise<{ ok: boolean; code?: string; message: string }>, onOk?: () => void) {
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
      afterMutation();
      onOk?.();
      router.refresh();
    });
  }

  function addAlias(prefill?: string, dest?: string) {
    run(
      () =>
        addSearchAlias({
          alias: prefill ?? aliasValue,
          kind: aliasKind,
          destCanonical: dest ?? aliasDest,
        }),
      () => {
        setAliasValue("");
        setAliasDest("");
      }
    );
  }

  return (
    <div className={shared.shell}>
      <header className={shared.header}>
        <p className={shared.eyebrow}>Admin · Buscador</p>
        <h1 className={shared.title}>Vocabulario de búsqueda</h1>
        <p className={shared.subtitle}>
          Analytics sugiere términos. El administrador decide. El buscador ejecuta. Nada se agrega solo.
        </p>
      </header>

      {error ? <p className={shared.errorBox}>{error}</p> : null}
      {warn ? <p className={extra.warnBox}>{warn}</p> : null}
      {info ? <p className={shared.infoBox}>{info}</p> : null}

      <p className={extra.testNote}>
        Hay eventos de prueba de desarrollo en <code>search_events</code> (por ejemplo{" "}
        <code>xyzabc</code>, <code>pantubotas</code>). No se borran desde acá. Ver documentación de
        Fase 5 antes de limpiar para producción real.
      </p>

      <section className={extra.statsGrid}>
        <Stat label="Búsquedas 7d" value={data.stats.searches7d} />
        <Stat label="Búsquedas 30d" value={data.stats.searches30d} />
        <Stat label="Sin resultados 30d" value={data.stats.zeroResults30d} />
        <Stat
          label="% usó alias 30d"
          value={data.stats.aliasUsedPct30d == null ? "—" : `${data.stats.aliasUsedPct30d}%`}
        />
        <Stat label="Keywords activas" value={data.stats.keywordsActive} />
        <Stat label="Aliases activos" value={data.stats.aliasesActive} />
      </section>

      <section className={extra.section}>
        <div className={shared.sectionHead}>
          <h2 className={shared.sectionTitle}>Oportunidades · sin resultados</h2>
          <DayTabs days={data.days} />
        </div>
        {data.zeroResults.length === 0 ? (
          <p className={shared.empty}>
            No hay búsquedas sin resultados en los últimos {data.days} días.
          </p>
        ) : (
          <QueryTable
            rows={data.zeroResults}
            canEdit={canEdit}
            pending={pending}
            onAddAlias={(term) => {
              setAliasValue(term);
              setAliasDest("");
            }}
            onIgnore={(term) => run(() => ignoreSearchCandidate({ term }))}
          />
        )}
      </section>

      <section className={extra.section}>
        <h2 className={shared.sectionTitle}>Candidatos a alias</h2>
        <p className={shared.subtitle}>
          Términos repetidos que el resolver no tradujo. No son recomendaciones semánticas: hay que
          elegir keyword a mano.
        </p>
        {data.candidates.length === 0 ? (
          <p className={shared.empty}>No hay candidatos nuevos para revisar.</p>
        ) : (
          <QueryTable
            rows={data.candidates}
            canEdit={canEdit}
            pending={pending}
            onAddAlias={(term) => {
              setAliasValue(term);
              setAliasDest("");
            }}
            onIgnore={(term) => run(() => ignoreSearchCandidate({ term }))}
          />
        )}
      </section>

      <section className={extra.section}>
        <h2 className={shared.sectionTitle}>Pocos resultados</h2>
        <p className={shared.subtitle}>
          Queries frecuentes con 1 o 2 resultados. Separadas de zero-results: el fuzzy a veces
          encuentra algo igualmente pobre.
        </p>
        {data.lowResults.length === 0 ? (
          <p className={shared.empty}>
            No hay búsquedas frecuentes con 1–2 resultados en los últimos {data.days} días.
          </p>
        ) : (
          <QueryTable
            rows={data.lowResults}
            canEdit={canEdit}
            pending={pending}
            onAddAlias={(term) => {
              setAliasValue(term);
              setAliasDest("");
            }}
            onIgnore={(term) => run(() => ignoreSearchCandidate({ term }))}
          />
        )}
      </section>

      {canEdit ? (
        <section className={`${shared.card} ${extra.section}`}>
          <h2 className={shared.sectionTitle}>Agregar alias</h2>
          <div className={extra.formGrid}>
            <div className={extra.field}>
              <label htmlFor="alias-input">Alias</label>
              <input
                id="alias-input"
                value={aliasValue}
                onChange={(e) => setAliasValue(e.target.value)}
                placeholder="botita"
              />
              {aliasNorm ? (
                <span className={extra.normPreview}>Normalizado: {aliasNorm}</span>
              ) : null}
            </div>
            <div className={extra.field}>
              <label htmlFor="alias-kind">Tipo</label>
              <select id="alias-kind" value={aliasKind} onChange={(e) => setAliasKind(e.target.value)}>
                {SEARCH_ALIAS_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {ALIAS_KIND_LABELS[k]}
                  </option>
                ))}
              </select>
            </div>
            <div className={extra.field}>
              <label htmlFor="alias-dest">Keyword destino</label>
              <select id="alias-dest" value={aliasDest} onChange={(e) => setAliasDest(e.target.value)}>
                <option value="">Elegir…</option>
                {data.keywords
                  .filter((k) => k.active)
                  .map((k) => (
                    <option key={k.id} value={k.canonical}>
                      {k.displayLabel}
                    </option>
                  ))}
              </select>
            </div>
            <button
              type="button"
              className={`${shared.btn} ${shared.btnPrimary}`}
              disabled={pending || !aliasValue || !aliasDest}
              onClick={() => addAlias()}
            >
              Guardar alias
            </button>
          </div>
          {aliasPreview && !aliasPreview.ok ? (
            <p className={extra.hint}>{aliasPreview.message}</p>
          ) : aliasPreview?.ok ? (
            <p className={extra.hint}>
              Se guardará “{aliasPreview.normalized}” → {aliasPreview.dest.displayLabel}.
            </p>
          ) : null}
        </section>
      ) : null}

      {canEdit ? (
        <section className={`${shared.card} ${extra.section}`}>
          <h2 className={shared.sectionTitle}>Crear keyword</h2>
          <p className={shared.subtitle}>Solo si es un concepto nuevo. No limpia tags.</p>
          <div className={extra.formGridWide}>
            <div className={extra.field}>
              <label htmlFor="kw-can">Canonical</label>
              <input
                id="kw-can"
                value={kwCanonical}
                onChange={(e) => setKwCanonical(e.target.value)}
                placeholder="botin"
              />
            </div>
            <div className={extra.field}>
              <label htmlFor="kw-lab">Display label</label>
              <input
                id="kw-lab"
                value={kwLabel}
                onChange={(e) => setKwLabel(e.target.value)}
                placeholder="Botín"
              />
            </div>
            <div className={extra.field}>
              <label htmlFor="kw-kind">Tipo</label>
              <select id="kw-kind" value={kwKind} onChange={(e) => setKwKind(e.target.value)}>
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
              disabled={pending || !kwCanonical}
              onClick={() =>
                run(
                  () =>
                    createSearchKeyword({
                      canonical: kwCanonical,
                      displayLabel: kwLabel,
                      kind: kwKind,
                      active: true,
                    }),
                  () => {
                    setKwCanonical("");
                    setKwLabel("");
                  }
                )
              }
            >
              Crear
            </button>
          </div>
        </section>
      ) : null}

      <section className={extra.section}>
        <div className={shared.sectionHead}>
          <h2 className={shared.sectionTitle}>Keywords</h2>
          <div className={extra.field}>
            <label htmlFor="kw-filter">Buscar</label>
            <input
              id="kw-filter"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="pantubota, color…"
            />
          </div>
        </div>
        {keywords.length === 0 ? (
          <p className={shared.empty}>No hay keywords que coincidan con el filtro.</p>
        ) : (
          <div className={shared.tableWrap}>
            <table className={shared.table}>
              <thead>
                <tr>
                  <th>Keyword</th>
                  <th>Tipo</th>
                  <th>Aliases</th>
                  <th>Uso 30d</th>
                  <th>Estado</th>
                  <th>Acciones</th>
                </tr>
              </thead>
              <tbody>
                {keywords.map((k) => (
                  <tr key={k.id}>
                    <td>
                      <Link href={`/admin/search/${k.canonical}`} className={shared.diffTrackLink}>
                        {k.displayLabel}
                      </Link>
                      <div className={shared.muted}>{k.canonical}</div>
                    </td>
                    <td>{k.kind ? KEYWORD_KIND_LABELS[k.kind] : "—"}</td>
                    <td className={shared.tdNum}>{k.aliasCount}</td>
                    <td className={shared.tdNum}>{k.usage30d}</td>
                    <td className={k.active ? undefined : extra.inactive}>
                      {k.active ? "Activa" : "Inactiva"}
                    </td>
                    <td>
                      <div className={extra.rowActions}>
                        <Link href={`/admin/search/${k.canonical}`} className={shared.btn}>
                          Editar
                        </Link>
                        {canEdit ? (
                          <button
                            type="button"
                            className={shared.btn}
                            disabled={pending}
                            onClick={() => {
                              const needsConfirm = k.active && confirmKeywordId !== k.id;
                              if (needsConfirm) {
                                setConfirmKeywordId(k.id);
                                setWarn(
                                  `Esta keyword tiene ${k.aliasCount} aliases. Confirmá para desactivarla.`
                                );
                                return;
                              }
                              setConfirmKeywordId(null);
                              run(() =>
                                setSearchKeywordActive({
                                  keywordId: k.id,
                                  active: !k.active,
                                  confirm: true,
                                })
                              );
                            }}
                          >
                            {k.active
                              ? confirmKeywordId === k.id
                                ? "Confirmar"
                                : "Desactivar"
                              : "Activar"}
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className={extra.section}>
        <h2 className={shared.sectionTitle}>Términos ignorados</h2>
        {data.ignored.length === 0 ? (
          <p className={shared.empty}>No hay términos ignorados.</p>
        ) : (
          <div className={shared.tableWrap}>
            <table className={shared.table}>
              <thead>
                <tr>
                  <th>Término</th>
                  <th>Motivo</th>
                  <th>Desde</th>
                  {canEdit ? <th></th> : null}
                </tr>
              </thead>
              <tbody>
                {data.ignored.map((row) => (
                  <tr key={row.id}>
                    <td className={shared.mono}>{row.normalizedTerm}</td>
                    <td>{row.reason || "—"}</td>
                    <td>{formatRelativeEs(row.createdAt)}</td>
                    {canEdit ? (
                      <td>
                        <button
                          type="button"
                          className={shared.btn}
                          disabled={pending}
                          onClick={() =>
                            run(() => restoreIgnoredSearchCandidate({ ignoredId: row.id }))
                          }
                        >
                          Restaurar
                        </button>
                      </td>
                    ) : null}
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

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className={shared.card}>
      <p className={shared.cardLabel}>{label}</p>
      <p className={shared.cardValue}>{value}</p>
    </div>
  );
}

function DayTabs({ days }: { days: SearchAdminDays }) {
  return (
    <div className={extra.dayTabs}>
      {SEARCH_ADMIN_DAY_OPTIONS.map((d) => (
        <Link
          key={d}
          href={`/admin/search?days=${d}`}
          className={`${extra.dayTab} ${d === days ? extra.dayTabActive : ""}`}
        >
          {d}d
        </Link>
      ))}
    </div>
  );
}

function QueryTable({
  rows,
  canEdit,
  pending,
  onAddAlias,
  onIgnore,
}: {
  rows: SearchAdminDashboard["zeroResults"];
  canEdit: boolean;
  pending: boolean;
  onAddAlias: (term: string) => void;
  onIgnore: (term: string) => void;
}) {
  return (
    <div className={`${shared.tableWrap} ${shared.tableWrapCompact}`}>
      <table className={shared.table}>
        <thead>
          <tr>
            <th>Término</th>
            <th>Búsquedas</th>
            <th>Última</th>
            <th>Normalizado</th>
            <th>Resuelto</th>
            <th>Relacionado</th>
            {canEdit ? <th>Acción</th> : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.queryNormalized}|${row.queryResolved}`}>
              <td>
                {row.sampleOriginal}
                <div className={shared.muted}>
                  {row.avgResultCount === 0 ? "0 resultados" : `${row.avgResultCount.toFixed(1)} resultados promedio`}
                </div>
              </td>
              <td className={shared.tdNum}>{row.searches}</td>
              <td>{formatRelativeEs(row.lastSeen)}</td>
              <td className={shared.mono}>{row.queryNormalized}</td>
              <td className={shared.mono}>{row.queryResolved}</td>
              <td>
                {row.related ? (
                  <Link href={`/admin/search/${row.related.canonical}`} className={extra.pill}>
                    {row.related.displayLabel}
                  </Link>
                ) : (
                  <span className={shared.muted}>No</span>
                )}
              </td>
              {canEdit ? (
                <td>
                  <div className={extra.rowActions}>
                    <button
                      type="button"
                      className={`${shared.btn} ${shared.btnPrimary}`}
                      disabled={pending}
                      onClick={() => onAddAlias(row.queryNormalized)}
                    >
                      Agregar alias
                    </button>
                    <button
                      type="button"
                      className={shared.btn}
                      disabled={pending}
                      onClick={() => onIgnore(row.queryNormalized)}
                    >
                      Ignorar
                    </button>
                  </div>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
