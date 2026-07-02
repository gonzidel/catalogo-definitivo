import { Router, Request, Response } from "express";
import { createClient } from "@supabase/supabase-js";
import { authMiddleware } from "../middleware/auth";
import { emitirFactura } from "../services/arcaService";
import { generatePdf } from "../services/pdfService";
import { uploadInvoiceToDrive } from "../services/driveService";

const router = Router();
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

router.post(
  "/generate",
  authMiddleware,
  async (req: Request, res: Response): Promise<void> => {
    try {
      const adminUserId = (req as Request & { adminUserId?: string })
        .adminUserId;
      if (!adminUserId) {
        res.status(401).json({ error: "Sin usuario admin" });
        return;
      }

      const result = await emitirFactura(req.body, adminUserId);
      const pdfBuffer = await generatePdf(result.invoiceData, result.caeResult);

      const {
        cbteLetra,
        puntoVenta,
        cbteNro,
        date,
        customerName: cName,
      } = result.invoiceData;
      const ptoStr = String(puntoVenta).padStart(4, "0");
      const nroStr = String(cbteNro).padStart(8, "0");
      const safeNombre = String(cName ?? "").replace(/[^a-zA-Z0-9_-]/g, "_");
      const nombreArchivo = `Factura_${cbteLetra}_${ptoStr}-${nroStr}_${date}_${safeNombre}.pdf`;

      // Respaldo en Google Drive: best-effort, nunca bloquea la descarga del PDF.
      // Si ya se había subido antes (reimpresión), no se vuelve a subir.
      let driveUploadStatus: "ok" | "failed" | "skipped" = "skipped";
      if (!result.driveFileUrl) {
        try {
          const driveUrl = await uploadInvoiceToDrive(pdfBuffer, nombreArchivo, date);
          await supabase
            .from("invoices")
            .update({ drive_file_url: driveUrl })
            .eq("id", result.invoiceId);
          driveUploadStatus = "ok";
        } catch (driveErr: unknown) {
          const driveMessage =
            driveErr instanceof Error ? driveErr.message : String(driveErr);
          console.error("[/generate] Error subiendo a Google Drive:", driveMessage);
          driveUploadStatus = "failed";
        }
      }

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${nombreArchivo}"`
      );
      res.setHeader("X-Drive-Upload", driveUploadStatus);
      res.send(pdfBuffer);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[/generate]", err);
      res.status(500).json({ error: message });
    }
  }
);

export default router;
