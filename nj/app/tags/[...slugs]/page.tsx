import { Suspense } from "react";
import type { Metadata } from "next";
import { getCatalogPage } from "@/lib/supabase/queries";
import CatalogShell from "@/components/catalog/CatalogShell";
import SkeletonCard from "@/components/catalog/SkeletonCard";

export const revalidate = 300;

interface PageProps {
  params: Promise<{ slugs: string[] }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slugs } = await params;
  const tags = slugs.map((s) => decodeURIComponent(s));
  return {
    title: `${tags.join(" · ")} — FYL Moda`,
    description: `Catálogo mayorista filtrado por: ${tags.join(", ")}. Stock visible, desde 4 pares.`,
  };
}

function CatalogSkeleton() {
  return (
    <div id="catalogo" className="catalogo">
      <div id="catalog-container">
        {Array.from({ length: 8 }).map((_, i) => (
          <SkeletonCard key={i} />
        ))}
      </div>
    </div>
  );
}

async function CatalogContent({ tags }: { tags: string[] }) {
  const { products } = await getCatalogPage("all", 1);
  return <CatalogShell initialProducts={products} categoria="all" tags={tags} />;
}

export default async function TagsPage({ params }: PageProps) {
  const { slugs } = await params;
  const tags = slugs.map((s) => decodeURIComponent(s));

  return (
    <Suspense fallback={<CatalogSkeleton />}>
      <CatalogContent tags={tags} />
    </Suspense>
  );
}
