import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import HowtoTabs from "@/components/howto/HowtoTabs";
import FaqSection from "@/components/howto/FaqSection";

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
          Mínimo 4 productos combinables. Armás tu pedido, lo enviás para
          reserva y te confirmamos stock.
        </p>
      </section>

      <section
        className="howto-section"
        id="howto-steps"
        aria-labelledby="howto-steps-title"
      >
        <div className="howto-section__head">
          <h2 id="howto-steps-title">Comprá en 4 pasos</h2>
          <p className="muted">
            No pagás por la web: enviás el pedido y coordinamos después.
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
              <h3>Enviá el pedido para reserva</h3>
              <p>
                Para reservar tu carrito, presioná "Hacer pedido" y así
                separamos tus productos. (Te avisamos si algo no queda en
                stock).
              </p>
            </div>
          </li>
          <li className="step">
            <div className="step__num">3</div>
            <div className="step__body">
              <h3>Sumá productos hasta 7 días</h3>
              <p>
                Podés seguir agregando productos a tu pedido durante 7 días sin
                costo. (Recordá que el mínimo de compra es de 4 productos).
              </p>
            </div>
          </li>
          <li className="step">
            <div className="step__num">4</div>
            <div className="step__body">
              <h3>Coordinamos envío y pago</h3>
              <p>Una vez finalizado tu pedido, coordinamos el envío y el pago.</p>
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
            <h3>Reserva y stock</h3>
            <p>
              El pedido se reserva al presionar "Hacer pedido". Si algún
              producto no tiene stock, te avisamos para que puedas cambiarlo o
              quitarlo.
            </p>
          </article>
          <article className="info-card">
            <h3>Envíos y retiro</h3>
            <p>
              Hacemos envíos a todo el país. También podés retirar en el local,
              pero esperá nuestra confirmación antes de venir.
            </p>
            <p>Av. Alberdi 1099, Resistencia, Chaco.</p>
          </article>
          <article className="info-card">
            <h3>Medios de pago</h3>
            <p>
              Transferencia o contra reembolso según localidad. Si pagás con
              tarjeta puede haber un recargo; te lo indicamos al confirmar.
            </p>
          </article>
        </div>
      </section>

      <FaqSection />

      <section className="howto-final" aria-label="Acción final">
        <h2>¿Lista para armar tu pedido?</h2>
        <p className="muted">
          Entrá al catálogo, elegí tus productos y enviá el pedido cuando
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
