"use client";

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import {
  isLocalPickupOrderFulfilled,
  localPickupFulfilledDismissKey,
  isCommonLocalPickupOrder,
} from "@/lib/orders/domain";
import { getCustomerFacingItemStatus } from "@/lib/orders/waiting-source";
import { groupCustomerOrderItems, type GroupedCustomerOrderItem } from "@/lib/orders/customer-order-display";
import {
  getCustomerOrderDeadlineDate,
  calendarDaysUntil,
  isOrderExpired,
  getLocalPickupDeadlineExplanation,
  isShortPickupDeadlineWindow,
  formatRemainingCountdown,
  orderDaysRemainingForOrder,
} from "@/lib/orders/deadline";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { loadWarehouses, rpcCloseOrder, rpcCustomerRequestClose } from "@/lib/supabase/order-queries";
import { hasCustomerUsedOrderExtension } from "@/lib/order-notes";
import {
  getOrderCloseMinimumUnits,
  getOrderReadyCompactMessage,
  isLocalPickupTransport,
  isLocalPickupShortDeadlineZone,
} from "@/lib/transport/shipping-helpers";
import { CATALOG_SOURCE } from "@/lib/utils/catalog";
import { useCartStore } from "@/store/cart";
import type { WarehouseIds } from "@/types/orders";
import LineItemRow, { formatItemARS, QuantityUnitLabel } from "@/components/cart/LineItemRow";
import PromoGroupRow from "@/components/cart/PromoGroupRow";
import CartRecommendedCarousel from "@/components/cart/CartRecommendedCarousel";
import OrderTransportConfirmModal, {
  getOrderTransportConfirmKey,
} from "@/components/cart/OrderTransportConfirmModal";
import { rpcSetTransportBeforeCloseOrder, rpcSetMyTransport } from "@/lib/transport/rpc";
import { canonicalizeTransportName } from "@/lib/transport";
import { useProfileGate } from "@/components/profile/ProfileGateProvider";
import {
  buildPromoGroups,
  fetchActivePromotionsForVariants,
  sumPromoAwareTotal,
  type ActivePromotion,
  type PromoGroup,
  type PromoGroupableItem,
} from "@/lib/cart/promo-groups";
import {
  getDashboardLocalPickupCloseCopy,
  resolvePickupDeadlineLabel,
} from "@/lib/orders/customer-status-message";

function orderItemPromoKey(item: {
  primaryItemId?: string;
  id?: string;
  variant_id?: string | null;
  size?: string | null;
}) {
  const id = item.primaryItemId || item.id || "";
  return `${item.variant_id ?? ""}__${String(item.size ?? "").toLowerCase()}__${id}`;
}

function toPromoGroupable(
  item: GroupedCustomerOrderItem & OrderItem
): PromoGroupableItem {
  return {
    key: orderItemPromoKey(item),
    variant_id: String(item.variant_id ?? ""),
    product_name: item.product_name,
    color: item.color,
    size: item.size,
    qty: Number(item.quantity ?? 0) || 0,
    price_snapshot: Number(item.price_snapshot ?? 0) || 0,
    imagen: item.imagen,
  };
}

type OrderDisplayRow =
  | { kind: "promo"; group: PromoGroup; members: Array<GroupedCustomerOrderItem & OrderItem> }
  | { kind: "item"; item: GroupedCustomerOrderItem & OrderItem };

function buildOrderDisplayRows(
  items: Array<GroupedCustomerOrderItem & OrderItem>,
  promotions: ActivePromotion[]
): OrderDisplayRow[] {
  const groupables = items
    .filter((i) => i.variant_id)
    .map(toPromoGroupable);
  const { groups, ungrouped } = buildPromoGroups(groupables, promotions);

  const itemByKey = new Map(
    items.map((i) => [orderItemPromoKey(i), i] as const)
  );
  const keyToGroup = new Map<string, PromoGroup>();
  for (const g of groups) {
    for (const gi of g.items) keyToGroup.set(gi.key, g);
  }
  const remainderByKey = new Map(ungrouped.map((u) => [u.key, u] as const));

  const emittedPromo = new Set<string>();
  const rows: OrderDisplayRow[] = [];

  for (const item of items) {
    const key = orderItemPromoKey(item);
    const g = keyToGroup.get(key);
    if (g && !emittedPromo.has(g.promotionId)) {
      emittedPromo.add(g.promotionId);
      // Miembros con la qty cubierta (pares), no la qty total de la línea.
      const members = g.items
        .map((gi) => {
          const src = itemByKey.get(gi.key);
          if (!src) return null;
          return { ...src, quantity: gi.qty };
        })
        .filter(Boolean) as Array<GroupedCustomerOrderItem & OrderItem>;
      rows.push({ kind: "promo", group: g, members });
    }

    const rem = remainderByKey.get(key);
    if (rem && rem.qty > 0) {
      rows.push({
        kind: "item",
        item: { ...item, quantity: rem.qty },
      });
      remainderByKey.delete(key);
    } else if (!g && !item.variant_id) {
      // Sin variant: nunca entra a promo
      rows.push({ kind: "item", item });
    }
  }

  return rows;
}

function offerItemKey(productName?: string | null, color?: string | null) {
  return `${String(productName ?? "").trim().toLowerCase()}|${String(color ?? "").trim().toLowerCase()}`;
}

function formatARS(n: number) {
  return formatItemARS(n);
}

const ORDER_STATUS_INFO: Record<string, { label: string; color: string; bg: string }> = {
  active:       { label: "Activo",     color: "#1b5e20", bg: "#e6f4ea" },
  closing_soon: { label: "Por cerrar", color: "#92400e", bg: "#fef3c7" },
  closed:       { label: "Cerrado",    color: "#1e40af", bg: "#dbeafe" },
};

interface OrderItem {
  id: string;
  product_name: string;
  color: string;
  size: string;
  quantity: number;
  price_snapshot: number;
  imagen?: string;
  status?: string;
  variant_id?: string;
  created_at?: string;
  order_item_stock_sources?: { warehouse_id: string; qty: number }[];
}

interface ActiveOrder {
  id: string;
  order_number: string;
  status: string;
  total_amount: number;
  created_at: string;
  payment_method?: string | null;
  dismantle_at?: string | null;
  expires_at?: string | null;
  local_deferred_pickup?: boolean | null;
  pickup_timer_started_at?: string | null;
  notes?: string | null;
  order_items: OrderItem[];
}

// sessionStorage key: si el cliente toca una alternativa y navega a su PDP,
// guardamos acá para qué ítem estaba abierto el panel — al volver con el
// botón atrás, "Mi pedido" lo reabre automáticamente en vez de perderlo.
const ALT_PANEL_STORAGE_KEY = "fyl-nj-alt-panel-item";
const FIRST_ORDER_GUIDE_KEY_PREFIX = "fyl-nj-first-order-guide:";
const WHATSAPP_HREF = "https://wa.me/5493624118637";
/** Local FYL — mismo link que en quiénes somos / cómo comprar. */
const LOCAL_STORE_MAPS_HREF = "https://maps.app.goo.gl/PoxAhU5AG3m2etSz5";

function WhatsAppIcon({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.7 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
    </svg>
  );
}

/** Círculo de líneas (tipo activity) — prep. pedido local diferido. */
function PreparingOrderSpinner({ size = 18 }: { size?: number }) {
  const ticks = 12;
  return (
    <span className="active-order-prep-spinner" aria-hidden="true">
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        {Array.from({ length: ticks }, (_, i) => {
          const angle = (i * 360) / ticks;
          const opacity = 0.2 + (i / (ticks - 1)) * 0.8;
          return (
            <line
              key={i}
              x1="12"
              y1="3.2"
              x2="12"
              y2="6.8"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              opacity={opacity}
              transform={`rotate(${angle} 12 12)`}
            />
          );
        })}
      </svg>
    </span>
  );
}

/** Check/spinner por ítem solo en retiro local especial (local_deferred_pickup / localidades asignadas). */
function CustomerItemPrepStatus({
  item,
  warehouseIds,
  localDeferredPickup,
}: {
  item: Parameters<typeof getCustomerFacingItemStatus>[0];
  warehouseIds: WarehouseIds;
  localDeferredPickup: boolean;
}) {
  if (!localDeferredPickup) return null;

  const facing = getCustomerFacingItemStatus(item, warehouseIds);
  if (facing === "picked") {
    return (
      <span
        className="active-order-prep-item-status is-done"
        aria-label="Producto confirmado"
        title="Confirmado"
      >
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
      </span>
    );
  }
  return (
    <span
      className="active-order-prep-item-status is-pending"
      aria-label="Producto en preparación"
      title="Preparando"
    >
      <PreparingOrderSpinner size={12} />
    </span>
  );
}

const MESES_ABREV = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const DIAS_SEMANA = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

function formatShortDate(d: Date): string {
  return `${d.getDate()} ${MESES_ABREV[d.getMonth()]}.`;
}

