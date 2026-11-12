const STORAGE_KEY = "fyl_search_hint_v1";

/**
 * Aviso chico de "buscador mejorado" debajo de la barra de busqueda.
 * Se oculta para siempre apenas el cliente lo cierra o hace una
 * busqueda real (ya descubrio que funciona).
 */
export function isSearchHintDismissed(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return true;
  }
}

export function dismissSearchHint(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, "1");
  } catch {
    /* private mode */
  }
}
