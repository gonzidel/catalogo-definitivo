"use client";

import { useState } from "react";

interface FaqItem {
  q: string;
  a: React.ReactNode;
}

const FAQ_ITEMS: FaqItem[] = [
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
