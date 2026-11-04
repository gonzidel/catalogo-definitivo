/** Formato / validación de celular AR (+54 9), paridad ProfileOnboardingModal. */

export function formatPhoneInput(value: string): string {
  let digits = String(value || "").replace(/\D/g, "");
  if (digits.length > 10) digits = digits.slice(0, 10);
  if (digits.length === 0) return "";
  if (digits.length <= 3) return digits;
  if (digits.length <= 6) return `${digits.slice(0, 3)} ${digits.slice(3)}`;
  return `${digits.slice(0, 3)} ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

export function formatPhoneE164(phoneRaw: string): string {
  let cleaned = phoneRaw.replace(/[\s\-()]/g, "");
  if (cleaned.length >= 8) cleaned = `9${cleaned}`;
  if (cleaned.length >= 10) {
    const match = cleaned.match(/^9(\d{2,4})(\d{6,8})$/);
    if (match) {
      const area = match[1];
      const number = match[2];
      const formatted =
        number.length > 4
          ? `${number.slice(0, -4)}-${number.slice(-4)}`
          : number;
      return `+54 9 ${area} ${formatted}`;
    }
  }
  return `+54 9 ${cleaned}`;
}

export function validatePhone(phoneRaw: string): boolean {
  const cleaned = phoneRaw.replace(/[\s\-()]/g, "");
  return /^\d{8,10}$/.test(cleaned);
}

/** Digitos del área+número sin +54 9, para precargar la celda editable. */
export function phoneToLocalInput(phone: string | null | undefined): string {
  const digits = String(phone || "").replace(/\D/g, "");
  if (!digits) return "";
  // +54 9 XXXXXXXXXX → quitar 54 y el 9 móvil
  let local = digits;
  if (local.startsWith("54")) local = local.slice(2);
  if (local.startsWith("9") && local.length >= 9) local = local.slice(1);
  return formatPhoneInput(local.slice(0, 10));
}
