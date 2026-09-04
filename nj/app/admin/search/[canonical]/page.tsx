import { getAdminContext, hasPermission } from "@/lib/auth/admin";
import AccessDenied from "@/components/admin-products/AccessDenied";
import KeywordDetailAdmin from "@/components/admin-search/KeywordDetailAdmin";
import { SEARCH_ADMIN_PERMISSION_KEY } from "@/lib/admin/search-admin-constants";
import { loadKeywordDetails, loadVocabLookup } from "@/lib/admin/search-admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import extra from "../search-admin.module.css";

export const dynamic = "force-dynamic";

export default async function SearchKeywordPage({
  params,
  searchParams,
}: {
  params: Promise<{ canonical: string }>;
  searchParams: Promise<{ alias?: string }>;
}) {
  const ctx = await getAdminContext();
  const { canonical } = await params;
  const query = await searchParams;

  if (!ctx) {
    return (
      <div className={extra.root}>
        <AccessDenied reason="Tu cuenta no tiene acceso al panel de administración." />
      </div>
    );
  }

  if (!hasPermission(ctx, SEARCH_ADMIN_PERMISSION_KEY, "view")) {
    return (
      <div className={extra.root}>
        <AccessDenied reason="No tenés permiso para ver el vocabulario de búsqueda." />
      </div>
    );
  }

  const supabase = await createSupabaseServerClient();
  const [details, lookup] = await Promise.all([
    loadKeywordDetails(supabase, decodeURIComponent(canonical), 30),
    loadVocabLookup(supabase),
  ]);

  if (!details) {
    return (
      <div className={extra.root}>
        <div className={extra.testNote} style={{ maxWidth: 520, margin: "80px auto" }}>
          No existe la keyword “{decodeURIComponent(canonical)}”.
        </div>
      </div>
    );
  }

  return (
    <div className={extra.root}>
      <KeywordDetailAdmin
        details={details}
        lookup={lookup}
        canEdit={hasPermission(ctx, SEARCH_ADMIN_PERMISSION_KEY, "edit")}
        initialAlias={query.alias ?? ""}
      />
    </div>
  );
}
