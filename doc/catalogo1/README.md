# FYL Next.js `/catalogo1` — Documentación Técnica

> Fork de `/nj` para lanzamiento público sin login ni carrito. Consulta por WhatsApp.
> Última actualización: 2026-06-13

## Índice

| Tema | Archivo |
|------|---------|
| Arquitectura y stack | este archivo |
| Catálogo, filtros, banners | mismo stack que `doc/nj/` |
| WhatsApp | `lib/utils/whatsapp.ts`, `components/contact/WhatsAppButton.tsx` |

---

## Propósito

- **URL**: `http://localhost:3002/catalogo1` (dev) / `https://<dominio>/catalogo1` (prod)
- **Datos**: mismo Supabase de producción (`catalog_public_snapshot`, Cloudinary, banners CMS)
- **Sin**: login, dashboard, carrito, `rpc_checkout_cart`, middleware de auth
- **CTA**: WhatsApp `5493625172874` (mismo que catálogo público vanilla)

`/nj` sigue siendo la línea de desarrollo con auth+carrito. Cuando esté listo, se sincroniza `nj/` → `catalogo1/` para cutover.

---

## Stack

- **Framework**: Next.js 15 App Router (TypeScript)
- **Carpeta raíz**: `catalogo1/`
- **`basePath`**: `/catalogo1` en `next.config.ts`
- **Constante**: `lib/constants/app.ts` → `BASE_PATH = "/catalogo1"`
- **Backend**: Supabase (mismo proyecto que `/nj` y vanilla)
- **Estilos**: `../../styles.css` + `styles/globals.css`
- **Imágenes**: Cloudinary loader custom

## Variables de entorno

Copiar desde `nj/.env.local`:

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
```

No requiere redirect URLs OAuth en Supabase.

## Desarrollo

```bash
cd catalogo1
npm install
npm run dev
# → http://localhost:3002/catalogo1
```

## Despliegue

- Vercel: `rootDirectory: catalogo1/`, `basePath` ya en `next.config.ts`
- Mismas env vars Supabase que `/nj`

## Diferencias vs `/nj`

| Área | `/nj` | `/catalogo1` |
|------|-------|--------------|
| Auth / dashboard | Sí | No |
| Carrito / pedidos | Sí | No |
| PDP CTA | Agregar al carrito | Consultar por WhatsApp |
| Bottom nav | Inicio, Buscar, Pedido, Perfil | Inicio, Buscar, WhatsApp |
| Header | Perfil + notificaciones | Icono WhatsApp |
| Puerto dev | 3001 | 3002 |

## Cutover futuro

1. Desarrollar en `nj/`
2. Sync `nj/` → `catalogo1/` (excl. `node_modules`, `.next`)
3. Re-aplicar config `catalogo1`: `basePath`, puerto, módulo WhatsApp si aplica
4. Build + deploy `catalogo1/`
