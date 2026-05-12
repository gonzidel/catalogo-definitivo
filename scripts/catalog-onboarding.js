/**
 * Onboarding tipo historias (index2): solo usuarios sin sesión Supabase.
 * Tras el evento fyl-catalog-boot-done (o si el boot ya terminó).
 */
import { supabase } from "./supabase-client.js";
import { fylAnalytics } from "./analytics.js";

const STORAGE_KEY = "fyl-catalog-onboarding-hide";
const SEEN_KEY = "fyl-catalog-onboarding-seen";
// FASE 1A · T4: subido de 3000 a 6000ms y se aborta si la usuaria interactúa antes.
const OPEN_DELAY_MS = 6000;
const ABORT_EVENTS = ["pointerdown", "touchstart", "scroll", "hashchange"];
const TOTAL = 3;

const root = document.getElementById("catalog-onboarding");
const track = document.getElementById("co-track");
const btnNext = document.getElementById("co-next");
const btnBack = document.getElementById("co-back");
const btnClose = document.getElementById("co-close");
const backdrop = document.getElementById("co-backdrop");
const chkNever = document.getElementById("co-never");
const dots = document.querySelectorAll(".catalog-onboarding__dot");
const bars = document.querySelectorAll(".catalog-onboarding__progress-bar");

let step = 0;
let opened = false;
let tryLock = false;
let openTimer = null;
let abortHandler = null;

function clearOpenTimer() {
  if (openTimer) {
    clearTimeout(openTimer);
    openTimer = null;
  }
  if (abortHandler) {
    ABORT_EVENTS.forEach((ev) =>
      window.removeEventListener(ev, abortHandler, true)
    );
    abortHandler = null;
  }
}

function setStep(n) {
  step = Math.max(0, Math.min(TOTAL - 1, n));
  if (track) {
    track.style.transform = `translateX(-${(step * 100) / TOTAL}%)`;
  }
  if (btnNext) {
    btnNext.textContent =
      step === TOTAL - 1 ? "Empezar a comprar" : "Siguiente";
  }
  bars.forEach((bar, i) => {
    bar.classList.toggle("is-active", i === step);
    bar.classList.toggle("is-done", i < step);
  });
  dots.forEach((d, i) => {
    d.classList.toggle("is-active", i === step);
    if (i === step) d.setAttribute("aria-current", "step");
    else d.removeAttribute("aria-current");
  });
}

function closeOnboarding(markAsSeen = true) {
  if (!root) return;
  root.classList.add("hidden");
  root.classList.remove("is-visible");
  root.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
  opened = false;
  clearOpenTimer();
  if (markAsSeen) {
    localStorage.setItem(SEEN_KEY, "1");
  }
  if (chkNever?.checked) {
    localStorage.setItem(STORAGE_KEY, "1");
  }
  try {
    if (fylAnalytics.isReady()) fylAnalytics.event("catalog_onboarding_close", { step: step + 1 });
  } catch (_e) {}
}

function openOnboarding() {
  if (!root || opened) return;
  opened = true;
  step = 0;
  if (chkNever) {
    chkNever.checked = localStorage.getItem(STORAGE_KEY) === "1";
  }
  setStep(0);
  root.classList.remove("hidden");
  requestAnimationFrame(() => root.classList.add("is-visible"));
  root.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  try {
    if (fylAnalytics.isReady()) fylAnalytics.event("catalog_onboarding_open", {});
  } catch (_e) {}
}

async function tryShowOnboarding() {
  if (
    !root ||
    localStorage.getItem(STORAGE_KEY) ||
    localStorage.getItem(SEEN_KEY) ||
    tryLock
  ) {
    return;
  }
  tryLock = true;
  try {
    let session = null;
    if (supabase?.auth?.getSession) {
      try {
        const { data } = await supabase.auth.getSession();
        session = data?.session ?? null;
      } catch (_) {
        /* sin sesión */
      }
    }
    if (session) return;

    // FASE 1A · T4: si la usuaria interactúa antes de los OPEN_DELAY_MS, abortamos
    // sin marcar SEEN_KEY → vuelve a intentar la próxima sesión, sin robar el primer tap.
    clearOpenTimer();
    abortHandler = function () {
      clearOpenTimer();
    };
    ABORT_EVENTS.forEach((ev) =>
      window.addEventListener(ev, abortHandler, {
        once: true,
        passive: true,
        capture: true,
      })
    );
    openTimer = setTimeout(() => {
      clearOpenTimer();
      openOnboarding();
    }, OPEN_DELAY_MS);
  } finally {
    tryLock = false;
  }
}

function onBootDone() {
  void tryShowOnboarding();
}

window.addEventListener("fyl-catalog-boot-done", onBootDone);

queueMicrotask(() => {
  const boot = document.getElementById("catalog-boot-overlay");
  if (boot?.classList.contains("catalog-boot-overlay--hidden")) {
    onBootDone();
  }
});

if (supabase?.auth?.onAuthStateChange) {
  supabase.auth.onAuthStateChange((_event, session) => {
    if (session && root && !root.classList.contains("hidden")) {
      closeOnboarding(false);
    }
  });
}

if (btnNext) {
  btnNext.addEventListener("click", () => {
    if (step < TOTAL - 1) {
      setStep(step + 1);
    } else {
      closeOnboarding();
    }
  });
}

if (btnBack) {
  btnBack.addEventListener("click", () => {
    if (step > 0) {
      setStep(step - 1);
    } else {
      closeOnboarding();
    }
  });
}

if (btnClose) {
  btnClose.addEventListener("click", () => closeOnboarding());
}

if (backdrop) {
  backdrop.addEventListener("click", () => closeOnboarding());
}

dots.forEach((d, i) => {
  d.addEventListener("click", () => setStep(i));
});
