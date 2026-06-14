"use client";

import useSWR from "swr";
import Link from "next/link";
import Image from "next/image";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { CATALOG_SOURCE, CATALOG_SELECT, agruparProductos, formatARS } from "@/lib/utils/catalog";
import { resolveImageSrc } from "@/lib/cloudinary";
import type { CatalogRow, GroupedProduct } from "@/types/catalog";

interface PdpRecommendedProps {
  articulo: string;
  filtro1?: string;
  filtro2?: string;
  filtro3?: string;
  categoria?: string;
}

async function fetchRecommended(
  articulo: string,
  filtro1: string,
  filtro2: string,
  filtro3: string,
  categoria: string
): Promise<GroupedProduct[]> {
  const supabase = getSupabaseBrowserClient();

  // Avoid .or() with ilike patterns — % wildcards get URL-decoded incorrectly
  // (e.g. %De is read as hex 0xDE). Use dedicated .ilike() on one column instead.
  // Priority: Filtro1 > Filtro2 > Filtro3 > same Categoria.
  const primaryTag = (filtro1 || filtro2 || filtro3).split(",")[0].trim();
  const primaryCol = filtro1
    ? "Filtro1"
    : filtro2
    ? "Filtro2"
    : filtro3
    ? "Filtro3"
    : null;

  let query = supabase
    .from(CATALOG_SOURCE)
    .select(CATALOG_SELECT)
    .order("FechaPublicacion", { ascending: false, nullsFirst: false })
    .limit(80);

  if (primaryCol && primaryTag) {
    query = query.ilike(primaryCol, `%${primaryTag}%`);
  } else if (categoria) {
    query = query.eq("Categoria", categoria);
  }

  const { data } = await query;
  if (!data || data.length === 0) {
    // Fallback: same category
    if (categoria) {
      const { data: byCategoria } = await supabase
        .from(CATALOG_SOURCE)
        .select(CATALOG_SELECT)
        .eq("Categoria", categoria)
        .order("FechaPublicacion", { ascending: false, nullsFirst: false })
        .limit(80);
      if (!byCategoria) return [];
      const grouped = agruparProductos(byCategoria as unknown as CatalogRow[]);
      return grouped.filter((p) => p.Articulo !== articulo).slice(0, 10);
    }
    return [];
  }

  const grouped = agruparProductos(data as unknown as CatalogRow[]);
  return grouped.filter((p) => p.Articulo !== articulo).slice(0, 10);
}

export default function PdpRecommended({
  articulo,
  filtro1 = "",
  filtro2 = "",
  filtro3 = "",
  categoria = "",
}: PdpRecommendedProps) {
  const key = `recommended:${articulo}:${filtro1}:${filtro2}:${filtro3}`;
  const { data: products } = useSWR(
    key,
    () => fetchRecommended(articulo, filtro1, filtro2, filtro3, categoria),
    { revalidateOnFocus: false, dedupingInterval: 300_000 }
  );

  if (!products || products.length === 0) return null;

  // Use the first non-empty filtro as the "ver más" link target
  const verMasTag = filtro1 || filtro2 || filtro3;

  return (
    <div style={{ marginTop: 32 }}>
      {/* Header */}
      <div style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        marginBottom: 12,
        padding: "0 2px",
      }}>
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "#222" }}>
          Recomendados
        </h3>
        {verMasTag && (
          <Link
            href={`/tags/${encodeURIComponent(verMasTag)}`}
            style={{
              fontSize: 13,
              color: "#555",
              textDecoration: "none",
              border: "1px solid #ddd",
              borderRadius: 20,
              padding: "4px 12px",
              whiteSpace: "nowrap",
            }}
          >
            Ver más
          </Link>
        )}
      </div>

      {/* Horizontal scroll */}
      <div style={{
        display: "flex",
        gap: 10,
        overflowX: "auto",
        paddingBottom: 8,
        WebkitOverflowScrolling: "touch" as const,
      }}>
        {products.map((p) => {
          const imgSrc = resolveImageSrc(p.VariantePrincipal);
          const price = formatARS(p.Precio);
          const offerPrice = p.OfertaActiva ? formatARS(p.PrecioOferta) : null;

          return (
            <Link
              key={p.Articulo}
              href={`/producto/${encodeURIComponent(p.Articulo)}`}
              style={{ textDecoration: "none", color: "inherit", flexShrink: 0 }}
            >
              <div style={{ width: 140 }}>
                {/* Image */}
                <div style={{
                  position: "relative",
                  width: 140,
                  height: 140,
                  borderRadius: 8,
                  overflow: "hidden",
                  background: "#f5f5f5",
                }}>
                  {imgSrc ? (
                    <Image
                      src={imgSrc}
                      alt={p.Articulo}
                      fill
                      sizes="140px"
                      style={{ objectFit: "cover" }}
                    />
                  ) : (
                    <div className="skeleton-shimmer" style={{ width: "100%", height: "100%" }} />
                  )}
                </div>

                {/* Info */}
                <div style={{ marginTop: 6, padding: "0 2px" }}>
                  <div style={{ fontSize: 12, color: "#888", marginBottom: 2 }}>
                    {p.Articulo}
                  </div>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
                    {offerPrice ? (
                      <>
                        <span style={{ fontSize: 13, color: "#999", textDecoration: "line-through" }}>
                          {price}
                        </span>
                        <span style={{ fontSize: 14, fontWeight: 700, color: "#CD844D" }}>
                          {offerPrice}
                        </span>
                      </>
                    ) : (
                      <span style={{ fontSize: 14, fontWeight: 700, color: "#CD844D" }}>
                        {price}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
