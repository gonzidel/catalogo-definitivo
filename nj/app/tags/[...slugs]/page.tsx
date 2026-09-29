import { Suspense } from "react";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { getCatalogPage, hasActiveOfertas } from "@/lib/supabase/queries";
import { isCollectionSlug } from "@/lib/banners/collections";
import CatalogShell from "@/components/catalog/CatalogShell";
import CatalogShellSkeleton from "@/components/catalog/CatalogShellSkeleton";

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
    alternates: { canonical: `/tags/${slugs.join("/")}` },
  };
}

async function CatalogContent({
  tags,
  hasOfertas,
}: {
  tags: string[];
  hasOfertas: boolean;
}) {
  const { products } = await getCatalogPage("all", 1);
  return (
    <CatalogShell
      initialProducts={products}
      categoria="all"
      tags={tags}
      hasOfertas={hasOfertas}
    />
  );
}

export default async function TagsPage({ params }: PageProps) {
  const { slugs } = await params;
  const tags = slugs.map((s) => decodeURIComponent(s));

  if (tags.length === 1 && isCollectionSlug(tags[0].trim().toLowerCase())) {
    redirect(`/coleccion/${encodeURIComponent(tags[0].trim().toLowerCase())}`);
  }

  const hasOfertas = await hasActiveOfertas();

  return (
    <Suspense
      fallback={
        <CatalogShellSkeleton categoria="all" hasOfertas={hasOfertas} />
      }
    >
      <CatalogContent tags={tags} hasOfertas={hasOfertas} />
    </Suspense>
  );
}
