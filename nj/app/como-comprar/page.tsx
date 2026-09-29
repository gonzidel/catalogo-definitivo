import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import HowtoTabs from "@/components/howto/HowtoTabs";
import FaqSection from "@/components/howto/FaqSection";
import { PurchaseFlowInline } from "@/components/guide/PurchaseFlowGuide";
import { PurchaseGuideButton } from "@/components/guide/PurchaseGuideClient";
import JsonLdScript from "@/lib/seo/JsonLdScript";
import { faqJsonLd } from "@/lib/seo/json-ld";
import { CATALOG_FAQ_ITEMS, FULL_FAQ_ITEMS } from "@/lib/constants/faq";
import { EXP_CATALOG_ONLY, EXP_FULL_ONLY } from "@/lib/rollout/client";

// Metadata y FAQ JSON-LD de catalog: es la variante que ven los crawlers (sin cookie full).
export const metadata: Metadata = {
  title: "Cómo usar el catálogo | FYL Moda",
  description:
    "Explorá productos, revisá stock, descargá fotos y consultanos por WhatsApp para coordinar tu pedido.",
  alternates: { canonical: "/como-comprar" },
};

function CatalogHowto() {
  return (
    <div className={EXP_CATALOG_ONLY} style={{ display: "contents" }}>
      <section className="howto-hero" aria-labelledby="howto-title-catalog">
        <Suspense>
          <HowtoTabs />
        </Suspense>
        <h2 id="howto-title-catalog">Cómo usar el catálogo</h2>
        <p className="howto-hero__lead">
          Explorá productos, revisá stock, descargá fotos y consultanos por
          WhatsApp para coordinar tu pedido.
        </p>
      </section>

      <section className="howto-section" aria-labelledby="howto-steps-title-catalog">
        <div className="howto-section__head">
          <h2 id="howto-steps-title-catalog">Cómo hacer tu pedido</h2>
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

      <section className="howto-section" aria-labelledby="howto-notes-title-catalog">
        <div className="howto-section__head">
          <h2 id="howto-notes-title-catalog">Antes de hacer tu pedido</h2>
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

      <FaqSection items={CATALOG_FAQ_ITEMS} id="howto-faq-catalog" />

      <section className="howto-final" aria-label="Acción final">
        <h2>¿Querés consultar un modelo?</h2>
        <p className="muted">
          Entrá al catálogo, elegí el producto y escribinos por WhatsApp.
        </p>
        <Link href="/" className="btn btn-primary btn-wide">
          Ver catálogo
        </Link>
      </section>
    </div>
  );
}

function FullHowto() {
  return (
    <div className={EXP_FULL_ONLY} style={{ display: "contents" }}>
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

      <FaqSection items={FULL_FAQ_ITEMS} />

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
    </div>
  );
}

export default function ComoComprarPage() {
  return (
    <main className="howto" aria-label="Cómo comprar por mayor">
      <JsonLdScript
        data={faqJsonLd(CATALOG_FAQ_ITEMS.map((item) => ({ question: item.q, answer: item.a })))}
      />
      <CatalogHowto />
      <FullHowto />

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
              <img src="/assets/icons/instagram.svg" alt="Instagram" />
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
              <img src="/assets/icons/facebook.svg" alt="Facebook" />
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
