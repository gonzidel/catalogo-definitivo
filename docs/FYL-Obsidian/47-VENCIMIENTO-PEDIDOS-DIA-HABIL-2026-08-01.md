# 47 — Vencimiento de pedidos a día hábil 17:00 Arg + reactivación de `pg_cron` (2026-08-01)

Ver también: [[03-FLUJO-PEDIDOS-Y-STOCK]], [[04-RPCS-CRITICAS]], [[06-RESERVED-QTY-Y-RECONCILE]].

## Qué cambió

**Regla de negocio nueva.** Antes, `dismantle_at` (vencimiento real del pedido) era `created_at + 7 días` literal — vencía a cualquier hora, incluso fin de semana o feriado. Ahora:

1. El pedido sigue teniendo una ventana de 7 días desde su creación.
2. Pero el vencimiento se fija siempre a las **17:00 hora Argentina**.
3. Si esa fecha cae sábado, domingo o un feriado marcado en el nuevo panel admin, el vencimiento se corre al **siguiente día hábil** (cascada: si ese día también es feriado/fin de semana, sigue avanzando).
4. `expires_at` (aviso "closing_soon") se mantiene 2 días antes del vencimiento real, sin snap a día hábil (es solo el aviso previo).

## Objetos nuevos / modificados (Supabase, proyecto `fyl-core`)

- **Tabla nueva** `public.order_deadline_holidays` (`holiday_date` date único, `reason` text, `created_by`). RLS: solo `public.admins` (mismo patrón que `offers`, `product_tag_details`, etc.).
- **Funciones nuevas**: `fn_is_business_day(date)`, `fn_next_business_day(date)`, `fn_compute_order_deadline(timestamptz, days=7)`.
- **Modificadas** (reemplazo completo, tomando la definición viva de producción como base y tocando solo el cálculo de fechas):
  - `rpc_checkout_cart()` — usa `fn_compute_order_deadline(now(), 7)` en creación y en el coalesce de backfill (en vez de `now() + interval '7 days'` / `'5 days'`).
  - `rpc_orders_daily_maintenance()` — el backfill D.1 usa la misma función.
- Migración canónica: `supabase/canonical/257_order_deadline_business_days.sql`.

## Módulo admin nuevo

`admin/holidays.html` + `admin/holidays.js` — alta/baja de feriados (fecha + motivo). Enlazado desde `admin/index.html` (tarjeta "📅 Feriados"), permiso `holidays` agregado a `admin/collaborators.js` y `admin/permissions-helper.js` (visible por defecto para admins; colaboradores necesitan que se les otorgue el permiso, igual que cualquier otro módulo).

## Hallazgo crítico durante el despliegue: `pg_cron` nunca estaba activo

Al auditar antes de este cambio se encontró que `rpc_orders_daily_maintenance()` (la función que pasa pedidos a `closing_soon`, los expira, devuelve stock reservado y llena `order_notifications`) **nunca corría sola en producción**: solo se disparaba desde `client/dashboard-instant.js` detrás de un flag (`window.FYL_ENABLE_ORDERS_MAINTENANCE`) que ningún HTML/JS del repo activaba. Evidencia: última fila en `order_notifications` era del 2026-04-14 (~3.5 meses sin correr); 8 de 9 pedidos `active` tenían `expires_at`/`dismantle_at` en `NULL`.

**Fix aplicado junto con este cambio:** `supabase/canonical/255_pg_cron_orders_maintenance.sql` — habilita `pg_cron` y programa `rpc_orders_daily_maintenance()` cada 15 minutos (job `orders-daily-maintenance`).

**Efecto secundario real al ejecutar el backfill manualmente post-deploy:** 3 pedidos activos vencidos hace tiempo (`A52942` creado 2026-05-15, `A54889` creado 2026-07-10, `A54991` creado 2026-07-14) pasaron automáticamente a `expired` y liberaron su stock reservado. Esto **no es un bug de este cambio**: es el comportamiento correcto de la función que llevaba meses sin ejecutarse. Se decidió (con el usuario) **no** recalcular retroactivamente el `dismantle_at` de pedidos existentes con la nueva regla de día hábil — solo aplica a pedidos nuevos; los que ya tenían fecha (`A55245`) quedan como estaban.

## Seguimiento 2026-08-01: verificación de pedidos futuros + prórrogas de 24h

Se verificó que un pedido creado "ahora" (sábado, fuera de horario hábil) calcula bien el vencimiento en producción (`fn_compute_order_deadline(now(), 7)` → lunes siguiente 17:00 Arg), y que el frontend (`ActiveOrderTab.tsx`, `DashboardClient.tsx`, `classification.ts`) no tiene ningún supuesto de "ventana fija de 7 días": el chip, el texto explicativo y el countdown se calculan siempre en base a días restantes reales desde `dismantle_at`, así que se adaptan solos a ventanas de 8, 9 o 10 días cuando el corrimiento de fin de semana/feriado las estira.

Además, se detectaron y corrigieron **dos prórrogas manuales de "24 horas"** que seguían haciendo `now() + interval '24 hours'` literal (podían volver a vencer un fin de semana):

- `rpc_customer_request_order_extension_24h` (botón del cliente, uso único, solo si el pedido ya venció).
- `rpc_admin_extend_order_24h` (**nueva**, admin desde el Kanban `nj/components/orders/OrderActions.tsx` → `nj/hooks/useOrders.ts`; antes hacía el cálculo de fecha en el cliente y un `update()` directo a la tabla `orders`, ahora delega en la RPC para no duplicar la lógica de día hábil).

Ambas usan ahora `fn_compute_order_deadline(now(), 1)` (próximo día hábil a las 17:00 Arg). Migración: `supabase/canonical/258_extension_24h_business_day.sql`, aplicada a producción.

