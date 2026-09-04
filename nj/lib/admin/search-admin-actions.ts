"use server";

import { revalidatePath } from "next/cache";
import { getAdminContext, hasPermission } from "@/lib/auth/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { SEARCH_ADMIN_PERMISSION_KEY } from "@/lib/admin/search-admin-constants";
import {
  loadVocabLookup,
  getAliasImpact,
  getKeywordImpact,
} from "@/lib/admin/search-admin";
import { normalizeText } from "@/lib/search/normalize";
import {
  validateAliasDraft,
  validateKeywordDraft,
  validateNormalizedTerm,
} from "@/lib/admin/search-admin-validate";

export type SearchAdminActionResult =
  | { ok: true; message: string; canonical?: string }
  | { ok: false; code: string; message: string };

async function requireSearchEdit() {
  const ctx = await getAdminContext();
  if (!ctx || !hasPermission(ctx, SEARCH_ADMIN_PERMISSION_KEY, "edit")) {
    return null;
  }
  return ctx;
}

function forbidden(): SearchAdminActionResult {
  return { ok: false, code: "forbidden", message: "No tenés permiso para editar el vocabulario de búsqueda." };
}

function dbMessage(error: { message?: string; code?: string } | null, fallback: string): string {
  const msg = error?.message || fallback;
  if (/duplicate key|unique/i.test(msg)) {
    return "Ese término ya existe en el diccionario.";
  }
  if (/choca con la keyword|ya existe como alias/i.test(msg)) {
    return msg;
  }
  return msg;
}

function refreshSearchAdmin(canonical?: string) {
  revalidatePath("/admin/search");
  if (canonical) revalidatePath(`/admin/search/${canonical}`);
}

export async function createSearchKeyword(input: {
  canonical: string;
  displayLabel: string;
  kind: string;
  active: boolean;
}): Promise<SearchAdminActionResult> {
  if (!(await requireSearchEdit())) return forbidden();
  const supabase = await createSupabaseServerClient();
  const lookup = await loadVocabLookup(supabase);
  const parsed = validateKeywordDraft(input.canonical, input.displayLabel, input.kind || null, lookup);
  if (!parsed.ok) return { ok: false, code: parsed.code, message: parsed.message };

  const { error } = await supabase.from("search_keywords").insert({
    canonical: parsed.canonical,
    display_label: parsed.displayLabel,
    kind: parsed.kind,
    active: input.active,
  });
  if (error) return { ok: false, code: "db", message: dbMessage(error, "No se pudo crear la keyword.") };

  refreshSearchAdmin(parsed.canonical);
  return { ok: true, message: `Keyword “${parsed.displayLabel}” creada.`, canonical: parsed.canonical };
}

export async function updateSearchKeyword(input: {
  keywordId: string;
  displayLabel: string;
  kind: string;
}): Promise<SearchAdminActionResult> {
  if (!(await requireSearchEdit())) return forbidden();
  const supabase = await createSupabaseServerClient();
  const displayLabel = input.displayLabel.trim();
  if (!displayLabel) {
    return { ok: false, code: "empty", message: "El label no puede quedar vacío." };
  }
  const { data, error } = await supabase
    .from("search_keywords")
    .update({ display_label: displayLabel, kind: input.kind || null })
    .eq("id", input.keywordId)
    .select("canonical")
    .maybeSingle();
  if (error) return { ok: false, code: "db", message: dbMessage(error, "No se pudo actualizar la keyword.") };
  if (!data) return { ok: false, code: "missing", message: "Keyword no encontrada." };
  refreshSearchAdmin(data.canonical);
  return { ok: true, message: "Keyword actualizada.", canonical: data.canonical };
}

export async function setSearchKeywordActive(input: {
  keywordId: string;
  active: boolean;
  confirm?: boolean;
}): Promise<SearchAdminActionResult> {
  if (!(await requireSearchEdit())) return forbidden();
  const supabase = await createSupabaseServerClient();

  if (!input.active && !input.confirm) {
    const impact = await getKeywordImpact(supabase, input.keywordId);
    return {
      ok: false,
      code: "needs_confirm",
      message: `Esta keyword tiene ${impact.activeAliases} aliases activos y ${impact.usage30d} usos en los últimos 30 días.`,
    };
  }

  const { data, error } = await supabase
    .from("search_keywords")
    .update({ active: input.active, updated_at: new Date().toISOString() })
    .eq("id", input.keywordId)
    .select("canonical, display_label")
    .maybeSingle();
  if (error) return { ok: false, code: "db", message: dbMessage(error, "No se pudo cambiar el estado.") };
  if (!data) return { ok: false, code: "missing", message: "Keyword no encontrada." };
  refreshSearchAdmin(data.canonical);
  return {
    ok: true,
    message: input.active
      ? `“${data.display_label}” quedó activa.`
      : `“${data.display_label}” quedó inactiva. El buscador deja de usarla cuando recargue el diccionario.`,
    canonical: data.canonical,
  };
}

