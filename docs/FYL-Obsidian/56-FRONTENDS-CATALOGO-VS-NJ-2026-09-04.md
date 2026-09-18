# 56 — Frontends publicados: `/catalogo` vs NJ vs vanilla — 2026-09-04

Auditoría **solo de arquitectura/deploy**. Sin cambios de routing.

Evidencia: `catalogo1/vercel.json`, `catalogo1/next.config.ts`, `nj/next.config.ts`, `firebase.json`, HEAD/GET a URLs vivas el 2026-09-04.

**Drift 2026-09-04 noche:** el **código local** de `nj/` ya no tiene `basePath: "/nj"` (rewrites internos `/nj` → raíz). El **deploy live** (`nj-gonzidel` y rewrite de `www`) sigue como este mapa. No se movió `www`. Ver [[59-NJ-CHECKOUT-IDEMPOTENCY-ROOT-PREP-2026-09-04]] §3.

---

## Diagrama

```text
https://fylmoda.com.ar/*
  → 308 www.fylmoda.com.ar  (Vercel, proyecto catalogo1)

www.fylmoda.com.ar/
  → 308 /catalogo

www.fylmoda.com.ar/catalogo/**
  → Next.js catalogo1/   basePath=/catalogo
  → código: catalogo1/app, hooks/useCatalog, lib/supabase/queries
  → rol: anon (NEXT_PUBLIC_SUPABASE_ANON_KEY, browser + SSR)
  → tablas: catalog_public_snapshot (ISR+SWR)
             product_variants, variant_sizes, variant_images, colors (enrich)
  → sin login, sin carrito, CTA WhatsApp
  → escritura DB: ninguna

www.fylmoda.com.ar/nj/**
  → rewrite Vercel → https://nj-gonzidel.vercel.app/nj/**
  → Next.js nj/   basePath=/nj
  → X-Robots-Tag: noindex
  → rol: anon (catálogo) + authenticated (login/dashboard/admin/checkout)
  → snapshot + fn_sellable_* + carts/cart_items + rpc_checkout_cart
  → middleware protege /nj/dashboard y /nj/admin (redirige a /nj/login)

www.fylmoda.com.ar/catalogo.html
www.fylmoda.com.ar/login          (no es NJ login)
www.fylmoda.com.ar/calzado-femenino-por-mayor
  → rewrite catch-all → https://catalogo-fyl-test.web.app/...
  → vanilla Firebase (catalogo.html + main-supabase.js + catalogo-publico.js)
  → rol: anon
  → VSS, variant_sizes, rpc_get_variant_size_reserved
  → NO carga cart-persistent.js

www.fylmoda.com.ar/index.html
www.fylmoda.com.ar/client/dashboard.html
  → 301/302 → /catalogo   (Next catalogo1)

www.fylmoda.com.ar/admin            → loop 301/308 (roto)
www.fylmoda.com.ar/admin/index.html
www.fylmoda.com.ar/admin/orders.html
app.fylmoda.com.ar/admin/
  → admin vanilla (Firebase)

https://catalogo-fyl.web.app/catalogo
app.fylmoda.com.ar/catalogo
  → 301 https://www.fylmoda.com.ar/catalogo  (live 2026-09-08; [[63-VANILLA-APP-CATALOGO-REDIRECT-2026-09-08]])
  Admin vanilla en app.fylmoda.com.ar/admin/ **sigue**.

https://catalogo-fyl-test.web.app/
  → 301 /catalogo  (vanilla)
```

---

## Respuestas 1–15

