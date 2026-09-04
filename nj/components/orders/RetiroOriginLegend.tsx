"use client";

/** Leyenda de colores de origen en Activos (solo Retiro). */
export default function RetiroOriginLegend() {
  return (
    <div className="retiro-origin-legend" aria-label="Origen del pedido">
      <span className="retiro-origin-legend__item">
        <span className="retiro-origin-legend__swatch retiro-origin-legend__swatch--customer" />
        Clienta
      </span>
      <span className="retiro-origin-legend__item">
        <span className="retiro-origin-legend__swatch retiro-origin-legend__swatch--moved" />
        Desde Pedidos
      </span>
      <span className="retiro-origin-legend__item">
        <span className="retiro-origin-legend__swatch retiro-origin-legend__swatch--from_closed" />
        Desde Cerrados
      </span>
      <span className="retiro-origin-legend__item">
        <span className="retiro-origin-legend__swatch retiro-origin-legend__swatch--admin" />
        Retiro / Caja
      </span>
      <span className="retiro-origin-legend__item">
        <span className="retiro-origin-legend__swatch retiro-origin-legend__swatch--customer-close" />
        Clienta cerró
      </span>
    </div>
  );
}
