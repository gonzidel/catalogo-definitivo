import Link from "next/link";
import { getAdminContext, hasPermission } from "@/lib/auth/admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getCategoryPricingDefault, listSuppliers } from "@/lib/products/actions";
import { getProductDetails, getProductTags } from "@/lib/products/tags";
import { getFirstProductImageUrl, listColors, listVariants } from "@/lib/products/variants";
import AccessDenied from "@/components/admin-products/AccessDenied";
import ProductGeneralForm from "@/components/admin-products/ProductGeneralForm";
import TagsHierarchyPicker from "@/components/admin-products/TagsHierarchyPicker";
import DetailsHighlightsPicker from "@/components/admin-products/DetailsHighlightsPicker";
import AutoTagsButton from "@/components/admin-products/AutoTagsButton";
import VariantsPanel from "@/components/admin-products/VariantsPanel";
import styles from "../products-admin.module.css";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function AdminProductEditPage({ params }: PageProps) {
  const { id } = await params;
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
        <AccessDenied reason="No tenés permiso para ver el módulo de productos." />
      </div>
    );
  }

  const canViewCost = ctx.isSuperAdmin;
  const baseFields = "id, name, handle, category, status, description, supplier_id";
  const selectFields = canViewCost
    ? `${baseFields}, cost, cost_is_estimated, price_percentage, logistic_amount`
    : baseFields;

  const supabase = await createSupabaseServerClient();
  const [{ data: product }, suppliers] = await Promise.all([
    supabase.from("products").select(selectFields).eq("id", id).maybeSingle(),
    listSuppliers(),
  ]);

  if (!product) {
    return (
      <div className={styles.root}>
        <div className={styles.shell}>
          <Link href="/admin/products" className={styles.backLink}>
            ← Volver a Productos
          </Link>
          <div className={styles.emptyState}>No se encontró ese producto.</div>
        </div>
      </div>
    );
  }

  const [calzado, ropa, otros, productTags, productDetails, variants, colors, firstImageUrl] =
    await Promise.all([
      getCategoryPricingDefault("Calzado"),
      getCategoryPricingDefault("Ropa"),
      getCategoryPricingDefault("Otros"),
      getProductTags(id),
      getProductDetails(id),
      listVariants(id),
      listColors(),
      getFirstProductImageUrl(id),
    ]);

  const p = product as unknown as {
    id: string;
    name: string;
    handle: string;
    category: "Calzado" | "Ropa" | "Otros";
    status: string;
    description: string | null;
    supplier_id: string | null;
    cost?: number | null;
    cost_is_estimated?: boolean | null;
    price_percentage?: number | null;
    logistic_amount?: number | null;
  };

  return (
    <div className={styles.root}>
      <div className={styles.shell}>
        <Link href="/admin/products" className={styles.backLink}>
          ← Volver a Productos
        </Link>

        <ProductGeneralForm
          mode="edit"
          productId={p.id}
          canViewCost={canViewCost}
          suppliers={suppliers}
          defaultPricing={{ Calzado: calzado, Ropa: ropa, Otros: otros }}
          initial={{
            name: p.name,
            handle: p.handle,
            category: p.category,
            status: p.status,
            description: p.description ?? "",
            supplierId: p.supplier_id,
            cost: p.cost ?? null,
            costIsEstimated: p.cost_is_estimated ?? false,
            pricePercentage: p.price_percentage ?? null,
            logisticAmount: p.logistic_amount ?? null,
          }}
        />

        <h2 className={styles.sectionHeading}>Tags jerárquicos</h2>
        <p className={styles.sectionHint}>Tipo, atributo y hasta 2 detalles destacados. Sin aprobación manual — el sistema chequea similitud antes de crear uno nuevo.</p>
        <div style={{ marginBottom: 14 }}>
          <AutoTagsButton
            productId={p.id}
            productName={p.name}
            category={p.category}
            description={p.description ?? ""}
            imageUrl={firstImageUrl}
          />
        </div>
        <TagsHierarchyPicker productId={p.id} category={p.category} initial={productTags} />

        {productTags.tag1Id && (
          <>
            <h2 className={styles.sectionHeading}>Detalles y Destacados</h2>
            <p className={styles.sectionHint}>Ilimitados para búsqueda; hasta 2 se muestran destacados en el catálogo.</p>
            <DetailsHighlightsPicker
              productId={p.id}
              category={p.category}
              tag1Id={productTags.tag1Id}
              initialDetailIds={productDetails}
              initialHighlightIds={productTags.tag3Ids}
            />
          </>
        )}

        <h2 className={styles.sectionHeading}>Variantes</h2>
        <p className={styles.sectionHint}>Un color por variante — talles, stock, imágenes y oferta se cargan dentro de cada una.</p>
        <VariantsPanel
          productId={p.id}
          category={p.category}
          handle={p.handle}
          supplierId={p.supplier_id}
          initialVariants={variants}
          colors={colors}
        />
      </div>
    </div>
  );
}
