"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";

interface CatalogRow {
  Articulo: string;
  Color?: string | null;
  Precio: string;
  PrecioOferta?: string;
  OfertaActiva?: boolean;
  "Imagen Principal"?: string | null;
  FechaIngreso?: string | null;
  Numeracion?: string | null;
  variant_id?: string | null;
}

interface Props {
  daysLeft: number;
  remaining: number;
}

const CHEAP_THRESHOLD = 18000;

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function toNum(v: string | undefined | null): number {
  return parseFloat(String(v ?? "0").replace(/[^0-9.]/g, "")) || 0;
}

function formatARS(n: number) {
  return "$ " + Math.round(n).toLocaleString("es-AR");
}

function hasAvailableSizes(row: CatalogRow): boolean {
  return String(row.Numeracion ?? "")
    .split(",")
    .map((s) => s.trim())
    .some(Boolean);
}

export default function CartRecommendedCarousel({ daysLeft, remaining }: Props) {
  const [pool, setPool] = useState<CatalogRow[]>([]);
  const [loading, setLoading] = useState(true);

  const urgentMode = daysLeft <= 1 && remaining > 0;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    async function load() {
      try {
        const supabase = getSupabaseBrowserClient();
        // Vista ya filtrada a variantes con available_qty > 0.
        const { data, error } = await supabase
          .from("catalog_public_available_view")
          .select(
            'Articulo, Color, Precio, PrecioOferta, OfertaActiva, "Imagen Principal", FechaIngreso, Numeracion, variant_id'
          )
          .not("Numeracion", "is", null)
          .order("FechaPublicacion", { ascending: false, nullsFirst: false })
          .limit(120);

        if (cancelled) return;
        if (error || !data) {
          setLoading(false);
          return;
        }

        // Deduplicar por Articulo; nos quedamos con la primera variante con talles.
        const seen = new Set<string>();
        const unique: CatalogRow[] = [];
        for (const row of data as CatalogRow[]) {
          if (!row.Articulo || seen.has(row.Articulo) || !hasAvailableSizes(row)) continue;
          seen.add(row.Articulo);
          unique.push(row);
        }

        let candidates: CatalogRow[];
        if (urgentMode) {
          const cheap = unique.filter((p) => {
            const price = toNum(p.OfertaActiva ? (p.PrecioOferta ?? p.Precio) : p.Precio);
            return price > 0 && price <= CHEAP_THRESHOLD;
          });
          const extra = unique
            .filter((p) => !cheap.includes(p))
            .sort((a, b) => toNum(a.Precio) - toNum(b.Precio));
          candidates = [...shuffle(cheap), ...extra];
        } else {
          const cutoff = Date.now() - 60 * 86400000;
          const newProds = unique.filter((p) => {
            const parts = (p.FechaIngreso ?? "").split("/");
            if (parts.length !== 3) return false;
            return new Date(`${parts[2]}-${parts[1]}-${parts[0]}`).getTime() > cutoff;
          });
          const rest = unique.filter((p) => !newProds.includes(p));
          candidates = [...shuffle(newProds), ...shuffle(rest)];
        }

        if (!cancelled) {
          setPool(candidates.slice(0, 9));
          setLoading(false);
        }
      } catch {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [urgentMode]);

  if (pool.length === 0 && !loading) return null;

  return (
    <div className="cart-reco">
      <div className="cart-reco__header">
        <span
          className={["cart-reco__title", urgentMode ? "is-urgent" : ""]
            .filter(Boolean)
            .join(" ")}
        >
          {urgentMode ? "⚡ ¡Completá tu pedido hoy!" : "✨ Te puede interesar"}
        </span>
      </div>

      <div className="cart-reco__wrap">
        <div className="cart-reco-scroll">
          {loading ? (
            [0, 1, 2, 3].map((i) => (
              <div key={i} className="cart-reco__skel">
                <div className="cart-reco__skel-card">
                  <div className="cart-reco__img-ph" />
                  <div className="cart-reco__info">
                    <div className="cart-reco__skel-line" />
                    <div className="cart-reco__skel-line cart-reco__skel-line--short" />
                  </div>
                </div>
              </div>
            ))
          ) : (
            pool.map((p) => {
              const img = p["Imagen Principal"];
              const price = toNum(p.Precio);
              const offerPrice = p.OfertaActiva ? toNum(p.PrecioOferta) : 0;
              const hasOffer = offerPrice > 0 && offerPrice < price;
              const displayPrice = hasOffer ? offerPrice : price;
              const color = String(p.Color ?? "").trim();
              const href = color
                ? `/producto/${encodeURIComponent(p.Articulo)}?color=${encodeURIComponent(color)}`
                : `/producto/${encodeURIComponent(p.Articulo)}`;
              return (
                <Link
                  key={`${p.Articulo}__${p.variant_id ?? color}`}
                  href={href}
                  className="cart-reco__card-link"
                >
                  <div className="cart-reco__card">
                    {img ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={img}
                        alt={p.Articulo}
                        loading="lazy"
                        className="cart-reco__img"
                      />
                    ) : (
                      <div className="cart-reco__img-ph" />
                    )}
                    <div className="cart-reco__info">
                      <div className="cart-reco__sku">{p.Articulo}</div>
                      {displayPrice > 0 && (
                        <div
                          className={[
                            "cart-reco__price",
                            hasOffer ? "is-offer" : "",
                          ]
                            .filter(Boolean)
                            .join(" ")}
                        >
                          {formatARS(displayPrice)}
                        </div>
                      )}
                    </div>
                  </div>
                </Link>
              );
            })
          )}
        </div>

        <div className="cart-reco__fade" aria-hidden />
      </div>
    </div>
  );
}