1. **Publicados hoy:** Next `/catalogo` (canónico), Next `/nj` (noindex), vanilla por catch-all y hosts Firebase/`app.`, admin vanilla en `/admin/*.html`.
2. **`/catalogo`:** `catalogo1/` Next 15, `basePath: "/catalogo"`.
3. **Código compartido:** fork de `nj/` (junio 2026), no symlink. Misma idea de snapshot/banners/categorías/PDP. CSS del repo (`styles.css`). Sync manual `nj → catalogo1`. Drift real.
4. **NJ full no expuesto como producto:** login, dashboard, carrito, checkout, admin Next, sellable live, buscador smart, Fase 4. La URL `/nj` **sí responde 200**.
5. **Vanilla:** ya no es la home. Sigue desplegada en Firebase y en el rewrite Vercel.
6. **Tráfico vanilla posible:** landings SEO y catch-all residual. `app.fylmoda.com.ar/catalogo` **ya no sirve vanilla**: 301 a `www.../catalogo` (live 2026-09-08, [[63-VANILLA-APP-CATALOGO-REDIRECT-2026-09-08]]).
7. **`cart-persistent.js` / `index.html`:** no se cargan en `/catalogo` Next. `index.html` redirige a `/catalogo`. `catalogo.html` carga `main-supabase.js` + `catalogo-publico.js`, **no** `cart-persistent.js`.
8. **Quién consume `reserved_qty` hoy:** vanilla residual (`main-supabase.js` SELECT + `rpc_get_variant_size_reserved`); admin stock-audit / reconcile; writers SQL. **No** `/catalogo` Next.
9. **`/catalogo` reducida:** no lee la columna ni el RPC de reserved.
10. **Datos de `/catalogo`:** `catalog_public_snapshot` (constante `CATALOG_SOURCE`). La vista 330 no se consulta en runtime. **No** tiene `lib/stock/catalog-availability.ts`. Enrich propio con `variant_sizes.stock_qty`.
11. **Home/categorías/banners/buscador:** misma familia de componentes, **copia separada**. Buscador catalogo1 = Levenshtein local; NJ full = `search-resolver` + vocabulario.
12. **Fases 1–5:** 330+332 **sí** (el snapshot que lee `/catalogo`). 331 / helpers Fase 2–4 **no** (no están en el fork).
13. **Roles `/catalogo`:** solo **anon** (browser + server). `getServerUser` existe pero no hay login. No service_role.
14. **Escrituras `/catalogo`:** ninguna a Supabase (solo `URLSearchParams.delete`).
15. **Admin prod:** vanilla `admin/*.html` en Firebase/`app.` y en `www.../admin/*.html`. `www.../admin` sin archivo entra en loop. NJ admin en `/nj/admin` (login, noindex). Dashboard cliente vanilla redirige a `/catalogo`.

---

## A–F

### A. PRODUCCIÓN ACTIVA
`catalogo1/` en `www.fylmoda.com.ar/catalogo`. Admin vanilla en `/admin/*.html`.

### B. DESPLEGADO LEGACY / NO ES EL FLUJO
Vanilla `catalogo.html` (tombstone), landings SEO rewriteadas, admin en `app.fylmoda.com.ar/admin/`. `app.../catalogo` 301 a `www` (live).

### C. NJ FULL DESARROLLO / RESTRINGIDO
`nj/` en `www.fylmoda.com.ar/nj` y `nj-gonzidel.vercel.app/nj`. Público HTTP, `noindex`, sin link desde `/catalogo`. Auth para dashboard/admin.

### D. ¿`reserved_qty` condiciona UX real?
**No en la home `/catalogo` Next.** Sí en páginas vanilla residuales si alguien entra. Admin/reconcile sí.

### E. ¿`cart_items` consumidor real en producción pública?
**No en `/catalogo`.** Solo si alguien usa `/nj` (carrito) o un `index.html` vanilla que ya no es la home.

### F. Cambio a Fase 6 (reinterpretado 2026-09-04)

Prioridad: `nj/` = próxima producción. `catalogo1/` = temporal, no portar Fase 4. Vanilla residual no diseña el futuro.

- **6A:** sigue pendiente. Vanilla residual **no** es el motivo. El admin vanilla (stock-audit / reconcile) **sí** usa `reserved_qty`. No aplicar hasta otro bloque.
- **6B:** `cart_items` son staging real de NJ. No borrar ni recortar grants. Los 361 zombies no bloquean el lanzamiento.
- **6C:** **aplicado.** Ver [[57-SELLABLE-STOCK-FASE6C-333C-2026-09-04]]. SELECT público intacto. Write de catálogo/stock solo admin.
