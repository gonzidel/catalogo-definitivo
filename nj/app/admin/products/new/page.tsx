import Link from "next/link";
import { getAdminContext, hasPermission } from "@/lib/auth/admin";
import { getCategoryPricingDefault, listSuppliers } from "@/lib/products/actions";
import { HIDDEN_CATEGORY_PRICING_DEFAULT } from "@/lib/products/pricing";
import AccessDenied from "@/components/admin-products/AccessDenied";
import ProductGeneralForm from "@/components/admin-products/ProductGeneralForm";
import styles from "../products-admin.module.css";

export const dynamic = "force-dynamic";

export default async function AdminProductNewPage() {
  const ctx = await getAdminContext();

  if (!ctx) {
    return (
      <div className={styles.root}>
        <AccessDenied reason="Tu cuenta no tiene acceso al panel de administración." />
      </div>
    );
  }

  if (!hasPermission(ctx, "products", "edit")) {
    return (
      <div className={styles.root}>
        <AccessDenied reason="No tenés permiso para crear productos." />
      </div>
    );
  }

  const loadPricing = (category: string) =>
    ctx.isSuperAdmin
      ? getCategoryPricingDefault(category)
      : Promise.resolve(HIDDEN_CATEGORY_PRICING_DEFAULT);

  const [suppliers, calzado, ropa, otros] = await Promise.all([
    listSuppliers(),
    loadPricing("Calzado"),
    loadPricing("Ropa"),
    loadPricing("Otros"),
  ]);

  return (
    <div className={styles.root}>
      <div className={styles.shell}>
        <Link href="/admin/products" className={styles.backLink}>
          ← Volver a Productos
        </Link>
        <ProductGeneralForm
          mode="new"
          canViewCost={ctx.isSuperAdmin}
          suppliers={suppliers}
          defaultPricing={{ Calzado: calzado, Ropa: ropa, Otros: otros }}
        />
      </div>
    </div>
  );
}
