import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import HowtoTabs from "@/components/howto/HowtoTabs";
import FaqSection from "@/components/howto/FaqSection";
import { PurchaseFlowInline } from "@/components/guide/PurchaseFlowGuide";
import { PurchaseGuideButton } from "@/components/guide/PurchaseGuideClient";

export const metadata: Metadata = {
  title: "Cómo comprar | FYL Moda",
  description:
    "Comprá por mayor en 4 pasos. Mínimo 4 productos combinables. Enviamos a todo el país.",
};

export default function ComoComprarPage() {
  return (
    <main className="howto" aria-label="Cómo comprar por mayor">
      <section className="howto-hero" aria-labelledby="howto-title">
        <Suspense>
          <HowtoTabs />
        </Suspense>
        <h2 id="howto-title">Cómo comprar por mayor</h2>
        <p className="howto-hero__lead">
          Mínimo 4 productos combinables. Armás tu pedido, lo cerrás
          cuando esté listo y coordinamos pago, envío o retiro por fuera de la web.
        </p>
        <div className="howto-quick-guide">
          <PurchaseFlowInline current="cart" />
          <PurchaseGuideButton />
        </div>
      </section>

      <section
        className="howto-section"
        id="howto-steps"
        aria-labelledby="howto-steps-title"
      >
        <div className="howto-section__head">
          <h2 id="howto-steps-title">Comprá en 4 pasos</h2>
          <p className="muted">
            No pagás por la web: cerrás el pedido y coordinamos después.
          </p>
        </div>
        <ol className="steps" aria-label="Pasos para comprar">
          <li className="step">
            <div className="step__num">1</div>
            <div className="step__body">
              <h3>Armá tu carrito</h3>
              <p>Elegí modelos, talles y colores. Podés combinar lo que quieras.</p>
            </div>
          </li>
          <li className="step">
            <div className="step__num">2</div>
            <div className="step__body">
              <h3>Armá tu pedido</h3>
              <p>
                Para pasar el carrito a tu cuenta, presioná "Armar mi pedido".
                Todavía no se envía ni se paga.
              </p>
            </div>
          </li>
          <li className="step">
            <div className="step__num">3</div>
            <div className="step__body">
              <h3>Sumá productos hasta 7 días</h3>
              <p>
                Podés seguir agregando productos a tu pedido durante 7 días sin
                costo. Cuando llegues al mínimo de 4 unidades, cerralo para que
                lo preparemos.
              </p>
            </div>
          </li>
          <li className="step">
            <div className="step__num">4</div>
            <div className="step__body">
              <h3>Coordinamos pago y retiro/envío</h3>
              <p>Una vez cerrado tu pedido, coordinamos el pago y cómo lo recibís o retirás.</p>
            </div>
          </li>
        </ol>
        <div className="howto-hero__actions">
          <Link href="/" className="btn btn-primary btn-wide">
            Empezar a comprar
          </Link>
        </div>
      </section>

      <section
        className="howto-section"
        id="howto-notes"
        aria-labelledby="howto-notes-title"
      >
        <div className="howto-section__head">
          <h2 id="howto-notes-title">Aclaraciones importantes</h2>
          <p className="muted">Condiciones que te conviene tener en cuenta.</p>
        </div>
        <div className="cards">
          <article className="info-card">
            <h3>Pedido y stock</h3>
            <p>
              El pedido queda abierto al presionar "Armar mi pedido".
              Si algún producto no tiene stock, te avisamos para que puedas
              cambiarlo o quitarlo.
            </p>
          </article>
          <article className="info-card">
            <h3>Envíos y retiro</h3>
            <p>
              Hacemos envíos a todo el país. También podés retirar en el local,
              pero coordiná con nosotros antes de venir.
            </p>
            <p>Av. Alberdi 1099, Resistencia, Chaco.</p>
          </article>
          <article className="info-card">
            <h3>Medios de pago</h3>
            <p>
              Transferencia o contra reembolso según localidad. Si pagás con
              tarjeta puede haber un recargo; te lo indicamos por WhatsApp.
            </p>
          </article>
        </div>
      </section>

      <FaqSection />

      <section className="howto-final" aria-label="Acción final">
        <h2>¿Lista para armar tu pedido?</h2>
        <p className="muted">
          Entrá al catálogo, elegí tus productos y cerrá el pedido cuando
          llegues al mínimo.
        </p>
        <Link href="/" className="btn btn-primary btn-wide">
          Ir al catálogo
        </Link>
      </section>

      <section className="howto-section" aria-label="Redes sociales">
        <div className="howto-section__head">
          <h2>Nuestras redes</h2>
          <p className="muted">
            Podés ver nuestros productos y cómo trabajamos en nuestras redes.
          </p>
        </div>
        <div className="about-fyl__socialActions" aria-label="Acciones de redes">
          <a
            className="btn about-fyl__socialBtn about-fyl__socialBtn--ig"
            href="https://www.instagram.com/fylmodaok/"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Abrir Instagram @fylmodaok"
          >
            <span className="about-fyl__socialIcon">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/nj/assets/icons/instagram.svg" alt="Instagram" />
            </span>
            <span className="about-fyl__socialText">
              <span className="about-fyl__socialLabel">Instagram</span>
              <span className="about-fyl__socialHandle">@fylmodaok</span>
            </span>
            <span className="about-fyl__socialGo" aria-hidden="true">↗</span>
          </a>
          <a
            className="btn about-fyl__socialBtn about-fyl__socialBtn--fb"
            href="https://www.facebook.com/FyLcalzados1"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Abrir Facebook FyL Calzados"
          >
            <span className="about-fyl__socialIcon">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/nj/assets/icons/facebook.svg" alt="Facebook" />
            </span>
            <span className="about-fyl__socialText">
              <span className="about-fyl__socialLabel">Facebook</span>
              <span className="about-fyl__socialHandle">FyL Calzados</span>
            </span>
            <span className="about-fyl__socialGo" aria-hidden="true">↗</span>
          </a>
        </div>
      </section>
    </main>
  );
}
