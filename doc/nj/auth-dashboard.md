# FYL /nj — Autenticación y Dashboard

> Última actualización: 2026-06-08

## Flujo de autenticación

```
/login
  ├── Google OAuth → supabase.auth.signInWithOAuth({ provider: "google" })
  └── Magic Link  → supabase.auth.signInWithOtp({ email })

/auth/callback (Route Handler)
  └── exchangeCodeForSession → redirect a /dashboard (o URL "next")

middleware.ts
  ├── /dashboard/* sin sesión → redirect /login?next=<path>
  └── /login con sesión      → redirect /dashboard
```

## Archivos clave

| Archivo | Rol |
|---------|-----|
| `app/login/LoginClient.tsx` | Formulario (Google + Magic Link), parámetro `?next=` |
| `app/auth/callback/route.ts` | Intercambia código OAuth, setea cookies |
| `app/dashboard/layout.tsx` | Guard server-side: redirect si no hay user |
| `lib/supabase/server.ts` | `createSupabaseServerClient()` async con cookies() |
| `lib/supabase/client.ts` | `getSupabaseBrowserClient()` singleton browser |
| `middleware.ts` | Guard de rutas, refresca cookies de sesión |
| `components/layout/HeaderActions.tsx` | Avatar Google / ícono genérico + onAuthStateChange |

## Icono de perfil en Header

- **Logueado**: muestra foto de Google (`user_metadata.avatar_url`) o iniciales
- **No logueado**: ícono genérico → link a `/login`
- **Escucha**: `supabase.auth.onAuthStateChange` para actualización en tiempo real

## Dashboard — tabs

| Tab | ID | Qué muestra |
|-----|----|-------------|
| Carrito | `cart` | Items locales (Zustand) + stock en tiempo real |
| Mi pedido | `active-order` | Pedido activo/cerrado/enviado |
| Historial | `orders` | Pedidos pasados |
| Perfil | `profile` | Datos del cliente |

## Datos del dashboard (Server Component)

`app/dashboard/page.tsx` hace fetch server-side de:
- `customers` → perfil del cliente autenticado
- `orders` → todos los pedidos con `order_items` (incluyendo `status`, `dismantle_at`, `expires_at`)

Pasa todo a `DashboardClient` (Client Component).

## Protección de rutas

```typescript
// middleware.ts — matcher: ["/dashboard/:path*", "/login"]
if (pathname.startsWith("/dashboard") && !user) → redirect /login
if (pathname === "/login" && user) → redirect /dashboard
```

## Nota SSL local

En desarrollo, `next.config.ts` setea `NODE_TLS_REJECT_UNAUTHORIZED = "0"` para que Node.js pueda conectar con Supabase sin verificar el certificado. **No aplicar en producción.**
