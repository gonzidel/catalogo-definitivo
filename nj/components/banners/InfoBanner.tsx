import Link from "next/link";

export default function InfoBanner() {
  return (
    <div id="info-banner-top-container">
      <Link
        href="/como-comprar"
        className="info-banner-top info-banner-top--visual"
        aria-label="Guía de compra mayorista"
      >
        <div className="info-banner-top__inner">
          <div className="info-banner-top__iconWrap" aria-hidden="true">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              className="info-banner-top__icon"
              src="/nj/assets/icono-carrito-x4.png"
              alt=""
              loading="lazy"
              decoding="async"
            />
          </div>
          <div className="info-banner-top__content">
            <h3 className="info-banner-top__title">
              <span className="info-banner-top__title-main">COMPRA MÍNIMA</span>
              <strong>4 productos combinables</strong>
            </h3>
            <p className="info-banner-top__line">
              Tenés hasta 7 días para armar tu pedido
            </p>
            <span className="info-banner-top__cta">
              Guía de compra{" "}
              <span className="info-banner-top__cta-arrow" aria-hidden="true">
                ➜
              </span>
            </span>
          </div>
        </div>
      </Link>
    </div>
  );
}
