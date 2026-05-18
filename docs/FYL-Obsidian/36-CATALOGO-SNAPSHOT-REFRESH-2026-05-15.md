# Catálogo snapshot — refresh operativo (2026-05-15)

**Problema:** La web lee por defecto `catalog_public_snapshot`. Si no se refresca tras altas/cambios, productos válidos en `catalog_public_available_view` **no aparecen** (catálogo, banner).

**Solución en repo:**

- Panel **Admin → Acciones rápidas** (`admin/quick-actions.html`): sección **Catálogo público** → botón **Actualizar catálogo público** (RPC `rpc_refresh_catalog_public_snapshot`; requiere usuario en `public.admins`).
- Plan y detalle: `doc/plan-catalogo-publico-snapshot-banner-2026-05-15.md`.
- SQL de verificación (solo lectura): `scripts/verify-catalog-snapshot-parity.sql`.

**Nota:** En SQL Editor sin JWT, `auth.uid()` es NULL → la RPC devuelve error de admin; usar el botón con sesión admin o el bloque `SET LOCAL request.jwt.claim.sub` documentado en hardening.

**Pendiente decisión equipo:** cron / automatización (Fase B del plan).

**Enlaces:** [[21-CONTEXTO-AGENTE-HARDENING-2026-04]], hardening `doc/hardening-supabase-2026-05-13.md` § snapshot.
