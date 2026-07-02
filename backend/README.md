# FYL Invoice Backend

Servidor Node.js/Express para facturación electrónica ARCA (homologación/producción).

## Requisitos

- Node.js 20+
- Certificados ARCA (`.crt` + `.key`) fuera del repositorio
- Supabase service role key (solo backend)

## Configuración

```bash
cd backend
cp .env.example .env
# Editar .env con credenciales reales
npm install
npm run dev
```

> `npm install` omite la descarga de Chromium vía `.npmrc` (`puppeteer_skip_download=true`).
> En producción, instalar Chromium del sistema y setear `PUPPETEER_EXECUTABLE_PATH`.

## Variables de entorno

Ver `.env.example`. **Nunca** commitear `.env`.

## Endpoints

- `GET /health` — health check
- `POST /api/invoices/generate` — requiere `Authorization: Bearer <jwt admin>`

## Frontend

En `admin/closed-orders.js`, `INVOICE_BACKEND_URL` apunta a este servidor (default `http://localhost:3001`).

## Producción

Firebase Hosting no ejecuta Node. Desplegar este backend en Render, Fly.io o VPS.
Actualizar `CORS_ORIGIN` y `INVOICE_BACKEND_URL` en el frontend.

## Limitación de concurrencia

El mutex in-memory solo protege con **una instancia** Node. No escalar horizontalmente sin locks compartidos (Postgres/Redis).
