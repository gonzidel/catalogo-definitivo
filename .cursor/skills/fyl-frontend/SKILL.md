---
name: fyl-frontend
description: Builds UI for the FYL B2B catalog (product cards, PDP, sticky cart, filters, dashboard). Mobile-first, reuses existing CSS, simple layouts, fast rendering. Use when implementing or changing catalog UI, product cards, PDP, cart, filters, or dashboard components.
---

# FYL Frontend

This skill specializes in building UI for the FYL catalog: a B2B mobile-first system.

## Common UI Components

- **Product cards** — grid/list of catalog items
- **PDP (Product Detail Page)** — fullscreen product view
- **Sticky cart** — persistent cart summary/CTA
- **Filters** — size, color, category, etc.
- **Dashboard cards** — client dashboard blocks

## UI Patterns

### Product card

- **Image ratio**: 4:5 (e.g. `aspect-ratio: 4/5` or padding-bottom)
- **Price**: below the image
- **Quick add**: buttons for size/variant add-to-cart without opening PDP when appropriate

Keep cards compact and thumb-friendly on 360–430px viewports.

### PDP

- Fullscreen or near-fullscreen experience
- Clear primary image, price, sizes, and add-to-cart
- Minimal steps to add and return to catalog

### Sticky cart

- Visible cart summary and CTA (e.g. item count, total, “Ver carrito”)
- Sticky at bottom or top as defined in the project; avoid covering critical content

### Filters

- Simple controls (chips, dropdowns, or bottom sheet) per project patterns
- Clear active state and easy clear/reset

### Dashboard cards

- Clear hierarchy: title, key metric or action, optional secondary info
- Reuse existing card styles from `styles.css`

## Guidelines

1. **Reuse existing CSS classes** — Prefer classes from `styles.css`; avoid new design systems or one-off styles.
2. **Simple layouts** — Prefer vertical flow and flex/grid; avoid complex nested structures.
3. **Fast rendering** — Minimize DOM nodes, avoid heavy wrappers, lazy-load images when appropriate.
4. **Avoid unnecessary DOM complexity** — Fewer elements and wrappers; semantic HTML.

## References

- Main stylesheet: `styles.css`
- Mobile-first and breakpoints: project rules (e.g. FYL-Mobile-UX, FYL-CSS-System)
- Catalog and cart logic: `scripts/main-supabase.js`, `scripts/cart-persistent.js`
