import { Suspense } from "react";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getCatalogPage, hasActiveOfertas } from "@/lib/supabase/queries";
import { slugToCategoria } from "@/lib/utils/catalog";
import CatalogShell from "@/components/catalog/CatalogShell";
import CatalogShellSkeleton from "@/components/catalog/CatalogShellSkeleton";
import JsonLdScript from "@/lib/seo/JsonLdScript";
import { catalogCategoryJsonLd } from "@/lib/seo/json-ld";

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
    description: `Catálogo mayorista de ${cat.toLowerCase()} femenino. Stock visible, compra mínima de 4 productos surtidos. Envíos a todo el país.`,
    alternates: { canonical: `/${slug}` },
  };
}

async function CatalogContent({
  cat,
  hasOfertas,
}: {
  cat: string;
  hasOfertas: boolean;
}) {
  const { products } = await getCatalogPage(cat, 1);
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

  const hasOfertas = await hasActiveOfertas();

  return (
    <>
      <JsonLdScript
        data={catalogCategoryJsonLd({
          name: `${cat} — FYL Moda`,
          description: `Catálogo mayorista de ${cat.toLowerCase()} femenino. Stock visible, compra mínima de 4 productos surtidos.`,
          path: `/${slug}`,
        })}
      />
      <Suspense
        fallback={
          <CatalogShellSkeleton categoria={cat} hasOfertas={hasOfertas} />
        }
      >
        <CatalogContent cat={cat} hasOfertas={hasOfertas} />
      </Suspense>
    </>
  );
}
