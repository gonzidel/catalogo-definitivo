---
name: fyl-performance
description: Optimizes performance in the FYL catalog (DOM updates, images, JS execution, mobile loading). Minimizes DOM churn, avoids heavy libraries, reduces main-thread work. Use when optimizing load time, improving rendering speed, or when the user mentions performance, slow loading, or mobile speed.
---

# FYL Performance

Performance is critical in FYL. Apply these guidelines when changing catalog, PDP, cart, or dashboard code.

## Principles

1. **Minimize DOM updates** — Batch changes, avoid layout thrash, prefer single reflows.
2. **Optimize images** — Right size, format, and loading strategy for mobile.
3. **Avoid heavy libraries** — Vanilla JS only; no extra frameworks or large dependencies.
4. **Reduce JavaScript execution time** — Less work on the main thread; defer when possible.
5. **Prioritize fast mobile loading** — First paint and interactive time matter most on 360–430px.

---

## DOM updates

- **Batch reads then writes** — Read layout (offsetHeight, getBoundingClientRect, etc.) in one pass; then do all DOM writes. Avoid interleaving read/write.
- **Prefer single container updates** — Build HTML as string or DocumentFragment, then one `innerHTML` or `appendChild` instead of many small appends.
- **Use event delegation** — Attach one listener on a parent (e.g. catalog grid) instead of per-card listeners.
- **Avoid unnecessary re-renders** — Only re-render the slice that changed (e.g. one product card or one cart line), not the whole list when possible.
- **Limit live NodeLists** — Cache `.querySelectorAll` results if the DOM will change, or use a static snapshot.

---

## Images

- **Dimensions** — Serve images sized for display (e.g. card width × aspect ratio). Avoid full-size originals in list views.
- **Format** — Prefer WebP with JPEG/PNG fallback when the project supports it; keep PNG only where transparency is needed.
- **Lazy loading** — Use `loading="lazy"` for below-the-fold images; consider `decoding="async"`.
- **Placeholder** — Use fixed aspect-ratio container (e.g. 4:5 for cards) to avoid layout shift; optional low-res or solid placeholder.
- **No image work in JS** — Avoid client-side resizing or heavy processing; do sizing/cropping at upload or via CDN/Cloudinary if available.

---

## JavaScript

- **No heavy libraries** — No React/Vue/jQuery for catalog UI; stick to vanilla JS and existing project scripts.
- **Defer non-critical script** — Use `defer` (or module) for scripts that don’t need to block first paint.
- **Minimize work on scroll/resize** — Throttle or debounce handlers; do cheap checks first (e.g. visibility) before DOM or layout reads.
- **Avoid long tasks** — Split large loops or big renders (e.g. 100+ cards) into smaller chunks with `requestAnimationFrame` or `setTimeout` so the main thread can breathe.
- **Cache repeated work** — Cache DOM references, normalized data (e.g. sizes), and small computation results instead of recalculating every time.

---

## Mobile loading

- **Critical path** — Keep HTML/CSS for above-the-fold content minimal; avoid blocking scripts for first paint.
- **Fonts** — Use `font-display: swap` (or optional); prefer system or few web fonts to limit render blocking.
- **Third-party** — Load analytics or non-critical scripts after initial render; avoid blocking the main document.
- **Measure** — When debugging slowness, consider LCP, FID/INP, CLS, and Time to Interactive on a throttled 3G profile (e.g. DevTools).

---

## Quick checklist

When touching catalog, PDP, cart, or dashboard:

- [ ] DOM: batched reads/writes, delegation where it fits, minimal re-renders.
- [ ] Images: appropriate size/format, lazy load, stable layout (aspect ratio).
- [ ] JS: no new heavy libs, deferred where possible, throttled/debounced scroll/resize.
- [ ] Mobile: critical path lean, fonts non-blocking, third-party deferred.

---

## References

- Styles and layout: `styles.css`, FYL-CSS-System, FYL-Mobile-UX.
- Catalog/cart: `scripts/main-supabase.js`, `scripts/cart-persistent.js`.
- Architecture: no frameworks; vanilla JS only (FYL-Architecture).
