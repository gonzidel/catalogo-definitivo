"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatSignedPriceAr, isReturnOrderItem, isSpecialExtraItem } from "@/lib/orders/domain";
import {
  catalogPriceGuardMessage,
  resolveSkuOrQrToOrderItem,
  searchProductsGroupedByPrefix,
  type OrderEditDraftItem,
  type ProductSearchGroup,
  type ProductSearchVariant,
} from "@/lib/supabase/order-edit";
import { loadWarehouses } from "@/lib/supabase/order-queries";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { normalizeSize } from "@/lib/utils/size-normalizer";
import { useOrdersStore } from "@/hooks/useOrders";

const QR_MIN_DIGITS = 6;
const SEARCH_DEBOUNCE_MS = 300;

interface OrderEditProductPickerProps {
  draft: OrderEditDraftItem[];
  onDraftChange: (items: OrderEditDraftItem[]) => void;
  onAddToDraft: (item: OrderEditDraftItem) => void;
  disabled?: boolean;
  /** Solo Retiro: precios negativos + sin descontar stock (como public-sales). */
  returnMode?: boolean;
  onReturnModeChange?: (enabled: boolean) => void;
  showReturnModeToggle?: boolean;
}

type ManualStep = "search" | "products" | "colors" | "sizes";

function manualPendingKey(variantId: string, size: string) {
  return `${variantId}|${normalizeSize(size)}`;
}

function hasValidPrice(price: unknown): boolean {
  const n = Number(price);
  return Number.isFinite(n) && n > 0;
}

function isCompleteQr(value: string) {
  const v = String(value || "").trim();
  return /^\d+$/.test(v) && v.length >= QR_MIN_DIGITS;
}

