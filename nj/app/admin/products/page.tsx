import { getAdminContext, hasPermission } from "@/lib/auth/admin";
import AccessDenied from "@/components/admin-products/AccessDenied";
import ProductSearchPanel from "@/components/admin-products/ProductSearchPanel";
import styles from "./products-admin.module.css";

export const dynamic = "force-dynamic";

export default async function AdminProductsPage() {
  const ctx = await getAdminContext();

  if (!ctx) {
    return (
      <div className={styles.root}>
        <AccessDenied reason="Tu cuenta no tiene acceso al panel de administración." />
      </div>
    );
  }

  if (!hasPermission(ctx, "products", "view")) {
    return (
      <div className={styles.root}>
        <AccessDenied reason="No tenés permiso para ver el módulo de productos. Pedile a un super admin que te lo habilite." />
      </div>
    );
  }

  const canEdit = hasPermission(ctx, "products", "edit");

  return (
    <div className={styles.root}>
      <div className={styles.landing}>
        <div className={styles.landingEyebrow}>Productos</div>
        <h1 className={styles.landingTitle}>¿Qué producto buscás o creás hoy?</h1>
        <ProductSearchPanel canEdit={canEdit} />
      </div>
    </div>
  );
}
