"use client";

import { useEffect, useState } from "react";
import {
  getActiveColorOffer,
  setColorOffer,
  updateVariant,
  type VariantRow as VariantRowType,
} from "@/lib/products/variants";
import SizesStockEditor from "./SizesStockEditor";
import VariantImagesEditor from "./VariantImagesEditor";
import styles from "@/app/admin/products/products-admin.module.css";

interface VariantRowProps {
  variant: VariantRowType;
  productId: string;
  category: string;
  onChanged: () => void;
  startExpanded?: boolean;
}

export default function VariantRow({ variant, productId, category, onChanged, startExpanded }: VariantRowProps) {
  const [expanded, setExpanded] = useState(!!startExpanded);
  const [price, setPrice] = useState(String(variant.price || ""));
  const [active, setActive] = useState(variant.active);
  const [onOffer, setOnOffer] = useState(false);
  const [offerPrice, setOfferPrice] = useState("");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    getActiveColorOffer(productId, variant.color).then((offer) => {
      if (offer) {
        setOnOffer(true);
        setOfferPrice(String(offer.offer_price));
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variant.id]);

  async function handleSaveBasics() {
    setSaving(true);
    setStatus(null);
    try {
      await updateVariant(variant.id, { price: parseFloat(price) || 0, active });
      await setColorOffer(productId, variant.color, onOffer, onOffer ? parseFloat(offerPrice) || null : null);
      setStatus("Guardado.");
      onChanged();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Error guardando");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className={styles.variantCard}>
      <div className={styles.variantHead}>
        <span className={styles.variantColor}>{variant.color}</span>
        <span className={styles.variantSku}>{variant.sku}</span>

        <div className={styles.variantPriceField}>
          <label htmlFor={`vprice-${variant.id}`}>Precio</label>
          <input
            id={`vprice-${variant.id}`}
            type="number"
            min={0}
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="0"
          />
        </div>

        <label className={styles.checkboxLabel}>
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Activa (visible en catálogo)
        </label>

        <span className={styles.variantStat}>Stock: {variant.stockTotal}</span>
        <span className={styles.variantStat}>Imágenes: {variant.imageCount}</span>

        <button
          type="button"
          className={styles.btnAccent}
          onClick={handleSaveBasics}
          disabled={saving}
          style={{ marginLeft: "auto" }}
        >
          {saving ? "..." : "Guardar"}
        </button>
        {status && <span style={{ fontSize: 11, color: "var(--accent)" }}>{status}</span>}
      </div>

      <div className={`${styles.offerBox} ${onOffer ? styles.offerBoxActive : ""}`}>
        <label className={styles.checkboxLabel} style={{ fontWeight: 600 }}>
          <input type="checkbox" checked={onOffer} onChange={(e) => setOnOffer(e.target.checked)} />
          En oferta
        </label>
        {onOffer && (
          <div className={styles.variantPriceField}>
            <label htmlFor={`voffer-${variant.id}`}>Precio de oferta</label>
            <input
              id={`voffer-${variant.id}`}
              type="number"
              min={0}
              value={offerPrice}
              onChange={(e) => setOfferPrice(e.target.value)}
              placeholder="0"
            />
          </div>
        )}
        {onOffer && (
          <span className={styles.offerNote}>
            Este es el precio que se ve en el catálogo mientras la oferta esté activa — el precio de venta normal
            queda guardado para cuando se desactive.
          </span>
        )}
      </div>

      <button type="button" className={styles.expandToggle} onClick={() => setExpanded((v) => !v)}>
        {expanded ? "Ocultar talles e imágenes ▲" : "Talles, stock e imágenes ▾"}
      </button>

      {expanded && (
        <div className={styles.variantExpanded}>
          <div>
            <div className={styles.miniLabel}>Talles y stock</div>
            <SizesStockEditor variantId={variant.id} skuBase={variant.sku} />
          </div>
          <div>
            <div className={styles.miniLabel}>Imágenes</div>
            <VariantImagesEditor
              variantId={variant.id}
              category={category}
              skuBase={variant.sku}
              color={variant.color}
            />
          </div>
        </div>
      )}
    </div>
  );
}
