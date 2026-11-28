// admin/product-meli.js — Datos y check "Habilitar en Mercado Libre" (migraciones 385 y 387).
//
// La regla AUTORITATIVA vive en la base: public.fn_product_meli_missing_for y el trigger
// trg_products_meli_enabled_guard rechazan guardar meli_enabled = true con datos faltantes.
// Este módulo es un espejo en el cliente: evita ofrecer el check cuando la base lo va a
// rechazar y explica qué falta. Si ambos difieren, manda la base.
//
// Requisitos (solo Calzado): tabla de talles, peso, medidas del paquete, material de la
// capellada, material de la base, altura de la base y género.
//
// Marca (opcional): vacía = se publica con la marca por defecto, "FYL" por ahora (decisión del
// negocio: "Genérica" posiciona peor). El valor por defecto lo aplica el publicador, no la base.

const LABELS = {
  tabla_de_talles: "tabla de talles",
  peso: "peso",
  medidas_paquete: "medidas del paquete (alto, ancho y largo)",
  material_capellada: "material de la capellada",
  material_base: "material de la base",
  altura_base: "altura de la base",
  genero: "género",
  sku_talles: "SKU en todos los talles",
};

// Elementos del formulario que influyen en los requisitos.
const WATCHED_IDS = [
  "category",
  "size-chart",
  "dim-height",
  "dim-width",
  "dim-length",
  "dim-weight",
  "feat-capellada",
  "feat-base-material",
  "feat-base-altura",
  "meli-gender",
];

const GENDERS = ["mujer", "hombre", "ninas", "ninos"];

