const GZ_BASE = "http://127.0.0.1:8785";

export type GzPrintJob =
  | string
  | {
      type: "raw";
      format: "image";
      flavor: "file";
      data: string;
      options?: { language: string };
    };

async function gzRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${GZ_BASE}${path}`, init);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`GZ agent HTTP ${res.status}${body ? `: ${body}` : ""}`);
  }
  return (await res.json()) as T;
}

export async function connectGzAgent(): Promise<void> {
  try {
    await gzRequest<{ ok?: boolean }>("/status");
  } catch {
    throw new Error(
      "No se pudo conectar con el agente GZ en http://127.0.0.1:8785. Verificá que gz-agent.exe esté corriendo en esta PC."
    );
  }
}

export async function getGzDefaultPrinter(): Promise<string> {
  const data = await gzRequest<{ default?: string; printers?: string[] }>("/printers");
  if (!data.default) {
    throw new Error("No hay impresora predeterminada configurada en Windows.");
  }
  return data.default;
}

export async function printWithGz(printer: string, jobs: GzPrintJob[]): Promise<void> {
  await gzRequest("/print", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ printer, jobs }),
  });
}

export async function printEscposTicketWithGz(opts: {
  ticketText: string;
  qrUrl?: string | null;
}): Promise<void> {
  await connectGzAgent();
  const printer = await getGzDefaultPrinter();
  const jobs: GzPrintJob[] = ["\x1B\x40", `${opts.ticketText}\n\n`];

  if (opts.qrUrl) {
    const size = 180;
    const qrApiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&margin=10&data=${encodeURIComponent(opts.qrUrl)}`;
    jobs.push("\x1B\x61\x01");
    jobs.push({
      type: "raw",
      format: "image",
      flavor: "file",
      data: qrApiUrl,
      options: { language: "ESCPOS" },
    });
    jobs.push("\x1B\x64\x03");
    jobs.push("\x1B\x61\x00");
  }

  jobs.push("\x1D\x56\x42\x00");
  await printWithGz(printer, jobs);
}
