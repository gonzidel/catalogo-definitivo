// scripts/fyl-perf.js — Logs temporales de performance (mobile-first)

/** @param {string} event catalog_requests | commercial_requests | banner_catalog_reuse | commercial_early_return */
export function fylPerf(event, detail = null) {
  if (detail != null) {
    console.warn("[FYL Perf]", event, detail);
  } else {
    console.warn("[FYL Perf]", event);
  }
}
