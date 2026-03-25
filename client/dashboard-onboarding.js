/**
 * client/dashboard-onboarding.js
 * Tour de onboarding en 3 pasos: Carrito → Mi pedido → Estados + Finalizar pedido.
 * Overlay global, target resaltado con clase, card fija. Sin librerías externas.
 */

const STORAGE_KEY = "fyl_dashboard_onboarding_seen";
const HIGHLIGHT_CLASS = "dash-onboarding-highlight";
const BODY_OPEN_CLASS = "onboarding-open";
const CARD_STEP3_CLASS = "dash-onboarding-card--step3";

let currentStepIndex = 0;
let currentHighlightEl = null;
let currentProductParentEl = null;
let autoRunDoneThisLoad = false;
let positionRetryTimer = null;

let prevProductParentPosition = "";
let prevProductParentZIndex = "";

function cleanupLegacyFloatingLayer() {
  const el = document.getElementById("dash-onboarding-floating-layer");
  if (el) el.remove();
}

function clearProductParentElevation() {
  if (!currentProductParentEl) return;
  if (prevProductParentPosition !== undefined) {
    currentProductParentEl.style.position = prevProductParentPosition;
  }
  if (prevProductParentZIndex !== undefined) {
    currentProductParentEl.style.zIndex = prevProductParentZIndex;
  }
  currentProductParentEl = null;
  prevProductParentPosition = "";
  prevProductParentZIndex = "";
}

// Paso 3: ya no aplicamos highlight del DOM real ni elevación de contenedores.

const STEPS = [
  {
    targetSelector: "#section-bag",
    title: "Carrito",
    body: "Acá agregás productos, pero todavía no están reservados. Cuando los enviás, pasan a Mi pedido.",
  },
  {
    targetSelector: "#section-active-order",
    title: "Mi pedido",
    body:
      "Acá ves los productos que ya enviaste desde el carrito.<br>" +
      "Cuando hacés el pedido, los productos pasan acá y se reservan para vos.<br>" +
      "Podés seguir agregando productos durante 7 días antes de finalizarlo.",
  },
  {
    title: "Estados del pedido",
    body:
      "Cada producto tiene un estado:" +
      "<div id=\"dash-onboarding-step3-preview\" class=\"dash-onboarding-product-preview\" aria-label=\"Preview del producto\"></div>" +
      "<div class=\"dash-onboarding-state-list\" role=\"list\" aria-label=\"Estados del pedido\">" +
      "<div class=\"dash-onboarding-state-row\" role=\"listitem\">" +
      "<span class=\"dash-onboarding-state-badge item-row__status item-row__status--st-reserved\">Reserva</span>" +
      "<div class=\"dash-onboarding-state-text\">Reservado, pendiente de confirmación de stock.</div>" +
      "</div>" +
      "<div class=\"dash-onboarding-state-row\" role=\"listitem\">" +
      "<span class=\"dash-onboarding-state-badge item-row__status item-row__status--st-picked\">Apartado</span>" +
      "<div class=\"dash-onboarding-state-text\">Confirmado y separado para vos.</div>" +
      "</div>" +
      "<div class=\"dash-onboarding-state-row\" role=\"listitem\">" +
      "<span class=\"dash-onboarding-state-badge item-row__status item-row__status--st-missing\">Sin stock</span>" +
      "<div class=\"dash-onboarding-state-text\">No hay disponibilidad. Podés cambiarlo.</div>" +
      "</div>" +
      "</div>" +
      "<div class=\"dash-onboarding-state-close\">Cuando todo esté listo, finalizás el pedido.</div>",
    targetSelectors: [
      "#section-active-order .item-row",
      "#section-active-order .dash-order__list",
      "#section-active-order",
    ],
  },
];

function getOverlay() {
  return document.getElementById("dash-onboarding-overlay");
}

function getCard() {
  return document.getElementById("dash-onboarding-card");
}

