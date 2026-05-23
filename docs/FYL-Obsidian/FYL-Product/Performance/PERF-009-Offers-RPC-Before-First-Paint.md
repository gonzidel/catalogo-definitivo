# PERF-009 — RPC `get_active_offers_with_images` antes del primer render

- **Estado:** implementado (2026-05-23)
- **Severidad:** alto
- **Detectado:** 2026-05-23 — [[2026-05-23-Auditoria-LCP-Catalogo-Clarity]]
- **Métrica afectada:** LCP
- **Área:** `cargarCategoria` → Home

## Síntoma

Las cards de producto no se insertan en `#catalogo` hasta que termina la RPC de ofertas, aunque las offer cards son opcionales para el primer paint.

## Causa raíz

`scripts/main-supabase.js` L1486–1490:

```javascript
const { data: offers, error: offersError } = await supabase
  .rpc('get_active_offers_with_images');
```

Ocurre **después** de `agruparProductos` y **antes** de `renderizarProductosPagina` L1528.

## Impacto LCP

**Directo.** Estimado +200–800 ms según latencia Supabase.

## Plan de fix

```javascript
const offersPromise = supabase.rpc("get_active_offers_with_images");
const firstChunkRendered = await renderizarProductosPagina(/* sin offers */, ...);
releaseBootOverlayOnFirstPaint("first_chunk_rendered");

offersPromise.then(({ data, error }) => {
  if (error || !data?.length) return;
  // insertar offer cards al inicio del grid si aún estamos en la misma categoría
});
```

Validar que no rompa orden visual si el usuario cambia de categoría antes de que resuelva la RPC.

## Verificación

Network: primer paint sin esperar `rpc/get_active_offers_with_images`.

## Cruces

- [[PERF-001-LCP-Round-Trips-Supabase]]
- [[2026-05-23-Auditoria-LCP-Catalogo-Clarity]]
