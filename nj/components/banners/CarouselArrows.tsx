"use client";

import type { RefObject } from "react";

function Chevron({ direction }: { direction: "left" | "right" }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {direction === "left" ? (
        <polyline points="15 18 9 12 15 6" />
      ) : (
        <polyline points="9 18 15 12 9 6" />
      )}
    </svg>
  );
}

/** Flechas para carruseles que hoy solo se desplazan con gesto. Visibles en escritorio. */
export default function CarouselArrows({
  scrollerRef,
}: {
  scrollerRef: RefObject<HTMLDivElement | null>;
}) {
  const move = (direction: -1 | 1) => {
    const el = scrollerRef.current;
    if (!el) return;
    const amount = Math.max(180, el.clientWidth);
    el.scrollBy({ left: direction * amount, behavior: "smooth" });
  };

  return (
    <div className="desktop-carousel-nav">
      <button
        type="button"
        className="desktop-carousel-nav__btn desktop-carousel-nav__btn--prev"
        aria-label="Anterior"
        onClick={() => move(-1)}
      >
        <Chevron direction="left" />
      </button>
      <button
        type="button"
        className="desktop-carousel-nav__btn desktop-carousel-nav__btn--next"
        aria-label="Siguiente"
        onClick={() => move(1)}
      >
        <Chevron direction="right" />
      </button>
    </div>
  );
}