function getTarget(stepIndex) {
  const step = STEPS[stepIndex];
  if (!step) return null;

  if (step.targetSelector) {
    return document.querySelector(step.targetSelector);
  }
  if (step.targetSelectors && step.targetSelectors.length) {
    for (const sel of step.targetSelectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
  }
  return null;
}

function clearHighlight() {
  if (currentHighlightEl) {
    currentHighlightEl.classList.remove(HIGHLIGHT_CLASS);
    currentHighlightEl = null;
  }
  clearProductParentElevation();
}

function setBodyScroll(open) {
  if (open) {
    document.body.classList.add(BODY_OPEN_CLASS);
  } else {
    document.body.classList.remove(BODY_OPEN_CLASS);
  }
}

function closeOnboarding(saveSeen = true) {
  const overlay = getOverlay();
  if (!overlay) return;

  clearHighlight();
  overlay.classList.remove("is-visible");
  overlay.setAttribute("aria-hidden", "true");
  setBodyScroll(false);
  cleanupLegacyFloatingLayer();

  const cardEl = getCard();
  if (cardEl) cardEl.classList.remove(CARD_STEP3_CLASS);

  if (saveSeen) {
    try {
      localStorage.setItem(STORAGE_KEY, "true");
    } catch (e) {}
  }
}

function updateCardContent(stepIndex) {
  const step = STEPS[stepIndex];
  if (!step) return;

  const progressEl = document.getElementById("dash-onboarding-progress");
  const titleEl = document.getElementById("dash-onboarding-card-title");
  const bodyEl = document.getElementById("dash-onboarding-card-body");
  const skipBtn = document.getElementById("dash-onboarding-skip");
  const backBtn = document.getElementById("dash-onboarding-back");
  const nextBtn = document.getElementById("dash-onboarding-next");
  const doneBtn = document.getElementById("dash-onboarding-done");

  const total = STEPS.length;
  const n = stepIndex + 1;

  if (progressEl) progressEl.textContent = `Paso ${n} de ${total}`;
  if (titleEl) titleEl.textContent = step.title;
  if (bodyEl) bodyEl.innerHTML = step.body;

  if (skipBtn) skipBtn.style.display = "";
  if (backBtn) backBtn.style.display = stepIndex > 0 ? "" : "none";
  if (nextBtn) nextBtn.style.display = stepIndex < total - 1 ? "" : "none";
  if (doneBtn) doneBtn.style.display = stepIndex === total - 1 ? "" : "none";
}

function showStep(index) {
  if (index < 0 || index >= STEPS.length) {
    closeOnboarding(true);
    return;
  }

  currentStepIndex = index;
  clearHighlight();
  cleanupLegacyFloatingLayer();

  const overlay = getOverlay();
  if (overlay) {
    overlay.classList.add("is-visible");
    overlay.setAttribute("aria-hidden", "false");
    setBodyScroll(true);
  }

  const cardEl = getCard();
  if (cardEl) cardEl.classList.toggle(CARD_STEP3_CLASS, index === 2);

  // Paso 3: renderizar preview limpio dentro de la card.
  if (index === 2) {
    const firstItemRow = document.querySelector("#section-active-order .item-row");
    if (!firstItemRow) {
      closeOnboarding(true);
      return;
    }

    updateCardContent(index);

    const previewEl = document.getElementById("dash-onboarding-step3-preview");
    if (previewEl) {
      previewEl.innerHTML = "";
      const clone = firstItemRow.cloneNode(true);
      clone.querySelectorAll("[id]").forEach((n) => n.removeAttribute("id"));
      previewEl.appendChild(clone);
    }
    resetCardPosition();
    return;
  }

  const target = getTarget(index);
  if (target) {
    target.classList.add(HIGHLIGHT_CLASS);
    currentHighlightEl = target;
    // Scroll para que el target quede en contexto antes de posicionar la card.
    target.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  updateCardContent(index);

  // Posicionar la card arriba/abajo del target para no competir con la bottom-nav.
  if (target) {
    schedulePositionCard(target, index);
  } else {
    resetCardPosition();
  }
}

function resetCardPosition() {
  const card = getCard();
  if (!card) return;
  card.style.top = "";
  card.style.bottom = "";
}

function getBottomNavHeight() {
  const bottomNav = document.getElementById("bottom-nav");
  if (!bottomNav) return 0;
  const rect = bottomNav.getBoundingClientRect();
  return Math.max(0, rect.height || 0);
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function applyCardPosition(targetEl, stepIndex) {
  const card = getCard();
  if (!card) return;

  const cardH = card.offsetHeight || 0;
  if (!cardH) return;

  const targetRect = targetEl.getBoundingClientRect();
  const bottomNavH = getBottomNavHeight();

  // Vista útil: no invadir bottom-nav.
  const viewportTop = 12;
  const viewportBottom = window.innerHeight - bottomNavH - 12;

  // Separación mínima card-target.
  const gapOptions = [16, 12, 8];

  let chosen = null; // "below" | "above"
  let chosenGap = gapOptions[1];

  for (const gap of gapOptions) {
    const belowTop = targetRect.bottom + gap;
    const aboveTop = targetRect.top - cardH - gap;

    const fitsBelow = belowTop >= viewportTop && belowTop + cardH <= viewportBottom;
    const fitsAbove = aboveTop >= viewportTop && aboveTop + cardH <= viewportBottom;

    // Prioridad por paso:
    // - Paso 1: preferir arriba del carrito si entra.
    if (stepIndex === 0) {
      if (fitsAbove) {
        chosen = "above";
        chosenGap = gap;
        break;
      }
      if (fitsBelow) {
        chosen = "below";
        chosenGap = gap;
        break;
      }
    } else {
      // Regla general:
      // - Si entra abajo, ubicarla debajo.
      // - Si no entra abajo pero sí arriba, ubicarla arriba.
      if (fitsBelow) {
        chosen = "below";
        chosenGap = gap;
        break;
      }
      if (fitsAbove) {
        chosen = "above";
        chosenGap = gap;
        break;
      }
    }

    // Si no cabe para este gap, probamos otro menor en el loop.
  }

  // Si nada calza perfectamente, elegimos el lado con más espacio con el gap más chico
  // y ajustamos lo máximo posible sin tapar el target.
  if (!chosen) {
    const gap = gapOptions[gapOptions.length - 1];
    const spaceAbove = targetRect.top - viewportTop - gap;
    const spaceBelow = viewportBottom - targetRect.bottom - gap;
    chosen = spaceBelow >= spaceAbove ? "below" : "above";
    chosenGap = gap;
  }

  const gap = chosenGap;
  const belowTop = targetRect.bottom + gap;
  const aboveTop = targetRect.top - cardH - gap;

  let finalTop = 0;
  if (chosen === "below") {
    // No tapar el target: el card debe empezar por debajo (>= belowTop).
    finalTop = Math.max(belowTop, viewportTop);
    const maxTop = viewportBottom - cardH;
    // Si clavar al máximo haría que el card vuelva a tocar el target, priorizamos no-overlap (podría quedar algo recortado).
    if (finalTop > maxTop) {
      finalTop = belowTop;
    }
  } else {
    // No tapar el target: el card debe terminar antes del target (<= aboveTop + cardH).
    finalTop = Math.min(aboveTop, viewportBottom - cardH);
    // Si elevarlo hasta viewportTop haría que se solape, priorizamos no-overlap.
    if (finalTop < viewportTop) {
      finalTop = aboveTop;
    }
  }

  // Siempre activar posicionamiento por top.
  card.style.top = `${finalTop}px`;
  card.style.bottom = "auto";
}

function schedulePositionCard(targetEl, stepIndex) {
  // En mobile el alto de la card puede cambiar levemente tras el innerHTML.
  // Intentamos 3 veces con timing distinto para medir layout estable.
  const delays = [0, 120, 280];
  if (positionRetryTimer) {
    clearTimeout(positionRetryTimer);
    positionRetryTimer = null;
  }

  delays.forEach((d, idx) => {
    const t = setTimeout(() => {
      applyCardPosition(targetEl, stepIndex);
    }, d);
    if (idx === delays.length - 1) positionRetryTimer = t;
  });
}

function bindButtons() {
  const overlay = getOverlay();
  const skipBtn = document.getElementById("dash-onboarding-skip");
  const backBtn = document.getElementById("dash-onboarding-back");
  const nextBtn = document.getElementById("dash-onboarding-next");
  const doneBtn = document.getElementById("dash-onboarding-done");
  const triggerBtn = document.getElementById("dashboard-onboarding-trigger");

  function handleSkip() {
    closeOnboarding(true);
  }

  function handleBack() {
    showStep(currentStepIndex - 1);
  }

  function handleNext() {
    showStep(currentStepIndex + 1);
  }

  function handleDone() {
    closeOnboarding(true);
  }

  if (skipBtn) skipBtn.addEventListener("click", handleSkip);
  if (backBtn) backBtn.addEventListener("click", handleBack);
  if (nextBtn) nextBtn.addEventListener("click", handleNext);
  if (doneBtn) doneBtn.addEventListener("click", handleDone);

  if (triggerBtn) {
    triggerBtn.addEventListener("click", () => {
      startOnboarding(true);
    });
  }

  if (overlay) {
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) {
        return;
      }
    });
  }
}

/**
 * Inicia el tour.
 * @param {boolean} force - Si true, ignora localStorage y muestra el tour (reapertura manual).
 */
function startOnboarding(force = false) {
  if (!force) {
    try {
      if (localStorage.getItem(STORAGE_KEY) === "true") return;
    } catch (e) {}
  }

  showStep(0);
}

/**
 * Llamar una sola vez por carga para mostrar el tour automáticamente si no fue visto.
 * Guarda en autoRunDoneThisLoad para no disparar más de una vez aunque loadData se ejecute varias veces.
 */
function runDashboardOnboardingIfNeeded() {
  if (autoRunDoneThisLoad) return;
  autoRunDoneThisLoad = true;
  startOnboarding(false);
}

function init() {
  bindButtons();
  window.runDashboardOnboardingIfNeeded = runDashboardOnboardingIfNeeded;
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
