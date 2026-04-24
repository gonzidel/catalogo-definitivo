# Contribuir al Catálogo FYL

## Documentación viva

La bóveda en **`docs/FYL-Obsidian/`** (Markdown preparado para Obsidian) **forma parte del repositorio** en igualdad que el código: documenta el estado real del sistema (frontend, Supabase, flujos críticos). Cualquiera que cambie lógica de negocio o esquema debe asumir la **responsabilidad de actualizar** los apartados afectos en esa carpeta, en el mismo cambio o en un commit inmediatamente asociado.

- Entrada: [`docs/FYL-Obsidian/00-INICIO.md`](docs/FYL-Obsidian/00-INICIO.md) (índice y enlaces internos).
- Meta-auditoría documentación vs código: [`docs/FYL-Obsidian/99-AUDITORIA-DOCUMENTACION.md`](docs/FYL-Obsidian/99-AUDITORIA-DOCUMENTACION.md).
- No sustituye el código ni el SQL; alinea a humanos (y a herramientas) sobre riesgos y flujos.

## Regla de mantenimiento de documentación

**Cada cambio** que afecte alguno de estos ámbitos debe ir acompañado de una **actualización** en el Markdown correspondiente bajo `docs/FYL-Obsidian/` (o creación de una nota nueva si el tema no existía y es sustancial):

| Ámbito | Dónde documentar (orientativo) |
|--------|---------------------------------|
| Stock (tablas, RPCs, descuentos, depósitos) | [`04-FLUJO-STOCK.md`](docs/FYL-Obsidian/04-FLUJO-STOCK.md), [`02-MAPA-DE-TABLAS.md`](docs/FYL-Obsidian/02-MAPA-DE-TABLAS.md), [`03-MAPA-DE-RPCS.md`](docs/FYL-Obsidian/03-MAPA-DE-RPCS.md) |
| Pedidos (cliente, admin, estados, cancelaciones) | [`05-FLUJO-PEDIDOS.md`](docs/FYL-Obsidian/05-FLUJO-PEDIDOS.md), mapas de tablas/RPCs |
| RPCs o funciones SQL (nuevas, firmas, comportamiento) | [`03-MAPA-DE-RPCS.md`](docs/FYL-Obsidian/03-MAPA-DE-RPCS.md) |
| Tablas, columnas, RLS, migraciones con impacto de dominio | [`02-MAPA-DE-TABLAS.md`](docs/FYL-Obsidian/02-MAPA-DE-TABLAS.md), [`09-TABLAS-COLUMNAS-DUDOSAS-O-LEGACY.md`](docs/FYL-Obsidian/09-TABLAS-COLUMNAS-DUDOSAS-O-LEGACY.md) |
| Permisos, `admins`, colaboradores, `super_admin` | [`08-PERMISOS-Y-ROLES.md`](docs/FYL-Obsidian/08-PERMISOS-Y-ROLES.md) |
| Costos, márgenes, visibilidad de precios/costes | [`07-FLUJO-ADMIN-PRODUCTOS.md`](docs/FYL-Obsidian/07-FLUJO-ADMIN-PRODUCTOS.md), permisos |
| Catálogo, vistas, filtros, PDP, carrito (comportamiento) | [`06-FLUJO-CATALOGO.md`](docs/FYL-Obsidian/06-FLUJO-CATALOGO.md) |
| Imágenes (Cloudinary, subida, transformaciones) | flujo catálogo y admin productos; ajustar la sección que corresponda |

Si el cambio introduce una **decisión** estable o **corrige un bug** relevante, agregá o extendé una nota en [`11-DECISIONES-TECNICAS.md`](docs/FYL-Obsidian/11-DECISIONES-TECNICAS.md) o [`10-BUGS-RESUELTOS.md`](docs/FYL-Obsidian/10-BUGS-RESUELTOS.md) según aplique. La checklist de recordatorio está en [`12-CHECKLIST-CAMBIOS-FUTUROS.md`](docs/FYL-Obsidian/12-CHECKLIST-CAMBIOS-FUTUROS.md).

## Otros criterios

- Tratar de seguir el estilo y la precisión de las notas existentes: referencias a archivos reales, marcar con **DUDOSO** lo no verificable.
- No commitear secretos ni credenciales (ver [README.md](README.md) y `npm run test:staged-secrets` si aplica al flujo de trabajo del equipo).
