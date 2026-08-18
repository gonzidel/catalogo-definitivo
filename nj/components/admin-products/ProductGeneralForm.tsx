"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  createProduct,
  createSupplier,
  updateProductGeneral,
  updateSupplierCode,
  type SupplierRow,
} from "@/lib/products/actions";
import {
  applyRopaPrefixOnBlur,
  slugify,
  stripRopaPrefixIfNotRopa,
} from "@/lib/products/naming";
import { calculateRecommendedPrice, estimateCostFromPrice } from "@/lib/products/pricing";
import styles from "@/app/admin/products/products-admin.module.css";

type Category = "Calzado" | "Ropa" | "Otros";

interface PricingDefaults {
  percentage: number;
  logistic_amount: number;
}

interface InitialProduct {
  name: string;
  handle: string;
  category: Category;
  status: string;
  description: string;
  supplierId: string | null;
  cost: number | null;
  costIsEstimated: boolean;
  pricePercentage: number | null;
  logisticAmount: number | null;
}

interface ProductGeneralFormProps {
  mode: "new" | "edit";
  productId?: string;
  canViewCost: boolean;
  suppliers: SupplierRow[];
  defaultPricing: Record<Category, PricingDefaults>;
  initial?: InitialProduct;
}

const STATUS_OPTIONS = [
  { value: "active", label: "Activo" },
  { value: "draft", label: "Borrador" },
  { value: "pending_stock", label: "Completar stock" },
  { value: "missing_tags", label: "Completar tags" },
  { value: "archived", label: "Archivado" },
];

const CATEGORIES: { value: Category; pillClass: string }[] = [
  { value: "Calzado", pillClass: "catPillCalzado" },
  { value: "Ropa", pillClass: "catPillRopa" },
  { value: "Otros", pillClass: "catPillOtros" },
];

