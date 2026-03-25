---
name: fyl-debugger
description: Debugs UI and logic issues in the FYL catalog project. Checks styles.css, DOM, mobile layout, Supabase queries, and event listeners. Prefers minimal fixes over large refactors. Use when debugging bugs, layout issues, or unexpected behavior in the FYL project.
---

# FYL Debugger

When debugging UI or logic issues in the FYL project, check in this order:

## 1. styles.css

- Confirm the element uses existing classes from `styles.css` where possible.
- Check for overrides, typos in class names, or missing selectors.
- Verify no conflicting rules (specificity, order).

## 2. DOM structure

- Ensure the HTML matches what the JS expects (ids, data attributes, container hierarchy).
- Look for missing or duplicate nodes, or elements rendered in the wrong place.

## 3. Mobile layout

- Target 360px–430px; verify layout, overflow, and touch targets.
- Check flex/grid and avoid fixed widths that break on small screens.

## 4. Supabase queries

- Verify table/view names, RPC names, and parameters.
- Check RLS and returned data shape; confirm error handling and loading states.

## 5. Event listeners

- Confirm listeners are attached to the right elements and not duplicated.
- Check delegation vs direct binding; ensure no listeners on removed nodes.

## Principle

Prefer **minimal fixes** (targeted CSS, one-line logic fixes, correct selectors) instead of large refactors. Only refactor when the root cause clearly requires it.
