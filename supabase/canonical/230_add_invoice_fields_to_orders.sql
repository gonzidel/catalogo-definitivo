-- ============================================================
-- Migración 230: Campos de facturación electrónica en orders
-- Integración: Facturante (AFIP Factura B - Consumidor Final)
-- ============================================================

ALTER TABLE public.orders
  -- Máquina de estados de facturación
  ADD COLUMN IF NOT EXISTS invoice_status TEXT
    NOT NULL DEFAULT 'sin_facturar'
    CHECK (invoice_status IN ('sin_facturar', 'processing', 'approved', 'error')),

  -- ID interno de Facturante: permite reconsultar, recuperar y depurar sin webhook
  ADD COLUMN IF NOT EXISTS facturante_id INTEGER,

  -- Número AFIP separado del prefijo para queries, ordenamiento y unicidad
  ADD COLUMN IF NOT EXISTS invoice_prefix TEXT,    -- ej: "0002" (punto de venta)
  ADD COLUMN IF NOT EXISTS invoice_number INTEGER, -- ej: 12345 (asignado por AFIP)

  -- CAE: código de autorización electrónica de AFIP (14 dígitos, obligatorio en factura)
  ADD COLUMN IF NOT EXISTS invoice_cae NUMERIC(14,0),

  -- URL del PDF oficial generado por Facturante
  ADD COLUMN IF NOT EXISTS invoice_pdf_url TEXT,

  -- Marca temporal de cuando AFIP autorizó (FechaHoraCAE de Facturante)
  ADD COLUMN IF NOT EXISTS invoice_created_at TIMESTAMPTZ,

  -- Snapshot inmutable del payload enviado a Facturante (trazabilidad fiscal)
  -- Captura: cliente, items, precios e importes exactos al momento de emisión
  ADD COLUMN IF NOT EXISTS invoice_payload JSONB,

  -- Mensaje de error de Facturante o AFIP (para diagnóstico en pantalla)
  ADD COLUMN IF NOT EXISTS invoice_error TEXT;

-- Garantía anti-duplicado capa DB:
-- Un facturante_id no puede asociarse a dos pedidos distintos
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_facturante_id_unique
  ON public.orders (facturante_id)
  WHERE facturante_id IS NOT NULL;

-- Unicidad AFIP:
-- Un número de comprobante no puede repetirse en el mismo punto de venta
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_invoice_number_unique
  ON public.orders (invoice_prefix, invoice_number)
  WHERE invoice_number IS NOT NULL;

-- Índice operativo para filtrar pedidos facturados/en proceso
CREATE INDEX IF NOT EXISTS idx_orders_invoice_status
  ON public.orders (invoice_status)
  WHERE invoice_status != 'sin_facturar';

-- ============================================================
-- Flujo de estados:
--   'sin_facturar' (default)
--     → 'processing'  (tras CrearComprobante OK — AFIP procesando)
--     → 'approved'    (webhook Facturante con CAE + PDF)
--     → 'error'       (cualquier fallo — reintentable)
--
-- Columnas por estado:
--   processing : facturante_id + invoice_payload
--   approved   : + invoice_prefix, invoice_number, invoice_cae,
--                  invoice_pdf_url, invoice_created_at
--   error      : + invoice_error
-- ============================================================
