"use client";

import { useState } from "react";

import { FAQ_ITEMS } from "@/lib/constants/faq";

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
