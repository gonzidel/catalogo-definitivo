import { getAdminContext, hasPermission } from "@/lib/auth/admin";
import AccessDenied from "@/components/admin-products/AccessDenied";
import SearchAdminDashboard from "@/components/admin-search/SearchAdminDashboard";
import { SEARCH_ADMIN_PERMISSION_KEY, parseSearchAdminDays } from "@/lib/admin/search-admin-constants";
import { loadSearchAdminDashboard } from "@/lib/admin/search-admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import extra from "./search-admin.module.css";

export const dynamic = "force-dynamic";

export default async function SearchAdminPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string; alias?: string }>;
}) {
  const ctx = await getAdminContext();
  const params = await searchParams;

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

  const days = parseSearchAdminDays(params.days);
  const supabase = await createSupabaseServerClient();
  const data = await loadSearchAdminDashboard(supabase, days);
  const canEdit = hasPermission(ctx, SEARCH_ADMIN_PERMISSION_KEY, "edit");

  return (
    <div className={extra.root}>
      <SearchAdminDashboard data={data} canEdit={canEdit} initialAlias={params.alias ?? ""} />
    </div>
  );
}
