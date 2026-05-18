#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/**
 * Verificación HTTP real (PostgREST) — Fase A (grants compras + publicación).
 *
 * Opciones:
 *   --report   Escribe scripts/outputs/phase-a-http-evidence.json (trunca cuerpos; sin tokens).
 *
 * Requiere:
 *   SUPABASE_URL
 *   SUPABASE_ANON_KEY  → pruebas rol anon (Bearer = anon key)
 *
 * Opcional (JWT de sesión Supabase = access_token del usuario, NO service_role):
 *   FYL_POSTGREST_ADMIN_ACCESS_TOKEN     → usuario admin del panel (proveedores / stock)
 *   FYL_POSTGREST_CUSTOMER_ACCESS_TOKEN → revendedor o cliente sin permisos admin
 *
 * Comportamiento no-admin:
 *   FYL_PHASE_A_NON_ADMIN_EXPECT_FORBIDDEN=1  → exige 403 o 404 en las 3 vistas (postura dura;
 *       hoy muchas instalaciones fallarán mientras GRANT SELECT siga en role "authenticated").
 *   Por defecto (sin variable o =0): 403/404 = OK; 200 = OK con WARN (deuda: vista amplia a authenticated).
 *
 * Uso:
 *   SUPABASE_ANON_KEY=... node scripts/phase-a-verify-postgrest.mjs
 *   SUPABASE_ANON_KEY=... node scripts/phase-a-verify-postgrest.mjs --report
 *   FYL_POSTGREST_ADMIN_ACCESS_TOKEN=eyJ... FYL_POSTGREST_CUSTOMER_ACCESS_TOKEN=eyJ... node scripts/phase-a-verify-postgrest.mjs
 *
 * TLS local:
 *   FYL_AUDIT_INSECURE_TLS=1
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WRITE_REPORT = process.argv.includes("--report");

const SUPABASE_URL = (process.env.SUPABASE_URL || "https://dtfznewwvsadkorxwzft.supabase.co").replace(/\/$/, "");
const ANON = process.env.SUPABASE_ANON_KEY || "";
const ADMIN_JWT = process.env.FYL_POSTGREST_ADMIN_ACCESS_TOKEN || "";
const CUSTOMER_JWT = process.env.FYL_POSTGREST_CUSTOMER_ACCESS_TOKEN || "";
const STRICT_NON_ADMIN =
  process.env.FYL_PHASE_A_NON_ADMIN_EXPECT_FORBIDDEN === "1" ||
  process.env.FYL_PHASE_A_NON_ADMIN_EXPECT_FORBIDDEN === "true";

if (process.env.FYL_AUDIT_INSECURE_TLS === "1") {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

const evidence = {
  generatedAt: new Date().toISOString(),
  supabaseUrl: SUPABASE_URL,
  phase: "A",
  checks: [],
};

function recordCheck(entry) {
  if (WRITE_REPORT) evidence.checks.push(entry);
}

const VIEWS = [
  {
    key: "purchase_spend_by_season",
    path: "/rest/v1/purchase_spend_by_season?select=season_id&limit=1",
  },
  {
    key: "purchase_order_line_fulfillment",
    path: "/rest/v1/purchase_order_line_fulfillment?select=order_line_id&limit=1",
  },
  {
    key: "vw_publication_events_performance",
    path: "/rest/v1/vw_publication_events_performance?select=id&limit=1",
  },
];

function anonHeaders() {
  return {
    apikey: ANON,
    authorization: `Bearer ${ANON}`,
    accept: "application/json",
  };
}

function userHeaders(accessToken) {
  return {
    apikey: ANON,
    authorization: `Bearer ${accessToken}`,
    accept: "application/json",
  };
}

function forbiddenForAnon(status) {
  return status === 401 || status === 403 || status === 404;
}

function okForAdmin(status) {
  return status === 200;
}

async function get(url, headers) {
  const res = await fetch(url, { headers });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { _raw: text.slice(0, 200) };
  }
  return { status: res.status, text, json };
}

let failed = 0;

function fail(msg) {
  console.log(`FAIL ${msg}`);
  failed += 1;
}

function ok(msg) {
  console.log(`OK   ${msg}`);
}

function warn(msg) {
  console.log(`WARN ${msg}`);
}

// --- 1) Anon: debe quedar fuera (401/403/404)
if (!ANON) {
  console.log("SKIP fase A anon: SUPABASE_ANON_KEY no definida");
} else {
  for (const v of VIEWS) {
    const url = `${SUPABASE_URL}${v.path}`;
    const { status, text } = await get(url, anonHeaders());
    recordCheck({
      role: "anon",
      endpoint: v.key,
      url,
      httpStatus: status,
      bodyPreview: text.slice(0, 500),
      outcome: forbiddenForAnon(status) ? "pass_closed" : "fail",
    });
    if (forbiddenForAnon(status)) {
      ok(`anon ${v.key}: HTTP ${status} (cerrado)`);
    } else {
      fail(`anon ${v.key}: esperaba 401/403/404, obtuve HTTP ${status}`);
      console.log(text.slice(0, 400));
    }
  }

  // Regresión catálogo público
  const snapUrl = `${SUPABASE_URL}/rest/v1/catalog_public_snapshot?select=Articulo&limit=1`;
  const snap = await get(snapUrl, anonHeaders());
  recordCheck({
    role: "anon",
    endpoint: "catalog_public_snapshot",
    url: snapUrl,
    httpStatus: snap.status,
    bodyPreview: snap.text.slice(0, 500),
    outcome: snap.status === 200 ? "pass_open" : "fail",
  });
  if (snap.status === 200) {
    ok(`anon catalog_public_snapshot: HTTP 200`);
  } else {
    fail(`anon catalog_public_snapshot: esperaba 200, obtuve HTTP ${snap.status}`);
    console.log(snap.text.slice(0, 400));
  }
}