export function parsePositive(raw) {
  const text = String(raw ?? "").trim().replace(",", ".");
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * @param {{category:string,sizeChartId:string,weight:string,width:string,height:string,length:string,
 *          capelladaId:string,baseMaterialId:string,baseAlturaId:string,gender:string}} v valores del formulario
 * @returns {string[]} códigos que faltan (mismos que fn_product_meli_missing_for); vacío = completo
 */
export function meliMissing(v) {
  if (v.category !== "Calzado") return ["categoria_no_soportada"];
  const missing = [];
  if (!v.sizeChartId) missing.push("tabla_de_talles");
  if (parsePositive(v.weight) == null) missing.push("peso");
  if (
    parsePositive(v.width) == null ||
    parsePositive(v.height) == null ||
    parsePositive(v.length) == null
  ) {
    missing.push("medidas_paquete");
  }
  if (!v.capelladaId) missing.push("material_capellada");
  if (!v.baseMaterialId) missing.push("material_base");
  if (!v.baseAlturaId) missing.push("altura_base");
  if (!GENDERS.includes(v.gender)) missing.push("genero");
  // Los SKU de los talles solo los conoce la base (se consulta por RPC al abrir el producto).
  if (v.skuMissing) missing.push("sku_talles");
  return missing;
}

export function meliMissingText(codes) {
  return codes.map((c) => LABELS[c] || c).join(", ");
}

/** Marca normalizada para guardar: sin espacios en los bordes; vacía = null (marca por defecto). */
export function normalizeBrand(raw) {
  const t = String(raw ?? "").trim().replace(/\s+/g, " ");
  return t ? t.slice(0, 255) : null;
}

/** Traduce el error del trigger de la base; null si el error no es de este check. */
export function meliSaveErrorMessage(error) {
  const message = String(error?.message ?? "");
  const m = /MELI_REQUIREMENTS_MISSING:\s*([a-z_,]+)/.exec(message);
  if (!m) return null;
  const codes = m[1].split(",").filter(Boolean);
  if (codes.includes("categoria_no_soportada")) {
    return "Mercado Libre: por ahora solo se pueden habilitar productos de Calzado.";
  }
  return `Mercado Libre: no se puede habilitar, falta ${meliMissingText(codes)}.`;
}

/**
 * @param {{ getCategory: () => string, canEdit: () => boolean,
 *           getProductId?: () => (string|null),
 *           fetchServerMissing?: (productId: string) => Promise<string[]> }} deps
 *   getProductId: id del producto abierto (null = producto nuevo, aún sin guardar).
 *   fetchServerMissing: faltantes según la base (rpc_admin_product_meli_readiness).
 */
const DEFAULT_GENDER = "mujer";

export function createProductMeliControl({ getCategory, canEdit, getProductId, fetchServerMissing }) {
  const box = document.getElementById("meli-enabled");
  const hint = document.getElementById("meli-enabled-hint");
  const fields = document.getElementById("meli-fields");
  const genderEl = document.getElementById("meli-gender");
  const brandEl = document.getElementById("meli-brand");
  const brandFromSupplierBtn = document.getElementById("meli-brand-supplier");
  let notice = "";
  let skuMissing = false;
  // setProduct se ejecuta antes de que products.js asigne currentProductId: el control recuerda el
  // id que recibe. Permisivo a propósito: si dudamos, no se bloquea; la base valida al guardar.
  let knownProductId = null;

  const isNewProduct = () => !knownProductId && !(getProductId && getProductId());

  async function loadServerFlags(productId) {
    skuMissing = false;
    if (productId && fetchServerMissing) {
      try {
        const codes = await fetchServerMissing(productId);
        skuMissing = Array.isArray(codes) && codes.includes("sku_talles");
      } catch {
        skuMissing = false; // si falla la consulta manda la base al guardar
      }
    }
    refresh();
  }

  function val(id) {
    return document.getElementById(id)?.value ?? "";
  }

  function readValues() {
    return {
      category: getCategory(),
      sizeChartId: val("size-chart"),
      weight: val("dim-weight"),
      width: val("dim-width"),
      height: val("dim-height"),
      length: val("dim-length"),
      capelladaId: val("feat-capellada"),
      baseMaterialId: val("feat-base-material"),
      baseAlturaId: val("feat-base-altura"),
      gender: val("meli-gender"),
      skuMissing,
    };
  }

  function setHint(text, color) {
    if (!hint) return;
    hint.textContent = text;
    hint.style.color = color || "";
  }

  /**
   * @param {{autoUncheck?: boolean}} opts autoUncheck solo ante un cambio hecho por la persona:
   *   al cargar un producto no se desmarca nada (los selects pueden terminar de cargar después).
   */
  function refresh({ autoUncheck = false } = {}) {
    if (!box) return;
    const values = readValues();
    const missing = meliMissing(values);
    const complete = missing.length === 0;
    const isCalzado = values.category === "Calzado";

    if (fields) fields.style.display = isCalzado ? "" : "none";
    if (genderEl) genderEl.disabled = !canEdit();
    if (brandEl) brandEl.disabled = !canEdit();
    if (brandFromSupplierBtn) brandFromSupplierBtn.disabled = !canEdit();

    // Producto nuevo: todavía no tiene colores ni talles ni SKU, así que no se puede habilitar.
    if (isCalzado && isNewProduct()) {
      box.checked = false;
      box.disabled = true;
      setHint("Guardá primero el producto con sus colores y talles; después podés habilitarlo.", "");
      return;
    }

    if (!complete && box.checked && autoUncheck) {
      box.checked = false;
      notice = `Se desmarcó porque falta ${meliMissingText(missing)}.`;
    }
    if (complete) notice = "";

    box.disabled = !canEdit() || (!complete && !box.checked);

    if (!complete && box.checked) {
      setHint(`Atención: está habilitado pero falta ${meliMissingText(missing)}. Completalo o desmarcalo.`, "#b45309");
    } else if (!complete) {
      const base = missing[0] === "categoria_no_soportada"
        ? "Por ahora solo disponible para productos de Calzado."
        : `No se puede habilitar: falta ${meliMissingText(missing)}.`;
      setHint(notice ? `${notice} ${base}` : base, notice ? "#b45309" : "");
    } else if (box.checked) {
      setHint("Habilitado en Mercado Libre.", "#0a7a3f");
    } else {
      setHint("Cumple todos los requisitos: ya podés habilitarlo.", "");
    }
  }

  function useSupplierAsBrand() {
    const sel = document.getElementById("supplier");
    if (!sel || !sel.value) {
      alert("Elegí primero un proveedor.");
      return;
    }
    const name = sel.selectedOptions?.[0]?.textContent?.trim();
    if (name && brandEl) brandEl.value = normalizeBrand(name) ?? "";
  }

  function bind() {
    if (!box) return;
    box.addEventListener("change", () => refresh());
    brandFromSupplierBtn?.addEventListener("click", useSupplierAsBrand);
    // Cambios hechos por la persona en cualquier campo que influya en los requisitos.
    const onUserChange = (e) => {
      if (e.target && WATCHED_IDS.includes(e.target.id)) refresh({ autoUncheck: true });
    };
    document.addEventListener("input", onUserChange);
    document.addEventListener("change", onUserChange);
    // Selects que se rellenan por código (tablas de talles, opciones de características).
    if (typeof MutationObserver !== "undefined") {
      const observer = new MutationObserver(() => refresh());
      for (const id of ["size-chart", "feat-capellada", "feat-base-material", "feat-base-altura"]) {
        const el = document.getElementById(id);
        if (el) observer.observe(el, { childList: true });
      }
    }
  }

  bind();

  return {
    init: () => {
      // Producto nuevo: género Mujer por defecto (la mayoría del calzado es de mujer).
      if (genderEl && !genderEl.value && !getProductId()) genderEl.value = DEFAULT_GENDER;
      refresh();
    },
    refresh,
    setProduct(prod) {
      knownProductId = prod?.id ?? null;
      skuMissing = false;
      if (box) box.checked = !!prod?.meli_enabled;
      if (genderEl) genderEl.value = GENDERS.includes(prod?.meli_gender) ? prod.meli_gender : "";
      if (brandEl) brandEl.value = prod?.meli_brand ?? "";
      notice = "";
      refresh();
      return loadServerFlags(knownProductId);
    },
    clearSelection() {
      knownProductId = null;
      skuMissing = false;
      if (box) box.checked = false;
      if (genderEl) genderEl.value = DEFAULT_GENDER;
      if (brandEl) brandEl.value = "";
      notice = "";
      refresh();
    },
    /** Copia género y marca de otro producto. No toca el check de ML ni el id conocido. */
    copyFrom(prod) {
      if (genderEl && GENDERS.includes(prod?.meli_gender)) genderEl.value = prod.meli_gender;
      if (brandEl) brandEl.value = prod?.meli_brand ?? "";
      refresh();
    },
    prepareClone() {
      // Un clon es un producto nuevo: nace sin habilitar. Género y marca se conservan.
      knownProductId = null;
      skuMissing = false;
      if (box) box.checked = false;
      notice = "";
      refresh();
      return "";
    },
    payloadField() {
      if (!box || !canEdit()) return {};
      if (getCategory() !== "Calzado") return { meli_enabled: false };
      return {
        meli_enabled: isNewProduct() ? false : !!box.checked,
        meli_gender: GENDERS.includes(genderEl?.value) ? genderEl.value : null,
        meli_brand: normalizeBrand(brandEl?.value),
      };
    },
  };
}
