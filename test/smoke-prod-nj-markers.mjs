/**
 * Smoke de "marcadores" de producción NJ.
 *
 * Objetivo: detectar que un deploy NO pisó funcionalidades que ya estaban publicadas.
 * Se corre contra un deployment YA construido (URL de preview con --skip-domain) ANTES de
 * `vercel promote`, y otra vez contra www después.
 *
 * Uso:
 *   node --use-system-ca test/smoke-prod-nj-markers.mjs https://nj-xxxx-gonzidel.vercel.app
 *   node --use-system-ca test/smoke-prod-nj-markers.mjs   (default: https://www.fylmoda.com.ar)
 *
 * `--use-system-ca` hace falta en la PC de Gonzalo: el antivirus/proxy intercepta TLS y Node
 * falla con UNABLE_TO_VERIFY_LEAF_SIGNATURE sin esa opción.
 *
 * Mantenimiento: cada funcionalidad que llega a producción agrega su marcador acá en el
 * mismo cambio. Si alguien APAGA a propósito algo (p. ej. TEMP_MIN_ONE_ENABLED=false),
 * actualiza el marcador en el mismo commit. Ver docs/15_PRODUCCION_NJ_ACTUAL.md.
 *
 * Nota: el banner de ofertas es "falla cerrado" (check admin/offers.html). Si el check está
 * apagado a propósito, el marcador `ofertas-banner` fallará: es esperado y hay que confirmarlo.
 */

const base = (process.argv[2] || "https://www.fylmoda.com.ar").replace(/\/+$/, "");
/** Admin legacy (Firebase Hosting). Segundo argumento opcional. */
const adminBase = (process.argv[3] || "https://app.fylmoda.com.ar").replace(/\/+$/, "");

/** @type {{ name: string, path: string, kind: "html" | "redirect", expect: string, admin?: boolean }[]} */
const MARKERS = [
  {
    name: "Banner de ofertas en el inicio (76-BANNER-OFERTAS)",
    path: "/",
    kind: "html",
    expect: "ofertas-banner",
  },
  {
    name: "Banner promo mínimo 1 (64-TEMP-MINIMO-1; ya no dice Cyber Monday)",
    path: "/",
    kind: "html",
    expect: "Comprá por mayor desde 1 producto",
  },
  {
    name: "Mínimo 1 en textos públicos (TEMP_PUBLIC_COPY_MIN_ONE)",
    path: "/como-comprar",
    kind: "html",
    expect: "Podés comprar desde 1 producto",
  },
  {
    name: "Links de Meta /catalogo?sku=X van a la ficha",
    path: "/catalogo?sku=B6180",
    kind: "redirect",
    expect: "/producto/B6180",
  },
  {
    name: "Admin: Peso y medidas del producto (alto/ancho/largo/peso)",
    path: "/admin/products.html",
    kind: "html",
    expect: "dim-height",
    admin: true,
  },
  {
    name: "Admin: caracteristicas de calzado (product-features.js)",
    path: "/admin/product-features.js",
    kind: "html",
    expect: "Características de Calzado",
    admin: true,
  },
  {
    name: "Admin: datos Mercado Libre del producto (product-meli.js)",
    path: "/admin/product-meli.js",
    kind: "html",
    expect: "Habilitar en Mercado Libre",
    admin: true,
  },
];

async function check(marker) {
  const url = (marker.admin ? adminBase : base) + marker.path;
  try {
    if (marker.kind === "redirect") {
      const res = await fetch(url, { redirect: "manual" });
      const location = res.headers.get("location") || "";
      return { ok: location.includes(marker.expect), detail: `${res.status} -> ${location || "(sin Location)"}` };
    }
    const res = await fetch(url, { headers: { "cache-control": "no-cache" } });
    const body = await res.text();
    return { ok: res.ok && body.includes(marker.expect), detail: `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, detail: `error de red: ${err instanceof Error ? err.message : String(err)}` };
  }
}

let failed = 0;
console.log(`Smoke de marcadores NJ contra ${base} (admin: ${adminBase})\n`);
for (const marker of MARKERS) {
  const { ok, detail } = await check(marker);
  if (!ok) failed += 1;
  console.log(`${ok ? "OK  " : "FALTA"}  ${marker.name}  [${marker.path}]  ${detail}`);
}

if (failed > 0) {
  console.error(`\n${failed} marcador(es) faltan. NO promover este deploy: probablemente pisa algo ya publicado.`);
  process.exit(1);
}
console.log("\nTodos los marcadores presentes.");
