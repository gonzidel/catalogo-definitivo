/**
 * TEMPORAL — Cyber Monday / mínimo 1
 *
 * Poner todos los flags en `false` y redeployar para volver al comportamiento
 * original (mínimo 4, recomendados solo si falta mínimo, textos "4 productos",
 * banner COMPRA MÍNIMA con icono-carrito-x4).
 *
 * La regla CANÓNICA del negocio sigue siendo 4 productos surtidos
 * (docs/02_MODELO_NEGOCIO.md). Esto es EN EVALUACIÓN / temporal.
 */

/** false = vuelve el mínimo 4 (salvo zona retiro local corto, que ya es 1). */
export const TEMP_MIN_ONE_ENABLED = true;

/** false = recomendados solo si falta mínimo (o retiro diferido). */
export const TEMP_RECOMMENDED_ALWAYS_ON = true;

/** false = textos públicos con mínimo 4. */
export const TEMP_PUBLIC_COPY_MIN_ONE = true;

/** false = banner original "COMPRA MÍNIMA / 4 productos combinables". */
export const TEMP_CYBER_BANNER = true;

/** Copys públicos temporales (solo se usan si TEMP_PUBLIC_COPY_MIN_ONE). */
export const TEMP_PUBLIC_COPY = {
  howtoLead:
    "Podés comprar desde 1 producto. Armás tu pedido, lo cerrás cuando esté listo y coordinamos pago, envío o retiro por fuera de la web.",
  howtoStep3:
    "Podés seguir agregando productos a tu pedido durante 7 días sin costo. Cuando tengas todo lo que querés, cerralo para que lo preparemos.",
  howtoFinalCta:
    "Entrá al catálogo, elegí tus productos y cerrá el pedido cuando quieras.",
  guideCloseStep:
    "Cuando ya no quieras sumar productos, cerrás el pedido. Podés cerrarlo desde 1 producto.",
  faqCombine:
    "Sí. Podés comprar desde 1 producto y combinar lo que quieras.",
  seoMinPhrase: "compra mínima de 1 producto",
} as const;

export const TEMP_PUBLIC_COPY_ORIGINAL = {
  howtoLead:
    "Mínimo 4 productos combinables. Armás tu pedido, lo cerrás cuando esté listo y coordinamos pago, envío o retiro por fuera de la web.",
  howtoStep3:
    "Podés seguir agregando productos a tu pedido durante 7 días sin costo. Cuando llegues al mínimo de 4 unidades, cerralo para que lo preparemos.",
  howtoFinalCta:
    "Entrá al catálogo, elegí tus productos y cerrá el pedido cuando llegues al mínimo.",
  guideCloseStep:
    "Cuando llegues al mínimo y ya no quieras sumar productos, cerrás el pedido.",
  faqCombine: "Sí. El mínimo es 4 productos y los combinás como quieras.",
  seoMinPhrase: "compra mínima de 4 productos surtidos",
} as const;

export function getPublicMinCopy() {
  return TEMP_PUBLIC_COPY_MIN_ONE ? TEMP_PUBLIC_COPY : TEMP_PUBLIC_COPY_ORIGINAL;
}

export const TEMP_CYBER_BANNER_COPY = {
  label: "CYBER MONDAY",
  title: "Comprá por mayor desde 1 producto",
  lineFull: "Bajamos el mínimo de compra. Tenés 7 días para sumar más.",
  lineCatalog: "Consultá por WhatsApp y coordinamos tu pedido",
  cta: "Cómo comprar",
  ariaLabel: "Cyber Monday: comprá por mayor desde 1 producto",
  iconSrc: "/assets/icono-cybermonday.webp",
} as const;
