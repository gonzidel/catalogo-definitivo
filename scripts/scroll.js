import { fylDevLog } from "./config.js";
import { fylAnalytics } from "./analytics.js";

const scrollBtn = document.getElementById("btn-scroll-top");

let lastScrollTop = 0;
const scrollThreshold = 12;
let isHeaderVisible = true;
let scrollRaf = 0;

function syncHeaderHeightVar() {
  const header = document.querySelector("header");
  if (!header) return;
  const h = Math.round(header.offsetHeight || 60);
  document.documentElement.style.setProperty("--fyl-header-h", `${h}px`);
}

function applyStickyOffsets() {
  const headerH = document.documentElement.style.getPropertyValue("--fyl-header-h") || "60px";
  const menuDesktop = document.querySelector(".menu-desktop");
  if (menuDesktop) {
    menuDesktop.style.top = `calc(${headerH} - 2px)`;
    menuDesktop.style.marginTop = "-2px";
  }
  const quickActions = document.querySelector(".quick-actions-container");
  if (quickActions && typeof isHeaderVisible !== "undefined" && isHeaderVisible) {
    quickActions.style.top = `calc(${headerH} - 2px)`;
    quickActions.style.marginTop = "-2px";
  }
}

function ensureHeaderSticky() {
  const header = document.querySelector("header");
  if (!header) return;
  const computedStyle = window.getComputedStyle(header);
  if (computedStyle.position !== "sticky" && computedStyle.position !== "-webkit-sticky") {
    header.style.position = "sticky";
    header.style.top = "0";
    header.style.zIndex = "1000";
    header.style.width = "100%";
    header.style.background = "#fff";
    fylDevLog("Header sticky forzado mediante JavaScript");
  }
}

function handleHeaderVisibility() {
  const currentScrollTop = window.pageYOffset || document.documentElement.scrollTop;
  const header = document.querySelector("header");
  const menuDesktop = document.querySelector(".menu-desktop");
  const quickActions = document.querySelector(".quick-actions-container");

  if (currentScrollTop <= 10) {
    if (!isHeaderVisible) {
      isHeaderVisible = true;
      header?.style.setProperty("transform", "translateY(0)");
      menuDesktop?.style.setProperty("transform", "translateY(0)");
      if (quickActions) {
        quickActions.style.top = `calc(var(--fyl-header-h, 60px) - 2px)`;
        quickActions.style.transform = "translateY(0)";
      }
    }
    lastScrollTop = currentScrollTop;
    return;
  }

  const scrollDelta = Math.abs(currentScrollTop - lastScrollTop);
  if (scrollDelta < scrollThreshold) return;

  if (currentScrollTop > lastScrollTop && currentScrollTop > 50) {
    if (isHeaderVisible) {
      isHeaderVisible = false;
      header?.style.setProperty("transform", "translateY(-100%)");
      menuDesktop?.style.setProperty("transform", "translateY(-100%)");
      if (quickActions) {
        quickActions.style.top = "0";
        quickActions.style.marginTop = "0";
        quickActions.style.transform = "translateY(0)";
      }
    }
  } else if (currentScrollTop < lastScrollTop) {
    if (!isHeaderVisible) {
      isHeaderVisible = true;
      header?.style.setProperty("transform", "translateY(0)");
      menuDesktop?.style.setProperty("transform", "translateY(0)");
      if (quickActions) {
        quickActions.style.top = `calc(var(--fyl-header-h, 60px) - 2px)`;
        quickActions.style.transform = "translateY(0)";
      }
    }
  }

  lastScrollTop = currentScrollTop <= 0 ? 0 : currentScrollTop;
}

function onScrollCoalesced() {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    if (isHeaderVisible) applyStickyOffsets();
    handleHeaderVisibility();
  });
}

if (scrollBtn) {
  window.addEventListener(
    "scroll",
    () => {
      if (window.pageYOffset > 300) scrollBtn.classList.add("visible");
      else scrollBtn.classList.remove("visible");
    },
    { passive: true }
  );

  scrollBtn.addEventListener("click", () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
    try {
      if (fylAnalytics.isReady()) fylAnalytics.event("scroll_top", {});
    } catch (_e) {}
  });
}

window.addEventListener("DOMContentLoaded", () => {
  ensureHeaderSticky();
  syncHeaderHeightVar();
  applyStickyOffsets();
});

window.addEventListener(
  "resize",
  () => {
    syncHeaderHeightVar();
    applyStickyOffsets();
  },
  { passive: true }
);

window.addEventListener("scroll", onScrollCoalesced, { passive: true });
