import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import HowtoTabs from "@/components/howto/HowtoTabs";

export const metadata: Metadata = {
  title: "Quiénes somos | FYL Moda",
  description:
    "Somos un mayorista familiar de calzado e indumentaria con fábrica propia. Enviamos a todo el país.",
};

export default function QuienesSomosPage() {
  return (
    <main className="howto about-fyl" aria-label="Quiénes somos">
      <section
        className="howto-hero about-fyl__hero"
        aria-labelledby="about-fyl-title"
      >
        <Suspense>
          <HowtoTabs />
        </Suspense>
        <article className="info-card about-fyl__mainCard">
          <div className="about-fyl__eyebrow">FYL Moda</div>
          <h2 id="about-fyl-title">Quiénes somos</h2>
          <p className="about-fyl__subtitle">
            Mayorista para revendedoras de todo el país.
          </p>
        </article>
      </section>

      <section className="howto-section" aria-label="Presentación">
        <article className="info-card about-fyl__intro">
          <p>
            Somos una empresa familiar especializada en venta mayorista de
            calzado e indumentaria. Trabajamos todos los días para acompañar el
            crecimiento de revendedoras y negocios en todo el país.
          </p>
          <p>
            Contamos con fábrica propia de calzado, lo que nos permite ofrecer
            stock constante, variedad y respuesta rápida en cada pedido.
          </p>
        </article>
      </section>

      <section
        className="howto-section about-fyl__block"
        aria-label="Por qué elegir FYL"
      >
        <div className="howto-section__head">
          <h2>Por qué elegir FYL</h2>
        </div>
        <ul
          className="about-fyl__list about-fyl__list--strong"
          aria-label="Por qué elegir FYL"
        >
          <li className="about-fyl__li">
            <span className="about-fyl__check" aria-hidden="true">✔</span>
            Gran variedad de modelos, talles y colores
          </li>
          <li className="about-fyl__li">
            <span className="about-fyl__check" aria-hidden="true">✔</span>
            Pedido flexible: combiná modelos y talles
          </li>
          <li className="about-fyl__li">
            <span className="about-fyl__check" aria-hidden="true">✔</span>
            Compra mínima accesible
          </li>
          <li className="about-fyl__li">
            <span className="about-fyl__check" aria-hidden="true">✔</span>
            Confirmación de stock antes del envío
          </li>
          <li className="about-fyl__li">
            <span className="about-fyl__check" aria-hidden="true">✔</span>
            Atención directa y rápida
          </li>
        </ul>
      </section>

      <section className="howto-section" aria-label="Ubicación">
        <div className="howto-section__head">
          <h2>Dónde estamos</h2>
          <p className="muted">Dirección real y acceso directo a Maps.</p>
        </div>
        <article className="info-card about-fyl__location">
          <div className="about-fyl__locationRow">
            <div className="about-fyl__pin" aria-hidden="true">📍</div>
            <div className="about-fyl__locationBody">
              <div className="about-fyl__address">
                Av. Alberdi 1099, Resistencia, Chaco
              </div>
              <div className="muted">
                Podés abrir la ubicación directamente en Google Maps.
              </div>
            </div>
          </div>
          <a
            className="about-fyl__mapLink"
            href="https://maps.app.goo.gl/PoxAhU5AG3m2etSz5"
            target="_blank"
            rel="noopener noreferrer"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/nj/assets/maps/mapa-fyl.jpg"
              alt="Ubicación FYL Moda"
              className="map-preview"
            />
          </a>
          <a
            className="btn btn-primary about-fyl__mapsBtn"
            href="https://maps.app.goo.gl/PoxAhU5AG3m2etSz5"
            target="_blank"
            rel="noopener noreferrer"
          >
            Abrir en Maps
          </a>
        </article>
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

      <section className="howto-final about-fyl__final" aria-label="Acción final">
        <h2>¿Querés empezar?</h2>
        <Link href="/como-comprar" className="btn btn-ghost btn-wide">
          Ver cómo comprar
        </Link>
      </section>
    </main>
  );
}
