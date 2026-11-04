import { Suspense } from "react";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getCatalogPage, hasActiveOfertas } from "@/lib/supabase/queries";
import { slugToCategoria } from "@/lib/utils/catalog";
import CatalogShell from "@/components/catalog/CatalogShell";
import CatalogShellSkeleton from "@/components/catalog/CatalogShellSkeleton";
import JsonLdScript from "@/lib/seo/JsonLdScript";
import { catalogCategoryJsonLd } from "@/lib/seo/json-ld";
import { CATALOG_URL } from "@/lib/constants/seo";

export const revalidate = 300;

interface PageProps {
  params: Promise<{ categoria: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { categoria: slug } = await params;
  const cat = slugToCategoria(slug);
  if (!cat) return {};
  return {
    title: `${cat} — FYL Moda | Mayorista`,
    description: `Catálogo mayorista de ${cat.toLowerCase()} femenino. Stock visible, desde 4 pares. Envíos a todo el país.`,
  };
}

async function CatalogContent({ cat }: { cat: string }) {
  const [{ products }, hasOfertas] = await Promise.all([
    getCatalogPage(cat, 1),
    hasActiveOfertas(),
  ]);
  return (
    <CatalogShell
      initialProducts={products}
      categoria={cat}
      tags={[]}
      hasOfertas={hasOfertas}
    />
  );
}

export default async function CategoriaPage({ params }: PageProps) {
  const { categoria: slug } = await params;
  const cat = slugToCategoria(slug);

  if (!cat) notFound();

  return (
    <>
      <JsonLdScript
        data={catalogCategoryJsonLd({
          name: `${cat} — FYL Moda`,
          description: `Catálogo mayorista de ${cat.toLowerCase()} femenino. Stock visible, desde 4 pares.`,
          url: `${CATALOG_URL}/${slug}`,
        })}
      />
      <Suspense
        fallback={
          <CatalogShellSkeleton categoria={cat} hasOfertas />
        }
      >
        <CatalogContent cat={cat} />
      </Suspense>
    </>
  );
}
