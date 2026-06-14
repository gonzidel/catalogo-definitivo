import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import HowtoTabs from "@/components/howto/HowtoTabs";
import FaqSection from "@/components/howto/FaqSection";
import { BASE_PATH } from "@/lib/constants/app";

export const metadata: Metadata = {
  title: "Cómo usar el catálogo | FYL Moda",
  description:
    "Explorá productos, revisá stock, descargá fotos y consultanos por WhatsApp para coordinar tu pedido.",
};

export default function ComoComprarPage() {
  return (
    <main className="howto" aria-label="Cómo usar el catálogo">
      <section className="howto-hero" aria-labelledby="howto-title">
        <Suspense>
          <HowtoTabs />
        </Suspense>
        <h2 id="howto-title">Cómo usar el catálogo</h2>
        <p className="howto-hero__lead">
          Explorá productos, revisá stock, descargá fotos y consultanos por
          WhatsApp para coordinar tu pedido.
        </p>
      </section>

      <section
        className="howto-section"
        id="howto-steps"
        aria-labelledby="howto-steps-title"
      >
        <div className="howto-section__head">
          <h2 id="howto-steps-title">Cómo hacer tu pedido</h2>
        </div>
        <ol className="steps" aria-label="Pasos para comprar">
          <li className="step">
            <div className="step__num">1</div>
            <div className="step__body">
              <h3>Elegí los modelos que querés vender</h3>
              <p>Explorá el catálogo y revisá fotos, talles y stock disponible</p>
            </div>
          </li>
          <li className="step">
            <div className="step__num">2</div>
            <div className="step__body">
              <h3>Prepará tus ventas con las fotos</h3>
              <p>Podés descargar o compartir imágenes con tus clientas</p>
            </div>
          </li>
          <li className="step">
            <div className="step__num">3</div>
            <div className="step__body">
              <h3>Consultanos por WhatsApp</h3>
              <p>Te ayudamos a armar y confirmar tu pedido</p>
            </div>
          </li>
        </ol>
        <div className="howto-hero__actions">
          <Link href="/" className="btn btn-primary btn-wide">
            Volver al catálogo
          </Link>
        </div>
      </section>

      <section
        className="howto-section"
        id="howto-notes"
        aria-labelledby="howto-notes-title"
      >
        <div className="howto-section__head">
          <h2 id="howto-notes-title">Antes de hacer tu pedido</h2>
          <p className="muted">Datos importantes para comprar</p>
        </div>
        <div className="cards">
          <article className="info-card">
            <h3>Stock disponible</h3>
            <p>Podés ver qué hay disponible antes de consultar</p>
          </article>
          <article className="info-card">
            <h3>Envíos a todo el país</h3>
            <p>
              Hacemos envíos a todo el país. También podés retirar en
              Resistencia con coordinación previa
            </p>
            <p>Resistencia, Chaco.</p>
          </article>
          <article className="info-card">
            <h3>Pagos simples</h3>
            <p>Transferencia o contra reembolso según tu localidad</p>
          </article>
        </div>
      </section>

      <FaqSection />

      <section className="howto-final" aria-label="Acción final">
        <h2>¿Querés consultar un modelo?</h2>
        <p className="muted">
          Entrá al catálogo, elegí el producto y escribinos por WhatsApp.
        </p>
        <Link href="/" className="btn btn-primary btn-wide">
          Ver catálogo
        </Link>
      </section>

      <section className="howto-section" aria-label="Redes sociales">
        <div className="howto-section__head">
          <h2>Seguinos en redes</h2>
          <p className="muted">
            Novedades, productos y contenido para revendedoras.
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
              <img src={`${BASE_PATH}/assets/icons/instagram.svg`} alt="Instagram" />
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
              <img src={`${BASE_PATH}/assets/icons/facebook.svg`} alt="Facebook" />
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
