import { google } from "googleapis";
import { Readable } from "stream";
import { withMutex } from "../utils/mutex";

let driveClient: ReturnType<typeof google.drive> | null = null;

function getDrive() {
  if (driveClient) return driveClient;

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Faltan variables de entorno de Google Drive (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN)"
    );
  }

  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
  oauth2Client.setCredentials({ refresh_token: refreshToken });

  driveClient = google.drive({ version: "v3", auth: oauth2Client });
  return driveClient;
}

// "20260712" -> "2026-07-12" (ordena bien alfabéticamente en Drive, a diferencia de DD-MM-YYYY)
function formatFolderNameFromYYYYMMDD(dateYYYYMMDD: string): string {
  const y = dateYYYYMMDD.slice(0, 4);
  const m = dateYYYYMMDD.slice(4, 6);
  const d = dateYYYYMMDD.slice(6, 8);
  return `${y}-${m}-${d}`;
}

// Busca (o crea, si no existe) la subcarpeta del día dentro de la carpeta raíz de
// facturas. Con mutex por fecha para que dos facturaciones simultáneas del mismo
// día no terminen creando dos carpetas duplicadas.
async function getOrCreateDailyFolder(
  parentFolderId: string,
  dateYYYYMMDD: string
): Promise<string> {
  const folderName = formatFolderNameFromYYYYMMDD(dateYYYYMMDD);

  return withMutex(`drive-folder-${parentFolderId}-${folderName}`, async () => {
    const drive = getDrive();

    const escapedName = folderName.replace(/'/g, "\\'");
    const list = await drive.files.list({
      q:
        `'${parentFolderId}' in parents and name = '${escapedName}' ` +
        `and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
      fields: "files(id, name)",
      spaces: "drive",
    });

    const existing = list.data.files?.[0];
    if (existing?.id) return existing.id;

    const created = await drive.files.create({
      requestBody: {
        name: folderName,
        mimeType: "application/vnd.google-apps.folder",
        parents: [parentFolderId],
      },
      fields: "id",
    });

    if (!created.data.id) {
      throw new Error(`No se pudo crear la carpeta del día ${folderName} en Drive`);
    }
    return created.data.id;
  });
}

// Respaldo best-effort: si falla, el llamador debe capturar el error y seguir
// (la descarga local del PDF nunca depende de que esto funcione).
// Sube dentro de GOOGLE_DRIVE_FOLDER_ID/{YYYY-MM-DD}/ según la fecha del comprobante
// (no la fecha de hoy — así una reimpresión de una factura vieja va a su día real).
export async function uploadInvoiceToDrive(
  pdfBuffer: Buffer,
  filename: string,
  dateYYYYMMDD: string
): Promise<string> {
  const drive = getDrive();
  const rootFolderId = process.env.GOOGLE_DRIVE_FOLDER_ID;

  const parentId = rootFolderId
    ? await getOrCreateDailyFolder(rootFolderId, dateYYYYMMDD)
    : undefined;

  const res = await drive.files.create({
    requestBody: {
      name: filename,
      parents: parentId ? [parentId] : undefined,
    },
    media: {
      mimeType: "application/pdf",
      body: Readable.from(pdfBuffer),
    },
    fields: "id, webViewLink",
  });

  const fileId = res.data.id;
  const webViewLink = res.data.webViewLink;
  if (!fileId) {
    throw new Error("Google Drive no devolvió un ID de archivo");
  }

  return webViewLink || `https://drive.google.com/file/d/${fileId}/view`;
}