export default function OrderEditProductPicker({
  draft,
  onDraftChange,
  onAddToDraft,
  disabled = false,
  returnMode = false,
  onReturnModeChange,
  showReturnModeToggle = false,
}: OrderEditProductPickerProps) {
  const showToast = useOrdersStore((s) => s.showToast);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const manualSearchGenerationRef = useRef(0);
  const qrQueueRef = useRef<string[]>([]);
  const qrProcessingRef = useRef(false);
  const pendingProductIdRef = useRef<string | null>(null);
  const manualStepRef = useRef<ManualStep>("search");

  const [inputValue, setInputValue] = useState("");
  const [manualMode, setManualMode] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [manualStep, setManualStep] = useState<ManualStep>("search");
  const [products, setProducts] = useState<ProductSearchGroup[]>([]);
  const [selectedProduct, setSelectedProduct] = useState<ProductSearchGroup | null>(null);
  const [selectedVariant, setSelectedVariant] = useState<ProductSearchVariant | null>(null);
  const [manualPending, setManualPending] = useState<Map<string, OrderEditDraftItem>>(new Map());

  const setStep = useCallback((step: ManualStep) => {
    manualStepRef.current = step;
    setManualStep(step);
  }, []);

  const resetManualPicker = useCallback(() => {
    setPickerOpen(false);
    setStep("search");
    setProducts([]);
    setSelectedProduct(null);
    setSelectedVariant(null);
    setManualPending(new Map());
    pendingProductIdRef.current = null;
  }, [setStep]);

  const focusInput = useCallback(() => {
    setTimeout(() => inputRef.current?.focus(), 30);
  }, []);

  useEffect(() => {
    focusInput();
  }, [focusInput]);

  useEffect(() => {
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
      qrQueueRef.current = [];
      qrProcessingRef.current = false;
      manualSearchGenerationRef.current += 1;
    };
  }, []);

  const getManualPendingTotalQty = () => {
    let n = 0;
    for (const row of manualPending.values()) n += Number(row.quantity) || 0;
    return n;
  };

  const getVariantPendingQty = (variantId: string) => {
    let n = 0;
    for (const row of manualPending.values()) {
      if (row.variant_id === variantId) n += Number(row.quantity) || 0;
    }
    return n;
  };

  const decrementManualPending = (key: string) => {
    setManualPending((prev) => {
      const current = prev.get(key);
      if (!current) return prev;
      const nextQty = (Number(current.quantity) || 0) - 1;
      const next = new Map(prev);
      if (nextQty <= 0) next.delete(key);
      else next.set(key, { ...current, quantity: nextQty });
      return next;
    });
  };

  const clearManualPending = () => {
    if (getManualPendingTotalQty() === 0) return;
    setManualPending(new Map());
    pendingProductIdRef.current = null;
    showToast("Selección manual limpiada", "info");
  };

  const flushManualPendingToDraft = () => {
    const qty = getManualPendingTotalQty();
    if (qty === 0) return;
    for (const item of manualPending.values()) {
      onAddToDraft({ ...item });
    }
    showToast(`${qty} unidad(es) agregadas al listado`, "success");
    resetManualPicker();
    setInputValue("");
    focusInput();
  };

  const processQrQueue = useCallback(async () => {
    if (!qrQueueRef.current.length) {
      qrProcessingRef.current = false;
      return;
    }
    qrProcessingRef.current = true;
    const code = qrQueueRef.current.shift() || "";
    try {
      const supabase = getSupabaseBrowserClient();
      const warehouseIds = await loadWarehouses(supabase);
      const item = await resolveSkuOrQrToOrderItem(
        supabase,
        code,
        warehouseIds,
        1,
        returnMode
      );
      onAddToDraft(item);
      if (item.product_name) {
        showToast(
          returnMode ? `Devolución: ${item.product_name}` : `+ ${item.product_name}`,
          "success"
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Error al escanear";
      showToast(message, "error");
    } finally {
      focusInput();
      setTimeout(() => {
        void processQrQueue();
      }, 0);
    }
  }, [focusInput, onAddToDraft, returnMode, showToast]);

  const enqueueQr = useCallback(
    (code: string) => {
      setInputValue("");
      qrQueueRef.current.push(code);
      if (!qrProcessingRef.current) void processQrQueue();
      focusInput();
    },
    [focusInput, processQrQueue]
  );

  const addScannedItem = (code: string) => {
    const trimmed = code.trim();
    if (!trimmed || disabled) return;
    if (isCompleteQr(trimmed)) {
      enqueueQr(trimmed);
      return;
    }
    // SKU alfanumérico (Enter): misma cola serial que QR.
    enqueueQr(trimmed);
  };

  const runManualSearch = async (query: string) => {
    const val = query.trim();
    if (val.length < 2) {
      resetManualPicker();
      return;
    }
    const gen = ++manualSearchGenerationRef.current;
    try {
      const supabase = getSupabaseBrowserClient();
      const results = await searchProductsGroupedByPrefix(supabase, val);
      if (gen !== manualSearchGenerationRef.current) return;
      if ((inputRef.current?.value || "").trim() !== val) return;
      // No pisar colores/talles si el admin ya eligió un producto.
      if (manualStepRef.current === "colors" || manualStepRef.current === "sizes") return;
      setProducts(results);
      setStep("products");
      setSelectedProduct(null);
      setSelectedVariant(null);
      setPickerOpen(true);
    } catch {
      if (gen !== manualSearchGenerationRef.current) return;
      setProducts([]);
      setPickerOpen(true);
      showToast("Error buscando productos", "error");
    }
  };

  const handleInputChange = (value: string) => {
    setInputValue(value);
    if (disabled) return;

    if (!manualMode) {
      if (isCompleteQr(value)) {
        enqueueQr(value.trim());
      }
      return;
    }

    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    // Al tipear de nuevo desde colores/talles, volver a búsqueda (como PAU).
    if (manualStepRef.current === "colors" || manualStepRef.current === "sizes") {
      setStep("search");
      setSelectedProduct(null);
      setSelectedVariant(null);
    }
    searchTimerRef.current = setTimeout(() => void runManualSearch(value), SEARCH_DEBOUNCE_MS);
  };

  const toggleManualMode = () => {
    const next = !manualMode;
    setManualMode(next);
    resetManualPicker();
    setInputValue("");
    focusInput();
  };

  const selectProduct = (p: ProductSearchGroup) => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    manualSearchGenerationRef.current += 1;
    setManualPending((prev) => {
      if (
        pendingProductIdRef.current &&
        pendingProductIdRef.current !== p.product_id &&
        prev.size > 0
      ) {
        return new Map();
      }
      return prev;
    });
    pendingProductIdRef.current = p.product_id;
    setSelectedProduct(p);
    setSelectedVariant(null);
    setStep("colors");
  };

  const manualGoBack = () => {
    if (manualStep === "sizes") {
      setStep("colors");
      setSelectedVariant(null);
      return;
    }
    if (manualStep === "colors") {
      setStep("products");
      setSelectedProduct(null);
    }
  };

  const addSizePending = (sizeRow: { size: string; sku: string | null }) => {
    if (!selectedProduct || !selectedVariant) return;
    if (!hasValidPrice(selectedVariant.price_snapshot)) {
      showToast(catalogPriceGuardMessage(selectedProduct.product_name), "error");
      return;
    }
    const unit = Math.abs(Number(selectedVariant.price_snapshot));
    const key = manualPendingKey(selectedVariant.variant_id, sizeRow.size);
    setManualPending((prev) => {
      const qty = prev.get(key)?.quantity || 0;
      const next = new Map(prev);
      next.set(key, {
        product_name: selectedProduct.product_name,
        color: selectedVariant.color,
        size: normalizeSize(sizeRow.size),
        price_snapshot: returnMode ? -unit : unit,
        variant_id: selectedVariant.variant_id,
        quantity: qty + 1,
        status: "picked",
        admin_confirmed_missing: false,
        qty_from_general: returnMode ? 0 : undefined,
        qty_from_venta: returnMode ? 0 : undefined,
      });
      return next;
    });
  };

  useEffect(() => {
    // Al cambiar modo venta/devolución, no mezclar picks con signo incorrecto.
    setManualPending((prev) => (prev.size === 0 ? prev : new Map()));
  }, [returnMode]);

  useEffect(() => {
    if (!showReturnModeToggle || !onReturnModeChange) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "F2") return;
      e.preventDefault();
      onReturnModeChange(!returnMode);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onReturnModeChange, returnMode, showReturnModeToggle]);

  const manualPendingQty = getManualPendingTotalQty();
  const draftQty = draft.reduce((n, i) => n + (Number(i.quantity) || 0), 0);

  return (
    <div className={`order-edit-picker${returnMode ? " order-edit-picker--return" : ""}`}>
      {showReturnModeToggle ? (
        <div className="order-edit-picker__return-toggle">
          <label className="order-edit-picker__return-label">
            <input
              type="checkbox"
              checked={returnMode}
              disabled={disabled}
              onChange={(e) => onReturnModeChange?.(e.target.checked)}
            />
            <strong>Modo Devoluciones</strong>
            <span className="order-edit-picker__return-hint">F2</span>
          </label>
          {returnMode ? (
            <div className="order-edit-picker__return-banner" role="status">
              ⚠️ Modo Devoluciones — usá <strong>Imprimir</strong> (no Guardar). Al cobrar:
              devoluciones suman stock y productos nuevos descuentan.
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="order-edit-picker__scan-row">
        <input
          ref={inputRef}
          type="text"
          className="order-edit-picker__input"
          autoComplete="off"
          disabled={disabled}
          placeholder={
            manualMode
              ? "Buscar producto por nombre…"
              : returnMode
                ? "Escanear devolución QR / SKU…"
                : "Escanear QR / SKU…"
          }
          value={inputValue}
          onChange={(e) => handleInputChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || manualMode) return;
            e.preventDefault();
            const code = inputValue.trim();
            if (code) addScannedItem(code);
          }}
        />
        <button
          type="button"
          className={`order-edit-picker__manual-btn${manualMode ? " is-active" : ""}`}
          disabled={disabled}
          onClick={toggleManualMode}
        >
          Manual
        </button>
      </div>

      {pickerOpen ? (
        <div className="order-edit-picker__picker">
          {(manualStep === "colors" || manualStep === "sizes") && (
            <div className="order-edit-picker__picker-head">
              <button type="button" className="order-edit-picker__back" onClick={manualGoBack}>
                ← Volver
              </button>
              <span className="order-edit-picker__step-label">
                {manualStep === "colors"
                  ? selectedProduct?.product_name
                  : `${selectedProduct?.product_name} · ${selectedVariant?.color}`}
              </span>
            </div>
          )}

          <div
            className={`order-edit-picker__choices${
              (manualStep === "products"
                ? products.length
                : manualStep === "colors"
                  ? selectedProduct?.variants.length ?? 0
                  : selectedVariant?.sizes.length ?? 0) > 12
                ? " is-scrollable"
                : ""
            }`}
          >
            {manualStep === "products" &&
              (products.length === 0 ? (
                <p className="order-edit-picker__hint">Sin coincidencias</p>
              ) : (
                products.map((p) => (
                  <button
                    key={p.product_id}
                    type="button"
                    className="order-edit-picker__choice"
                    onClick={() => selectProduct(p)}
                  >
                    {p.product_name}
                  </button>
                ))
              ))}

            {manualStep === "colors" &&
              selectedProduct?.variants.map((v) => {
                const qty = getVariantPendingQty(v.variant_id);
                return (
                  <button
                    key={v.variant_id}
                    type="button"
                    className={`order-edit-picker__choice${qty > 0 ? " is-selected" : ""}`}
                    onClick={() => {
                      setSelectedVariant(v);
                      setStep("sizes");
                    }}
                  >
                    {v.color}
                    {qty > 0 ? <span className="order-edit-picker__choice-badge">{qty}</span> : null}
                  </button>
                );
              })}

            {manualStep === "sizes" &&
              selectedProduct &&
              selectedVariant?.sizes.map((s) => {
                const key = manualPendingKey(selectedVariant.variant_id, s.size);
                const pending = manualPending.get(key);
                const qty = pending?.quantity || 0;
                return (
                  <div key={key} className="order-edit-picker__choice-wrap">
                    <button
                      type="button"
                      className={`order-edit-picker__choice${qty > 0 ? " is-selected" : ""}`}
                      onClick={() => addSizePending(s)}
                    >
                      {s.size}
                      {qty > 0 ? <span className="order-edit-picker__choice-badge">{qty}</span> : null}
                    </button>
                    {qty > 0 ? (
                      <button
                        type="button"
                        className="order-edit-picker__choice-decrement"
                        aria-label={`Quitar una unidad de talle ${s.size}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          decrementManualPending(key);
                        }}
                      >
                        −
                      </button>
                    ) : null}
                  </div>
                );
              })}
          </div>

          {manualPendingQty > 0 ? (
            <div className="order-edit-picker__manual-actions">
              <button
                type="button"
                className="order-card__btn order-edit-picker__clear-picks"
                disabled={disabled}
                onClick={clearManualPending}
              >
                Limpiar selección
              </button>
              <button
                type="button"
                className="order-card__btn order-card__btn--primary order-edit-picker__add-picks"
                disabled={disabled}
                onClick={flushManualPendingToDraft}
              >
                Agregar ({manualPendingQty})
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      <section className="order-edit-picker__draft">
        <div className="order-edit-picker__draft-head">
          <h4 className="order-edit-modal__section-title">Por agregar al pedido</h4>
          <span className="order-edit-picker__draft-count">{draftQty} u.</span>
        </div>
        {draft.length === 0 ? (
          <p className="order-edit-picker__hint">
            Los productos escaneados o buscados aparecen acá. Se guardan al pedido con Guardar.
          </p>
        ) : (
          <ul className="order-edit-picker__draft-list">
            {draft.map((item, idx) => {
              const special = isSpecialExtraItem(item);
              const isReturn = !special && isReturnOrderItem(item);
              return (
                <li
                  key={`${item.variant_id || "special"}-${item.size}-${idx}-${isReturn ? "r" : "s"}`}
                  className={`order-edit-picker__draft-row${special ? " order-edit-picker__draft-row--special" : ""}${isReturn ? " order-edit-picker__draft-row--return" : ""}`}
                >
                  <div className="order-edit-picker__draft-main">
                    <strong>
                      {special
                        ? `${Number(item.price_snapshot) < 0 ? "➖ Resta" : "➕ Extra"}: ${item.product_name}`
                        : isReturn
                          ? `[DEV] ${item.product_name}`
                          : item.product_name}
                    </strong>
                    {!special ? (
                      <span>
                        {item.color || "-"} · Talle {item.size} · x{item.quantity}
                      </span>
                    ) : (
                      <span>{formatSignedPriceAr(Number(item.price_snapshot) || 0)}</span>
                    )}
                  </div>
                  <div className="order-edit-picker__draft-meta">
                    {!special ? (
                      <span className={isReturn ? "is-return-price" : undefined}>
                        {formatSignedPriceAr(Number(item.price_snapshot) || 0)}
                      </span>
                    ) : null}
                    <button
                      type="button"
                      className="order-edit-modal__remove order-edit-modal__remove--icon"
                      disabled={disabled}
                      onClick={() => onDraftChange(draft.filter((_, i) => i !== idx))}
                    >
                      ✕
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
