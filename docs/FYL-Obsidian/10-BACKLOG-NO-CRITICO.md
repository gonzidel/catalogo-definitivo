# 10 — Backlog no crítico (FYL, post-saneamiento)

> Items detectados en auditorías, comentarios SQL (ej. 165, import-export) o deuda estructural. **No** bloquean el gate si el sistema se opera según gobernanza; prioridad sugerida.

| Prioridad | Tema | Motivo de no cerrar aún / comentario |
|-----------|------|----------------------------------------|
| Media | `product_variants.stock_qty` / `size` (legacy) | Sigue existiendo en esquema; UIs deberían ignorar para disponible — eliminación de columna = migración de datos riesgosa. |
| Media | `reserved_qty` “por talle” (si se desea) | Hoy reserva agregada a variante; granularidad en filas = modelo más pesado. |
| Baja | RPC de **metadatos de variante** unificada | Varios módulos leen con Supabase; reduciría duplicación. |
| Media | Unificar `fetchVariantInfo` / cachés entre carrito, dashboard, catálogo | Código compartido reduce bugs de resolución de `variant_id`. |
| Baja | RLS “fino” opcional en tablas de stock vía policy por rol además de *no public write* | Gobernanza sugirió *no* trigger-guard; RLS adicional requiere producto. |
| Media | `admin/fyl-products` / `incomplete-products` batch sin talle: migrar restos a `rpc_set_variant_warehouse_stock_batch` (165) | 165 aún comenta *pendiente* de migración. |
| Baja | `import-export.js` rutas con notas “actualizar canónica” (ver grep) | Revisar si queda write directo o ya RPC. **Pendiente de verificación** con búsqueda. |
| Baja | Documentar transiciones exactas de `order_items.status` en una matriz (pedido+admin) | Mejora operativa, no corregiría lógica. |
| Baja | Tests automatizados de idempotencia (Playwright + asserts en `rpc_operations`) | Aumenta confianza en deploys. |

## Enlaces

- [[00-INDICE]] · [[14-AUDITORIA-MODULO-PRODUCTS]] · [[15-OBSERVACIONES-PRODUCTS-A-REVISAR]] · `supabase/canonical/165_*.sql` (comentarios iniciales)
