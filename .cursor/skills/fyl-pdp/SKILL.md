---
name: fyl-pdp
description: Modifies or builds the Product Detail Page (PDP). Full-screen layout, 4:5 image, thumbnails, clickable tags, visible CTA, sticky footer. No modals.
---

# FYL PDP (Product Detail Page)

This skill helps modify or build the Product Detail Page (PDP) for the FYL catalog.

## PDP Rules

1. **Full-screen layout** — Use a full-screen layout for the PDP. Do not use modal overlays; the PDP is a dedicated full-screen view, not a popup or overlay.

2. **Main image ratio 4:5** — The primary product image must use a 4:5 aspect ratio (e.g. `aspect-ratio: 4/5` or equivalent padding-bottom technique).

3. **Thumbnails below image** — Show product thumbnails (e.g. other angles/variants) in a row or strip directly below the main image.

4. **Product tags clickable** — Category, collection, or attribute tags on the PDP must be clickable (e.g. link to filtered catalog or category).

5. **CTA "Agregar" always visible** — The main add-to-cart action ("Agregar") must remain visible without scrolling when possible (e.g. in a sticky area or above the fold).

6. **Footer sticky button** — Use a sticky footer that contains the primary CTA (e.g. "Agregar" or "Agregar al carrito") so it is always accessible while scrolling.

## Constraints

- **Do not create modal overlays** for the PDP. Use a full-screen layout instead (separate page or full-screen panel).
- Reuse existing classes from `styles.css` and follow the project’s mobile-first and CSS rules (FYL-CSS-System, FYL-Mobile-UX).

## References

- Main stylesheet: `styles.css`
- Catalog/PDP logic: `scripts/main-supabase.js`, `scripts/cart-persistent.js`
- Related: fyl-frontend skill for general catalog UI patterns
