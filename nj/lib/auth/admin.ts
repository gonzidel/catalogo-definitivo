import { createSupabaseServerClient } from "@/lib/supabase/server";

export interface AdminPermission {
  can_view: boolean;
  can_edit: boolean;
  can_delete: boolean;
}

export interface AdminContext {
  userId: string;
  adminId: string;
  email: string;
  role: string;
  isSuperAdmin: boolean;
  permissions: Record<string, AdminPermission>;
}

/** null means the logged-in user is not staff (not present in public.admins). */
export async function getAdminContext(): Promise<AdminContext | null> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: adminRow } = await supabase
    .from("admins")
    .select("id, email, role")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!adminRow) return null;

  const isSuperAdmin = adminRow.role === "super_admin";
  const permissions: Record<string, AdminPermission> = {};

  if (!isSuperAdmin) {
    const { data: perms } = await supabase
      .from("admin_permissions")
      .select("permission_key, can_view, can_edit, can_delete")
      .eq("admin_id", adminRow.id);

    for (const p of perms ?? []) {
      permissions[p.permission_key] = {
        can_view: !!p.can_view,
        can_edit: !!p.can_edit,
        can_delete: !!p.can_delete,
      };
    }
  }

  return {
    userId: user.id,
    adminId: adminRow.id,
    email: adminRow.email,
    role: adminRow.role ?? "collaborator",
    isSuperAdmin,
    permissions,
  };
}

export function hasPermission(
  ctx: AdminContext,
  key: string,
  action: "view" | "edit" | "delete"
): boolean {
  if (ctx.isSuperAdmin) return true;
  const perm = ctx.permissions[key];
  if (!perm) return false;
  if (action === "view") return perm.can_view;
  if (action === "edit") return perm.can_edit;
  return perm.can_delete;
}
