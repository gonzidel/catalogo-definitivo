"use client";

import { useState, useEffect, useMemo, useRef } from "react";
import Link from "next/link";
import { useCartStore, type CartItem } from "@/store/cart";
import { useCartSync, checkoutCart } from "@/hooks/useCart";
import LineItemRow, { formatItemARS } from "@/components/cart/LineItemRow";
import PromoGroupRow, { type PromoChildControls } from "@/components/cart/PromoGroupRow";
import { useProfileGate } from "@/components/profile/ProfileGateProvider";
import { useSellableStock } from "@/hooks/useSellableStock";
import {
  cartLineStockStatus,
  formatSellableRemaining,
  lookupSellableQty,
  sellableStockKey,
} from "@/lib/stock/sellable-stock";
import {
  buildPromoGroups,
  fetchActivePromotionsForVariants,
  formatPromoTitle,
  sumPromoAwareTotal,
  type ActivePromotion,
  type PromoGroupableItem,
} from "@/lib/cart/promo-groups";

function formatARS(n: number) {
  return formatItemARS(n);
}

function cartItemKey(item: CartItem) {
  return sellableStockKey(item.variant_id, item.size);
}

function describeCartItem(item: CartItem) {
  return [item.product_name, item.color, item.size ? `T. ${item.size}` : ""]
    .filter(Boolean)
    .join(" · ");
}

function findStockConflicts(
  items: CartItem[],
  getStock: (item: CartItem) => number | null
) {
  return items
    .map((item) => ({ item, stock: getStock(item) }))
    .filter(({ item, stock }) => stock !== null && item.qty > stock);
}