export async function addSearchAlias(input: {
  alias: string;
  kind: string;
  destCanonical: string;
}): Promise<SearchAdminActionResult> {
  if (!(await requireSearchEdit())) return forbidden();
  const supabase = await createSupabaseServerClient();
  const lookup = await loadVocabLookup(supabase);
  const parsed = validateAliasDraft(input.alias, input.destCanonical, input.kind, lookup);
  if (!parsed.ok) return { ok: false, code: parsed.code, message: parsed.message };

  const { error } = await supabase.from("search_aliases").insert({
    keyword_id: parsed.dest.id,
    alias: input.alias.trim(),
    alias_normalized: parsed.normalized,
    kind: parsed.kind,
    active: true,
  });
  if (error) return { ok: false, code: "db", message: dbMessage(error, "No se pudo guardar el alias.") };

  refreshSearchAdmin(parsed.dest.canonical);
  return {
    ok: true,
    message: `Alias “${parsed.normalized}” → ${parsed.dest.displayLabel}.`,
    canonical: parsed.dest.canonical,
  };
}

export async function updateSearchAlias(input: {
  aliasId: string;
  alias: string;
  kind: string;
}): Promise<SearchAdminActionResult> {
  if (!(await requireSearchEdit())) return forbidden();
  const supabase = await createSupabaseServerClient();
  const { data: current, error: curErr } = await supabase
    .from("search_aliases")
    .select("id, keyword_id, alias_normalized")
    .eq("id", input.aliasId)
    .maybeSingle();
  if (curErr) return { ok: false, code: "db", message: curErr.message };
  if (!current) return { ok: false, code: "missing", message: "Alias no encontrado." };

  const lookup = await loadVocabLookup(supabase);
  const dest = lookup.keywords.find((k) => k.id === current.keyword_id);
  if (!dest) return { ok: false, code: "missing", message: "Keyword destino no encontrada." };

  const parsed = validateAliasDraft(input.alias, dest.canonical, input.kind, lookup, input.aliasId);
  if (!parsed.ok) return { ok: false, code: parsed.code, message: parsed.message };

  const { error } = await supabase
    .from("search_aliases")
    .update({
      alias: input.alias.trim(),
      alias_normalized: parsed.normalized,
      kind: parsed.kind,
    })
    .eq("id", input.aliasId);
  if (error) return { ok: false, code: "db", message: dbMessage(error, "No se pudo editar el alias.") };

  refreshSearchAdmin(dest.canonical);
  return { ok: true, message: "Alias actualizado.", canonical: dest.canonical };
}

export async function setSearchAliasActive(input: {
  aliasId: string;
  active: boolean;
  confirm?: boolean;
}): Promise<SearchAdminActionResult> {
  if (!(await requireSearchEdit())) return forbidden();
  const supabase = await createSupabaseServerClient();

  if (!input.active && !input.confirm) {
    const impact = await getAliasImpact(supabase, input.aliasId);
    return {
      ok: false,
      code: "needs_confirm",
      message: `Este alias fue usado ${impact.usage30d} veces en los últimos 30 días.`,
    };
  }

  const { data, error } = await supabase
    .from("search_aliases")
    .update({ active: input.active })
    .eq("id", input.aliasId)
    .select("alias_normalized, keyword_id")
    .maybeSingle();
  if (error) return { ok: false, code: "db", message: dbMessage(error, "No se pudo cambiar el alias.") };
  if (!data) return { ok: false, code: "missing", message: "Alias no encontrado." };

  const { data: kw } = await supabase
    .from("search_keywords")
    .select("canonical")
    .eq("id", data.keyword_id)
    .maybeSingle();

  refreshSearchAdmin(kw?.canonical);
  return {
    ok: true,
    message: input.active
      ? `Alias “${data.alias_normalized}” reactivado.`
      : `Alias “${data.alias_normalized}” desactivado. Deja de resolver cuando el diccionario recargue.`,
    canonical: kw?.canonical,
  };
}

export async function ignoreSearchCandidate(input: {
  term: string;
  reason?: string;
}): Promise<SearchAdminActionResult> {
  if (!(await requireSearchEdit())) return forbidden();
  const parsed = validateNormalizedTerm(input.term);
  if (!parsed.ok) return { ok: false, code: parsed.code, message: parsed.message };

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("search_ignored_terms").insert({
    normalized_term: parsed.normalized,
    reason: input.reason?.trim() || null,
  });
  if (error) {
    if (/duplicate key|unique/i.test(error.message)) {
      return { ok: true, message: `“${parsed.normalized}” ya estaba ignorado.` };
    }
    return { ok: false, code: "db", message: dbMessage(error, "No se pudo ignorar el término.") };
  }
  refreshSearchAdmin();
  return { ok: true, message: `“${parsed.normalized}” no se va a proponer como alias.` };
}

export async function restoreIgnoredSearchCandidate(input: {
  ignoredId: string;
}): Promise<SearchAdminActionResult> {
  if (!(await requireSearchEdit())) return forbidden();
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("search_ignored_terms").delete().eq("id", input.ignoredId);
  if (error) return { ok: false, code: "db", message: dbMessage(error, "No se pudo restaurar el término.") };
  refreshSearchAdmin();
  return { ok: true, message: "Término restaurado. Si sigue cumpliendo las condiciones, vuelve a aparecer como candidato." };
}

export async function previewAliasNormalization(raw: string): Promise<string> {
  return normalizeText(raw);
}
