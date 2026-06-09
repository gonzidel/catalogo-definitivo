import { Suspense } from "react";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getCatalogPage } from "@/lib/supabase/queries";
import { slugToCategoria } from "@/lib/utils/catalog";
import CatalogShell from "@/components/catalog/CatalogShell";
import SkeletonCard from "@/components/catalog/SkeletonCard";

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

// Async child: fetch happens here, inside Suspense
async function CatalogContent({ cat }: { cat: string }) {
  const { products } = await getCatalogPage(cat, 1);
  return <CatalogShell initialProducts={products} categoria={cat} tags={[]} />;
}

// NOT async — sends HTML immediately with skeleton fallback
export default async function CategoriaPage({ params }: PageProps) {
  const { categoria: slug } = await params;
  const cat = slugToCategoria(slug);

  if (!cat) notFound();

  return (
    <Suspense fallback={<CatalogSkeleton />}>
      <CatalogContent cat={cat} />
    </Suspense>
  );
}
