import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { test } from "node:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ColorDetail, GroupedProduct } from "@/types/catalog";
import {
  loadPdpProductBase,
  PUBLIC_PRODUCT_FALLBACK_SELECT,
  stubFromProductsTable,
} from "@/lib/pdp/load-product-base";
import {
  PUBLIC_PRODUCT_SEARCH_SELECT,
  searchProductsIncludingOutOfStock,
} from "@/lib/utils/catalog-variant-enrich";
import { formatARS } from "@/lib/utils/catalog";
import { getColorEffectivePrice } from "@/lib/utils/variant-price";
import { calculateRecommendedPrice } from "@/lib/products/pricing";

const SENSITIVE_COLUMNS = /\b(cost|cost_is_estimated|price_percentage|logistic_amount)\b/;

interface RecordedCall {
  table: string;
  select?: string;
}

/** Cliente falso: devuelve filas fijas por tabla y registra los `select` pedidos. */
function mockSupabase(tables: Record<string, unknown[]>) {
  const calls: RecordedCall[] = [];
  const client = {
    from(table: string) {
      const call: RecordedCall = { table };
      calls.push(call);
      const rows = tables[table] ?? [];
      const builder: Record<string, unknown> = {};
      for (const method of ["eq", "in", "or", "limit", "order", "ilike"]) {
        builder[method] = () => builder;
      }
      builder.select = (columns: string) => {
        call.select = columns;
        return builder;
      };
      builder.maybeSingle = async () => ({ data: rows[0] ?? null, error: null });
      builder.then = (
        resolve: (v: { data: unknown[]; error: null }) => unknown,
        reject: (e: unknown) => unknown
      ) => Promise.resolve({ data: rows, error: null }).then(resolve, reject);
      return builder;
    },
  };
  return { client: client as unknown as SupabaseClient, calls };
}

/** Fila de `products` tal como la devolvería hoy la base si se pidieran costos. */
const PRODUCT_ROW_WITH_COST = {
  name: "ART-TEST",
  description: "Zapatilla de prueba",
  category: "Calzado",
  status: "active",
  cost: 10_000,
  price_percentage: 30,
  logistic_amount: 500,
};

const COST_DERIVED_PRICE = calculateRecommendedPrice(10_000, 30, 500);

function variantRow(price: number | null) {
  return {
    id: "v1",
    color: "Negro",
    sku: "ART-TEST-NEG",
    price,
    products: { name: "ART-TEST" },
  };
}

const VARIANT_IMAGE = { variant_id: "v1", url: "https://img.test/v1.jpg", position: 0 };

/** Precio visible en card (`ProductCard.renderPrice`, sin oferta ni promo). */
function cardDisplayPrice(product: GroupedProduct, color: ColorDetail | null): string {
  const pricing = getColorEffectivePrice(color, product);
  return formatARS(pricing.normalPrice) || formatARS(product.Precio);
}

/** Precio visible en PDP (`PdpInteractive` / `PdpRecommended`). */
function pdpDisplayPrice(product: GroupedProduct, color: ColorDetail | null): string {
  const pricing = getColorEffectivePrice(color, product);
  return formatARS(pricing.normalPrice || product.Precio);
}

function colorWithPrice(precio: ColorDetail["Precio"]): ColorDetail {
  return {
    color: "Negro",
    hex_color: null,
    ColorDisplayNumber: null,
    talles: [],
    images: ["https://img.test/v1.jpg"],
    Precio: precio,
    OfertaActiva: false,
    PrecioOferta: "",
    PromoActiva: "",
  };
}

function productWithFallback(precio: GroupedProduct["Precio"], color: ColorDetail): GroupedProduct {
  return {
    Articulo: "ART-TEST",
    Descripcion: "",
    Precio: precio,
    VariantePrincipal: null,
    Oferta: "",
    FechaIngreso: "",
    FechaPublicacion: "",
    Categoria: "Calzado",
    Filtro1: "",
    Filtro2: "",
    Filtro3: "",
    DetallesSimilitud: "",
    OfertaActiva: false,
    PrecioOferta: "",
    PromoActiva: "",
    DetalleColor: [color],
  };
}