## Seguimiento 2026-08-03: tercer lugar con `now() + 24h` literal (botón "Editar pedido")

Un pedido (`A55552`) creado el lunes con `dismantle_at` correcto (lunes siguiente 17:00 Arg) mostraba bien "vence el 10/8". Pasadas las 19hs la clienta usó el botón **"Editar pedido"** (reabre un pedido `closed` o con flag `customer_requested_close` para sumar productos antes de reenviar, dándole una ventana corta de 24hs en vez de los 7 días completos) y el vencimiento quedó pisado por "mañana a cualquier hora" (`dismantle_at = 2026-08-04 21:59:33.175 UTC`, con milisegundos).

Causa: `handleReopenForEditing` en `nj/components/cart/ActiveOrderTab.tsx` calculaba `new Date(Date.now() + 24*60*60*1000).toISOString()` en el cliente y hacía un `.update()` directo a `orders` — el mismo patrón `now() + interval '24 hours'` literal que ya se había corregido en este cambio (258) para las prórrogas de pedidos vencidos, pero que quedó sin migrar en este tercer lugar. Se encontró un cuarto lugar con el mismo patrón en el admin legacy: el botón "habilitar 24hs" de `admin/orders.js` tampoco usaba la RPC `rpc_admin_extend_order_24h` ya existente, sino su propio `.update()` con `Date.now() + 24h`.

**Fix aplicado:**
- Migración `supabase/canonical/270_rpc_customer_reopen_order_for_editing.sql`: nueva RPC `rpc_customer_reopen_order_for_editing(p_order_id)` que unifica los dos casos que manejaba el código cliente (pedido `closed` → `active`; pedido `active` con flag `customer_requested_close` → solo limpia el flag) en un solo `UPDATE`, usando `fn_compute_order_deadline(now(), 1)` (próximo día hábil 17:00 Arg) en vez de un literal +24hs.
- **Fix 2026-09-02 (A56427 / mig 323):** esa RPC ya no debe acortar un `dismantle_at` que todavía sea mayor que el plazo corto. Regla: `max(dismantle_at actual, fn_compute_order_deadline(now(), 1))`. Si no, admin mostraba "Mañana" y Mi pedido (que ignora plazos cortos no-deferred vía `getCustomerFacingDismantleAt`) seguía mostrando ~7 días.
- `nj/components/cart/ActiveOrderTab.tsx`: `handleReopenForEditing` ahora llama a esa RPC en vez de hacer `.update()` directo.
- `admin/orders.js`: el botón "habilitar 24hs" ahora llama a `rpc_admin_extend_order_24h` (ya existente desde 258) en vez de su propio cálculo.
- Reparación puntual de `A55552`: `dismantle_at` corregido de `2026-08-04 21:59:33.175 UTC` a `2026-08-04 20:00:00 UTC` (17:00 Arg), sin cambiar el día (ya era correcto que el reopen le diera ventana hasta el día siguiente hábil, solo estaba mal la hora exacta).

**Verificación:** reabrir un pedido `closed` de prueba y confirmar que `dismantle_at` queda en `HH:00:00` (17:00 Arg) del próximo día hábil, sin fracciones de segundo.

**Rollback:** `DROP FUNCTION public.rpc_customer_reopen_order_for_editing(uuid);` y revertir los dos archivos de frontend/admin.

## Seguimiento 2026-08-06: countdown en cards del Kanban admin

En `nj/admin/orders` (mobile y desktop) las `OrderCard` muestran un chip con días restantes hasta `dismantle_at` ("5 días" / "Mañana" / "Hoy" / "Vencido"), usando `nj/lib/orders/deadline.ts` (`calendarDaysUntil` + `formatAdminDeadlineCountdown`).

Cuando faltan **≤2 días** (y aún no venció), la card pasa a fondo **rosa** (`.order-card--expiring-soon`, `#fce7f3` / borde `#f472b6`) — distinto del azul de pedidos clienta y del borde rojo `aged` de vencidos. Pedidos admin/PAU sin `dismantle_at` no muestran countdown.

---

## Pendiente (no incluido en este cambio)

- `supabase/canonical/256_order_notifications_dispatch_webhook.sql` (dispatcher de `order_notifications` vía `pg_net` a un webhook n8n) sigue **sin aplicar** — es un problema distinto (127 notificaciones sin `sent_at`), no bloquea la regla de vencimiento.
- Zona horaria en el frontend (`ActiveOrderTab.tsx` / `DashboardClient.tsx`): siguen mostrando la hora en el timezone del navegador del cliente, no forzado a Argentina. No es un problema nuevo de este cambio, pero queda como deuda si algún cliente compra desde otro huso horario.

## Verificación

```sql
-- Lunes normal -> vence el lunes siguiente 17:00 Arg
SELECT public.fn_compute_order_deadline('2026-08-03 13:00:00-03'::timestamptz, 7);
-- 2026-08-10 20:00:00+00 (= 17:00 Arg) ✅

-- Cae sábado -> corre a lunes
SELECT public.fn_compute_order_deadline('2026-08-01 13:00:00-03'::timestamptz, 7);
-- 2026-08-10 20:00:00+00 ✅

-- Feriado marcado en martes -> corre a miércoles
SELECT public.fn_compute_order_deadline('2026-08-04 13:00:00-03'::timestamptz, 7);
-- (con holiday_date = 2026-08-11 insertado temporalmente) 2026-08-12 20:00:00+00 ✅

-- Cron activo
SELECT jobid, jobname, schedule, active FROM cron.job WHERE jobname = 'orders-daily-maintenance';
-- jobid 1, */15 * * * *, active=true ✅
```

Las 3 pruebas se corrieron contra producción (`fyl-core`) el 2026-08-01 y dieron el resultado esperado.