function formatWeekdayDate(d: Date): string {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${DIAS_SEMANA[d.getDay()]} ${dd}/${mm}`;
}

function formatTime(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function formatDeadlineChip(calendarDaysLeft: number, deadline: Date): string {
  if (calendarDaysLeft > 5) return `Vence ${formatShortDate(deadline)}`;
  if (calendarDaysLeft >= 2) return `${calendarDaysLeft} días`;
  if (calendarDaysLeft === 1) return "Mañana";
  return `Hoy · ${formatTime(deadline)}`;
}

function getDeadlineExplanation(calendarDaysLeft: number, deadline: Date): string {
  const when = formatWeekdayDate(deadline);
  const time = formatTime(deadline);
  if (calendarDaysLeft > 5) {
    return `Fecha límite de tu pedido. Podés agregar productos y cerrarlo hasta el ${when} a las ${time}. Después quedará cerrado para cambios.`;
  }
  if (calendarDaysLeft === 5) {
    return `Te quedan 5 días. Podés seguir agregando productos y cerrar tu pedido cuando termines. Vence el ${when} a las ${time}.`;
  }
  if (calendarDaysLeft === 4) {
    return `Te quedan 4 días. Podés seguir agregando productos hasta el ${when} a las ${time}. Recordá cerrarlo antes del vencimiento.`;
  }
  if (calendarDaysLeft === 3) {
    return `Te quedan 3 días. Terminá de agregar productos y cerrá tu pedido antes del ${when} a las ${time}.`;
  }
  if (calendarDaysLeft === 2) {
    return `Te quedan 2 días. Tu pedido vence el ${when} a las ${time}. Cerralo antes de ese horario para evitar que quede cerrado para cambios.`;
  }
  if (calendarDaysLeft === 1) {
    return `Tu pedido vence mañana. Cerrá tu pedido antes de las ${time}. Después de ese horario quedará cerrado para cambios.`;
  }
  return `Tu pedido vence hoy. Cerrá tu pedido antes de las ${time}. Después ya no podrás agregar ni modificar productos.`;
}

interface AlternativeProduct {
  Articulo: string;
  Color: string;
  Talle: string;
  Precio: number;
  "Imagen Principal": string;
  variant_id?: string;
}

interface AlternativesResult {
  items: AlternativeProduct[];
  tags: string[];
  categoria: string | null;
}

// ─── Alternatives panel ───────────────────────────────────────────────────────

async function fetchAlternatives(
  articulo: string,
  size: string,
  color: string
): Promise<AlternativesResult> {
  const supabase = getSupabaseBrowserClient();

  // Get product tags
  const { data: catalogRow } = await supabase
    .from("catalog_public_view")
    .select('"Filtro1","Filtro2","Filtro3","Categoria"')
    .eq("Articulo", articulo)
    .limit(1)
    .maybeSingle();

  const filters = [
    catalogRow?.Filtro1,
    catalogRow?.Filtro2,
    catalogRow?.Filtro3,
  ].filter(Boolean) as string[];

  // catalog_public_view no tiene columnas "Talle" ni "Stock" (por eso esto
  // siempre devolvía vacío): el talle real se llama "Numeracion" y vive en
  // catalog_public_available_view, que ya viene pre-filtrada a variantes
  // con stock disponible. Ojo: "Numeracion" ahí es una lista de talles
  // separada por comas para toda la variante (ej. "36,37,38,40"), no un
  // talle por fila — por eso el filtro exacto se hace en el cliente,
  // después de un ilike amplio del lado de la base.
  let query = supabase
    .from("catalog_public_available_view")
    .select('"Articulo","Color","Numeracion","Precio","Imagen Principal","variant_id"')
    .ilike("Numeracion", `%${size}%`)
    .neq("Articulo", articulo)
    .limit(60);

  // Try to match by tags first
  if (filters.length > 0) {
    query = query.or(
      filters.map((f) => `"Filtro1".ilike.${f},"Filtro2".ilike.${f},"Filtro3".ilike.${f}`).join(",")
    );
  } else if (catalogRow?.Categoria) {
    query = query.ilike("Categoria", catalogRow.Categoria);
  }

  const categoria = catalogRow?.Categoria ?? null;

  const { data, error } = await query;
  if (error) {
    console.error("fetchAlternatives error", error);
    return { items: [], tags: filters, categoria };
  }

  const wantedSize = size.trim().toLowerCase();
  const exactMatches = (data ?? []).filter((row: any) =>
    String(row.Numeracion ?? "")
      .split(",")
      .map((s: string) => s.trim().toLowerCase())
      .includes(wantedSize)
  );

  // Priorizar mismo color que el producto sin stock (ej. buscaba negro,
  // mostrar primero otras opciones en negro) y recién si no alcanzan para
  // completar la vista previa, completar con otros colores. No se
  // descarta nada: solo se reordena, así "Ver más opciones" sigue
  // teniendo el universo completo disponible.
  const wantedColor = color.trim().toLowerCase();
  const sameColor: any[] = [];
  const otherColor: any[] = [];
  for (const row of exactMatches) {
    if (String(row.Color ?? "").trim().toLowerCase() === wantedColor) {
      sameColor.push(row);
    } else {
      otherColor.push(row);
    }
  }
  const sorted = [...sameColor, ...otherColor];

  const items = sorted.slice(0, 30).map((row: any) => ({
    Articulo: row.Articulo,
    Color: row.Color,
    Talle: size,
    Precio: row.Precio,
    "Imagen Principal": row["Imagen Principal"],
    variant_id: row.variant_id,
  })) as AlternativeProduct[];

  return { items, tags: filters, categoria };
}

function AlternativesPanel({
  item,
  onClose,
  onSelected,
  onRemoveItem,
  removing,
  replacingId,
  replaceError,
}: {
  item: OrderItem;
  onClose: () => void;
  onSelected: (alt: AlternativeProduct, cardId: string) => void;
  onRemoveItem: () => void;
  removing: boolean;
  /** Articulo+Color+i de la alternativa que se está reemplazando (matchea la key de cada card), o null si no hay ninguna en curso. */
  replacingId: string | null;
  replaceError: string | null;
}) {
  const [alts, setAlts] = useState<AlternativeProduct[] | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [categoria, setCategoria] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetched, setFetched] = useState(false);

  if (!fetched && !loading) {
    setLoading(true);
    setFetched(true);
    fetchAlternatives(item.product_name, item.size, item.color).then((res) => {
      setAlts(res.items);
      setTags(res.tags);
      setCategoria(res.categoria);
      setLoading(false);
    });
  }

  const PREVIEW_COUNT = 6;
  const preview = (alts ?? []).slice(0, PREVIEW_COUNT);

  // Antes de ir al PDP de una alternativa, guardamos qué ítem tenía este
  // panel abierto — así, si el cliente vuelve con "atrás", este mismo panel
  // se reabre solo en vez de perder el contexto.
  const handleProductTap = () => {
    try { sessionStorage.setItem(ALT_PANEL_STORAGE_KEY, item.id); } catch { /* ignore */ }
  };

  // "Ver más opciones" — mismo buscador del catálogo, con talle + tags (o
  // categoría) pre-aplicados como si el cliente los hubiese elegido ahí.
  const seeMoreHref = (() => {
    const qs = new URLSearchParams({ talle: item.size }).toString();
    if (tags.length > 0) {
      return `/nj/tags/${tags.map((t) => encodeURIComponent(t)).join("/")}?${qs}`;
    }
    if (categoria) {
      return `/nj/${encodeURIComponent(categoria)}?${qs}`;
    }
    return `/nj?${qs}`;
  })();

  // Portal a document.body: #catalog-view tiene view-transition-name (usado para
  // las transiciones nativas entre páginas), lo que lo obliga a formar su propio
  // stacking context de forma permanente (no solo durante una transición activa,
  // ver spec CSS View Transitions). Cualquier z-index puesto en un descendiente de
  // #catalog-view queda "encerrado" ahí adentro y nunca puede superar a elementos
  // fuera de #catalog-view como .bottom-nav (z-index 10000 !important), sin
  // importar cuán alto sea el z-index inline. El portal saca este modal fixed
  // fuera de esa jerarquía para que sí compita de igual a igual.
  return createPortal(
    <div className="active-order-alt-backdrop" onClick={onClose}>
      <div
        className="active-order-alt-sheet"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="active-order-sheet__header active-order-sheet__header--alt">
          <span className="active-order-sheet__title active-order-sheet__title--left">
            Alternativas en Talle {item.size}
          </span>
          <button type="button" onClick={onClose} className="active-order-btn active-order-btn--text-danger active-order-state__close active-order-alt-close">×</button>
        </div>
        <p className="active-order-sheet__subtitle active-order-sheet__subtitle--left">
          {item.product_name} no tiene stock en este talle — tocá una opción para reemplazarlo directamente.
        </p>

        {replaceError && (
          <div className="active-order-banner active-order-banner--error">
            {replaceError}
          </div>
        )}

        {loading && (
          <div className="active-order-alt__loading">
            Buscando alternativas...
          </div>
        )}

        {!loading && alts !== null && alts.length === 0 && (
          <div className="active-order-alt__empty">
            No encontramos alternativas disponibles en este talle.
          </div>
        )}

        {!loading && preview.length > 0 && (
          <div className="active-order-alt__grid active-order-alt__grid--mb">
            {preview.map((alt, i) => {
              const cardId = `${alt.Articulo}-${alt.Color}-${i}`;
              const isReplacingThis = replacingId === cardId;
              const disabled = replacingId !== null;
              return (
                <button
                  key={cardId}
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    handleProductTap();
                    onSelected(alt, cardId);
                  }}
                  className={`active-order-alt-card${disabled && !isReplacingThis ? " is-disabled" : ""}`}
                >
                  {alt["Imagen Principal"] && (
                    <img
                      src={alt["Imagen Principal"]}
                      alt={alt.Articulo}
                      className="active-order-alt-card__img"
                    />
                  )}
                  <div className="active-order-alt-card__name">
                    {alt.Articulo}
                  </div>
                  <div className="active-order-alt-card__color">
                    {alt.Color}
                  </div>
                  <div className="active-order-alt-card__price">
                    {formatARS(alt.Precio)}
                  </div>
                  {isReplacingThis && (
                    <div className="active-order-alt-card__overlay">
                      Reemplazando…
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {/* Rápido: si nada le interesa, quitarlo directo — sin obligarlo a
            ir y volver del catálogo para resolverlo. */}
        <div className="active-order-sheet__actions active-order-sheet__actions--stack active-order-sheet__actions--flat">
          {!loading && alts !== null && alts.length > 0 && (
            <a
              href={seeMoreHref}
              onClick={handleProductTap}
              className="active-order-btn active-order-btn--dashed"
            >
              Ver más opciones
            </a>
          )}

          <button
            onClick={onRemoveItem}
            disabled={removing || replacingId !== null}
            className={`active-order-btn active-order-btn--danger-outline${removing || replacingId !== null ? " is-disabled" : ""}`}
          >
            {removing ? "Quitando..." : "No, prefiero quitarlo del pedido"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

interface ActiveOrderTabProps {
  order: ActiveOrder | null;
  customerId: string;
  customerProvince?: string | null;
  customerCity?: string | null;
  onOrderSent: () => void;
  onOrderRefresh: () => void;
  onOrderDismissed: () => void;
  onOrderCancelled: () => void; // revert closed → active
  onOrderFullyCancelled: () => void;
  showCancelSuccess?: boolean;
  onCancelSuccessDismiss?: () => void;
  /** Transporte asignado según provincia/localidad (mismo cálculo que DashboardClient) — cambia el aviso de "listo para coordinar" (ej. Via Cargo también coordina el pago). */
  transportName?: string | null;
  /** Cuando el cliente confirma/guarda transporte en BD (cierre o elección). */
  onTransportPersisted?: (transporte: string, transportId?: string | null) => void;
  /** Tras "Agregar al carrito" desde editar cantidad: cambiar a la pestaña Carrito. */
  onGoToCart?: () => void;
}

export default function ActiveOrderTab({
  order,
  customerId,
  customerProvince,
  customerCity,
  showCancelSuccess,
  onCancelSuccessDismiss,
  onOrderSent,
  onOrderRefresh,
  onOrderDismissed,
  onOrderCancelled,
  onOrderFullyCancelled,
  transportName,
  onTransportPersisted,
  onGoToCart,
}: ActiveOrderTabProps) {
  const [confirmedTransportName, setConfirmedTransportName] = useState<string | null>(transportName ?? null);
  const activeTransportName = confirmedTransportName ?? transportName;
  const isLocalPickupOrder = isLocalPickupTransport(activeTransportName);
  const [sending, setSending]                   = useState(false);
  const [error, setError]                       = useState<string | null>(null);
  const [showMissingHint, setShowMissingHint]   = useState(false);
  // Se mantiene montado un instante más que showMissingHint para poder
  // reproducir la animación de salida (fade+scale) antes de desaparecer del
  // todo — si se desmontara junto con showMissingHint, el cierre sería
  // instantáneo sin transición.
  const [missingHintMounted, setMissingHintMounted] = useState(false);
  useEffect(() => {
    if (showMissingHint) {
      setMissingHintMounted(true);
      return;
    }
    const t = window.setTimeout(() => setMissingHintMounted(false), 220);
    return () => window.clearTimeout(t);
  }, [showMissingHint]);
  const [cancelingId, setCancelingId]           = useState<string | null>(null);
  const [altOpenFor, setAltOpenFor]             = useState<string | null>(null);
  const [altReplacingCardId, setAltReplacingCardId] = useState<string | null>(null);
  const [altReplaceError, setAltReplaceError]   = useState<string | null>(null);
  const [menuOpenFor, setMenuOpenFor]           = useState<string | null>(null);
  const [orderMenuOpen, setOrderMenuOpen]         = useState(false);
  const [showSendConfirm, setShowSendConfirm]   = useState(false);
  const [showTransportConfirm, setShowTransportConfirm] = useState(false);
  const [showFirstOrderGuide, setShowFirstOrderGuide] = useState(false);
  const [showCancelConfirm, setShowCancelConfirm] = useState(false);
  const [cancelingPrep, setCancelingPrep]       = useState(false);
  const [showReopenConfirm, setShowReopenConfirm] = useState(false);
  const [reopenError, setReopenError]           = useState<string | null>(null);
  const [extending, setExtending]               = useState(false);
  const [cancelingOrder, setCancelingOrder]     = useState(false);
  const [showAllItems, setShowAllItems]         = useState(false);
  const [headerAltPhase, setHeaderAltPhase]     = useState(false);
  const [warehouseIds, setWarehouseIds]       = useState<WarehouseIds>({
    general: null,
    ventaPublico: null,
  });
  // Nota: estos 4 deben declararse acá (antes de cualquier `return` anticipado
  // más abajo) para no violar las Reglas de los Hooks — moverlos después de un
  // `if (...) return` hace que React vea un número distinto de hooks entre
  // renders ("change in order of Hooks") cuando el pedido está `sent`/`closed`/
  // sin pedido/cancelado.
  const [showStatusInfo, setShowStatusInfo] = useState(false);
  const [showDaysInfo, setShowDaysInfo]     = useState(false);
  const [showMinInfo, setShowMinInfo]       = useState(false);
  const [editQtyFor, setEditQtyFor]         = useState<string | null>(null);
  const [editQtyValue, setEditQtyValue]     = useState<number>(0);
  const [variantStock, setVariantStock]     = useState<Record<string, number>>({});
  /** Confirmación al quitar desde el menú ⋯ de Mi pedido */
  const [pendingRemoveItem, setPendingRemoveItem] = useState<(GroupedCustomerOrderItem & OrderItem) | null>(null);
  /** Unidades que quedan en el pedido (como en la lista). Quitar = cantidad actual − keepUnits. */
  const [keepUnits, setKeepUnits]           = useState(0);
  /** Keys `producto|color` con oferta activa (para 🔥 + precio rojo). */
  const [offerItemKeys, setOfferItemKeys]   = useState<Set<string>>(() => new Set());
  const [promotions, setPromotions]         = useState<ActivePromotion[]>([]);
  // Debe estar aquí (antes de los early returns) para no violar las Reglas de los Hooks.
  // Date.now() en el render causaría hydration mismatch; se hidrata vía useEffect.
  const [nowMs, setNowMs]                   = useState<number | null>(null);
  const [prepShowAll, setPrepShowAll]       = useState(false);
  const [requestedCloseOrderId, setRequestedCloseOrderId] = useState<string | null>(null);
  const ITEMS_PREVIEW = 4;
  const addItem = useCartStore((s) => s.addItem);
  const { requireProfileComplete } = useProfileGate();

  useEffect(() => {
    setConfirmedTransportName(transportName ?? null);
  }, [transportName]);

  useEffect(() => {
    void loadWarehouses(getSupabaseBrowserClient()).then(setWarehouseIds);
  }, []);

  // Sincronizar ítems awaiting_apartado sin stock real → missing (zona retiro diferido).
  useEffect(() => {
    if (!order?.id || !order.local_deferred_pickup) return;
    let cancelled = false;
    const supabase = getSupabaseBrowserClient();
    void supabase
      .rpc("rpc_refresh_my_order_availability", { p_order_id: order.id })
      .then(({ data, error }) => {
        if (cancelled || error) return;
        const updated =
          data &&
          typeof data === "object" &&
          "updated_count" in data &&
          Number((data as { updated_count?: number }).updated_count) > 0;
        if (updated) onOrderRefresh();
      });
    return () => {
      cancelled = true;
    };
  }, [order?.id, order?.local_deferred_pickup, onOrderRefresh]);

  // Promos 2x1 / 2xMonto activas para variantes del pedido.
  useEffect(() => {
    const items = order?.order_items ?? [];
    const variantIds = [
      ...new Set(
        items
          .map((i) => String(i.variant_id ?? "").trim())
          .filter(Boolean)
      ),
    ];
    if (!variantIds.length) {
      setPromotions([]);
      return;
    }
    let cancelled = false;
    void fetchActivePromotionsForVariants(variantIds).then((rows) => {
      if (!cancelled) setPromotions(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [order?.id, order?.order_items]);

  // Ofertas activas por producto+color (misma fuente que el catálogo).
  useEffect(() => {
    const items = order?.order_items ?? [];
    if (!items.length) {
      setOfferItemKeys(new Set());
      return;
    }
    const articulos = [
      ...new Set(
        items
          .map((i) => String(i.product_name ?? "").trim())
          .filter(Boolean)
      ),
    ];
    if (!articulos.length) {
      setOfferItemKeys(new Set());
      return;
    }

    let cancelled = false;
    const supabase = getSupabaseBrowserClient();
    void supabase
      .from(CATALOG_SOURCE)
      .select('"Articulo","Color","OfertaActiva","PrecioOferta"')
      .in("Articulo", articulos)
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.warn("ActiveOrderTab ofertas:", error.message);
          setOfferItemKeys(new Set());
          return;
        }
        const keys = new Set<string>();
        const offerPriceByKey = new Map<string, number>();
        for (const row of data ?? []) {
          const key = offerItemKey(
            row.Articulo as string,
            row.Color as string
          );
          const active =
            row.OfertaActiva === true || row.OfertaActiva === "true";
          const offerPrice = Number(row.PrecioOferta);
          if (active) keys.add(key);
          if (Number.isFinite(offerPrice) && offerPrice > 0) {
            offerPriceByKey.set(key, offerPrice);
          }
        }
        // También marcar ítems cuyo price_snapshot coincide con PrecioOferta
        // (comprados en oferta aunque el flag live haya cambiado).
        for (const item of items) {
          const key = offerItemKey(item.product_name, item.color);
          const offerPrice = offerPriceByKey.get(key);
          if (
            offerPrice != null &&
            Math.abs(Number(item.price_snapshot) - offerPrice) < 1
          ) {
            keys.add(key);
          }
        }
        setOfferItemKeys(keys);
      });

    return () => {
      cancelled = true;
    };
  }, [order?.id, order?.order_items]);

  const itemIsOffer = (item: {
    product_name?: string | null;
    color?: string | null;
  }) => offerItemKeys.has(offerItemKey(item.product_name, item.color));

  // Alterna el header entre "apartado" y "cuenta regresiva" cuando quedan ≤3 días
  useEffect(() => {
    setHeaderAltPhase(false);
    const id = setInterval(() => setHeaderAltPhase((v) => !v), 3000);
    return () => clearInterval(id);
  }, [order?.id]);

  // Hidrata nowMs solo en cliente para evitar hydration mismatch con Date.now().
  // Con countdown de retiro local, refresca cada minuto (cada 15s si falta < 1 h).
  useEffect(() => {
    setNowMs(Date.now());
    if (!order?.dismantle_at || !order.local_deferred_pickup) return;
    let timer: ReturnType<typeof setTimeout>;
    let cancelled = false;
    const schedule = () => {
      const now = Date.now();
      const left = new Date(order.dismantle_at!).getTime() - now;
      const delay = left > 0 && left < 60 * 60 * 1000 ? 15_000 : 60_000;
      timer = setTimeout(() => {
        if (cancelled) return;
        setNowMs(Date.now());
        schedule();
      }, delay);
    };
    schedule();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [order?.id, order?.dismantle_at, order?.local_deferred_pickup]);

  // Si el cliente volvió desde el PDP de una alternativa (botón atrás),
  // reabrimos el panel de alternativas para ese ítem en vez de perderlo.
  useEffect(() => {
    try {
      const pending = sessionStorage.getItem(ALT_PANEL_STORAGE_KEY);
      if (pending) {
        sessionStorage.removeItem(ALT_PANEL_STORAGE_KEY);
        setAltOpenFor(pending);
      }
    } catch { /* ignore */ }
  }, []);

  // Debe estar antes de todos los early returns para evitar errores de referencia.
  // El cliente presionó "Enviar pedido" con ítems reservados: el pedido sigue en
  // 'active' para el admin pero el cliente ve la pantalla de "En preparación".
  // `requestedCloseOrderId` es optimista (mientras llega el refresh); NO puede
  // quedar pegado si el servidor ya limpió el flag (bug A56427: reopen 400
  // porque la UI seguía en preparación con notes={} y status=active).
  const notesRequestClose = (() => {
    if (!order?.notes) return false;
    try {
      const n = JSON.parse(String(order.notes)) as Record<string, unknown>;
      return Boolean(n?.customer_requested_close);
    } catch {
      return false;
    }
  })();
  const customerRequestedClose =
    order?.status === "closed"
      ? false // closed se maneja por status en el branch de preparación
      : notesRequestClose || requestedCloseOrderId === order?.id;

  useEffect(() => {
    if (!order || order.id !== requestedCloseOrderId) return;
    // Seguir mostrando prep solo si el servidor confirma closed o el flag en notes.
    if (order.status === "closed" || notesRequestClose) return;
    setRequestedCloseOrderId(null);
  }, [order, notesRequestClose, requestedCloseOrderId]);

  useEffect(() => {
    if (!customerId || !order?.id || !["active", "closing_soon"].includes(order.status)) {
      setShowFirstOrderGuide(false);
      return;
    }

    try {
      const seen = window.localStorage.getItem(`${FIRST_ORDER_GUIDE_KEY_PREFIX}${customerId}`);
      setShowFirstOrderGuide(seen !== "1");
    } catch {
      setShowFirstOrderGuide(false);
    }
  }, [customerId, order?.id, order?.status]);

  function dismissFirstOrderGuide() {
    setShowFirstOrderGuide(false);
    try {
      window.localStorage.setItem(`${FIRST_ORDER_GUIDE_KEY_PREFIX}${customerId}`, "1");
    } catch { /* ignore */ }
  }

  if (showCancelSuccess) {
    return (
      <div className="active-order-state active-order-state--dismissible">
        <button
          type="button"
          onClick={onCancelSuccessDismiss}
          aria-label="Cerrar"
          className="active-order-btn active-order-btn--text-danger active-order-state__close"
        >
          ×
        </button>
        <div className="active-order-state__icon active-order-state__icon--lg">✓</div>
        <div className="active-order-state__title active-order-state__title--lg">
          Pedido cancelado
        </div>
        <p className="active-order-state__text">
          El pedido fue cancelado. Podés armar uno nuevo cuando quieras.
        </p>
        <div className="active-order-state__actions">
          <button
            type="button"
            onClick={onCancelSuccessDismiss}
            className="active-order-btn active-order-btn--primary active-order-btn--cta"
          >
            Ir al carrito
          </button>
          <Link href="/" className="active-order-btn active-order-btn--secondary">
            Seguir comprando
          </Link>
        </div>
      </div>
    );
  }

  if (!order) {
    return (
      <div className="active-order-state">
        <div className="active-order-state__icon">📋</div>
        <div className="active-order-state__title active-order-state__title--muted">
          No tenés ningún pedido activo
        </div>
        <p className="active-order-state__text active-order-state__text--muted">
          Agregá productos al carrito y hacé tu pedido
        </p>
        <Link href="/" className="active-order-btn active-order-btn--primary active-order-btn--inline">
          Ver catálogo
        </Link>
      </div>
    );
  }

  // ── Sent: "Tu pedido fue enviado" ──────────────────────────────────────────
  if (order.status === "sent") {
    function dismiss() {
      const key = `fyl-order-sent-dismissed-${order!.id}`;
      localStorage.setItem(key, String(Date.now()));
      onOrderDismissed();
    }
    return (
      <div className="active-order-state active-order-state--dismissible">
        <button onClick={dismiss} aria-label="Cerrar" className="active-order-btn active-order-btn--text-danger active-order-state__close">×</button>
        <div className="active-order-state__icon active-order-state__icon--lg">
          {isLocalPickupOrder ? "📦" : "🚚"}
        </div>
        <div className="active-order-state__title active-order-state__title--lg active-order-state__title--green">
          {isLocalPickupOrder ? "¡Tu pedido está listo para retirar!" : "¡Tu pedido fue enviado!"}
        </div>
        <p className="active-order-state__text active-order-state__text--lead">
          Pedido <strong>#{order.order_number}</strong>
        </p>
        <p className="active-order-state__text">
          {isLocalPickupOrder
            ? "Podés pasar por el local. Tenés 48 horas para retirarlo y el pago se realiza en el local."
            : "Ya está en camino. Podés ver el detalle completo en tu historial."}
        </p>
        <div className="active-order-state__actions">
          <button onClick={dismiss} className="active-order-btn active-order-btn--primary-green active-order-btn--history">
            Ver en historial
          </button>
          <Link href="/" className="active-order-btn active-order-btn--secondary">
            Seguir comprando
          </Link>
        </div>
      </div>
    );
  }

  // ── Retiro local ya cobrado en el local (admin Cerrar pedido + imprimir) ───
  if (order.status === "closed" && isLocalPickupOrderFulfilled(order, activeTransportName)) {
    function dismissPickupFulfilled() {
      localStorage.setItem(localPickupFulfilledDismissKey(order!.id), String(Date.now()));
      onOrderDismissed();
    }
    return (
      <div className="active-order-state active-order-state--dismissible">
        <button
          onClick={dismissPickupFulfilled}
          aria-label="Cerrar"
          className="active-order-btn active-order-btn--text-danger active-order-state__close"
        >
          ×
        </button>
        <div className="active-order-state__icon active-order-state__icon--lg">✅</div>
        <div className="active-order-state__title active-order-state__title--lg active-order-state__title--green">
          ¡Ya retiraste tu pedido!
        </div>
        <p className="active-order-state__text active-order-state__text--lead">
          Pedido <strong>#{order.order_number}</strong>
        </p>
        <p className="active-order-state__text">
          Gracias por tu compra. Podés ver el detalle completo en tu historial.
        </p>
        <div className="active-order-state__actions">
          <button
            onClick={dismissPickupFulfilled}
            className="active-order-btn active-order-btn--primary-green active-order-btn--history"
          >
            Ver en historial
          </button>
          <Link href="/" className="active-order-btn active-order-btn--secondary">
            Seguir comprando
          </Link>
        </div>
      </div>
    );
  }

  // ── "En preparación": pedido cerrado O cliente solicitó cierre con ítems reservados ─
  if (order.status === "closed" || customerRequestedClose) {
    const hasUnresolvedMissing = order.order_items.some(
      (i) => i.status === "missing" && Number(i.quantity ?? 0) > 0
    );
    // Si hay ítems sin stock el cliente debe resolverlos → fall-through a vista normal
    if (hasUnresolvedMissing) {
      /* intentional fall-through — rendered below with full item list */
    } else {
    const totalUnits = order.order_items
      .filter((i) => i.status !== "cancelled" && Number(i.quantity ?? 0) > 0)
      .reduce((a, i) => a + i.quantity, 0);
    const prepBillable = order.order_items.filter(
      (i) =>
        i.status !== "cancelled" &&
        Number(i.quantity ?? 0) > 0 &&
        i.status !== "missing"
    );
    const prepPromoBuilt = buildPromoGroups(
      prepBillable.map((i) => ({
        key: `${i.variant_id ?? ""}__${String(i.size ?? "").toLowerCase()}__${i.id}`,
        variant_id: String(i.variant_id ?? ""),
        product_name: i.product_name,
        color: i.color,
        size: i.size,
        qty: Number(i.quantity ?? 0) || 0,
        price_snapshot: Number(i.price_snapshot ?? 0) || 0,
        imagen: i.imagen,
      })),
      promotions
    );
    const totalAmt = sumPromoAwareTotal(
      prepPromoBuilt.groups,
      prepPromoBuilt.ungrouped
    );
    const prepOperationalItems = prepBillable;
    const allPrepItemsPicked =
      prepOperationalItems.length > 0 &&
      prepOperationalItems.every((i) => i.status === "picked");
    const localPickupCloseCopy = isLocalPickupOrder
      ? getDashboardLocalPickupCloseCopy({
          orderNumber: order.order_number,
          totalFormatted: formatARS(totalAmt),
          allItemsPicked: allPrepItemsPicked,
          pickupDeadlineLabel: resolvePickupDeadlineLabel(order),
        })
      : null;

    async function handleReopenForEditing() {
      if (!order || cancelingPrep) return;
      setCancelingPrep(true);
      setReopenError(null);
      const supabase = getSupabaseBrowserClient();
      // Plazo corto para volver a enviar (día hábil siguiente a las 17:00
      // Arg, no los 7 días completos de un pedido nuevo) calculado en el
      // servidor vía rpc_customer_reopen_order_for_editing (270) -- antes
      // se calculaba acá con `Date.now() + 24h`, lo que podía vencer un
      // fin de semana/feriado a cualquier hora (mismo bug que ya se había
      // corregido para las prórrogas de 24h, ver 258).
      try {
        const { error: err } = await supabase.rpc("rpc_customer_reopen_order_for_editing", {
          p_order_id: order.id,
        });
        if (err) {
          const msg = String(err.message || "");
          // Pedido ya editable en servidor (UI quedada en prep por flag
          // optimista): destrabar sin mostrar error genérico.
          if (
            msg.includes("no está en preparación") ||
            msg.includes("no corresponde reabrir")
          ) {
            setRequestedCloseOrderId(null);
            setShowReopenConfirm(false);
            onOrderRefresh();
            return;
          }
          setReopenError(
            msg.trim()
              ? msg
              : "No se pudo reabrir el pedido. Intentá de nuevo."
          );
          return;
        }
        setRequestedCloseOrderId(null);
        setShowReopenConfirm(false);
        onOrderRefresh();
      } catch {
        setReopenError("No se pudo reabrir el pedido. Intentá de nuevo.");
      } finally {
        setCancelingPrep(false);
      }
    }

    return (
      <div>
        {/* Status card */}
        <div className="active-order-card active-order-card--prep active-order-card--prep-success is-ready">
          <div className="active-order-prep-success">
            <div className="active-order-prep-success__check" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none">
                <path d="M5 12.5l4.2 4.2L19 7" />
              </svg>
            </div>
            <div className="active-order-prep-success__eyebrow">
              Pedido #{order.order_number}
            </div>
            <div className="active-order-prep-success__title">
              {localPickupCloseCopy?.title ?? "Pedido en preparación"}
            </div>
            <div className="active-order-prep-success__text">
              {localPickupCloseCopy?.lead ??
                (isLocalPickupOrder
                  ? "Lo estamos preparando para que lo retires."
                  : "Lo estamos preparando para enviártelo.")}
            </div>
            {localPickupCloseCopy?.progressLabel ? (
              <div className="active-order-prep-success__pill active-order-prep-success__pill--pending">
                <span className="active-order-header__loading-dots">
                  {[0, 1, 2].map((i) => (
                    <span
                      key={i}
                      className="active-order-header__loading-dot"
                      style={{ animationDelay: `${i * 0.2}s` }}
                    />
                  ))}
                </span>
                <span>{localPickupCloseCopy.progressLabel}</span>
              </div>
            ) : localPickupCloseCopy?.mode === "all_picked" ? null : (
              <div className="active-order-prep-success__pill">
                <span className="active-order-header__loading-dots">
                  {[0, 1, 2].map((i) => (
                    <span
                      key={i}
                      className="active-order-header__loading-dot"
                      style={{ animationDelay: `${i * 0.2}s` }}
                    />
                  ))}
                </span>
                <span>Preparación en curso</span>
              </div>
            )}
            <div className="active-order-prep-success__detail">
              {localPickupCloseCopy?.detail ??
                getOrderReadyCompactMessage(activeTransportName)}
            </div>
          </div>
          {/* Contacto */}
          <div className="active-order-prep-contact">
            <span className="active-order-prep-contact__label">
              ¿Tenés alguna duda?
            </span>
            <a
              href={WHATSAPP_HREF}
              target="_blank"
              rel="noopener noreferrer"
              className="active-order-btn active-order-btn--whatsapp active-order-btn--whatsapp-sm"
            >
              <WhatsAppIcon size={14} />
              Escribir
            </a>
          </div>
        </div>

        {/* Order summary */}
        <div className="active-order-card active-order-card--summary">
          <div className="active-order-summary__meta">
            <span className="active-order-summary__units">
              {totalUnits} unidad{totalUnits !== 1 ? "es" : ""}
            </span>
            <span className="active-order-summary__amount">
              {formatARS(totalAmt)}
            </span>
          </div>
        </div>

        {/* Items list — primeros 4 visibles, resto colapsado */}
        {(() => {
          const prepItems = groupCustomerOrderItems(
            order.order_items
              .filter((i) => i.status !== "cancelled" && Number(i.quantity ?? 0) > 0)
              .sort((a, b) => {
                // Los "reserved"/"waiting" (todavía esperando confirmación del
                // equipo) van primero — son los que necesitan atención, no
                // tiene sentido enterrarlos al final de la lista.
                const aReserved =
                  a.status === "reserved" ||
                  a.status === "waiting" ||
                  a.status === "awaiting_apartado"
                    ? 0
                    : 1;
                const bReserved =
                  b.status === "reserved" ||
                  b.status === "waiting" ||
                  b.status === "awaiting_apartado"
                    ? 0
                    : 1;
                if (aReserved !== bReserved) return aReserved - bReserved;
                return new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime();
              }),
            warehouseIds
          );
          const prepRows = buildOrderDisplayRows(prepItems, promotions);
          const PREVIEW = 4;
          const visible = prepShowAll ? prepRows : prepRows.slice(0, PREVIEW);
          const hidden = Math.max(0, prepRows.length - PREVIEW);
          return (
            <>
              <div className="active-order-card active-order-card--items active-order-card--items-flat">
                {visible.map((row) => {
                  if (row.kind === "promo") {
                    const childControls: Record<
                      string,
                      {
                        qty: number;
                        qtyLabel: ReactNode;
                      }
                    > = {};
                    for (const member of row.members) {
                      childControls[orderItemPromoKey(member)] = {
                        qty: member.quantity,
                        qtyLabel: <QuantityUnitLabel quantity={member.quantity} />,
                      };
                    }
                    return (
                      <div key={row.group.promotionId} className="active-order-item-divider">
                        <PromoGroupRow
                          mode="order"
                          promoLabel={row.group.promoLabel}
                          groups={row.group.groups}
                          totalQty={row.group.totalQty}
                          promoPrice={row.group.promoPrice}
                          items={row.group.items}
                          childControls={childControls}
                        />
                      </div>
                    );
                  }
                  const item = row.item;
                  return (
                    <div key={item.primaryItemId} className="active-order-item-divider">
                      <LineItemRow
                        imagen={item.imagen}
                        variantId={item.variant_id}
                        productName={item.product_name}
                        color={item.color}
                        size={item.size}
                        quantity={item.quantity}
                        unitPrice={item.price_snapshot}
                        isOffer={itemIsOffer(item)}
                      />
                    </div>
                  );
                })}
              </div>
              {prepRows.length > PREVIEW && (
                <button
                  onClick={() => setPrepShowAll((v) => !v)}
                  className="active-order-expand active-order-expand--rounded-bottom"
                >
                  {prepShowAll
                    ? "∧ Ver menos"
                    : `∨ Ver ${hidden} producto${hidden !== 1 ? "s" : ""} más del pedido`}
                </button>
              )}
              {prepRows.length <= PREVIEW && <div className="active-order-spacer-sm" />}
            </>
          );
        })()}

        {/* Una sola acción para modificar el pedido — antes había dos
            ("Cancelar preparación" y "Seguir eligiendo productos") que
            llevaban al mismo lugar y podían leerse como "cancelar todo
            el pedido". */}
        <button
          type="button"
          onClick={() => {
            setReopenError(null);
            setShowReopenConfirm(true);
          }}
          className="active-order-btn active-order-btn--brand-soft"
        >
          + Agregar más productos
        </button>

        {showReopenConfirm && createPortal(
          <div
            className="active-order-sheet-backdrop"
            onClick={() => {
              if (!cancelingPrep) setShowReopenConfirm(false);
            }}
          >
            <div className="active-order-sheet active-order-sheet--padded" onClick={(e) => e.stopPropagation()}>
              <div className="active-order-sheet__title">
                ¿Agregar productos al pedido?
              </div>
              <p className="active-order-sheet__subtitle">
                Vamos a volverlo a pedido abierto para que puedas sumar productos. Cuando termines, tocá Cerrar pedido.
              </p>
              {reopenError && (
                <div className="active-order-send-modal-error">
                  {reopenError}
                </div>
              )}
              <div className="active-order-sheet__actions active-order-sheet__actions--stack active-order-sheet__actions--flat">
                <button
                  type="button"
                  onClick={handleReopenForEditing}
                  disabled={cancelingPrep}
                  className={`active-order-btn active-order-btn--primary active-order-btn--sheet-primary${cancelingPrep ? " is-busy" : ""}`}
                >
                  {cancelingPrep ? "Reabriendo..." : "Sí, reabrir pedido"}
                </button>
                <button
                  type="button"
                  onClick={() => setShowReopenConfirm(false)}
                  disabled={cancelingPrep}
                  className="active-order-btn active-order-btn--secondary active-order-btn--sheet-secondary"
                >
                  Mantener en preparación
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
      </div>
    );
    } // end if (!hasUnresolvedMissing)
  } // end if (order.status === "closed")

  // Most recently added first — missing always pinned at top regardless of date
  // Orden cronológico por el momento en que se agregaron al pedido (los
  // primeros agregados arriba de todo) — antes los "sin stock" siempre
  // flotaban al tope sin importar cuándo se habían sumado, lo cual no
  // tiene mucho sentido: en la práctica, lo que se queda sin stock suele
  // ser justamente lo último que se agregó (lo primero ya se apartó).
  const allVisible = order.order_items
    .filter((i) => i.status !== "cancelled" && Number(i.quantity ?? 0) > 0)
    .sort((a, b) => new Date(a.created_at ?? 0).getTime() - new Date(b.created_at ?? 0).getTime());

  const missingItems = groupCustomerOrderItems(
    allVisible.filter((i) => i.status === "missing"),
    warehouseIds
  );
  const regularItems = groupCustomerOrderItems(
    allVisible
      .filter((i) => i.status !== "missing")
      .sort((a, b) => {
        // "Reserved"/"waiting" (esperando confirmación del equipo) va
        // primero — si no, al ordenar solo por fecha puede quedar empujado
        // más allá del preview de ITEMS_PREVIEW y esconderse detrás de
        // "Ver más productos", justo el ítem que más atención necesita.
        const aReserved =
          a.status === "reserved" || a.status === "waiting" || a.status === "awaiting_apartado"
            ? 0
            : 1;
        const bReserved =
          b.status === "reserved" || b.status === "waiting" || b.status === "awaiting_apartado"
            ? 0
            : 1;
        if (aReserved !== bReserved) return aReserved - bReserved;
        return new Date(a.created_at ?? 0).getTime() - new Date(b.created_at ?? 0).getTime();
      }),
    warehouseIds
  );

  // ¿Todos los ítems visibles (no cancelados) ya están apartados de verdad?
  // A propósito NO cuenta "waiting": un ítem en espera (local/fábrica) todavía no
  // está físicamente en mano, así que el pedido no puede cerrarse solo aunque no
  // le queden "reserved" — antes esto contaba "waiting" como listo y un pedido con
  // ítems en espera podía cerrarse (enviarse) directo sin que nadie lo resolviera.
  // Se usa SOLO para la mecánica real de envío/cierre (handleSend) y la caja de
  // abajo junto al botón — nunca para el mensaje del header (ver
  // allConfirmedForCustomer más abajo).
  const allItemsPicked = allVisible.length > 0 && allVisible.every(
    (i) => i.status === "picked"
  );
  // Cuántas UNIDADES (no líneas/filas) la CLIENTA ve como todavía sin
  // confirmar. Usa el status visible para ella (getCustomerFacingItemStatus),
  // no el status interno crudo: un ítem "waiting" de fábrica se le muestra
  // como "Confirmado" (ver waiting-source.ts), así que NO debe contar aquí
  // aunque internamente siga en "waiting" — solo cuenta "reserved" y
  // "waiting" de origen local, que a ella se le siguen mostrando como
  // "Reservado". Antes sumaba filas (.length): un talle con 2 unidades
  // reservadas contaba como "1 producto por confirmar" en vez de 2.
  const reservedCount = regularItems
    .filter((i) => getCustomerFacingItemStatus(i, warehouseIds) !== "picked")
    .reduce((sum, i) => sum + (Number(i.quantity) || 0), 0);
  // Todo lo que la clienta ve queda "Confirmado" (aunque internamente algún
  // ítem siga en "waiting" de fábrica). Distinto de allItemsPicked: ese
  // sigue exigiendo "picked" real para poder cerrar el pedido de una. No
  // mira "sin stock" acá — cada lugar que lo usa decide si combinarlo con
  // hasMissing según el mensaje que necesite mostrar.
  const allConfirmedForCustomer = allVisible.length > 0 && reservedCount === 0;

  // Filas de display (promos 2x agrupadas + ítems sueltos)
  const regularDisplayRows = buildOrderDisplayRows(regularItems, promotions);
  const hiddenCount = Math.max(0, regularDisplayRows.length - ITEMS_PREVIEW);
  const shownRegularRows = showAllItems
    ? regularDisplayRows
    : regularDisplayRows.slice(0, ITEMS_PREVIEW);
  const totalItems = regularItems.reduce((a, i) => a + i.quantity, 0);
  const regularPromoBuilt = buildPromoGroups(
    regularItems.map(toPromoGroupable),
    promotions
  );
  const totalAmount = sumPromoAwareTotal(
    regularPromoBuilt.groups,
    regularPromoBuilt.ungrouped
  );
  // Block send if there are unresolved missing items
  const hasMissing      = missingItems.length > 0;
  const isLocalPickupZone = isLocalPickupShortDeadlineZone(customerProvince, customerCity);
  /** Plazo 36 h: solo retiro especial (local_deferred_pickup) en zona marcada. */
  const isDeferredLocalZone = Boolean(
    order.local_deferred_pickup && isLocalPickupZone
  );
  const hasAwaitingApartado = allVisible.some((i) => i.status === "awaiting_apartado");
  /** Post-apartado: todo apartado → listo para retirar. */
  const isLocalDeferredReady = Boolean(
    order.local_deferred_pickup &&
      allItemsPicked &&
      !hasAwaitingApartado &&
      !hasMissing
  );
  /** Ocultar countdown hasta que arranque el timer o no queden ítems por apartar. */
  const hideDeadlineUntilApartado = Boolean(
    order.local_deferred_pickup &&
      (hasAwaitingApartado || !order.dismantle_at)
  );
  const localDeferredPickup = Boolean(order.local_deferred_pickup);
  const closeMinUnits   = getOrderCloseMinimumUnits(customerProvince, customerCity);
  const canSend         = totalItems >= closeMinUnits && !hasMissing;
  const remaining       = Math.max(0, closeMinUnits - totalItems);
  // For "closed" orders re-confirming after resolving missing items: allow re-send
  const isClosed        = order.status === "closed";
  const orderStatusInfo = ORDER_STATUS_INFO[order.status] ?? ORDER_STATUS_INFO.active;

  // Deadline logic — calculado solo en cliente (nowMs hidratado por useEffect arriba)

  const _now         = nowMs ?? 0;
  const isExpired    = nowMs !== null ? (isOrderExpired(order, _now) && !isClosed) : false;
  const daysLeft     = nowMs !== null ? orderDaysRemainingForOrder(order, _now) : 99;
  const isReadOnly   = isExpired;

  // Fecha real de vencimiento — en días CALENDARIO (no bloques de 24hs,
  // para no confundir "mañana" con "hoy más tarde"). Se usa tanto para
  // el chip "N días"/"Mañana"/"Hoy" del header como para el aviso de
  // abajo, para que ambos siempre digan lo mismo.
  const deadlineDate      = getCustomerOrderDeadlineDate(order);
  const calendarDaysLeft  = nowMs !== null ? calendarDaysUntil(deadlineDate, _now) : 99;
  const shortPickupWindow = Boolean(
    order.local_deferred_pickup &&
      (isShortPickupDeadlineWindow(order.created_at, order.dismantle_at) ||
        isLocalPickupZone)
  );
  /** Cuenta regresiva en vivo (chip + banner) cuando el retiro local ya tiene plazo. */
  const showPickupCountdown = Boolean(
    nowMs !== null &&
      order.dismantle_at &&
      !hideDeadlineUntilApartado &&
      (isLocalDeferredReady || (order.local_deferred_pickup && shortPickupWindow))
  );
  // Listo para retirar: una sola tarjeta verde (sin banner de vencimiento aparte).
  const warnSoon     =
    !hideDeadlineUntilApartado &&
    !isLocalDeferredReady &&
    !isExpired &&
    !isClosed &&
    calendarDaysLeft >= 0 &&
    calendarDaysLeft <= 3;

  async function handleCancelItem(itemId: string) {
    setCancelingId(itemId);
    const supabase = getSupabaseBrowserClient();
    const { error: err } = await supabase.rpc("rpc_cancel_order_item", { p_item_id: itemId });
    setCancelingId(null);
    if (err) {
      setError("No se pudo quitar el producto. Intentá de nuevo.");
    } else {
      setAltOpenFor(null);
      onOrderRefresh();
    }
  }

  function openRemoveProductConfirm(item: GroupedCustomerOrderItem & OrderItem) {
    const maxUnits = Math.max(1, Number(item.quantity) || 1);
    setMenuOpenFor(null);
    setPendingRemoveItem(item);
    // Multi: mostrar cantidad actual (bajar = quitar diferencia). Una sola unidad: quitar todo.
    setKeepUnits(maxUnits <= 1 ? 0 : maxUnits);
  }

  function closeRemoveProductConfirm() {
    if (cancelingId) return;
    setPendingRemoveItem(null);
    setKeepUnits(0);
  }

  async function handleConfirmRemoveProduct() {
    if (!pendingRemoveItem || !order) return;
    const item = pendingRemoveItem;
    const maxUnits = Math.max(1, Number(item.quantity) || 1);
    const keep = Math.max(0, Math.min(maxUnits, Number(keepUnits) || 0));
    const unitsToRemove = maxUnits - keep;
    if (unitsToRemove <= 0) return;

    setCancelingId(item.primaryItemId);
    setError(null);
    const supabase = getSupabaseBrowserClient();

    // Distribuir unidades entre las líneas agrupadas (puede haber varias filas).
    const rows = (order.order_items || [])
      .filter((r) => item.itemIds.includes(r.id))
      .map((r) => ({
        id: r.id,
        quantity: Math.max(0, Number(r.quantity || 0) || 0),
      }))
      .filter((r) => r.quantity > 0);

    let remaining = unitsToRemove;
    let failed = false;

    for (const row of rows) {
      if (remaining <= 0) break;
      const cancelQty = Math.min(remaining, row.quantity);
      const { error: rpcErr } = await supabase.rpc("rpc_cancel_order_item_units", {
        p_item_id: row.id,
        p_units: cancelQty,
      });
      if (rpcErr) {
        console.error("Error quitando unidades del pedido:", rpcErr);
        failed = true;
        break;
      }
      remaining -= cancelQty;
    }

    setCancelingId(null);
    setPendingRemoveItem(null);
    setKeepUnits(0);

    if (failed || remaining > 0) {
      setError("No se pudo quitar el producto. Intentá de nuevo.");
      onOrderRefresh();
      return;
    }

    setAltOpenFor(null);
    onOrderRefresh();
  }

  async function openEditQty(item: GroupedCustomerOrderItem & OrderItem) {
    setEditQtyFor(item.primaryItemId);
    setEditQtyValue(item.quantity);
    setMenuOpenFor(null);
    // Fetch available stock for this variant+size
    if (item.variant_id && !variantStock[item.primaryItemId]) {
      const supabase = getSupabaseBrowserClient();
      const { data } = await supabase
        .from("variant_sizes")
        .select("stock_qty")
        .eq("variant_id", item.variant_id)
        .ilike("size", item.size)
        .maybeSingle();
      if (data) {
        setVariantStock((prev) => ({
          ...prev,
          [item.primaryItemId]: Number(data.stock_qty ?? 0),
        }));
      }
    }
  }

  function handleQtyDecrement(item: GroupedCustomerOrderItem & OrderItem) {
    setEditQtyValue((v) => Math.max(0, v - 1));
  }

  function handleQtyIncrement(item: GroupedCustomerOrderItem & OrderItem, availableToAdd: number | null) {
    if (availableToAdd !== null && availableToAdd <= 0) return;
    setEditQtyValue((v) => v + 1);
  }

  async function confirmQtyChange(item: GroupedCustomerOrderItem & OrderItem) {
    const delta = editQtyValue - item.quantity;
    if (delta === 0) { setEditQtyFor(null); return; }

    setEditQtyFor(null);

    if (delta < 0) {
      // Quitar N unidades usando el RPC que soporta cancelación parcial
      setCancelingId(item.primaryItemId);
      const supabase = getSupabaseBrowserClient();
      await supabase.rpc("rpc_cancel_order_item_units", {
        p_item_id: item.primaryItemId,
        p_units: Math.abs(delta),
      });
      setCancelingId(null);
      onOrderRefresh();
    } else {
      // Agregar al carrito (exige perfil completo si hay sesión)
      const profileOk = await requireProfileComplete();
      if (!profileOk) return;
      addItem({
        variant_id: item.variant_id ?? "",
        product_name: item.product_name,
        color: item.color,
        size: item.size,
        qty: delta,
        price_snapshot: item.price_snapshot,
        imagen: item.imagen,
      });
      onGoToCart?.();
    }
  }

  async function handleSelectAlternative(missingItem: OrderItem, alt: AlternativeProduct, cardId: string) {
    // Antes esto agregaba la alternativa al carrito local (para checkout
    // manual después) y cancelaba el ítem sin stock por separado -- dos
    // pasos desconectados, y el producto nuevo no quedaba "reservado" en
    // el pedido hasta que la clienta pasara por Carrito. Ahora una sola
    // RPC atómica reserva la alternativa (misma cantidad que tenía el
    // ítem sin stock) y cancela el ítem "missing" en el mismo paso.
    if (!alt.variant_id) {
      setAltReplaceError("Este producto no tiene variante asociada — probá con otra opción.");
      return;
    }
    setAltReplacingCardId(cardId);
    setAltReplaceError(null);
    const supabase = getSupabaseBrowserClient();
    const { error: err } = await supabase.rpc("rpc_customer_replace_missing_item", {
      p_missing_item_id: missingItem.id,
      p_variant_id: alt.variant_id,
      p_product_name: alt.Articulo,
      p_color: alt.Color,
      p_size: alt.Talle,
      p_imagen: alt["Imagen Principal"] || null,
    });
    setAltReplacingCardId(null);
    if (err) {
      setAltReplaceError(err.message || "No se pudo reemplazar el producto. Probá con otra opción.");
      return;
    }
    setAltOpenFor(null);
    onOrderRefresh();
  }

  function shouldShowTransportConfirmBeforeClose() {
    if (!customerId || typeof window === "undefined") return false;
    return window.localStorage.getItem(getOrderTransportConfirmKey(customerId)) !== "1";
  }

  function openFinalCloseConfirm() {
    if (shouldShowTransportConfirmBeforeClose()) {
      setShowTransportConfirm(true);
      return;
    }
    setShowSendConfirm(true);
  }

  function handleTransportConfirmed(transport: string) {
    void persistTransportThenContinue(transport);
  }

  async function persistTransportThenContinue(transport: string) {
    const canonical = canonicalizeTransportName(transport);
    setConfirmedTransportName(canonical);
    setError(null);

    if (!canonical) {
      setShowTransportConfirm(false);
      setShowSendConfirm(true);
      return;
    }

    setSending(true);
    try {
      const supabase = getSupabaseBrowserClient();
      let result;
      if (order?.id) {
        result = await rpcSetTransportBeforeCloseOrder(supabase, order.id, canonical);
      } else {
        result = await rpcSetMyTransport(supabase, canonical);
      }
      const savedName = canonicalizeTransportName(result.transport_name || canonical);
      setConfirmedTransportName(savedName);
      onTransportPersisted?.(savedName, result.transport_id ?? null);
      if (customerId && typeof window !== "undefined") {
        window.localStorage.setItem(getOrderTransportConfirmKey(customerId), "1");
      }
      setShowTransportConfirm(false);
      setShowSendConfirm(true);
    } catch (err) {
      const msg =
        err && typeof err === "object" && "message" in err
          ? String((err as { message?: string }).message || "")
          : "";
      setError(
        msg.includes("WhatsApp") || msg.includes("transporte") || msg.includes("Transporte")
          ? msg
          : "No se pudo guardar el transporte. Intentá de nuevo."
      );
    } finally {
      setSending(false);
    }
  }

  async function ensureTransportPersistedBeforeClose(): Promise<boolean> {
    const name = canonicalizeTransportName(activeTransportName || "");
    if (!name || !order?.id) return true;
    try {
      const supabase = getSupabaseBrowserClient();
      const result = await rpcSetTransportBeforeCloseOrder(supabase, order.id, name);
      const savedName = canonicalizeTransportName(result.transport_name || name);
      setConfirmedTransportName(savedName);
      onTransportPersisted?.(savedName, result.transport_id ?? null);
      return true;
    } catch (err) {
      const msg =
        err && typeof err === "object" && "message" in err
          ? String((err as { message?: string }).message || "")
          : "";
      setError(
        msg.includes("WhatsApp") || msg.includes("transporte") || msg.includes("Transporte")
          ? msg
          : "No se pudo guardar el transporte. Intentá de nuevo."
      );
      return false;
    }
  }

  function handleSendCtaClick() {
    if (sending) return;
    setError(null);

    if (canSend) {
      openFinalCloseConfirm();
      return;
    }

    if (hasMissing) {
      setShowMissingHint(true);
      window.setTimeout(() => setShowMissingHint(false), 3000);
      return;
    }

    if (remaining > 0 || totalItems < closeMinUnits) {
      setShowMinInfo(true);
    }
  }

  async function handleSend(): Promise<boolean> {
    if (!order) return false;
    setSending(true);
    setError(null);
    const supabase = getSupabaseBrowserClient();

    const transportOk = await ensureTransportPersistedBeforeClose();
    if (!transportOk) {
      setSending(false);
      return false;
    }

    if (allItemsPicked) {
      if (isCommonLocalPickupOrder(order, activeTransportName)) {
        // Retiro común: no rpc_close_order — queda active en Apartados hasta cobrar en admin.
        // Flag vía RPC (RLS bloquea UPDATE directo de customers sobre orders).
        try {
          await rpcCustomerRequestClose(supabase, order.id);
          setRequestedCloseOrderId(order.id);
          onOrderRefresh();
          return true;
        } catch {
          setError("No se pudo cerrar el pedido. Intentá de nuevo.");
          return false;
        } finally {
          setSending(false);
        }
      }
      // Envío / otros: cerrar vía RPC.
      // Nota: notes.local_zone_shipping_close ya no se escribe acá — customers
      // no tienen RLS UPDATE sobre orders; el cierre queda igual vía rpc_close_order.
      try {
        await rpcCloseOrder(supabase, order.id, "Pendiente");
        onOrderSent();
        return true;
      } catch {
        setError("No se pudo cerrar el pedido. Intentá de nuevo.");
        return false;
      } finally {
        setSending(false);
      }
    } else {
      // Hay reservados → flag customer_requested_close vía SECURITY DEFINER;
      // el pedido sigue active para el admin y el cliente ve "En preparación".
      try {
        await rpcCustomerRequestClose(supabase, order.id);
        setRequestedCloseOrderId(order.id);
        onOrderRefresh();
        return true;
      } catch {
        setError("No se pudo cerrar el pedido. Intentá de nuevo.");
        return false;
      } finally {
        setSending(false);
      }
    }
  }

  async function handleRequestExtension() {
    if (!order || extending) return;
    setExtending(true);
    setError(null);
    const supabase = getSupabaseBrowserClient();
    const { error: err } = await supabase.rpc("rpc_customer_request_order_extension_24h", {
      p_order_id: order.id,
    });
    setExtending(false);
    if (err) {
      const msg = err.message.includes("Ya usaste")
        ? "Ya usaste la prórroga de 24 horas para este pedido."
        : "No pudimos habilitar las 24 horas. Intentá de nuevo o escribinos por WhatsApp.";
      setError(msg);
      return;
    }
    onOrderRefresh();
  }

  async function handleCancelEntireOrder() {
    if (!order || cancelingOrder) return;
    setCancelingOrder(true);
    setError(null);
    const supabase = getSupabaseBrowserClient();
    const { error: err } = await supabase.rpc("rpc_customer_cancel_order", {
      p_order_id: order.id,
    });
    setCancelingOrder(false);
    setShowCancelConfirm(false);
    if (err) {
      const msg = err.message?.includes("permiso")
        ? "No tenés permiso para cancelar este pedido."
        : err.message || "No se pudo cancelar el pedido. Intentá de nuevo.";
      setError(msg);
      return;
    }
    onOrderFullyCancelled();
  }

  const extensionUsed = hasCustomerUsedOrderExtension(order.notes);

  function renderItem(item: GroupedCustomerOrderItem & OrderItem, isMissing: boolean) {
    const isAltOpen  = altOpenFor === item.primaryItemId;
    const isMenuOpen = menuOpenFor === item.primaryItemId;
    const isEditingQty = editQtyFor === item.primaryItemId;
    const productSlug = encodeURIComponent(item.product_name ?? "");
    const isCanceling = item.itemIds.includes(cancelingId ?? "");
    const stock = variantStock[item.primaryItemId] ?? null;
    // Stock disponible neto = stock físico - unidades ya en el pedido
    const availableToAdd = stock !== null ? Math.max(0, stock - item.quantity) : null;

    return (
      <div key={item.primaryItemId}>
        <LineItemRow
          imagen={item.imagen}
          variantId={item.variant_id}
          productName={item.product_name}
          color={item.color}
          size={item.size}
          quantity={item.quantity}
          unitPrice={item.price_snapshot}
          isOffer={itemIsOffer(item)}
          highlight={isMissing ? "missing" : null}
          mutedPrice={isMissing}
          line2={
            <span className="active-order-line2">
              <QuantityUnitLabel quantity={item.quantity} />
              {!isMissing && (
                <CustomerItemPrepStatus
                  item={item}
                  warehouseIds={warehouseIds}
                  localDeferredPickup={localDeferredPickup}
                />
              )}
              {/* En missing el total ya está a la derecha; el c/u compite con
                  «Alternativas» + «Quitar» y overflow:hidden lo corta (360px). */}
              {item.quantity > 1 && !isMissing && (
                <span
                  className={[
                    "active-order-unit-price",
                    itemIsOffer(item) ? "is-offer" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                >
                  {formatARS(item.price_snapshot)} c/u
                </span>
              )}
              {isMissing && !isReadOnly && (
                <button
                  type="button"
                  onClick={() => setAltOpenFor(isAltOpen ? null : item.primaryItemId)}
                  className="active-order-btn active-order-btn--alt-trigger active-order-btn--brand-soft"
                >
                  {isAltOpen ? "Cerrar" : "Alternativas"}
                </button>
              )}
            </span>
          }
          trailing={
            !isReadOnly ? (
              isMissing ? (
                // Sin stock no tiene "editar cantidad" ni "ver producto" que
                // valga la pena esconder detrás de un menú — un solo botón
                // directo para quitarlo es más rápido que abrir el "⋯" y
                // después tocar "Quitar producto".
                <button
                  onClick={() => handleCancelItem(item.primaryItemId)}
                  disabled={isCanceling}
                  className={`active-order-btn active-order-btn--danger-outline active-order-btn--quitar${isCanceling ? " is-busy" : ""}`}
                >
                  {isCanceling ? "Quitando..." : "Quitar"}
                </button>
              ) : (
              <div className="active-order-item-menu">
                <button
                  type="button"
                  onClick={() => {
                    if (isEditingQty) { setEditQtyFor(null); return; }
                    setMenuOpenFor(isMenuOpen ? null : item.primaryItemId);
                  }}
                  aria-label="Opciones"
                  className={`active-order-item-menu__btn${isEditingQty ? " is-editing" : ""}`}
                >
                  {isEditingQty ? "Listo" : "⋯"}
                </button>

                {isMenuOpen && !isEditingQty && (
                  <>
                    <div className="active-order-menu-backdrop" onClick={() => setMenuOpenFor(null)} />
                    <div className="active-order-menu active-order-menu--item">
                      <button
                        type="button"
                        onClick={() => openEditQty(item)}
                        className="active-order-menu__item active-order-menu__item--row"
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
                          stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="active-order-svg-icon">
                          <path d="M12 20h9" />
                          <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
                        </svg>
                        Editar cantidad
                      </button>

                      <a
                        href={`/nj/producto/${productSlug}`}
                        onClick={() => setMenuOpenFor(null)}
                        className="active-order-menu__item active-order-menu__item--row"
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
                          stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="active-order-svg-icon">
                          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8Z" />
                          <circle cx="12" cy="12" r="3" />
                        </svg>
                        Ver producto
                      </a>

                      <button
                        type="button"
                        onClick={() => openRemoveProductConfirm(item)}
                        className="active-order-menu__item active-order-menu__item--row active-order-menu__item--danger"
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
                          stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="active-order-svg-icon">
                          <path d="M3 6h18" />
                          <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6h16Z" />
                        </svg>
                        Quitar producto
                      </button>
                    </div>
                  </>
                )}
              </div>
              )
            ) : undefined
          }
          below={
            isEditingQty ? (
              <div className="active-order-qty-wrap">
                <div className="active-order-qty">
                  <button
                    type="button"
                    onClick={() => handleQtyDecrement(item)}
                    aria-label="Quitar 1"
                    className="active-order-qty__btn"
                  >−</button>

                  <span className={`active-order-qty__value${editQtyValue === 0 ? " is-zero" : ""}`}>
                    {editQtyValue}
                  </span>

                  {(() => {
                    const canAdd = availableToAdd === null || availableToAdd > (editQtyValue - item.quantity);
                    return (
                      <button
                        type="button"
                        onClick={() => handleQtyIncrement(item, availableToAdd)}
                        disabled={!canAdd}
                        aria-label="Agregar 1"
                        className={`active-order-qty__btn${!canAdd ? " is-max" : ""}`}
                      >+</button>
                    );
                  })()}

                  {editQtyValue !== item.quantity && (
                    <button
                      type="button"
                      onClick={() => confirmQtyChange(item)}
                      disabled={isCanceling}
                      className={`active-order-qty__confirm${editQtyValue === 0 ? " is-remove" : ""}${isCanceling ? " is-busy" : ""}`}
                      style={{ opacity: isCanceling ? 0.6 : 1 }}
                    >
                      {editQtyValue === 0
                        ? isCanceling ? "Quitando..." : "Quitar"
                        : editQtyValue > item.quantity ? "Agregar al carrito" : "Guardar"}
                    </button>
                  )}

                  {editQtyValue === 0 && (
                    <span className="active-order-qty__hint active-order-qty__hint--inline">
                      Se va a quitar del pedido
                    </span>
                  )}
                </div>

                {editQtyValue > item.quantity && (
                  <div className="active-order-qty__hint">
                    Las unidades extra se agregan al carrito y se suman al pedido cuando lo actualices.
                  </div>
                )}
              </div>
            ) : undefined
          }
        />

        {isMissing && isAltOpen && (
          <AlternativesPanel
            item={{ ...item, id: item.primaryItemId, quantity: 1 }}
            onClose={() => { setAltOpenFor(null); setAltReplaceError(null); }}
            onSelected={(alt, cardId) =>
              handleSelectAlternative({ ...item, id: item.primaryItemId, quantity: 1 }, alt, cardId)
            }
            onRemoveItem={() => handleCancelItem(item.primaryItemId)}
            removing={isCanceling}
            replacingId={altReplacingCardId}
            replaceError={altReplaceError}
          />
        )}
      </div>
    );
  }

  function renderPromoOrderRow(row: Extract<OrderDisplayRow, { kind: "promo" }>) {
    const childControls: Record<
      string,
      {
        qty: number;
        qtyLabel: ReactNode;
        onRemove?: () => void;
        onStatusClick?: () => void;
      }
    > = {};

    for (const member of row.members) {
      childControls[orderItemPromoKey(member)] = {
        qty: member.quantity,
        qtyLabel: (
          <span className="active-order-line2">
            <QuantityUnitLabel quantity={member.quantity} />
            <CustomerItemPrepStatus
              item={member}
              warehouseIds={warehouseIds}
              localDeferredPickup={localDeferredPickup}
            />
          </span>
        ),
        // Mi pedido: sin −/+, solo basura (misma acción que quitar producto)
        onRemove: isReadOnly
          ? undefined
          : () => {
              void handleCancelItem(member.primaryItemId);
            },
      };
    }

    return (
      <div key={row.group.promotionId} className="active-order-item-divider">
        <PromoGroupRow
          mode="order"
          promoLabel={row.group.promoLabel}
          groups={row.group.groups}
          totalQty={row.group.totalQty}
          promoPrice={row.group.promoPrice}
          items={row.group.items}
          childControls={childControls}
        />
      </div>
    );
  }

  // Tarjeta de total + botón de enviar — se reutiliza en dos posiciones:
  // pegada arriba de la lista de ítems cuando el pedido está vencido
  // (para que la acción principal quede junto al aviso de vencimiento,
  // no perdida al final de la lista), y en su lugar habitual (debajo de
  // la lista) en el resto de los casos.
  // Zona local diferida (Resistencia/etc.): sin "Cerrar pedido" (prep. ni ya apartado).
  const showCloseButton = isExpired
    ? !isDeferredLocalZone && (canSend || hasMissing)
    : !order.local_deferred_pickup;

  const totalAndSendCard = (
    <div
      className={[
        "active-order-card",
        "active-order-card--summary",
        showCloseButton ? "active-order-card--summary-action" : "active-order-card--summary-only",
      ].join(" ")}
    >
      <div className="active-order-summary__meta">
        <div className="active-order-summary__units">
          {totalItems} unidad{totalItems !== 1 ? "es" : ""}
        </div>
        <div className="active-order-summary__amount">
          {formatARS(totalAmount)}
        </div>
      </div>

      {isExpired ? (
        showCloseButton && (
          <button
            type="button"
            onClick={handleSendCtaClick}
            disabled={sending}
            className={`active-order-btn active-order-btn--primary-green active-order-btn--compact${sending ? " is-busy" : ""}${!canSend ? " is-disabled" : ""}`}
          >
            {sending ? "Cerrando..." : canSend ? "✓ Cerrar pedido" : "Cerrar pedido"}
          </button>
        )
      ) : showCloseButton ? (
        <button
          type="button"
          onClick={handleSendCtaClick}
          disabled={sending}
          className={`active-order-btn active-order-btn--primary-green active-order-btn--compact${sending ? " is-busy" : ""}${!canSend ? " is-disabled" : ""}`}
        >
          {sending
            ? "Cerrando..."
            : canSend
              ? "✓ Cerrar pedido"
              : hasMissing
                ? "Cerrar pedido"
                : totalItems === 0
                  ? "Agregá productos"
                  : `Faltan ${remaining} unidad${remaining !== 1 ? "es" : ""}`}
        </button>
      ) : null}
    </div>
  );

  return (
    <div>
      {/* Aviso: plazo vencido */}
      {isExpired && (
        <div className="active-order-card active-order-card--expired">
          <div className="active-order-expired__order-no">
            Pedido #{order.order_number}
          </div>
          <div className="active-order-state__title active-order-state__title--center">
            El plazo de tu pedido venció
          </div>
          <p className="active-order-state__text active-order-state__text--center">
            {isDeferredLocalZone
              ? "El plazo de 36 horas venció. Escribinos por WhatsApp si necesitás ayuda."
              : "No podés modificarlo, pero aún podés cerrarlo tal como está."}
          </p>

          <div className="active-order-expired__actions">
            {!isDeferredLocalZone && !extensionUsed && (
              <button
                type="button"
                onClick={handleRequestExtension}
                disabled={extending}
                className={`active-order-btn active-order-btn--primary${extending ? " is-busy" : ""}`}

              >
                {extending ? "Habilitando..." : "Extender 24 h"}
              </button>
            )}

            <a
              href={WHATSAPP_HREF}
              target="_blank"
              rel="noopener noreferrer"
              className="active-order-btn active-order-btn--whatsapp"

            >
              <WhatsAppIcon size={17} />
              WhatsApp
            </a>
          </div>

          {!isDeferredLocalZone && extensionUsed && (
            <div className="active-order-banner active-order-banner--extension active-order-banner--extension-note">
              <p>
                Ya usaste tu prórroga. Para más tiempo, escribinos por WhatsApp.
              </p>
            </div>
          )}

          <button
            type="button"
            onClick={() => setShowCancelConfirm(true)}
            disabled={cancelingOrder}
            className="active-order-btn active-order-btn--text-danger"
            style={{ marginTop: 10, opacity: cancelingOrder ? 0.7 : undefined }}
          >
            Cancelar pedido
          </button>
        </div>
      )}

      {/* Total + enviar, pegado al aviso de vencimiento — no perdido al
          final de la lista de productos. */}
      {isExpired && totalAndSendCard}

      {/* Header — compact single row. Oculto cuando el pedido venció: toda
          la info (número de pedido, estado) ya vive en la tarjeta blanca
          de arriba, mostrar ambas era redundante. */}
      {!isExpired && (
      <div
        className={[
          "active-order-header",
          "active-order-header--compact",
          order.status === "closing_soon" ? "active-order-header--closing-soon" : "",
          isLocalDeferredReady ? "active-order-header--ready-pickup" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <div className="active-order-header__row active-order-header__row--top">
          <div className="active-order-header__icon">
            {isLocalDeferredReady || (allConfirmedForCustomer && missingItems.length === 0 && !hideDeadlineUntilApartado) ? (
              // Check cuando todo lo que ve la clienta ya está confirmado / apartado
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
            ) : (
              // Reloj mientras espera confirmación
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
              </svg>
            )}
          </div>

          {/* Número de pedido */}
          <div className="active-order-header__meta">
            <div className="active-order-header__order-no">
              Pedido {order.order_number}
            </div>
          </div>

          {/* Right side: order options menu */}
          <div className="active-order-header__controls">
            {/* Options menu ⋯ */}
            {!isReadOnly && (order.status === "active" || order.status === "closing_soon") && (
              <div className="active-order-item-menu">
                <button
                  type="button"
                  onClick={() => setOrderMenuOpen((v) => !v)}
                  aria-label="Opciones del pedido"
                  className="active-order-header__menu-btn"
                >
                  …
                </button>
                {orderMenuOpen && (
                  <>
                    <div className="active-order-menu-backdrop" onClick={() => setOrderMenuOpen(false)} />
                    <div className="active-order-menu active-order-menu--order">
                      <button
                        type="button"
                        onClick={() => { setOrderMenuOpen(false); setShowCancelConfirm(true); }}
                        className="active-order-menu__item active-order-menu__item--danger"
                      >
                        Cancelar pedido
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="active-order-header__row active-order-header__row--bottom">
          <div className="active-order-header__status-title">
            {hideDeadlineUntilApartado ? (
              <span className="active-order-header__status-title-row">
                <PreparingOrderSpinner size={16} />
                Preparando tu pedido
              </span>
            ) : isLocalDeferredReady
              ? "Tu pedido está listo para retirar"
              : order.status === "closing_soon"
              ? "Cerrá tu pedido pronto"
              : allConfirmedForCustomer && missingItems.length > 0
                ? (missingItems.length === 1
                    ? "Falta resolver 1 producto sin stock"
                    : `Falta resolver ${missingItems.length} productos sin stock`)
                : daysLeft <= 3 && !isExpired
                  ? headerAltPhase
                    ? (daysLeft === 0 ? "Vence hoy: cerrá el pedido" : `Te quedan ${daysLeft} día${daysLeft !== 1 ? "s" : ""} para cerrarlo`)
                    : "Pedido abierto"
                  : "Pedido abierto"}
          </div>
          {!isExpired && !hideDeadlineUntilApartado && Boolean(order.dismantle_at || !order.local_deferred_pickup) && (
            <button
              type="button"
              onClick={() => { setShowDaysInfo((v) => !v); setShowStatusInfo(false); }}
              aria-label="¿Qué significa este plazo?"
              className={`active-order-header__chip${showDaysInfo ? " is-open" : ""}`}
            >
              {showPickupCountdown ? (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                </svg>
              ) : (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="3" y="4" width="18" height="18" rx="2"/>
                  <path d="M16 2v4M8 2v4M3 10h18"/>
                </svg>
              )}
              {showPickupCountdown
                ? formatRemainingCountdown(deadlineDate, _now)
                : formatDeadlineChip(calendarDaysLeft, deadlineDate)}
            </button>
          )}
        </div>

        {hideDeadlineUntilApartado && (
          <p className="active-order-header__sub active-order-header__sub--detail">
            Estamos verificando los productos en el local. Te avisaremos cuando esté listo para retirar.
          </p>
        )}

        {isLocalDeferredReady && (
          <div className="active-order-header__ready-body">
            <p className="active-order-header__sub active-order-header__sub--detail">
              Ya preparamos tus productos. Podés pasar a retirarlos por nuestro local.
            </p>
            <div className="active-order-header__pickup-meta">
              <a
                href={LOCAL_STORE_MAPS_HREF}
                target="_blank"
                rel="noopener noreferrer"
                className="active-order-header__pickup-address"
                aria-label="Abrir ubicación en Google Maps"
              >
                <span aria-hidden="true">📍</span>
                <span className="active-order-header__pickup-address-text">
                  Av. Alberdi 1099
                </span>
              </a>
              <p className="active-order-header__pickup-pay">
                El pago se realiza al retirar.
              </p>
            </div>
            <p className="active-order-header__pickup-hint">
              Al retirar, indicá tu nombre o N.º de pedido{" "}
              <strong>{order.order_number}</strong>
            </p>
          </div>
        )}

        {/* Expandable explanation — oculto por defecto */}
        {!hideDeadlineUntilApartado && (showStatusInfo || showDaysInfo) && (
          <div className="active-order-header__info-panel">
            {showDaysInfo
              ? showPickupCountdown
                ? `Tenés ${formatRemainingCountdown(deadlineDate, _now)} para retirarlo (vence el ${formatWeekdayDate(deadlineDate)} a las ${formatTime(deadlineDate)}).`
                : shortPickupWindow
                  ? getLocalPickupDeadlineExplanation(deadlineDate, _now)
                  : getDeadlineExplanation(calendarDaysLeft, deadlineDate)
              : order.status === "closing_soon"
                ? isDeferredLocalZone
                  ? `Tu pedido está próximo a vencer. Cerralo para que podamos prepararlo.`
                  : `Tu pedido está próximo a vencer (${daysLeft} día${daysLeft !== 1 ? "s" : ""}). Completá el mínimo de unidades o cerralo para que podamos prepararlo.`
                : (() => {
                    const hasMissing  = missingItems.length > 0;
                    if (allConfirmedForCustomer && !hasMissing)
                      return "Podés seguir agregando productos o cerrarlo para que preparemos tu pedido.";
                    if (allConfirmedForCustomer && hasMissing)
                      return "Uno o más productos de tu pedido no tienen stock disponible. Podés quitarlos o elegir una alternativa.";
                    if (hasMissing && reservedCount === 0)
                      return "Uno o más productos de tu pedido no tienen stock disponible. Podés quitarlos o elegir una alternativa.";
                    return hasMissing
                      ? "Uno o más productos de tu pedido no tienen stock disponible. Podés quitarlos o elegir una alternativa."
                      : "Podés seguir agregando productos o cerrarlo para que preparemos tu pedido.";
                  })()
            }
          </div>
        )}

        {/* Deadline warning — 1, 2 o 3 días. No se usa en listo-para-retirar
            (esa UI es una sola tarjeta verde con countdown en el chip). */}
        {warnSoon && !showStatusInfo && !showDaysInfo && (
          <div className="active-order-header__deadline-banner">
            <div className="active-order-header__deadline-title">
              {calendarDaysLeft === 0
                ? "Tu pedido vence hoy"
                : calendarDaysLeft === 1
                  ? "Tu pedido vence mañana"
                  : `Tu pedido vence en ${calendarDaysLeft} días`}
            </div>
            <div className="active-order-header__deadline-text">
              {calendarDaysLeft === 0
                ? `Cerrá el pedido antes de las ${formatTime(deadlineDate)}. Si vence el plazo, el pedido se cancelará.`
                : calendarDaysLeft === 1
                  ? "Cerrá el pedido hoy. Si vence el plazo, el pedido se cancelará."
                : calendarDaysLeft === 2
                    ? "Cerrá tu pedido para mantener estos productos en el pedido."
                    : "Cerrá tu pedido antes del vencimiento para mantener estos productos."}
              {!canSend && !isLocalPickupZone && ` Te faltan ${remaining} unidad${remaining !== 1 ? "es" : ""} para poder cerrarlo.`}
            </div>
            <div className="active-order-header__deadline-row">
              <span className="active-order-header__deadline-ask">
                ¿Tenés alguna duda?
              </span>
              <a
                href={WHATSAPP_HREF}
                target="_blank"
                rel="noopener noreferrer"
                className="active-order-btn active-order-btn--whatsapp active-order-btn--whatsapp-xs"
              >
                <WhatsAppIcon size={11} />
                WhatsApp
              </a>
            </div>
          </div>
        )}
      </div>
      )}

      {showFirstOrderGuide && !isExpired && createPortal(
        <div
          className="active-order-first-guide-backdrop"
          onClick={dismissFirstOrderGuide}
        >
          <div
            className="active-order-first-guide"
            role="dialog"
            aria-modal="true"
            aria-labelledby="active-order-first-guide-title"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              onClick={dismissFirstOrderGuide}
              className="active-order-first-guide__close"
              aria-label="Cerrar explicación"
            >
              ×
            </button>
            <div className="active-order-first-guide__eyebrow">Mi pedido</div>
            <div
              id="active-order-first-guide-title"
              className="active-order-first-guide__title"
            >
              Tus productos ya están en el pedido
            </div>
            <div className="active-order-first-guide__lead">
              Acá podés revisarlos antes de cerrarlo.
            </div>
            <div className="active-order-first-guide__list">
              <div className="active-order-first-guide__item">
                <span className="active-order-first-guide__icon" aria-hidden="true">
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
                    <path d="M12 3 4.5 7.2v9.2L12 20.7l7.5-4.3V7.2L12 3Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                    <path d="M4.8 7.4 12 11.5l7.2-4.1M12 11.5v5.7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                    <path d="m15.8 14.9 3.2 3.2m0-3.2-3.2 3.2" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
                  </svg>
                </span>
                <span>
                  <strong>Si algún producto no está disponible</strong>
                  <small>Lo vamos a marcar acá y también te avisaremos por WhatsApp.</small>
                </span>
              </div>
              <div className="active-order-first-guide__item">
                <span className="active-order-first-guide__icon" aria-hidden="true">
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
                    <circle cx="12" cy="12" r="8.3" stroke="currentColor" strokeWidth="1.9" />
                    <path d="M12 7.7v4.9l3 1.8" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
                <span>
                  <strong>
                    {order.local_deferred_pickup && isLocalPickupZone
                      ? "Tenés 36 horas"
                      : "Tenés 7 días"}
                  </strong>
                  <small>Podés cerrar el pedido cuando quieras.</small>
                </span>
              </div>
            </div>
            <button
              type="button"
              onClick={dismissFirstOrderGuide}
              className="active-order-first-guide__ok"
            >
              Entendido, ver mi pedido
            </button>
          </div>
        </div>,
        document.body
      )}

      {!isExpired && (
        <>
        </>
      )}

      {/* "Closed + missing items" banner — admin is processing but found unavailable stock */}
      {isClosed && missingItems.length > 0 && (
        <div className="active-order-banner active-order-banner--missing active-order-banner--closed-missing">
          <div className="active-order-banner__title">
            ⚠️ Tu pedido está siendo preparado, pero hay {missingItems.length === 1 ? "un producto" : `${missingItems.length} productos`} sin stock
          </div>
          <div className="active-order-banner__text">
            Nuestro equipo no encontró disponibilidad de estos productos. Podés quitarlos o elegir una alternativa para poder avanzar con el pedido.
          </div>
        </div>
      )}

      {/* Regular missing items warning (active/closing_soon) */}
      {!isClosed && missingItems.length > 0 && (
        <div className="active-order-banner active-order-banner--missing">
          <span className="active-order-svg-icon active-order-svg-icon--warn">⚠️</span>
          <div>
            <div className="active-order-banner__title">
              {missingItems.length === 1
                ? "1 producto sin stock"
                : `${missingItems.length} productos sin stock`}
            </div>
            <div className="active-order-banner__text">
              Podés quitarlos o elegir una alternativa disponible.
            </div>
          </div>
        </div>
      )}

      {/* Items list */}
      <div className="active-order-card active-order-card--items">
        {missingItems.map((item) => (
          <div key={item.primaryItemId} className="active-order-item-divider">
            {renderItem(item, true)}
          </div>
        ))}

        {shownRegularRows.map((row) =>
          row.kind === "promo" ? (
            renderPromoOrderRow(row)
          ) : (
            <div key={row.item.primaryItemId} className="active-order-item-divider">
              {renderItem(row.item, false)}
            </div>
          )
        )}

        {hiddenCount > 0 && !showAllItems && (
          <button
            onClick={() => setShowAllItems(true)}
            className="active-order-expand active-order-expand--with-icon"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="6 9 12 15 18 9"/>
            </svg>
            Ver {hiddenCount} producto{hiddenCount !== 1 ? "s" : ""} más del pedido
          </button>
        )}

        {/* "Ver menos" collapse */}
        {showAllItems && regularDisplayRows.length > ITEMS_PREVIEW && (
          <button
            onClick={() => setShowAllItems(false)}
            className="active-order-expand active-order-expand--muted active-order-expand--with-icon"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="18 15 12 9 6 15"/>
            </svg>
            Ver menos
          </button>
        )}

        {allVisible.length === 0 && (
          <div className="active-order-empty-items">
            No hay productos en este pedido
          </div>
        )}
      </div>

      {/* Total + enviar en su posición habitual, debajo de la lista —
          cuando el pedido está vencido ya se mostró arriba, junto al
          aviso de vencimiento (ver más arriba). */}
      {!isExpired && totalAndSendCard}

      {/* Retiro local diferido: sin "Cerrar pedido", pero sí pueden seguir
          sumando unidades (catálogo). Misma CTA que en pedido cerrado/prep. */}
      {!isExpired && (hideDeadlineUntilApartado || isLocalDeferredReady) && (
        <Link href="/" className="active-order-btn active-order-btn--brand-soft active-order-btn--brand-soft--follow">
          + Agregar más productos
        </Link>
      )}

      {/* Minimum progress — antes se mostraba con "!canSend", pero canSend
          también es false cuando hay un producto sin stock aunque el mínimo
          de 4 unidades ya esté cumplido: mostraba "9/4" con "0 unidades más"
          y la barra de progreso se pasaba de 100% de ancho. El mínimo es
          harina de otro costal — solo importa cuánto falta para las 4. */}
      {!isLocalPickupZone && remaining > 0 && totalItems > 0 && (
        <div className="active-order-min">
          <div className="active-order-min__header">
            <div className="active-order-min__label-row">
              <span className="active-order-min__label">Mínimo del pedido</span>
              <button
                type="button"
                onClick={() => setShowMinInfo((v) => !v)}
                aria-label="¿Qué es el mínimo del pedido?"
                className={`active-order-min__info${showMinInfo ? " is-open" : ""}`}
              >
                ?
              </button>
            </div>
            <span className="active-order-min__count">
              {totalItems} / 4 unidades
            </span>
          </div>
          {showMinInfo && (
            <div className="active-order-banner active-order-banner--extension active-order-min__info-box">
              <strong>
                ¿Qué es el mínimo del pedido?
              </strong>
              Para poder preparar tu pedido necesitás un mínimo de <strong>4 unidades</strong>. Pueden ser productos completamente distintos — combiná tallas, colores y artículos como quieras. Lo importante es llegar a 4 en total.
            </div>
          )}
          <div className="active-order-min__progress-wrap">
            <div className="active-order-min__track active-order-min__track--inline" />
            {totalItems >= 2 && (
              <div
                className="active-order-min__fill"
                style={{ width: `${((totalItems - 1) / 3) * 100}%` }}
              />
            )}
            {([0, 1, 2, 3] as const).map((i) => {
              const filled = totalItems >= i + 1;
              const posStyle: CSSProperties = {
                left: `calc(7px + ${(i / 3) * 100}% - ${(i / 3) * 14}px)`,
              };
              return (
                <div
                  key={i}
                  className={`active-order-min__dot active-order-min__dot--lg${filled ? " is-filled" : ""}`}
                  style={posStyle}
                >
                  {filled && (
                    <svg width="7" height="7" viewBox="0 0 10 10">
                      <polyline points="1.5,5 4,7.5 8.5,2.5" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  )}
                </div>
              );
            })}
          </div>
          <div className="active-order-min__hint">
            Necesitás al menos {remaining} unidad{remaining !== 1 ? "es" : ""} más para cerrar el pedido
          </div>
          <Link href="/" className="active-order-btn active-order-btn--brand-soft active-order-btn--brand-soft--follow">
            + Seguir eligiendo productos
          </Link>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="active-order-banner active-order-banner--error">
          {error}
        </div>
      )}

      {/* Avisos relacionados con el envío — el botón en sí ya vive en la
          tarjeta de totales de arriba, acá solo quedan los mensajes de
          apoyo (hint de "sin stock" y el carrusel de recomendados).
          Zona local diferida (preparando o listo para retirar): recomendados
          para seguir sumando productos al pedido. */}
      {!isExpired && !hasMissing && (
        (!isLocalPickupZone && !canSend && remaining > 0) ||
        ((hideDeadlineUntilApartado || isLocalDeferredReady) && totalItems > 0)
      ) && (
        <div className="active-order-carousel-wrap">
          <CartRecommendedCarousel
            daysLeft={(hideDeadlineUntilApartado || isLocalDeferredReady) ? 99 : daysLeft}
            remaining={(hideDeadlineUntilApartado || isLocalDeferredReady) ? 0 : remaining}
          />
        </div>
      )}
      {/* Toast centrado en pantalla, por encima de todo — antes este aviso
          quedaba en el flujo normal (debajo de la tarjeta de envío) y podía
          no verse si esa zona no estaba a la vista. Se cierra solo a los
          3s (ver el setTimeout en el botón "Enviar pedido") o al tocar
          afuera. missingHintMounted queda un rato más que showMissingHint
          para poder reproducir la animación de salida en vez de cortar en seco. */}
      {missingHintMounted && createPortal(
        <div
          onClick={() => setShowMissingHint(false)}
          className="active-order-sheet-backdrop active-order-sheet-backdrop--center active-order-hint-backdrop"
          style={{
            animation: showMissingHint
              ? "active-order-hint-in 0.2s ease forwards"
              : "active-order-hint-out 0.2s ease forwards",
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="active-order-toast active-order-toast--missing"
            style={{
              animation: showMissingHint
                ? "active-order-hint-in 0.28s cubic-bezier(.34,1.56,.64,1) forwards"
                : "active-order-hint-out 0.2s ease forwards",
            }}
          >
            <div className="active-order-toast__icon">⚠️</div>
            <div className="active-order-toast__message active-order-toast__message--danger">
              Quitá o reemplazá los productos sin stock para poder cerrar el pedido.
            </div>
          </div>
        </div>,
        document.body
      )}

      <OrderTransportConfirmModal
        open={showTransportConfirm}
        province={customerProvince}
        city={customerCity}
        currentTransport={activeTransportName}
        onCancel={() => setShowTransportConfirm(false)}
        onConfirm={handleTransportConfirmed}
      />

      {/* ── Confirmation modal ─────────────────────────────────────────────── */}
      {showSendConfirm && createPortal(
        <div
          className="active-order-sheet-backdrop"
          onClick={() => {
            if (!sending) setShowSendConfirm(false);
          }}
        >
          <div className="active-order-sheet active-order-sheet--padded" onClick={(e) => e.stopPropagation()}>
            <div className="active-order-toast__icon active-order-toast__icon--lg">📦</div>
            <div className="active-order-sheet__title active-order-sheet__title--spaced">
              {isLocalPickupOrder
                ? "¿Cerrar pedido para retirar en local?"
                : "¿Cerrar pedido para preparar envío?"}
            </div>

            <div className="active-order-send-receipt">
<strong>{totalItems}</strong>
<span>unidad{totalItems !== 1 ? "es" : ""}</span>
<span className="active-order-send-receipt__sep">·</span>
<strong className="active-order-send-receipt__total">{formatARS(totalAmount)}</strong>
            </div>

            <div className="active-order-send-explainer">
              {isLocalPickupOrder
                ? "Al cerrar, nos pedís que preparemos tu pedido para retirarlo por el local."
                : "Al cerrar, nos pedís que preparemos tu pedido para enviártelo."}
            </div>

            <div className={`active-order-send-note ${allItemsPicked ? "active-order-send-note--ok" : "active-order-send-note--wait"}`}>
              <div className="active-order-send-note__title">
                {allItemsPicked ? "✓ Pedido listo para preparar" : "⏳ Si surge un faltante, te avisamos"}
              </div>
              <div className="active-order-send-note__text">
                {allItemsPicked
                  ? isLocalPickupOrder
                    ? "No se cobra por la web. El pago se realiza en el local al retirar."
                    : "No se cobra por la web. El pago y el transporte se coordinan después."
                  : "No se cobra por la web. Si algún producto no está disponible, te escribimos por WhatsApp."}
              </div>
            </div>
            {error && (
              <div className="active-order-send-modal-error">
                {error}
              </div>
            )}
            <div className="active-order-sheet__actions active-order-sheet__actions--stack active-order-sheet__actions--flat">
              <button
                type="button"
                onClick={async () => {
                  const ok = await handleSend();
                  if (ok) setShowSendConfirm(false);
                }}
                disabled={sending}
                className={`active-order-btn active-order-btn--primary-green active-order-btn--sheet-primary${sending ? " is-busy" : ""}`}
              >
                {sending
                  ? "Cerrando..."
                  : isLocalPickupOrder
                    ? "Sí, cerrar y preparar retiro"
                    : "Sí, cerrar y preparar envío"}
              </button>
              <button
                type="button"
                onClick={() => setShowSendConfirm(false)}
                disabled={sending}
                className="active-order-btn active-order-btn--secondary active-order-btn--sheet-secondary"
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* ── Cancel order modal ──────────────────────────────────────────────── */}
      {showCancelConfirm && createPortal(
        <div className="active-order-sheet-backdrop" onClick={() => setShowCancelConfirm(false)}>
          <div className="active-order-sheet active-order-sheet--padded" onClick={(e) => e.stopPropagation()}>
            <div className="active-order-sheet__title active-order-sheet__title--spaced-sm">
              ¿Cancelar todo el pedido?
            </div>
            <p className="active-order-sheet__subtitle">
              Los productos vuelven a estar disponibles para otros pedidos. El pedido desaparece de tu cuenta pero queda registrado para administración.
            </p>
            <div className="active-order-sheet__actions active-order-sheet__actions--stack active-order-sheet__actions--flat">
              <button
                type="button"
                onClick={handleCancelEntireOrder}
                disabled={cancelingOrder}
                className={`active-order-btn active-order-btn--danger active-order-btn--sheet-primary${cancelingOrder ? " is-busy" : ""}`}
              >
                {cancelingOrder ? "Cancelando..." : "Sí, cancelar pedido"}
              </button>
              <button
                type="button"
                onClick={() => setShowCancelConfirm(false)}
                className="active-order-btn active-order-btn--secondary active-order-btn--sheet-secondary"
              >
                Volver
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* ── Quitar producto (menú ⋯) ─────────────────────────────────────────── */}
      {pendingRemoveItem && (() => {
        const removeMaxUnits = Math.max(1, Number(pendingRemoveItem.quantity) || 1);
        const removeKeep = Math.max(0, Math.min(removeMaxUnits, Number(keepUnits) || 0));
        const removeDelta = removeMaxUnits - removeKeep;
        const removeConfirmLabel = cancelingId
          ? "Quitando..."
          : removeMaxUnits <= 1
            ? "Quitar"
            : removeKeep === 0
              ? "Quitar todo"
              : removeDelta <= 0
                ? "Quitar"
                : removeDelta === 1
                  ? "Quitar 1"
                  : `Quitar ${removeDelta}`;

        return createPortal(
          <div
            className="active-order-sheet-backdrop"
            onClick={closeRemoveProductConfirm}
          >
            <div
              className="active-order-sheet active-order-sheet--padded"
              role="dialog"
              aria-modal="true"
              aria-labelledby="active-order-remove-title"
              onClick={(e) => e.stopPropagation()}
            >
              <div
                id="active-order-remove-title"
                className="active-order-sheet__title active-order-sheet__title--spaced-sm"
              >
                ¿Quitar producto del pedido?
              </div>
              <p className="active-order-sheet__subtitle">
                Estás por quitar{" "}
                <strong>
                  {pendingRemoveItem.product_name || "Producto"}
                  {" · "}
                  {pendingRemoveItem.color || "Color"}
                  {pendingRemoveItem.size
                    ? ` · T. ${pendingRemoveItem.size}`
                    : ""}
                </strong>
                {" "}de tu pedido.
              </p>

              {removeMaxUnits > 1 && (
                <div className="active-order-remove-stepper">
                  <div className="active-order-remove-stepper__label">
                    Cantidad en el pedido
                  </div>
                  <div className="active-order-remove-stepper__controls">
                    <button
                      type="button"
                      className="active-order-remove-stepper__btn"
                      aria-label="Reducir cantidad"
                      disabled={removeKeep <= 0 || Boolean(cancelingId)}
                      onClick={() => setKeepUnits((u) => Math.max(0, u - 1))}
                    >
                      −
                    </button>
                    <div className="active-order-remove-stepper__qty" aria-live="polite">
                      {removeKeep}
                    </div>
                    <button
                      type="button"
                      className="active-order-remove-stepper__btn"
                      aria-label="Aumentar cantidad"
                      disabled={removeKeep >= removeMaxUnits || Boolean(cancelingId)}
                      onClick={() => setKeepUnits((u) => Math.min(removeMaxUnits, u + 1))}
                    >
                      +
                    </button>
                  </div>
                  <div className="active-order-remove-stepper__hint">
                    {removeDelta <= 0
                      ? `Tenés ${removeMaxUnits} unidades. Bajá el número para quitar.`
                      : removeKeep === 0
                        ? `Se quitarán las ${removeMaxUnits} unidades del pedido.`
                        : removeDelta === 1
                          ? `Se quitará 1 unidad. Quedarán ${removeKeep}.`
                          : `Se quitarán ${removeDelta} unidades. Quedarán ${removeKeep}.`}
                  </div>
                </div>
              )}

              <div className="active-order-sheet__actions active-order-sheet__actions--flat active-order-remove-actions">
                <button
                  type="button"
                  onClick={closeRemoveProductConfirm}
                  disabled={Boolean(cancelingId)}
                  className="active-order-btn active-order-btn--secondary active-order-btn--sheet-secondary"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={() => void handleConfirmRemoveProduct()}
                  disabled={Boolean(cancelingId) || removeDelta <= 0}
                  className={`active-order-btn active-order-btn--danger active-order-btn--sheet-primary${cancelingId ? " is-busy" : ""}`}
                >
                  {removeConfirmLabel}
                </button>
              </div>
            </div>
          </div>,
          document.body
        );
      })()}
    </div>
  );
}
