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
    <div className="pdp-recommended">
      <div className="pdp-recommended__header">
        <h3 className="pdp-recommended__title">Recomendados</h3>
        {verMasTag && (
          <Link
            href={`/tags/${encodeURIComponent(verMasTag)}`}
            className="pdp-recommended__more"
          >
            Ver más
          </Link>
        )}
      </div>

      <div className="pdp-recommended__scroller">
        {products.map((p) => {
          const imgSrc = resolveImageSrc(p.VariantePrincipal);
          const price = formatARS(p.Precio);
          const offerPrice = p.OfertaActiva ? formatARS(p.PrecioOferta) : null;

          return (
            <Link
              key={p.Articulo}
              href={`/producto/${encodeURIComponent(p.Articulo)}`}
              className="pdp-recommended__card-link"
            >
              <div className="pdp-recommended__card">
                <div className="pdp-recommended__img-wrap">
                  {imgSrc ? (
                    <Image
                      src={imgSrc}
                      alt={p.Articulo}
                      fill
                      sizes="140px"
                      className="pdp-recommended__img"
                    />
                  ) : (
                    <div className="skeleton-shimmer pdp-recommended__img-skel" />
                  )}
                </div>

                <div className="pdp-recommended__info">
                  <div className="pdp-recommended__sku">{p.Articulo}</div>
                  <div className="pdp-recommended__prices">
                    {offerPrice ? (
                      <>
                        <span className="pdp-recommended__price-old">{price}</span>
                        <span className="pdp-recommended__price">{offerPrice}</span>
                      </>
                    ) : (
                      <span className="pdp-recommended__price">{price}</span>
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
