/** Campos mínimos exigidos al crear cuenta (alineado con client/auth-helper.js). */
export const INITIAL_PROFILE_REQUIRED_FIELDS = [
  "full_name",
  "phone",
  "dni",
  "province",
  "city",
  "address",
] as const;

export type InitialProfileField = (typeof INITIAL_PROFILE_REQUIRED_FIELDS)[number];

export type ProfileCompletenessSource = Partial<
  Record<InitialProfileField, string | null | undefined>
> | null | undefined;

export function isInitialProfileComplete(
  customer: ProfileCompletenessSource
): boolean {
  if (!customer) return false;
  return INITIAL_PROFILE_REQUIRED_FIELDS.every((field) => {
    const value = customer[field];
    return value != null && String(value).trim() !== "";
  });
}

export function missingInitialProfileFields(
  customer: ProfileCompletenessSource
): InitialProfileField[] {
  if (!customer) return [...INITIAL_PROFILE_REQUIRED_FIELDS];
  return INITIAL_PROFILE_REQUIRED_FIELDS.filter((field) => {
    const value = customer[field];
    return value == null || String(value).trim() === "";
  });
}
