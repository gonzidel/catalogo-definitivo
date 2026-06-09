"use client";

import { useRef } from "react";
import Image from "next/image";
import Link from "next/link";
import useSWR from "swr";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { CATALOG_SOURCE, CATALOG_SELECT, agruparProductos } from "@/lib/utils/catalog";
import { resolveImageSrc } from "@/lib/cloudinary";
import { formatARS } from "@/lib/utils/catalog";
import type { CatalogRow, GroupedProduct } from "@/types/catalog";

const ORIGINALS_SELECT = CATALOG_SELECT;

async function fetchFylOriginals(): Promise<GroupedProduct[]> {
  const supabase = getSupabaseBrowserClient();
  const { data, error } = await supabase
    .from(CATALOG_SOURCE)
    .select(ORIGINALS_SELECT)
    .eq("SupplierCode", "FYL")
    .order("FechaPublicacion", { ascending: false, nullsFirst: false });

  if (error || !data || data.length === 0) return [];
  return agruparProductos(data as unknown as CatalogRow[]);
}

function OriginalCard({ product }: { product: GroupedProduct }) {
  const src = resolveImageSrc(product.VariantePrincipal);
  const colors = product.DetalleColor ?? [];
  const precio = product.OfertaActiva && product.PrecioOferta
    ? product.PrecioOferta
    : product.Precio;

  return (
    <Link
      href={`/producto/${encodeURIComponent(product.Articulo)}`}
      className="fyl-originals-card"
      style={{ display: "flex", flexDirection: "column", textDecoration: "none", color: "inherit" }}
    >
      <div style={{ position: "relative", width: "100%", height: 110 }}>
        {src ? (
          <Image
            src={src}
            alt={product.Articulo}
            fill
            sizes="110px"
            style={{ objectFit: "cover" }}
          />
        ) : (
          <div className="skeleton-shimmer" style={{ width: "100%", height: "100%" }} />
        )}
        <div className="fyl-originals-badge">{product.Articulo}</div>
      </div>
      {colors.length > 0 && (
        <div className="fyl-originals-colors">
          {colors.slice(0, 3).map((c) => (
            <span
              key={c.color}
              style={{
                width: 12,
                height: 12,
                borderRadius: "50%",
                background: c.hex_color ?? "#ccc",
                display: "inline-block",
                flexShrink: 0,
              }}
              title={c.color}
            />
          ))}
          {colors.length > 3 && (
            <span className="color-dot color-dot-more" aria-hidden="true">
              +{colors.length - 3}
            </span>
          )}
        </div>
      )}
      <div className="fyl-originals-card-content">
        <div className="fyl-originals-card-price">{formatARS(precio)}</div>
        <div className="fyl-originals-card-wholesale">Precio por Mayor</div>
      </div>
    </Link>
  );
}

function SkeletonOriginalCard() {
  return (
    <div
      className="fyl-originals-card"
      style={{ flexDirection: "column", pointerEvents: "none" }}
      aria-hidden="true"
    >
      <div
        className="skeleton-shimmer"
        style={{ width: "100%", height: 110 }}
      />
      <div className="fyl-originals-card-content">
        <div
          className="skeleton-shimmer"
          style={{ width: "60%", height: 14, borderRadius: 4 }}
        />
      </div>
    </div>
  );
}

export default function FylOriginalsBanner() {
  const scrollRef = useRef<HTMLDivElement>(null);

  const { data: products, isLoading } = useSWR(
    "fyl-originals",
    fetchFylOriginals,
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      dedupingInterval: 300_000,
    }
  );

  const visible = products ?? [];

  // Don't render shell if loaded and empty
  if (!isLoading && visible.length === 0) return null;

  return (
    <section className="orig-block fyl-originals-banner" aria-label="F&L Originals — fabricación propia">
      <div className="orig-head">
        <h2 className="orig-title">
          F&amp;L Originals{" "}
          <span className="orig-subInline">• Fabricación propia</span>
        </h2>
        <Link
          href="/tags/fyl-originals"
          className="orig-ver-todo"
          aria-label="Ver colección completa"
        >
          Ver colección →
        </Link>
      </div>

      <div
        ref={scrollRef}
        className="fyl-originals-scroll orig-carousel"
        style={{ display: "flex", overflowX: "auto" }}
      >
        {isLoading
          ? Array.from({ length: 6 }).map((_, i) => <SkeletonOriginalCard key={i} />)
          : visible.map((p) => <OriginalCard key={p.Articulo} product={p} />)}
      </div>
    </section>
  );
}