// --- 2) Admin autenticado: debe seguir pudiendo leer las 3 vistas
if (!ANON) {
  console.log("SKIP admin: hace falta SUPABASE_ANON_KEY (apikey PostgREST)");
} else if (!ADMIN_JWT) {
  console.log("SKIP admin: FYL_POSTGREST_ADMIN_ACCESS_TOKEN no definido");
} else {
  for (const v of VIEWS) {
    const url = `${SUPABASE_URL}${v.path}`;
    const { status, text } = await get(url, userHeaders(ADMIN_JWT));
    recordCheck({
      role: "admin_jwt",
      endpoint: v.key,
      url,
      httpStatus: status,
      bodyPreview: text.slice(0, 500),
      outcome: okForAdmin(status) ? "pass" : status === 401 ? "auth_fail" : "fail",
    });
    if (okForAdmin(status)) {
      ok(`admin JWT ${v.key}: HTTP 200`);
    } else if (status === 401) {
      fail(`admin JWT ${v.key}: HTTP 401 (token inválido o expirado)`);
    } else {
      fail(`admin JWT ${v.key}: esperaba 200, obtuve HTTP ${status}`);
      console.log(text.slice(0, 400));
    }
  }
}

// --- 3) No-admin: no debe "abrirse" un acceso nuevo por la migración
//     Con grants actuales (SELECT → authenticated), PostgREST suele devolver 200 igual que admin.
//     Eso es deuda conocida; aquí verificamos coherencia y modo estricto opcional.
if (!ANON) {
  console.log("SKIP no-admin: hace falta SUPABASE_ANON_KEY");
} else if (!CUSTOMER_JWT) {
  console.log("SKIP no-admin: FYL_POSTGREST_CUSTOMER_ACCESS_TOKEN no definido");
} else if (!ADMIN_JWT) {
  console.log("SKIP no-admin: FYL_POSTGREST_ADMIN_ACCESS_TOKEN no definido (necesario para comparar)");
} else {
  for (const v of VIEWS) {
    const url = `${SUPABASE_URL}${v.path}`;
    const adminRes = await get(url, userHeaders(ADMIN_JWT));
    const custRes = await get(url, userHeaders(CUSTOMER_JWT));

    recordCheck({
      role: "customer_jwt",
      endpoint: v.key,
      url,
      httpStatus: custRes.status,
      adminHttpStatus: adminRes.status,
      bodyPreview: custRes.text.slice(0, 500),
      strictNonAdmin: STRICT_NON_ADMIN,
      outcome: "compared",
    });

    if (custRes.status === 401) {
      fail(`no-admin ${v.key}: HTTP 401 (token cliente inválido o expirado)`);
      continue;
    }

    if (STRICT_NON_ADMIN) {
      if (forbiddenForAnon(custRes.status)) {
        ok(`no-admin ${v.key}: HTTP ${custRes.status} (modo estricto: sin lectura)`);
      } else {
        fail(
          `no-admin ${v.key}: modo estricto FYL_PHASE_A_NON_ADMIN_EXPECT_FORBIDDEN=1 pero HTTP ${custRes.status}`,
        );
        console.log(custRes.text.slice(0, 400));
      }
      continue;
    }

    // Modo por defecto: no exigir 403 hasta que se revoque SELECT a rol amplio
    if (forbiddenForAnon(custRes.status)) {
      ok(`no-admin ${v.key}: HTTP ${custRes.status} (sin lectura; coherente con política deseada)`);
    } else if (custRes.status === 200) {
      if (adminRes.status === 200) {
        warn(
          `no-admin ${v.key}: HTTP 200 igual que admin — deuda conocida (GRANT SELECT a role authenticated en la vista). ` +
            `La Fase A no amplía esto; revocar SELECT a no-admins es fase posterior.`,
        );
        ok(`no-admin ${v.key}: HTTP 200 aceptado (no estricto)`);
      } else {
        fail(`no-admin ${v.key}: cliente 200 pero admin HTTP ${adminRes.status} (incoherente)`);
      }
    } else {
      fail(`no-admin ${v.key}: HTTP ${custRes.status} inesperado`);
      console.log(custRes.text.slice(0, 400));
    }
  }
}

if (WRITE_REPORT) {
  const outDir = path.join(__dirname, "outputs");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "phase-a-http-evidence.json");
  fs.writeFileSync(outFile, JSON.stringify(evidence, null, 2), "utf8");
  console.log(`\nReporte HTTP escrito: ${outFile}`);
}

if (failed > 0) {
  console.log(`\nTerminó con ${failed} fallo(s).`);
  process.exit(1);
}
console.log("\nTodas las comprobaciones ejecutadas pasaron (los SKIP no cuentan como fallo).");
