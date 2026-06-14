"use client";

import { useState } from "react";

const FAQ_ITEMS = [
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

export default function FaqSection() {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  return (
    <section className="howto-section" id="howto-faq" aria-labelledby="howto-faq-title">
      <div className="howto-section__head">
        <h2 id="howto-faq-title">Preguntas frecuentes</h2>
      </div>
      <div className="faq" role="region" aria-label="Preguntas frecuentes">
        {FAQ_ITEMS.map((item, i) => {
          const open = openIndex === i;
          return (
            <div className="faq-item" key={i}>
              <button
                className="faq-q"
                type="button"
                aria-expanded={open}
                onClick={() => setOpenIndex(open ? null : i)}
              >
                {item.q}{" "}
                <span className="faq-icon" aria-hidden="true">
                  {open ? "−" : "+"}
                </span>
              </button>
              {open && <div className="faq-a">{item.a}</div>}
            </div>
          );
        })}
      </div>
    </section>
  );
}