function buildStockConflictMessage(
  conflicts: Array<{ item: CartItem; stock: number | null }>
) {
  const first = conflicts[0];
  if (!first || first.stock === null) {
    return "No pudimos confirmar el stock. Intentá nuevamente.";
  }

  const itemName = describeCartItem(first.item);
  const prefix = conflicts.length > 1 ? `${conflicts.length} productos necesitan ajuste. ` : "";
  if (first.stock <= 0) {
    return `${prefix}${itemName} ya no tiene stock disponible. Quitalo del carrito para hacer el pedido.`;
  }

  const availableLabel = first.stock === 1 ? "queda 1" : `quedan ${first.stock}`;
  return `${prefix}${itemName}: ${availableLabel} y tenés ${first.item.qty}. Ajustá la cantidad para hacer el pedido.`;
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface CartTabProps {
  customerId: string;
  onOrderCreated: () => void;
  activeOrderStatus?: string | null; // "closed" = envío pendiente; no usar si retiro ya cobrado
  onGoToOrder?: () => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function CartTab({ customerId, onOrderCreated, activeOrderStatus, onGoToOrder }: CartTabProps) {
  const items            = useCartStore((s) => s.items);
  const removeItem       = useCartStore((s) => s.removeItem);
  const updateQty        = useCartStore((s) => s.updateQty);
  const clearCart        = useCartStore((s) => s.clearCart);
  const isCheckingOut    = useCartStore((s) => s.isCheckingOut);
  const checkoutError    = useCartStore((s) => s.checkoutError);
  const setCheckingOut   = useCartStore((s) => s.setCheckingOut);
  const setCheckoutError = useCartStore((s) => s.setCheckoutError);
  const [showConfirm, setShowConfirm] = useState(false);
  const checkoutLock = useRef(false);

  const { removeFromSupabase, syncNow } = useCartSync(customerId);
  const sellableVariantIds = useMemo(
    () => [...new Set(items.map((i) => i.variant_id).filter(Boolean))],
    [items]
  );
  const {
    byVariant,
    queryFailed,
    isValidating,
    revalidate: revalidateSellable,
  } = useSellableStock(sellableVariantIds);
  const { requireProfileComplete, profileComplete } = useProfileGate();
  const [promotions, setPromotions] = useState<ActivePromotion[]>([]);

  function getStock(item: CartItem): number | null {
    if (queryFailed) return null;
    if (!byVariant) return null;
    return lookupSellableQty(byVariant, item.variant_id, item.size);
  }

  const itemsWithStock = items.map((item) => {
    const stock = getStock(item);
    const status = cartLineStockStatus(item.qty, stock);
    const outOfStock = status.kind === "out";
    const limitedStock = status.kind === "limited";
    return { item, stock, status, outOfStock, limitedStock };
  });

  const outOfStockCount = itemsWithStock.filter((x) => x.outOfStock).length;
  const stockConflictCount = itemsWithStock.filter(
    ({ item, stock }) => stock !== null && item.qty > stock
  ).length;

  const inStockItems = itemsWithStock.filter((x) => !x.outOfStock);

  useEffect(() => {
    const variantIds = inStockItems
      .map(({ item }) => item.variant_id)
      .filter(Boolean);
    if (variantIds.length === 0) {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inStockItems.map(({ item }) => item.variant_id).join(",")]);

  const promoGroupables: PromoGroupableItem[] = useMemo(
    () =>
      inStockItems.map(({ item }) => ({
        key: cartItemKey(item),
        variant_id: item.variant_id,
        product_name: item.product_name,
        color: item.color,
        size: item.size,
        qty: item.qty,
        price_snapshot: item.price_snapshot,
        imagen: item.imagen,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [inStockItems.map(({ item }) => `${cartItemKey(item)}:${item.qty}:${item.price_snapshot}`).join("|")]
  );

  const { groups: promoGroups, ungrouped: ungroupedPromoItems } = useMemo(
    () => buildPromoGroups(promoGroupables, promotions),
    [promoGroupables, promotions]
  );

  // Total con descuento de promos 2x (solo ítems con stock)
  const total = sumPromoAwareTotal(promoGroups, ungroupedPromoItems);
  const totalItems = inStockItems.reduce((a, { item }) => a + item.qty, 0);

  const cartByKey = useMemo(() => {
    const map = new Map<string, CartItem>();
    for (const item of items) map.set(cartItemKey(item), item);
    return map;
  }, [items]);

  async function handleRemove(item: CartItem) {
    removeItem(item.variant_id, item.size);
    await removeFromSupabase(item.id);
  }

  function handleQty(item: CartItem, delta: number) {
    const next = item.qty + delta;
    if (next <= 0) return;
    const stock = getStock(item);
    if (stock !== null && next > stock) return; // no superar stock disponible
    updateQty(item.variant_id, item.size, next);
  }

  async function assertSellableBeforeCheckout(): Promise<boolean> {
    let latest;
    try {
      latest = await revalidateSellable();
    } catch {
      setCheckoutError("No pudimos verificar el stock. Intentá nuevamente.");
      return false;
    }
    if (!latest) {
      setCheckoutError("No pudimos verificar el stock. Intentá nuevamente.");
      return false;
    }
    const freshGetStock = (item: CartItem): number | null =>
      lookupSellableQty(latest, item.variant_id, item.size);
    const unverified = items.filter((item) => freshGetStock(item) === null);
    if (unverified.length > 0) {
      setCheckoutError("No pudimos verificar el stock. Intentá nuevamente.");
      return false;
    }
    const conflicts = findStockConflicts(items, freshGetStock);
    if (conflicts.length > 0) {
      setCheckoutError(buildStockConflictMessage(conflicts));
      return false;
    }
    const availableUnits = items.reduce((acc, item) => {
      const sellable = freshGetStock(item);
      if (sellable === null || sellable <= 0) return acc;
      return acc + item.qty;
    }, 0);
    if (availableUnits <= 0) {
      setCheckoutError("No hay productos con stock disponible para hacer el pedido.");
      return false;
    }
    setCheckoutError(null);
    return true;
  }

  async function handleCheckout() {
    if (checkoutLock.current || useCartStore.getState().isCheckingOut) return;
    checkoutLock.current = true;
    setCheckingOut(true);
    try {
      const profileOk = await requireProfileComplete();
      if (!profileOk) return;
      setCheckoutError(null);
      const sellableOk = await assertSellableBeforeCheckout();
      if (!sellableOk) return;
      const synced = await syncNow();
      if (!synced) {
        setCheckoutError("No pudimos guardar el carrito. Intentá nuevamente.");
        return;
      }
      const currentItems = useCartStore.getState().items;
      const result = await checkoutCart(currentItems);
      if (result.success) {
        clearCart();
        onOrderCreated();
      } else {
        let msg = result.error ?? "Error al hacer tu pedido";
        if (msg.includes("conflict_in_progress")) {
          msg = "Hay un pedido en proceso. Esperá unos segundos e intentá nuevamente.";
        } else if (msg.includes("operation_id_conflict")) {
          msg = "El carrito cambió entre intentos. Intentá nuevamente.";
        } else if (/no se encontró un carrito activo/i.test(msg) || /carrito está vacío/i.test(msg)) {
          msg = "El carrito no se guardó en el servidor. Cerrá esto e intentá de nuevo.";
        } else if (/no tiene variante asociada/i.test(msg)) {
          msg = "Hay un producto que ya no está disponible. Eliminalo y volvé a intentar.";
        } else if (/stock.*insuficiente/i.test(msg)) {
          msg = "El stock cambió recién. Revisá las cantidades del carrito y volvé a intentar.";
        }
        setCheckoutError(msg);
      }
    } catch {
      setCheckoutError("No pudimos revisar el stock. Intentá nuevamente.");
    } finally {
      checkoutLock.current = false;
      setCheckingOut(false);
    }
  }

  if (items.length === 0) {
    return (
      <div className="cart-tab-empty">
        <div className="cart-tab-empty__icon">🛒</div>
        <div className="cart-tab-empty__title">Tu carrito está vacío</div>
        <p className="cart-tab-empty__text">
          Navegá el catálogo, elegí los productos y agregalos acá
        </p>
        <Link href="/" className="cart-tab-empty__cta">
          Ver catálogo
        </Link>
      </div>
    );
  }

  // Only block the CTA while checkout is in flight — never while the advisory
  // stock probe is running (slow networks made "Verificando stock..." feel stuck).
  const submitBusy = isCheckingOut;

  return (
    <div>
      {queryFailed && (
        <div className="cart-tab-banner cart-tab-banner--info">
          <span className="cart-tab-banner__icon">⚠️</span>
          <div>
            <div className="cart-tab-banner__title">No pudimos verificar el stock</div>
            <div className="cart-tab-banner__text">
              Tus productos siguen en el carrito. Reintentá o volvé a esta pestaña.
            </div>
          </div>
        </div>
      )}

      {outOfStockCount > 0 && (
        <div className="cart-tab-banner cart-tab-banner--oos">
          <span className="cart-tab-banner__icon">⚠️</span>
          <div>
            <div className="cart-tab-banner__title">
              {outOfStockCount === 1
                ? "1 producto sin stock disponible"
                : `${outOfStockCount} productos sin stock disponible`}
            </div>
            <div className="cart-tab-banner__text">
              Están marcados en rojo. Quitalos o ajustá el carrito para hacer el pedido.
            </div>
          </div>
        </div>
      )}

      <div className="cart-tab-list">
        {promoGroups.map((group) => {
          const childControls: Record<string, PromoChildControls> = {};
          for (const gItem of group.items) {
            const cartItem = cartByKey.get(gItem.key);
            if (!cartItem) continue;
            const s = getStock(cartItem);
            const status = cartLineStockStatus(cartItem.qty, s);
            childControls[gItem.key] = {
              qty: gItem.qty,
              atMax: s !== null && cartItem.qty >= s,
              onQtyDelta: (delta) => handleQty(cartItem, delta),
              onRemove: () => {
                void handleRemove(cartItem);
              },
              below:
                status.kind === "limited" ? (
                  <span className="cart-tab-stock-pill cart-tab-stock-pill--limited">
                    {formatSellableRemaining(status.sellable)}
                  </span>
                ) : undefined,
            };
          }
          return (
            <div key={group.promotionId} className="cart-tab-list__row">
              <PromoGroupRow
                mode="cart"
                promoLabel={group.promoLabel}
                groups={group.groups}
                totalQty={group.totalQty}
                promoPrice={group.promoPrice}
                items={group.items}
                childControls={childControls}
              />
            </div>
          );
        })}

        {/* Unidades fuera de promo (remainder u ítems sin par) */}
        {ungroupedPromoItems.map((uItem) => {
          const item = cartByKey.get(uItem.key);
          if (!item) return null;
          const stock = getStock(item);
          const limitedStock = stock !== null && stock > 0 && stock < item.qty;
          const atMax = stock !== null && item.qty >= stock;

          return (
            <div
              key={`${uItem.key}__rest`}
              className="cart-tab-list__row"
            >
              <LineItemRow
                imagen={item.imagen}
                variantId={item.variant_id}
                productName={item.product_name}
                color={item.color}
                size={item.size}
                quantity={uItem.qty}
                unitPrice={item.price_snapshot}
                isOffer={item.is_offer === true}
                line2={
                  <div className="cart-tab-line2">
                    <div className="cart-tab-stepper">
                      <button
                        type="button"
                        onClick={() => handleQty(item, -1)}
                        aria-label="Menos"
                        className="cart-tab-stepper__btn"
                      >
                        −
                      </button>
                      <span className="cart-tab-stepper__value">{uItem.qty}</span>
                      <button
                        type="button"
                        onClick={() => handleQty(item, +1)}
                        aria-label="Más"
                        disabled={atMax}
                        className={[
                          "cart-tab-stepper__btn",
                          "cart-tab-stepper__btn--plus",
                          atMax ? "is-max" : "",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                      >
                        +
                      </button>
                    </div>
                    <span
                      className={
                        item.is_offer ? "cart-tab-unit-price is-offer" : undefined
                      }
                    >
                      · {formatARS(item.price_snapshot)} c/u
                    </span>
                  </div>
                }
                trailing={
                  <button
                    type="button"
                    onClick={() => handleRemove(item)}
                    aria-label="Eliminar"
                    className="cart-tab-remove"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="3 6 5 6 21 6"/>
                      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                      <path d="M10 11v6M14 11v6"/>
                      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
                    </svg>
                  </button>
                }
                below={
                  limitedStock ? (
                    <span className="cart-tab-stock-pill cart-tab-stock-pill--limited">
                      {stock !== null ? formatSellableRemaining(stock) : ""}
                    </span>
                  ) : undefined
                }
              />
            </div>
          );
        })}

        {/* Sin stock: siempre fuera de promo */}
        {itemsWithStock
          .filter(({ outOfStock }) => outOfStock)
          .map(({ item }) => (
            <div
              key={`${cartItemKey(item)}__oos`}
              className="cart-tab-list__row"
            >
              <LineItemRow
                imagen={item.imagen}
                variantId={item.variant_id}
                productName={item.product_name}
                color={item.color}
                size={item.size}
                quantity={item.qty}
                unitPrice={item.price_snapshot}
                isOffer={item.is_offer === true}
                highlight="outOfStock"
                line2={
                  <span className="cart-tab-line2--oos">
                    Cant. {item.qty} · sin stock
                  </span>
                }
                trailing={
                  <button
                    type="button"
                    onClick={() => handleRemove(item)}
                    aria-label="Eliminar"
                    className="cart-tab-remove is-oos"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="3 6 5 6 21 6"/>
                      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                      <path d="M10 11v6M14 11v6"/>
                      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
                    </svg>
                  </button>
                }
                below={
                  <span className="cart-tab-stock-pill cart-tab-stock-pill--oos">
                    Sin stock
                  </span>
                }
              />
            </div>
          ))}
      </div>

      <div className="cart-tab-summary">
        <div className="cart-tab-summary__row">
          <div className="cart-tab-summary__units">
            <span className="cart-tab-summary__units-value">{totalItems}</span>
            <span className="cart-tab-summary__units-label">
              unidad{totalItems !== 1 ? "es" : ""}
            </span>
            {outOfStockCount > 0 && (
              <span className="cart-tab-summary__oos-note">
                {outOfStockCount} sin stock no incluido{outOfStockCount !== 1 ? "s" : ""}
              </span>
            )}
          </div>
          <div className="cart-tab-summary__total-block">
            <span className="cart-tab-summary__total">{formatARS(total)}</span>
          </div>
        </div>
      </div>

      {checkoutError && (
        <div className="cart-tab-error">{checkoutError}</div>
      )}

      {activeOrderStatus === "closed" && (
        <div className="cart-tab-banner cart-tab-banner--info">
          <span className="cart-tab-banner__icon cart-tab-banner__icon--sm">📋</span>
          <div className="cart-tab-banner__body">
            <div className="cart-tab-banner__title">Ya tenés un pedido en preparación</div>
            <div className="cart-tab-banner__text">
              El equipo lo está procesando.{" "}
              {onGoToOrder && (
                <button type="button" onClick={onGoToOrder} className="cart-tab-banner__link">
                  Ver pedido →
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {profileComplete === false && (
        <div className="cart-tab-banner cart-tab-banner--info" style={{ marginBottom: 10 }}>
          <span className="cart-tab-banner__icon cart-tab-banner__icon--sm">📋</span>
          <div className="cart-tab-banner__body">
            <div className="cart-tab-banner__title">Completá tu perfil</div>
            <div className="cart-tab-banner__text">
              Antes de armar tu pedido necesitamos tus datos de cuenta mayorista.
            </div>
          </div>
        </div>
      )}

      <button
        type="button"
        onClick={async () => {
          const ok = await requireProfileComplete();
          if (ok && (await assertSellableBeforeCheckout())) setShowConfirm(true);
        }}
        disabled={submitBusy}
        className={[
          "cart-tab-submit",
          submitBusy ? "is-busy" : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {isCheckingOut ? (
          "Haciendo pedido..."
        ) : (
          <>
            <svg
              className="cart-tab-submit__icon"
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.9"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M7 8h10l-1 12H8L7 8Z" />
              <path d="M10 8a2 2 0 0 1 4 0" />
              <path d="M9.5 12h5" />
              <path d="M9.5 15h4" />
            </svg>
            <span>Hacer pedido</span>
            <svg
              className="cart-tab-submit__arrow"
              width="24"
              height="20"
              viewBox="0 0 24 20"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M3.5 10h15" />
              <path d="m13.5 4.5 5.5 5.5-5.5 5.5" />
            </svg>
          </>
        )}
      </button>
      {isValidating && (
        <p className="cart-tab-submit-hint">Revisando tu carrito…</p>
      )}
      {queryFailed && !isValidating && (
        <p className="cart-tab-submit-hint">No pudimos verificar el stock.</p>
      )}
      {!isValidating && !queryFailed && stockConflictCount > 0 && (
        <p className="cart-tab-submit-hint">Ajustá los productos marcados antes de hacer el pedido.</p>
      )}

      <div className="cart-tab-clarity">
        <div className="cart-tab-clarity__title">Todavía no hiciste el pedido</div>
        <div className="cart-tab-clarity__text">
          Estos productos siguen solo en el carrito. Para hacer el pedido,
          tocá <strong>Hacer pedido</strong>.
        </div>
      </div>

      {showConfirm && (
        <div
          className="cart-confirm-backdrop"
          onClick={() => setShowConfirm(false)}
        >
          <div
            className="cart-confirm-sheet"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="cart-confirm-sheet__header">
              <div className="cart-confirm-sheet__intro">
                <div className="cart-confirm-sheet__icon">🛒</div>
                <div className="cart-confirm-sheet__title">Hacer pedido</div>
                <div className="cart-confirm-sheet__text">
                  Pasamos estos productos a <strong className="cart-confirm-sheet__strong">Mi pedido</strong>.
                  Todavía no se envía ni se paga.
                </div>
                <div className="cart-confirm-sheet__summary">
                  <span>
                    {totalItems} unidad{totalItems !== 1 ? "es" : ""}
                  </span>
                  <strong className="cart-confirm-sheet__amount">{formatARS(total)}</strong>
                </div>
              </div>
            </div>

            <div className="cart-confirm-sheet__body">
              <div className="cart-confirm-sheet__list">
                {promoGroups.map((group) => (
                  <div
                    key={group.promotionId}
                    className="cart-confirm-sheet__promo"
                  >
                    <div className="cart-confirm-sheet__row cart-confirm-sheet__row--promo">
                      <div className="cart-confirm-sheet__item">
                        <span className="cart-confirm-sheet__item-name">
                          {formatPromoTitle(group.groups, group.promoLabel)}
                        </span>
                        <span className="cart-confirm-sheet__item-qty">
                          {" "}
                          · {group.totalQty} producto
                          {group.totalQty !== 1 ? "s" : ""}
                        </span>
                      </div>
                      <div className="cart-confirm-sheet__item-price is-promo">
                        {formatARS(group.promoPrice)}
                      </div>
                    </div>
                    <div className="cart-confirm-sheet__promo-items">
                      {group.items.map((gItem) => (
                        <div
                          key={`${gItem.key}__promo`}
                          className="cart-confirm-sheet__promo-item"
                        >
                          <span>
                            <span className="cart-confirm-sheet__item-name">
                              {gItem.product_name}
                            </span>
                            {" · "}
                            {gItem.color}
                            {" · T. "}
                            {gItem.size}
                            {gItem.qty > 1 && (
                              <span className="cart-confirm-sheet__item-qty">
                                {" "}
                                ×{gItem.qty}
                              </span>
                            )}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}

                {ungroupedPromoItems.map((uItem) => {
                  const item = cartByKey.get(uItem.key);
                  const isOffer = item?.is_offer === true;
                  return (
                    <div
                      key={`${uItem.key}__rest`}
                      className="cart-confirm-sheet__row"
                    >
                      <div className="cart-confirm-sheet__item">
                        <span className="cart-confirm-sheet__item-name">
                          {uItem.product_name}
                        </span>
                        {" · "}
                        {uItem.color}
                        {" · T. "}
                        {uItem.size}
                        {isOffer ? " 🔥" : ""}
                        {uItem.qty > 1 && (
                          <span className="cart-confirm-sheet__item-qty">
                            {" "}
                            ×{uItem.qty}
                          </span>
                        )}
                      </div>
                      <div
                        className={[
                          "cart-confirm-sheet__item-price",
                          isOffer ? "is-offer" : "",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                      >
                        {formatARS(uItem.price_snapshot * uItem.qty)}
                      </div>
                    </div>
                  );
                })}
              </div>

              {checkoutError && (
                <div className="cart-confirm-sheet__error">{checkoutError}</div>
              )}
            </div>

            <div className="cart-confirm-sheet__actions">
              <button
                type="button"
                onClick={() => { setShowConfirm(false); setCheckoutError(null); }}
                className="cart-confirm-sheet__cancel"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={async () => {
                  await handleCheckout();
                  if (!useCartStore.getState().checkoutError) {
                    setShowConfirm(false);
                    onGoToOrder?.();
                  }
                }}
                disabled={isCheckingOut}
                className={[
                  "cart-confirm-sheet__ok",
                  isCheckingOut ? "is-busy" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                {isCheckingOut ? "Haciendo..." : "Sí, hacer pedido"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
