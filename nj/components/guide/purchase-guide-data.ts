export type FlowStepId = "cart" | "open" | "close" | "coordinate";

export const FLOW_STEPS: Array<{
  id: FlowStepId;
  label: string;
  title: string;
  text: string;
}> = [
  {
    id: "cart",
    label: "Carrito",
    title: "Elegís productos",
    text: "Agregá modelos, colores y talles. El carrito todavía no crea un pedido.",
  },
  {
    id: "open",
    label: "Mi pedido",
    title: "Armás tu pedido",
    text: "Tu carrito pasa a Mi pedido. No se envía ni se paga todavía: podés revisarlo y seguir sumando.",
  },
  {
    id: "close",
    label: "Cerrar",
    title: "Cerrás cuando esté listo",
    text: "Cuando llegues al mínimo y ya no quieras sumar productos, cerrás el pedido.",
  },
  {
    id: "coordinate",
    label: "Retiro/envío",
    title: "Coordinamos pago y retiro/envío",
    text: "Después coordinamos pago, envío o retiro por fuera de la web.",
  },
];

export function stepIndex(step: FlowStepId) {
  return Math.max(0, FLOW_STEPS.findIndex((s) => s.id === step));
}
