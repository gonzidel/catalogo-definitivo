-- 243_invoices_drive_backup.sql
-- Respaldo best-effort del PDF de cada factura en Google Drive del emisor.
-- No es la fuente de verdad (eso sigue siendo invoices/invoice_items + ARCA),
-- solo guarda el link para acceso rápido si se subió con éxito.

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS drive_file_url text;

COMMENT ON COLUMN public.invoices.drive_file_url IS
  'URL del PDF de la factura respaldado en Google Drive (best-effort, puede ser null si falló la subida o no se intentó).';