test("los selects públicos de products no piden columnas de costo", () => {
  assert.doesNotMatch(PUBLIC_PRODUCT_FALLBACK_SELECT, SENSITIVE_COLUMNS);
  assert.doesNotMatch(PUBLIC_PRODUCT_SEARCH_SELECT, SENSITIVE_COLUMNS);
});

test("stubFromProductsTable no deriva precio de costos aunque la fila los traiga", async () => {
  const { client, calls } = mockSupabase({ products: [PRODUCT_ROW_WITH_COST] });
  const stub = await stubFromProductsTable(client, "ART-TEST");

  assert.ok(stub);
  assert.equal(stub.Precio, "");
  assert.equal(stub.Articulo, "ART-TEST");
  assert.equal(stub.Categoria, "Calzado");
  const productCalls = calls.filter((c) => c.table === "products");
  assert.equal(productCalls.length, 1);
  assert.doesNotMatch(productCalls[0].select ?? "", SENSITIVE_COLUMNS);
});

test("PDP fuera del snapshot muestra el precio de variante, no el derivado del costo", async () => {
  const { client, calls } = mockSupabase({
    catalog_public_snapshot: [],
    variant_sizes: [],
    product_variants: [variantRow(45_000)],
    variant_images: [VARIANT_IMAGE],
    colors: [],
    products: [PRODUCT_ROW_WITH_COST],
  });

  const base = await loadPdpProductBase(client, "ART-TEST");
  assert.ok(base);
  const color = base.product.DetalleColor[0];
  assert.equal(color.Precio, 45_000);
  assert.equal(base.product.Precio, "");
  assert.equal(pdpDisplayPrice(base.product, color), formatARS(45_000));
  assert.notEqual(pdpDisplayPrice(base.product, color), formatARS(COST_DERIVED_PRICE));

  for (const call of calls.filter((c) => c.table === "products")) {
    assert.doesNotMatch(call.select ?? "", SENSITIVE_COLUMNS);
  }
});

test("búsqueda ampliada usa precio de variante y no pide costos", async () => {
  const { client, calls } = mockSupabase({
    products: [PRODUCT_ROW_WITH_COST],
    catalog_public_snapshot: [],
    product_variants: [variantRow(45_000)],
    variant_images: [VARIANT_IMAGE],
    colors: [],
  });

  const results = await searchProductsIncludingOutOfStock(client, "ART", new Set());
  assert.equal(results.length, 1);
  const [product] = results;
  assert.equal(product.Precio, "");
  assert.equal(product.DetalleColor[0].Precio, 45_000);
  assert.equal(cardDisplayPrice(product, product.DetalleColor[0]), formatARS(45_000));

  for (const call of calls.filter((c) => c.table === "products")) {
    assert.doesNotMatch(call.select ?? "", SENSITIVE_COLUMNS);
  }
});

test("variante sin precio en búsqueda ampliada no expone el precio derivado del costo", async () => {
  const { client } = mockSupabase({
    products: [PRODUCT_ROW_WITH_COST],
    catalog_public_snapshot: [],
    product_variants: [variantRow(null)],
    variant_images: [VARIANT_IMAGE],
    colors: [],
  });

  const [product] = await searchProductsIncludingOutOfStock(client, "ART", new Set());
  const color = product.DetalleColor[0];
  assert.equal(color.Precio, "");
  assert.notEqual(cardDisplayPrice(product, color), formatARS(COST_DERIVED_PRICE));
  assert.equal(pdpDisplayPrice(product, color), "");
});

