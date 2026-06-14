import { Suspense } from "react";
import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  COLLECTION_META,
  fetchCollectionProducts,
  isCollectionSlug,
} from "@/lib/banners/collections";
import CatalogShell from "@/components/catalog/CatalogShell";
import SkeletonCard from "@/components/catalog/SkeletonCard";

export const revalidate = 300;

interface PageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const normalized = decodeURIComponent(slug).trim().toLowerCase();
  if (!isCollectionSlug(normalized)) return { title: "Colección — FYL Moda" };
  const meta = COLLECTION_META[normalized];
  return {
    title: `${meta.title} — FYL Moda`,
    description: `${meta.title}. ${meta.subtitle}. Catálogo mayorista.`,
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

async function CollectionContent({ slug }: { slug: string }) {
  const normalized = slug.trim().toLowerCase();
  if (!isCollectionSlug(normalized)) notFound();

  const meta = COLLECTION_META[normalized];
  const supabase = await createSupabaseServerClient();
  const products = await fetchCollectionProducts(supabase, normalized);

  return (
    <>
      <div style={{ padding: "10px 12px 0" }}>
        <Link
          href="/"
          style={{
            color: "#CD844D",
            textDecoration: "none",
            fontSize: "0.875rem",
            fontWeight: 600,
          }}
        >
          ← Inicio
        </Link>
        <h1
          style={{
            margin: "8px 0 0",
            fontSize: "1.25rem",
            fontWeight: 700,
            color: "#1a1a1a",
          }}
        >
          {meta.title}
        </h1>
        <p style={{ margin: "4px 0 0", fontSize: "0.8125rem", color: "#666" }}>
          {meta.subtitle}
          {products.length > 0 && (
            <>
              {" "}
              · {products.length} artículo{products.length === 1 ? "" : "s"}
            </>
          )}
        </p>
      </div>

      <CatalogShell
        initialProducts={products}
        categoria="all"
        tags={[]}
        fixedProductSet
      />
    </>
  );
}

export default async function ColeccionPage({ params }: PageProps) {
  const { slug } = await params;
  const decoded = decodeURIComponent(slug);

  return (
    <Suspense fallback={<CatalogSkeleton />}>
      <CollectionContent slug={decoded} />
    </Suspense>
  );
}
