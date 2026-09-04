"use client";

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

const DISMISS_KEY = "fyl-nj-launch-onboarding-dismissed-v1";
const VIEW_COUNT_KEY = "fyl-nj-launch-onboarding-view-count-v1";
const MAX_AUTO_VIEWS = 3;

const SLIDES = [
  {
    title: "Ahora podés hacer tu pedido cuando quieras",
    text: "Ya no necesitás esperar una respuesta por WhatsApp. Elegí tus productos, colores y talles directamente desde nuestro catálogo, en cualquier momento.",
    image: "/nj/history/launch-mobile-cart.webp?v=20260826",
  },
  {
    title: "Reservá y seguí agregando productos",
    text: "Al armar tu pedido, los productos disponibles se reservan para vos. Tu pedido queda abierto durante 7 días para que puedas seguir sumando productos cuando quieras.",
    image: "/nj/history/launch-mobile-order.webp?v=20260826",
  },
  {
    title: "Cuando estés lista, cerrá tu pedido",
    text: "¿Terminaste de elegir? Cerrá tu pedido y nosotros nos encargamos de prepararlo. Después te contactamos para coordinar el pago, envío o retiro.",
    image: "/nj/history/launch-mobile-coordinate.webp?v=20260826",
  },
] as const;

export default function HomeLaunchOnboarding() {
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [neverShowAgain, setNeverShowAgain] = useState(false);
  const active = SLIDES[activeIndex] ?? SLIDES[0];
  const isFirst = activeIndex === 0;
  const isLast = activeIndex === SLIDES.length - 1;

  const shouldForceOpen = useMemo(() => {
    if (typeof window === "undefined") return false;
    return new URLSearchParams(window.location.search).get("novedades") === "1";
  }, []);

  useEffect(() => {
    setMounted(true);

    SLIDES.forEach((slide) => {
      const image = new window.Image();
      image.src = slide.image;
    });

    try {
      const dismissed = window.localStorage.getItem(DISMISS_KEY) === "1";
      const viewCount = Number(window.localStorage.getItem(VIEW_COUNT_KEY) ?? "0");
      if (!shouldForceOpen && (dismissed || viewCount >= MAX_AUTO_VIEWS)) return;
    } catch {
      // If storage is unavailable, still show it once in this session.
    }

    const timer = window.setTimeout(() => {
      setOpen(true);
      if (shouldForceOpen) return;

      try {
        const current = Number(window.localStorage.getItem(VIEW_COUNT_KEY) ?? "0");
        window.localStorage.setItem(VIEW_COUNT_KEY, String(Math.max(0, current) + 1));
      } catch {
        // ignore storage failures
      }
    }, shouldForceOpen ? 0 : 1200);
    return () => window.clearTimeout(timer);
  }, [shouldForceOpen]);

  useEffect(() => {
    if (!open) return;
    document.body.classList.add("modal-open");

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") close();
      if (event.key === "ArrowRight") next();
      if (event.key === "ArrowLeft") prev();
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.classList.remove("modal-open");
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, activeIndex]);

  function markDismissedIfNeeded() {
    if (!neverShowAgain) return;

    try {
      window.localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      // ignore storage failures
    }
  }

  function close() {
    markDismissedIfNeeded();
    setOpen(false);
  }

  function next() {
    if (activeIndex >= SLIDES.length - 1) {
      close();
      return;
    }
    setActiveIndex((index) => Math.min(SLIDES.length - 1, index + 1));
  }

  function prev() {
    setActiveIndex((index) => Math.max(0, index - 1));
  }

  if (!mounted || !open) return null;

  return createPortal(
    <div className="home-launch-onboarding" role="presentation" onClick={close}>
      <div
        className="home-launch-onboarding__sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="home-launch-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="home-launch-onboarding__top">
          <button
            type="button"
            className="home-launch-onboarding__back"
            onClick={isFirst ? close : prev}
            aria-label={isFirst ? "Cerrar novedades" : "Volver al paso anterior"}
          >
            <span aria-hidden="true">‹</span>
          </button>

          <div className="home-launch-onboarding__bars" aria-hidden="true">
            {SLIDES.map((slide, index) => (
              <span
                key={slide.title}
                className={[
                  "home-launch-onboarding__bar",
                  index <= activeIndex ? "is-active" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              />
            ))}
          </div>

          <button type="button" className="home-launch-onboarding__skip" onClick={close}>
            Saltar
          </button>
        </div>

        <div className="home-launch-onboarding__body">
          <div className="home-launch-onboarding__image-wrap" aria-hidden="true">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              className="home-launch-onboarding__image"
              src={active.image}
              width={560}
              height={560}
              alt=""
              decoding="async"
            />
          </div>

          <div className="home-launch-onboarding__copy">
            <span className="home-launch-onboarding__eyebrow">Novedades de la web</span>
            <h2 id="home-launch-title" className="home-launch-onboarding__title">
              {active.title}
            </h2>
            <p className="home-launch-onboarding__text">{active.text}</p>
          </div>
        </div>

        <div className="home-launch-onboarding__footer">
          <div className="home-launch-onboarding__dots" aria-label="Pasos de novedades">
            {SLIDES.map((slide, index) => (
              <button
                key={slide.title}
                type="button"
                className={[
                  "home-launch-onboarding__dot",
                  index === activeIndex ? "is-active" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onClick={() => setActiveIndex(index)}
                aria-label={`Ir al paso ${index + 1}`}
                aria-current={index === activeIndex ? "step" : undefined}
              />
            ))}
          </div>

          <label className="home-launch-onboarding__never">
            <input
              type="checkbox"
              checked={neverShowAgain}
              onChange={(event) => setNeverShowAgain(event.target.checked)}
            />
            <span>No volver a mostrar</span>
          </label>

          <button type="button" className="home-launch-onboarding__next" onClick={next}>
            {isLast ? "Empezar a comprar" : "Siguiente"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
