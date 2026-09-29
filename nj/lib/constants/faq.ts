export interface FaqItem {
  q: string;
  a: string;
}

/** Experiencia full: pedido online con carrito. */
export const FULL_FAQ_ITEMS: FaqItem[] = [
  {
    q: "¿Puedo combinar modelos, talles y colores?",
    a: "Sí. El mínimo es 4 productos y los combinás como quieras.",
  },
  {
    q: "¿Qué pasa si un producto no hay en stock?",
    a: "Te avisamos por WhatsApp y podés reemplazarlo por otro disponible.",
  },
  {
    q: "¿Qué pasa después de cerrar mi pedido?",
    a: "Lo preparamos para coordinar pago y envío. Si surge algún faltante, te avisamos por WhatsApp.",
  },
  {
    q: "¿Hay cambios o devoluciones?",
    a: "Consultalo con nosotros por WhatsApp; te pasamos la política según el producto y el caso.",
  },
];

/** Experiencia catalog: pedido por WhatsApp (textos de catalogo1). */
export const CATALOG_FAQ_ITEMS: FaqItem[] = [
  {
    q: "¿Cómo hago un pedido?",
    a: "Elegís los modelos y nos escribís por WhatsApp. Te ayudamos a armar y confirmar tu pedido.",
  },
  {
    q: "¿Puedo consultar varios modelos juntos?",
    a: "Sí, podés consultar todos los modelos que quieras en un mismo mensaje.",
  },
  {
    q: "¿Qué pasa si un producto no está disponible?",
    a: "Te avisamos al momento de confirmar y podés elegir otro modelo disponible.",
  },
  {
    q: "¿Hacen envíos a todo el país?",
    a: "Sí, hacemos envíos a todo el país o podés retirar en Resistencia coordinando previamente.",
  },
  {
    q: "¿Cómo se coordinan los pedidos?",
    a: "Los pedidos se coordinan directamente por WhatsApp para confirmar stock y envío.",
  },
  {
    q: "¿Hay cambios o devoluciones?",
    a: "Las condiciones se confirman según el producto al momento de tu pedido.",
  },
];