test("precio visible idéntico con precio de variante válido, con o sin fallback de costo", () => {
  const validPrices: ColorDetail["Precio"][] = [1, 100, 45_000, 129_900, "45000", "129900"];
  const oldFallbacks: GroupedProduct["Precio"][] = [COST_DERIVED_PRICE, 1, 999_999];

  for (const price of validPrices) {
    const color = colorWithPrice(price);
    const after = productWithFallback("", color);
    for (const oldFallback of oldFallbacks) {
      const before = productWithFallback(oldFallback, color);
      assert.equal(cardDisplayPrice(after, color), cardDisplayPrice(before, color), `card ${price}`);
      assert.equal(pdpDisplayPrice(after, color), pdpDisplayPrice(before, color), `pdp ${price}`);
    }
  }
});

test("precio de variante 0 sin costo cargado: mismo resultado antes y después", () => {
  // Antes: `precio || ""` con costo 0 ya daba "".
  const oldFallback = calculateRecommendedPrice(0, 30, 500) || "";
  assert.equal(oldFallback, "");
  const color = colorWithPrice(0);
  const before = productWithFallback(oldFallback, color);
  const after = productWithFallback("", color);
  assert.equal(cardDisplayPrice(after, color), cardDisplayPrice(before, color));
  assert.equal(pdpDisplayPrice(after, color), pdpDisplayPrice(before, color));
});

const NJ_ROOT = join(__dirname, "..", "..");
const SOURCE_DIRS = ["app", "components", "hooks", "lib", "store", "middleware.ts", "proxy.ts"];

/** Archivos de admin de productos que pueden tocar costos (gated por super_admin). */
const COST_ALLOWLIST = new Set([
  "lib/products/actions.ts",
  "lib/products/pricing.ts",
  "app/admin/products/[id]/page.tsx",
  "components/admin-products/ProductGeneralForm.tsx",
]);

function collectSourceFiles(path: string, out: string[]) {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return;
  }
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      collectSourceFiles(join(path, entry), out);
    }
    return;
  }
  if (!/\.(ts|tsx|js|mjs)$/.test(path)) return;
  if (/\.(test|selftest)\.(ts|tsx)$/.test(path)) return;
  out.push(path);
}

test("ningún archivo fuera del admin de productos consulta costos o defaults de precio", () => {
  const files: string[] = [];
  for (const dir of SOURCE_DIRS) collectSourceFiles(join(NJ_ROOT, dir), files);
  assert.ok(files.length > 50, "el escaneo no encontró el código fuente");

  const quotedSensitive =
    /["'`][^"'`\n]*\b(cost|cost_is_estimated|price_percentage|logistic_amount|category_pricing_defaults)\b[^"'`\n]*["'`]/;
  const offenders: string[] = [];
  for (const file of files) {
    const rel = relative(NJ_ROOT, file).split(sep).join("/");
    if (COST_ALLOWLIST.has(rel)) continue;
    const match = readFileSync(file, "utf8").match(quotedSensitive);
    if (match) offenders.push(`${rel}: ${match[0]}`);
  }
  assert.deepEqual(offenders, []);
});

test("las Server Actions de costos y proveedores exigen permiso antes de consultar", () => {
  const source = readFileSync(join(NJ_ROOT, "lib/products/actions.ts"), "utf8");

  function assertGuardBeforeQuery(fnName: string, guard: string) {
    const start = source.indexOf(`export async function ${fnName}`);
    assert.ok(start >= 0, `${fnName} no encontrada`);
    const body = source.slice(start);
    const guardAt = body.indexOf(guard);
    const queryAt = body.indexOf("createSupabaseServerClient");
    assert.ok(guardAt >= 0 && queryAt >= 0 && guardAt < queryAt, `${fnName} debe llamar ${guard} antes de consultar`);
  }

  assertGuardBeforeQuery("getCategoryPricingDefault", "await requireSuperAdmin()");
  assertGuardBeforeQuery("listSuppliers", "await requireProductsView()");

  assert.match(source, /async function requireSuperAdmin\(\)[\s\S]*?if \(!ctx\?\.isSuperAdmin\)/);
});