export default function ProductGeneralForm({
  mode,
  productId,
  canViewCost,
  suppliers,
  defaultPricing,
  initial,
}: ProductGeneralFormProps) {
  const router = useRouter();
  const [name, setName] = useState(initial?.name ?? "");
  const [handle, setHandle] = useState(initial?.handle ?? "");
  const [category, setCategory] = useState<Category>(initial?.category ?? "Calzado");
  const [status, setStatus] = useState(initial?.status ?? "pending_stock");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [supplierId, setSupplierId] = useState(initial?.supplierId ?? "");
  const [supplierList, setSupplierList] = useState(suppliers);

  const [pricePercentage, setPricePercentage] = useState<string>(
    initial?.pricePercentage != null ? String(initial.pricePercentage) : String(defaultPricing[category].percentage)
  );
  const [logisticAmount, setLogisticAmount] = useState<string>(
    initial?.logisticAmount != null ? String(initial.logisticAmount) : String(defaultPricing[category].logistic_amount)
  );

  const [cost, setCost] = useState<string>(initial?.cost != null ? String(initial.cost) : "");
  const [costIsEstimated, setCostIsEstimated] = useState(initial?.costIsEstimated ?? false);
  const [salePrice, setSalePrice] = useState<string>(() => {
    if (initial?.cost != null) {
      const p = initial.pricePercentage ?? defaultPricing[initial.category].percentage;
      const l = initial.logisticAmount ?? defaultPricing[initial.category].logistic_amount;
      const computed = calculateRecommendedPrice(initial.cost, p, l);
      return computed > 0 ? String(computed) : "";
    }
    return "";
  });

  const handleDirty = useRef(mode === "edit");
  const percentageDirty = useRef(initial?.pricePercentage != null);
  const logisticDirty = useRef(initial?.logisticAmount != null);

  const [showNewSupplier, setShowNewSupplier] = useState(false);
  const [newSupplierName, setNewSupplierName] = useState("");
  const [newSupplierCode, setNewSupplierCode] = useState("");
  const [showEditSupplier, setShowEditSupplier] = useState(false);
  const [editSupplierCode, setEditSupplierCode] = useState("");

  const [advancedOpen, setAdvancedOpen] = useState(false);
  const advancedRef = useRef<HTMLDivElement>(null);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (advancedRef.current && !advancedRef.current.contains(e.target as Node)) {
        setAdvancedOpen(false);
      }
    }
    if (advancedOpen) document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [advancedOpen]);

  const currentSupplier = useMemo(
    () => supplierList.find((s) => s.id === supplierId) ?? null,
    [supplierList, supplierId]
  );

  function handleNameChange(value: string) {
    const upper = value.toUpperCase();
    setName(upper);
    if (!handleDirty.current) setHandle(slugify(upper));
  }

  function handleNameBlur() {
    const withPrefix = applyRopaPrefixOnBlur(name, category);
    if (withPrefix !== name) {
      setName(withPrefix);
      if (!handleDirty.current) setHandle(slugify(withPrefix));
    }
  }

  function handleCategoryChange(next: Category) {
    setCategory(next);
    const strippedName = stripRopaPrefixIfNotRopa(name, next);
    if (strippedName !== name) {
      setName(strippedName);
      if (!handleDirty.current) setHandle(slugify(strippedName));
    }
    if (!percentageDirty.current) setPricePercentage(String(defaultPricing[next].percentage));
    if (!logisticDirty.current) setLogisticAmount(String(defaultPricing[next].logistic_amount));
  }

  function handleCostChange(value: string) {
    setCost(value);
    setCostIsEstimated(false);
    const c = parseFloat(value);
    if (!isNaN(c) && c > 0) {
      const p = parseFloat(pricePercentage || "0");
      const l = parseFloat(logisticAmount || "0");
      const computed = calculateRecommendedPrice(c, p, l);
      setSalePrice(computed > 0 ? String(computed) : "");
    } else {
      setSalePrice("");
    }
  }

  function handleSalePriceChange(value: string) {
    setSalePrice(value);
    const price = parseFloat(value);
    if (!isNaN(price) && price > 0) {
      const p = parseFloat(pricePercentage || "0");
      const l = parseFloat(logisticAmount || "0");
      const estimated = estimateCostFromPrice(price, p, l);
      setCost(estimated > 0 ? String(estimated) : "");
      setCostIsEstimated(true);
    } else {
      setCost("");
      setCostIsEstimated(false);
    }
  }

  async function handleCreateSupplier() {
    if (!newSupplierName.trim()) return;
    try {
      const created = await createSupplier(newSupplierName, newSupplierCode);
      setSupplierList((prev) => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
      setSupplierId(created.id);
      setShowNewSupplier(false);
      setNewSupplierName("");
      setNewSupplierCode("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error creando proveedor");
    }
  }

  async function handleSaveSupplierCode() {
    if (!currentSupplier) return;
    try {
      await updateSupplierCode(currentSupplier.id, editSupplierCode);
      setSupplierList((prev) =>
        prev.map((s) => (s.id === currentSupplier.id ? { ...s, code: editSupplierCode.trim() } : s))
      );
      setShowEditSupplier(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error actualizando código de proveedor");
    }
  }

  async function handleSubmit() {
    setSaving(true);
    setError(null);
    try {
      const payload = {
        name: name.trim(),
        handle: handle.trim(),
        category,
        status,
        description,
        supplierId: supplierId || null,
        cost: cost ? parseFloat(cost) : null,
        costIsEstimated,
        pricePercentage: pricePercentage ? parseFloat(pricePercentage) : null,
        logisticAmount: logisticAmount ? parseFloat(logisticAmount) : null,
      };

      if (mode === "new") {
        const { id } = await createProduct(payload);
        router.push(`/admin/products/${id}`);
      } else if (productId) {
        await updateProductGeneral(productId, payload);
        router.refresh();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error guardando producto");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      {error && <div className={styles.errorBanner}>{error}</div>}

      <div className={styles.docHeader}>
        <div className={styles.metaRow}>
          {CATEGORIES.map((c) => (
            <button
              key={c.value}
              type="button"
              className={`${styles.catPill} ${styles[c.pillClass]} ${
                category === c.value ? styles.catPillActive : styles.catPillInactive
              }`}
              onClick={() => handleCategoryChange(c.value)}
            >
              {c.value}
            </button>
          ))}

          <select className={styles.statusSelect} value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUS_OPTIONS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        </div>

        <input
          className={styles.titleInput}
          value={name}
          onChange={(e) => handleNameChange(e.target.value)}
          onBlur={handleNameBlur}
          placeholder="Escribí el nombre del producto..."
          autoComplete="off"
          autoFocus={mode === "new"}
        />

        <div className={styles.slugRow}>
          /
          <input
            className={styles.slugInput}
            value={handle}
            onChange={(e) => {
              handleDirty.current = true;
              setHandle(e.target.value);
            }}
            placeholder="handle-del-producto"
            autoComplete="off"
          />
        </div>
      </div>

      <div className={styles.bodyField}>
        <label htmlFor="pf-description">Descripción</label>
        <textarea
          id="pf-description"
          className={styles.descriptionInput}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="¿Qué es y qué lo distingue?"
          rows={2}
        />
      </div>

      <div className={styles.bodyField}>
        <label>Proveedor</label>
        <div className={styles.supplierRow}>
          <select className={styles.selectLike} value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
            <option value="">Sin proveedor</option>
            {supplierList.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          {currentSupplier && (
            <button
              type="button"
              className={styles.ghostBtn}
              onClick={() => {
                setEditSupplierCode(currentSupplier.code || "");
                setShowEditSupplier((v) => !v);
              }}
            >
              Editar
            </button>
          )}
          <button type="button" className={styles.ghostBtn} onClick={() => setShowNewSupplier((v) => !v)}>
            + Nuevo
          </button>
        </div>

        {showNewSupplier && (
          <div className={styles.inlineForm}>
            <input placeholder="Nombre del proveedor" value={newSupplierName} onChange={(e) => setNewSupplierName(e.target.value)} />
            <input placeholder="Código (opcional)" value={newSupplierCode} onChange={(e) => setNewSupplierCode(e.target.value)} />
            <button type="button" className={styles.ghostBtn} onClick={handleCreateSupplier}>
              Crear
            </button>
            <button type="button" className={styles.ghostBtn} onClick={() => setShowNewSupplier(false)}>
              Cancelar
            </button>
          </div>
        )}

        {showEditSupplier && currentSupplier && (
          <div className={styles.inlineForm}>
            <input placeholder="Código" value={editSupplierCode} onChange={(e) => setEditSupplierCode(e.target.value)} />
            <button type="button" className={styles.ghostBtn} onClick={handleSaveSupplierCode}>
              Guardar
            </button>
            <button type="button" className={styles.ghostBtn} onClick={() => setShowEditSupplier(false)}>
              Cancelar
            </button>
          </div>
        )}
      </div>

      {canViewCost && (
        <div className={styles.bodyField} style={{ position: "relative" }} ref={advancedRef}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <label style={{ marginBottom: 0 }}>Costo y precio de venta</label>
            <button type="button" className={styles.advancedTrigger} style={{ position: "static" }} onClick={() => setAdvancedOpen((v) => !v)}>
              % y logístico ⚙
            </button>
            {advancedOpen && (
              <div className={styles.advancedPanel}>
                <h4>Configuración de precio</h4>
                <p className="hint">
                  Raramente hace falta tocar esto — ya vienen del default de la categoría.
                </p>
                <div className={styles.advancedField}>
                  <label htmlFor="pf-percentage">Porcentaje de ganancia (%)</label>
                  <input
                    id="pf-percentage"
                    type="number"
                    min={0}
                    max={100}
                    step={0.1}
                    value={pricePercentage}
                    onChange={(e) => {
                      percentageDirty.current = true;
                      setPricePercentage(e.target.value);
                    }}
                  />
                </div>
                <div className={styles.advancedField}>
                  <label htmlFor="pf-logistic">Monto logístico ($)</label>
                  <input
                    id="pf-logistic"
                    type="number"
                    min={0}
                    value={logisticAmount}
                    onChange={(e) => {
                      logisticDirty.current = true;
                      setLogisticAmount(e.target.value);
                    }}
                  />
                </div>
              </div>
            )}
          </div>

          <div className={styles.priceRow} style={{ marginTop: 10 }}>
            <div className={styles.priceField}>
              <label htmlFor="pf-cost">Costo</label>
              <div className={styles.priceInputWrap}>
                <span>$</span>
                <input
                  id="pf-cost"
                  className={styles.priceInput}
                  type="number"
                  min={0}
                  value={cost}
                  onChange={(e) => handleCostChange(e.target.value)}
                  placeholder="0"
                />
              </div>
              {costIsEstimated && cost && (
                <div className={styles.estimatedNote}>Estimado a partir del precio de venta</div>
              )}
            </div>

            <span className={styles.priceLinkIcon}>=</span>

            <div className={styles.priceField}>
              <label htmlFor="pf-sale-price">Precio de venta</label>
              <div className={styles.priceInputWrap}>
                <span>$</span>
                <input
                  id="pf-sale-price"
                  className={styles.priceInput}
                  type="number"
                  min={0}
                  value={salePrice}
                  onChange={(e) => handleSalePriceChange(e.target.value)}
                  placeholder="0"
                />
              </div>
              {!costIsEstimated && cost && (
                <div className={styles.estimatedNote} style={{ color: "var(--ink-faint)" }}>
                  Calculado desde el costo
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <div className={styles.submitRow}>
        <button type="button" className={styles.submitBtn} disabled={saving} onClick={handleSubmit}>
          {saving ? "Guardando..." : mode === "new" ? "Crear producto" : "Guardar cambios"}
        </button>
        {mode === "new" && (
          <span style={{ fontSize: 12, color: "var(--ink-faint)" }}>
            Colores, talles y precio por variante se cargan después.
          </span>
        )}
      </div>
    </div>
  );
}
