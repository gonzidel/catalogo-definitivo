// admin/move-stock.js
import { requireAuth } from "./admin-auth.js";
import { supabase } from "../scripts/supabase-client.js";
import { normalizeSize } from "../scripts/utils/size-normalizer.js";

await requireAuth();

const searchInput = document.getElementById("search-input");
const resultsContainer = document.getElementById("results-container");
const messageContainer = document.getElementById("message-container");
const suggestionsDropdown = document.getElementById("suggestions-dropdown");
const suggestionsList = document.getElementById("suggestions-list");
const productsDatalist = document.getElementById("products-datalist");
const searchSection = document.getElementById("search-section");
const qrReaderModeEl = document.getElementById("qr-reader-mode");
const qrReaderHint = document.getElementById("qr-reader-hint");
const clearQrListBtn = document.getElementById("clear-qr-list-btn");
const readerTotalBox = document.getElementById("reader-total-box");
const readerTotalValue = document.getElementById("reader-total-value");

let searchTimeout = null;
let suggestionsTimeout = null;
let currentMode = "to_public"; // "to_public" o "to_general"

/** Modo lector QR (lector externo tipo teclado), misma resolución que public-sales */
let isQrReaderMode = false;
const pendingMoves = new Map(); // key variantId::normalizedSize -> línea acumulada
let qrInputTimeout = null;
let qrProcessingQueue = [];
let isProcessingQr = false;
const QR_MIN_DIGITS = 6;
const QR_INPUT_DEBOUNCE_MS = 50;
const QR_VARIANT_STOCK_CACHE_TTL_MS = 4000;
const qrMetaCache = new Map(); // qr -> metadata|{notFound:true}
const variantStockCache = new Map(); // variantId -> { at, data, sizeMap }

const SEARCH_PLACEHOLDER_MANUAL =
  "Buscar producto por nombre, SKU, color o talle...";
const SEARCH_PLACEHOLDER_READER =
  "Escaneá el código QR (producto + color + talle)...";

function isCompleteReaderQr(value) {
  const v = String(value ?? "").trim();
  return /^\d+$/.test(v) && v.length >= QR_MIN_DIGITS;
}

function shouldAutoFocusMoveStockReaderInput() {
  const isCoarsePointer = typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(pointer: coarse)").matches;
  return !isCoarsePointer;
}

function generateOperationId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const nowHex = Date.now().toString(16).padStart(12, "0");
  const randHex = Math.random().toString(16).slice(2).padEnd(20, "0").slice(0, 20);
  return `${nowHex.slice(0, 8)}-${nowHex.slice(8, 12)}-4${randHex.slice(0, 3)}-a${randHex.slice(3, 6)}-${randHex.slice(6, 18)}`;
}

async function rpcMoveSizeStockWithIdempotency(basePayload, action, operationId = generateOperationId()) {
  const requestMeta = {
    source: "admin/move-stock.js",
    action,
  };

  const { data, error } = await supabase.rpc("rpc_move_size_stock", {
    ...basePayload,
    p_operation_id: operationId,
    p_request: requestMeta,
  });

  if (error) {
    const errMsg = String(error?.message || "");
    if (errMsg.includes("conflict_in_progress")) {
      console.warn("⏳ rpc_move_size_stock conflict_in_progress", {
        operationId,
        action,
        variantId: basePayload?.p_variant_id || null,
        size: basePayload?.p_size || null,
      });
    } else if (errMsg.includes("operation_id_conflict")) {
      console.error("🚫 rpc_move_size_stock operation_id_conflict", {
        operationId,
        action,
        variantId: basePayload?.p_variant_id || null,
        size: basePayload?.p_size || null,
      });
    }
    throw error;
  }

  if (data?.idempotent_replay === true) {
    console.info("♻️ rpc_move_size_stock replay", {
      operationId,
      action,
      movementId: data?.movement_id || null,
    });
  } else {
    console.info("✅ rpc_move_size_stock operación normal", {
      operationId,
      action,
      movementId: data?.movement_id || null,
    });
  }

  return { data, operationId };
}

function pendingLineKey(variantId, normalizedSize) {
  return `${String(variantId)}::${String(normalizedSize)}`;
}

function setReaderModeUi(on) {
  if (searchSection) {
    searchSection.classList.toggle("reader-active", on);
  }
  if (qrReaderHint) {
    qrReaderHint.style.display = on ? "block" : "none";
  }
  searchInput.placeholder = on ? SEARCH_PLACEHOLDER_READER : SEARCH_PLACEHOLDER_MANUAL;
  if (clearQrListBtn) {
    clearQrListBtn.style.display =
      on && pendingMoves.size > 0 ? "inline-block" : "none";
  }
  updateReaderTotalCounter();
}

function getPendingTotalUnits() {
  return [...pendingMoves.values()].reduce((acc, line) => {
    const qty = Number(line?.quantity || 0);
    return acc + (Number.isFinite(qty) && qty > 0 ? qty : 0);
  }, 0);
}

function updateReaderTotalCounter() {
  if (!readerTotalBox || !readerTotalValue) return;
  if (!isQrReaderMode) {
    readerTotalBox.style.display = "none";
    return;
  }
  readerTotalBox.style.display = "flex";
  readerTotalValue.textContent = String(getPendingTotalUnits());
}

function updateQrResultsHeader() {
  const resultsHeader = document.getElementById("results-header");
  if (!resultsHeader || !isQrReaderMode) return;
  if (pendingMoves.size > 0) {
    resultsHeader.style.display = "block";
    if (clearQrListBtn) clearQrListBtn.style.display = "inline-block";
  } else {
    resultsHeader.style.display = "none";
    if (clearQrListBtn) clearQrListBtn.style.display = "none";
  }
}

function getSourceStockFromRow(sizeRow) {
  if (!sizeRow) return 0;
  return currentMode === "to_public" ? sizeRow.general : sizeRow.ventaPublico;
}

function clearMoveStockCaches() {
  qrMetaCache.clear();
  variantStockCache.clear();
}

function invalidateVariantStockCache(variantId) {
  if (variantId === undefined || variantId === null) return;
  variantStockCache.delete(String(variantId));
}

function getStockRowFromCacheEntry(cacheEntry, size) {
  if (!cacheEntry?.sizeMap) return null;
  return cacheEntry.sizeMap.get(normalizeSize(size)) || null;
}

async function getVariantStockCached(variantId, options = {}) {
  const key = String(variantId);
  const force = Boolean(options.force);
  const now = Date.now();
  const cached = variantStockCache.get(key);
  if (!force && cached && now - cached.at <= QR_VARIANT_STOCK_CACHE_TTL_MS) {
    return cached;
  }
  const data = await getVariantStock(variantId);
  const sizeMap = new Map();
  (data?.sizes || []).forEach((s) => {
    sizeMap.set(normalizeSize(s.size), s);
  });
  const entry = { at: now, data, sizeMap };
  variantStockCache.set(key, entry);
  return entry;
}

async function refreshPendingMovesStock() {
  const entries = [...pendingMoves.values()];
  for (const line of entries) {
    const stockEntry = await getVariantStockCached(line.variantId, { force: true });
    const sizeRow = getStockRowFromCacheEntry(stockEntry, line.size);
    line.sourceStock = getSourceStockFromRow(sizeRow);
  }
}

function renderQrPendingList() {
  if (!isQrReaderMode) return;

  updateQrResultsHeader();
  updateReaderTotalCounter();

  if (pendingMoves.size === 0) {
    resultsContainer.innerHTML = `
      <div class="no-results">
        <p>Escaneá códigos QR para armar la lista de traspaso (cada código = producto + color + talle).</p>
      </div>
    `;
    return;
  }

  const lines = [...pendingMoves.values()].sort((a, b) =>
    (a.productName + a.color + a.size).localeCompare(
      b.productName + b.color + b.size,
      "es"
    )
  );

  const sourceLabel =
    currentMode === "to_public" ? "Stock origen (General)" : "Stock origen (Venta Público)";
  const moveOneLabel =
    currentMode === "to_public" ? "Mover línea" : "Devolver línea";

  let totalUnits = 0;
  let html = `<div class="qr-pending-list">`;
  for (const line of lines) {
    totalUnits += line.quantity;
    const maxStock = Math.max(0, line.sourceStock || 0);
    const atOrOver = maxStock > 0 && line.quantity > maxStock;
    const maxInputAttr = maxStock > 0 ? `max="${maxStock}"` : "";
    const warn = atOrOver
      ? `<span style="color:#856404;font-size:12px;">Supera stock disponible (${maxStock})</span>`
      : maxStock === 0
        ? `<span style="color:#856404;font-size:12px;">Sin stock en origen para este modo — no se puede mover.</span>`
        : "";
    const incDisabled =
      maxStock > 0 ? line.quantity >= maxStock : false;
    const lineMoveDisabled = maxStock <= 0 || line.quantity > maxStock;
    html += `
      <div class="qr-line" data-variant-id="${escapeHtml(String(line.variantId))}" data-size="${escapeHtml(String(line.size))}">
        <div class="qr-line-meta">
          <div class="qr-line-title">${escapeHtml(line.productName)}</div>
          <div class="qr-line-tags">
            <span class="qr-line-tag"><strong>Color:</strong> ${escapeHtml(line.color || "—")}</span>
            <span class="qr-line-tag"><strong>Talle:</strong> ${escapeHtml(String(line.size))}</span>
            <span class="qr-line-tag"><strong>SKU:</strong> ${escapeHtml(line.sku || "—")}</span>
            <span class="qr-line-tag">${escapeHtml(sourceLabel)}: <strong>${maxStock}</strong></span>
          </div>
          ${warn ? `<div style="margin-top:6px;">${warn}</div>` : ""}
        </div>
        <div class="qr-line-actions">
          <div class="quantity-controls">
            <button type="button" class="quantity-btn decrease qr-qty-dec" data-variant-id="${escapeHtml(String(line.variantId))}" data-size="${escapeHtml(String(line.size))}" ${line.quantity <= 1 ? "disabled" : ""}>−</button>
            <input type="number" class="quantity-input qr-qty-input" min="1" ${maxInputAttr} value="${line.quantity}"
              data-variant-id="${escapeHtml(String(line.variantId))}" data-size="${escapeHtml(String(line.size))}" />
            <button type="button" class="quantity-btn increase qr-qty-inc" data-variant-id="${escapeHtml(String(line.variantId))}" data-size="${escapeHtml(String(line.size))}" ${incDisabled ? "disabled" : ""}>+</button>
          </div>
          <button type="button" class="move-btn qr-line-move" data-variant-id="${escapeHtml(String(line.variantId))}" data-size="${escapeHtml(String(line.size))}" ${lineMoveDisabled ? "disabled" : ""}>
            ${escapeHtml(moveOneLabel)}
          </button>
          <button type="button" class="btn btn-danger-ghost qr-line-remove" style="padding:8px 12px;font-size:13px;" data-variant-id="${escapeHtml(String(line.variantId))}" data-size="${escapeHtml(String(line.size))}">
            Quitar
          </button>
        </div>
      </div>
    `;
  }
  html += `</div>
    <div style="margin-top:16px;padding:12px;background:#f8f9fa;border-radius:8px;font-size:14px;color:#333;">
      <strong>Total unidades en lista:</strong> ${totalUnits}
    </div>`;

  resultsContainer.innerHTML = html;

  resultsContainer.querySelectorAll(".qr-qty-dec").forEach((btn) => {
    btn.addEventListener("click", onQrQtyButton);
  });
  resultsContainer.querySelectorAll(".qr-qty-inc").forEach((btn) => {
    btn.addEventListener("click", onQrQtyButton);
  });
  resultsContainer.querySelectorAll(".qr-qty-input").forEach((input) => {
    input.addEventListener("change", onQrQtyInput);
  });
  resultsContainer.querySelectorAll(".qr-line-move").forEach((btn) => {
    btn.addEventListener("click", handleMoveQrLineClick);
  });
  resultsContainer.querySelectorAll(".qr-line-remove").forEach((btn) => {
    btn.addEventListener("click", onQrLineRemove);
  });
}

function onQrQtyButton(e) {
  const btn = e.currentTarget;
  const variantId = btn.getAttribute("data-variant-id");
  const size = btn.getAttribute("data-size");
  const key = pendingLineKey(variantId, size);
  const line = pendingMoves.get(key);
  if (!line) return;

  const action = btn.classList.contains("qr-qty-inc") ? "increase" : "decrease";
  const maxStock = Math.max(0, line.sourceStock || 0);
  let q = line.quantity;
  if (action === "increase") {
    if (maxStock > 0) {
      q = Math.min(q + 1, maxStock);
    } else {
      q = q + 1;
    }
  } else {
    q = Math.max(1, q - 1);
  }
  line.quantity = q;
  renderQrPendingList();
}

function onQrQtyInput(e) {
  const input = e.currentTarget;
  const variantId = input.getAttribute("data-variant-id");
  const size = input.getAttribute("data-size");
  const key = pendingLineKey(variantId, size);
  const line = pendingMoves.get(key);
  if (!line) return;

  let q = parseInt(input.value, 10);
  if (!q || q < 1 || isNaN(q)) q = 1;
  const maxStock = Math.max(0, line.sourceStock || 0);
  if (maxStock > 0 && q > maxStock) q = maxStock;
  line.quantity = q;
  renderQrPendingList();
}

function onQrLineRemove(e) {
  const btn = e.currentTarget;
  const variantId = btn.getAttribute("data-variant-id");
  const size = btn.getAttribute("data-size");
  const key = pendingLineKey(variantId, size);
  pendingMoves.delete(key);
  renderQrPendingList();
  setReaderModeUi(true);
}

function addToQrQueue(qrCode) {
  if (!isCompleteReaderQr(qrCode)) return;
  searchInput.value = "";
  qrProcessingQueue.push(qrCode);
  if (!isProcessingQr) {
    processQrQueue();
  }
}

async function processQrQueue() {
  if (qrProcessingQueue.length === 0) {
    isProcessingQr = false;
    return;
  }
  isProcessingQr = true;
  const qrCode = qrProcessingQueue.shift();
  try {
    await processQrCodeForMoveStock(qrCode);
  } catch (err) {
    console.error("Error procesando QR:", err);
    showMessage(
      `Error al procesar código QR ${qrCode}: ${err.message || "Error desconocido"}`,
      "error"
    );
  }
  queueMicrotask(() => processQrQueue());
}

async function processQrCodeForMoveStock(qrCode) {
  let qrMeta = qrMetaCache.get(qrCode);
  if (!qrMeta) {
    const { data: sizeData, error: sizeError } = await supabase
      .from("variant_sizes")
      .select(`
        variant_id,
        size,
        sku,
        qr_code,
        product_variants!inner (
          id,
          sku,
          color,
          active,
          products!inner (
            id,
            name,
            category,
            status
          )
        )
      `)
      .eq("qr_code", qrCode)
      .eq("product_variants.active", true)
      .in("product_variants.products.status", ["active", "pending_stock", "draft"])
      .maybeSingle();

    if (sizeError) throw sizeError;
    if (!sizeData || !sizeData.product_variants) {
      qrMetaCache.set(qrCode, { notFound: true });
      showMessage(`No se encontró el producto con el código QR "${qrCode}"`, "error");
      return;
    }

    const pv = sizeData.product_variants;
    const product = pv.products;
    qrMeta = {
      variantId: pv.id,
      normalizedSize: normalizeSize(sizeData.size) || sizeData.size,
      productName: product?.name || "",
      color: pv.color || "",
      sku: pv.sku || sizeData.sku || "",
    };
    qrMetaCache.set(qrCode, qrMeta);
  }

  if (qrMeta?.notFound) {
    showMessage(`No se encontró el producto con el código QR "${qrCode}"`, "error");
    return;
  }

  const variantId = qrMeta.variantId;
  const normalizedSize = qrMeta.normalizedSize;
  const stockEntry = await getVariantStockCached(variantId);
  const sizeRow = getStockRowFromCacheEntry(stockEntry, normalizedSize);
  const sourceStock = getSourceStockFromRow(sizeRow);

  const key = pendingLineKey(variantId, normalizedSize);
  const sku = qrMeta.sku;

  if (pendingMoves.has(key)) {
    const line = pendingMoves.get(key);
    line.quantity += 1;
    line.sourceStock = sourceStock;
    line.sku = sku;
    line.productName = qrMeta.productName;
    line.color = qrMeta.color;
  } else {
    pendingMoves.set(key, {
      key,
      variantId,
      size: normalizedSize,
      productName: qrMeta.productName,
      color: qrMeta.color,
      sku,
      quantity: 1,
      sourceStock,
    });
  }

  renderQrPendingList();
  setReaderModeUi(true);
  if (shouldAutoFocusMoveStockReaderInput()) searchInput.focus();
}

async function handleMoveQrLineClick(e) {
  const btn = e.currentTarget;
  const variantId = btn.getAttribute("data-variant-id");
  const size = btn.getAttribute("data-size");
  const key = pendingLineKey(variantId, size);
  const line = pendingMoves.get(key);
  if (!line) return;

  const row = btn.closest(".qr-line");
  const qtyInput = row?.querySelector(".qr-qty-input");
  const quantity = qtyInput
    ? parseInt(qtyInput.value, 10)
    : line.quantity;

  if (!quantity || quantity <= 0 || isNaN(quantity)) {
    showMessage("Cantidad inválida", "error");
    return;
  }

  const maxStock = Math.max(0, line.sourceStock || 0);
  if (quantity > maxStock) {
    showMessage(
      `No podés mover más de ${maxStock} unidades (stock disponible en origen)`,
      "error"
    );
    return;
  }

  btn.disabled = true;
  const prevText = btn.textContent;
  btn.textContent = "Moviendo...";

  try {
    const fromWarehouse =
      currentMode === "to_public" ? "general" : "venta-publico";
    const toWarehouse =
      currentMode === "to_public" ? "venta-publico" : "general";
    const actionText =
      currentMode === "to_public"
        ? "movieron a Venta al Público"
        : "devolvieron a General";
    const normalizedSize = normalizeSize(size);

    const operationId = generateOperationId();
    const { data } = await rpcMoveSizeStockWithIdempotency(
      {
        p_variant_id: variantId,
        p_size: normalizedSize,
        p_from_warehouse_code: fromWarehouse,
        p_to_warehouse_code: toWarehouse,
        p_quantity: quantity,
        p_notes:
          currentMode === "to_public"
            ? `Movido desde panel admin (lector QR)`
            : `Devuelto a General desde panel admin (lector QR)`,
      },
      "move_stock_qr_line",
      operationId
    );

    showMessage(
      `✅ Se ${actionText} ${quantity} u. del talle ${normalizedSize}`,
      "success"
    );

    pendingMoves.delete(key);
    invalidateVariantStockCache(variantId);
    await refreshPendingMovesStock();
    renderQrPendingList();
    setReaderModeUi(true);
  } catch (err) {
    console.error(err);
    showMessage("Error al mover stock: " + (err.message || "Error desconocido"), "error");
  } finally {
    btn.disabled = false;
    btn.textContent = prevText;
  }
}

async function handleMoveQrPendingAll() {
  const moveAllBtn = document.getElementById("move-all-btn");
  const moveAllStatus = document.getElementById("move-all-status");

  if (pendingMoves.size === 0) {
    showMessage("La lista de escaneo está vacía.", "error");
    return;
  }

  await refreshPendingMovesStock();

  const movesToProcess = [];
  for (const line of pendingMoves.values()) {
    const quantity = line.quantity;
    if (!quantity || quantity <= 0) continue;
    const maxStock = Math.max(0, line.sourceStock || 0);
    if (quantity > maxStock) {
      showMessage(
        `Revisá la línea "${line.productName}" talle ${line.size}: pedís ${quantity} y hay ${maxStock} en origen.`,
        "error"
      );
      renderQrPendingList();
      return;
    }
    movesToProcess.push({ ...line, quantity });
  }

  if (movesToProcess.length === 0) {
    showMessage("No hay líneas con cantidad válida para mover", "error");
    return;
  }

  if (moveAllBtn) moveAllBtn.disabled = true;
  if (moveAllBtn) moveAllBtn.textContent = "Moviendo...";
  if (moveAllStatus) {
    moveAllStatus.textContent = `Procesando ${movesToProcess.length} línea(s)...`;
  }

  let successCount = 0;
  let errorCount = 0;

  try {
    const batchSize = 5;
    const fromWarehouse =
      currentMode === "to_public" ? "general" : "venta-publico";
    const toWarehouse =
      currentMode === "to_public" ? "venta-publico" : "general";

    for (let i = 0; i < movesToProcess.length; i += batchSize) {
      const batch = movesToProcess.slice(i, i + batchSize);
      const results = await Promise.allSettled(
        batch.map(async ({ variantId, size, quantity }) => {
          const normalizedSize = normalizeSize(size);
          const operationId = generateOperationId();
          await rpcMoveSizeStockWithIdempotency(
            {
              p_variant_id: variantId,
              p_size: normalizedSize,
              p_from_warehouse_code: fromWarehouse,
              p_to_warehouse_code: toWarehouse,
              p_quantity: quantity,
              p_notes:
                currentMode === "to_public"
                  ? `Movido desde panel admin (lector QR, mover todo)`
                  : `Devuelto a General desde panel admin (lector QR, mover todo)`,
            },
            "move_stock_qr_bulk_item",
            operationId
          );
          return { variantId, size: normalizedSize };
        })
      );

      results.forEach((result, index) => {
        const item = batch[index];
        if (result.status === "fulfilled") {
          successCount++;
          const k = pendingLineKey(item.variantId, item.size);
          pendingMoves.delete(k);
          invalidateVariantStockCache(item.variantId);
        } else {
          errorCount++;
          console.error(
            `Error moviendo variante ${item.variantId}, talle ${item.size}:`,
            result.reason
          );
        }
      });

      if (moveAllStatus) {
        moveAllStatus.textContent = `Procesando... ${Math.min(i + batchSize, movesToProcess.length)}/${movesToProcess.length}`;
      }
    }

    if (successCount > 0) {
      if (errorCount === 0) {
        qrMetaCache.clear();
      }
      showMessage(
        `✅ Se movieron ${successCount} línea(s)${errorCount > 0 ? ` (${errorCount} error(es))` : ""}`,
        errorCount > 0 ? "error" : "success"
      );
    } else {
      showMessage("No se pudo mover ninguna línea", "error");
    }

    await refreshPendingMovesStock();
    renderQrPendingList();
    setReaderModeUi(true);
  } catch (err) {
    console.error(err);
    showMessage("Error al mover stock: " + (err.message || "Error desconocido"), "error");
  } finally {
    if (moveAllBtn) moveAllBtn.disabled = false;
    updateMoveAllButtonText();
    if (moveAllStatus) moveAllStatus.textContent = "";
  }
}

// Buscar productos
async function searchProducts(term) {
  if (!term || term.trim().length < 2) {
    resultsContainer.innerHTML = `
      <div class="no-results">
        <p>Ingresa al menos 2 caracteres para buscar</p>
      </div>
    `;
    return;
  }

  resultsContainer.innerHTML = '<div class="loading">Buscando productos...</div>';

  try {
    const searchTerm = term.trim().toLowerCase();
    
    let productIds = [];
    let products = [];
    
    // Primero intentar buscar productos por nombre
    if (searchTerm) {
      // Si el término parece ser un código corto (solo números o alfanumérico corto),
      // buscar coincidencias exactas o que empiecen con el término seguido de un separador
      const isShortCode = /^[a-z0-9]{1,5}$/i.test(searchTerm);
      
      let productsQuery = supabase
        .from("products")
        .select("id, name, category, status")
        .in("status", ["active", "pending_stock", "draft"]);
      
      if (isShortCode) {
        // Para códigos cortos, buscar coincidencias exactas primero
        const { data: exactMatch, error: exactError } = await supabase
          .from("products")
          .select("id, name, category, status")
          .in("status", ["active", "pending_stock", "draft"])
          .ilike("name", searchTerm)
          .limit(100);
        
        if (exactError) throw exactError;
        
        if (exactMatch && exactMatch.length > 0) {
          products = exactMatch;
          productIds = products.map(p => p.id);
        } else {
          // Si no hay coincidencia exacta, buscar que el código esté al inicio o al final
          // pero separado por un guion, espacio, o al inicio/fin del nombre
          // Esto evita que "55" coincida con "MU55" o "Z55"
          const { data: prefixMatch, error: prefixError } = await supabase
            .from("products")
            .select("id, name, category, status")
            .in("status", ["active", "pending_stock", "draft"])
            .or(`name.ilike.${searchTerm},name.ilike.${searchTerm}-%,name.ilike.${searchTerm} %,name.ilike.%-${searchTerm},name.ilike.% ${searchTerm}`)
            .limit(100);
          
          if (prefixError) throw prefixError;
          
          if (prefixMatch && prefixMatch.length > 0) {
            // Filtrar resultados para asegurar que el término esté separado correctamente
            const filtered = prefixMatch.filter(p => {
              const name = p.name.toLowerCase();
              // Coincidencia exacta
              if (name === searchTerm) return true;
              // Empieza con el término seguido de separador
              if (name.startsWith(searchTerm + "-") || name.startsWith(searchTerm + " ")) return true;
              // Termina con el término precedido de separador
              if (name.endsWith("-" + searchTerm) || name.endsWith(" " + searchTerm)) return true;
              return false;
            });
            
            if (filtered.length > 0) {
              products = filtered;
              productIds = products.map(p => p.id);
            }
          }
        }
      } else {
        // Para términos más largos, usar búsqueda parcial normal
        const { data: productsByName, error: productsError } = await productsQuery
          .ilike("name", `%${searchTerm}%`)
          .limit(100);
        
        if (productsError) throw productsError;
        
        if (productsByName && productsByName.length > 0) {
          products = productsByName;
          productIds = products.map(p => p.id);
        }
      }
    }
    
    // Buscar variantes que coincidan con el término (SKU, color)
    // Nota: size ya no está en product_variants, se busca en variant_sizes después
    let variantsQuery = supabase
      .from("product_variants")
      .select(`
        id,
        sku,
        color,
        active,
        product_id,
        products!inner(id, name, category, status)
      `)
      .eq("active", true)
      .in("products.status", ["active", "pending_stock", "draft"]);
    
    if (searchTerm) {
      // Si ya tenemos productos por nombre, buscar variantes de esos productos
      if (productIds.length > 0) {
        variantsQuery = variantsQuery
          .in("product_id", productIds)
          .or(`sku.ilike.%${searchTerm}%,color.ilike.%${searchTerm}%`);
      } else {
        // Si no hay productos por nombre, buscar variantes directamente por SKU o color
        variantsQuery = variantsQuery.or(
          `sku.ilike.%${searchTerm}%,color.ilike.%${searchTerm}%`
        );
      }
    } else {
      // Sin término de búsqueda, obtener todas las variantes activas
      if (productIds.length > 0) {
        variantsQuery = variantsQuery.in("product_id", productIds);
      }
    }
    
    const { data: variants, error: variantsError } = await variantsQuery.limit(500);
    
    if (variantsError) throw variantsError;
    
    if (!variants || variants.length === 0) {
      resultsContainer.innerHTML = `
        <div class="no-results">
          <p>No se encontraron variantes que coincidan con "${term}"</p>
        </div>
      `;
      return;
    }
    
    // Obtener talles desde variant_sizes para las variantes encontradas
    const variantIds = variants.map(v => v.id);
    const { data: variantSizes, error: sizesError } = await supabase
      .from("variant_sizes")
      .select("variant_id, size")
      .in("variant_id", variantIds)
      .order("variant_id, size");
    
    if (sizesError) {
      console.warn("Error obteniendo talles desde variant_sizes:", sizesError);
    }
    
    // Agrupar talles por variant_id
    const sizesByVariant = new Map();
    if (variantSizes) {
      variantSizes.forEach(vs => {
        if (!sizesByVariant.has(vs.variant_id)) {
          sizesByVariant.set(vs.variant_id, []);
        }
        sizesByVariant.get(vs.variant_id).push(vs.size);
      });
    }
    
    // Si el término de búsqueda parece ser un talle, filtrar variantes que tengan ese talle
    let filteredVariants = variants;
    if (searchTerm && variantSizes) {
      const searchTermLower = searchTerm.toLowerCase().trim();
      // Verificar si alguna variante tiene un talle que coincida
      const matchingVariantIds = new Set();
      variantSizes.forEach(vs => {
        if (String(vs.size || "").toLowerCase().includes(searchTermLower)) {
          matchingVariantIds.add(vs.variant_id);
        }
      });
      
      if (matchingVariantIds.size > 0) {
        filteredVariants = variants.filter(v => matchingVariantIds.has(v.id));
      }
    }
    
    if (filteredVariants.length === 0) {
      resultsContainer.innerHTML = `
        <div class="no-results">
          <p>No se encontraron variantes que coincidan con "${term}"</p>
        </div>
      `;
      return;
    }
    
    // Agregar talles a cada variante
    filteredVariants.forEach(v => {
      v.sizes = sizesByVariant.get(v.id) || [];
    });
    
    // Si no encontramos productos por nombre pero sí variantes, obtener los productos de las variantes
    if (products.length === 0) {
      const uniqueProductIds = [...new Set(variants.map(v => v.product_id))];
      const { data: productsFromVariants, error: productsError2 } = await supabase
        .from("products")
        .select("id, name, category, status")
        .in("id", uniqueProductIds)
        .in("status", ["active", "pending_stock", "draft"]);
      
      if (productsError2) throw productsError2;
      products = productsFromVariants || [];
    }
    
    // Combinar productos con sus variantes
    const productsMap = new Map();
    
    // Primero agregar productos conocidos
    products.forEach(p => {
      productsMap.set(p.id, {
        id: p.id,
        name: p.name,
        category: p.category,
        variants: []
      });
    });
    
    // Agregar productos desde variantes si no están en el mapa
    filteredVariants.forEach(v => {
      if (v.products && !productsMap.has(v.products.id)) {
        productsMap.set(v.products.id, {
          id: v.products.id,
          name: v.products.name,
          category: v.products.category,
          variants: []
        });
      }
    });
    
    // Agregar variantes a sus productos
    filteredVariants.forEach(v => {
      const productId = v.product_id || (v.products && v.products.id);
      const product = productsMap.get(productId);
      
      if (product) {
        product.variants.push({
          id: v.id,
          sku: v.sku,
          color: v.color,
          sizes: v.sizes || [],
          active: v.active,
          products: {
            id: product.id,
            name: product.name,
            category: product.category,
            status: "active"
          }
        });
      }
    });
    
    // Filtrar productos que no tienen variantes
    const productsWithVariants = Array.from(productsMap.values())
      .filter(p => p.variants.length > 0);
    
    if (productsWithVariants.length === 0) {
      resultsContainer.innerHTML = `
        <div class="no-results">
          <p>No se encontraron productos con variantes que coincidan con "${term}"</p>
        </div>
      `;
      return;
    }

    // Cargar stock para cada variante
    const productsToShow = productsWithVariants;
    
    for (const product of productsToShow) {
      for (const variant of product.variants) {
        const stockData = await getVariantStock(variant.id);
        variant.stockData = stockData;
      }
    }

    renderResults(productsToShow);
  } catch (error) {
    console.error("Error buscando productos:", error);
    showMessage("Error al buscar productos: " + error.message, "error");
    resultsContainer.innerHTML = `
      <div class="no-results">
        <p>Error al buscar productos. Por favor, intenta nuevamente.</p>
      </div>
    `;
  }
}

// Obtener stock por almacén para una variante (por talle individual)
async function getVariantStock(variantId) {
  try {
    // 1. Obtener talles desde variant_sizes para esta variante
    const { data: sizesData, error: sizesError } = await supabase
      .from("variant_sizes")
      .select("size, stock_qty")
      .eq("variant_id", variantId)
      .order("size");

    if (sizesError) throw sizesError;

    // Crear mapa de talles
    const sizesMap = new Map();
    (sizesData || []).forEach(s => {
      const normalizedSize = normalizeSize(s.size);
      if (normalizedSize) {
        sizesMap.set(normalizedSize, {
          size: normalizedSize,
          stockQty: s.stock_qty || 0
        });
      }
    });

    // 2. Obtener stock por talle desde variant_size_warehouse_stock (usar left join para traer todos)
    // Primero obtener IDs de warehouses
    const { data: warehouses, error: warehousesError } = await supabase
      .from("warehouses")
      .select("id, code")
      .in("code", ["general", "venta-publico"]);

    if (warehousesError) throw warehousesError;

    const warehouseMap = new Map();
    warehouses?.forEach(w => {
      warehouseMap.set(w.code, w.id);
    });

    const generalWarehouseId = warehouseMap.get("general");
    const ventaPublicoWarehouseId = warehouseMap.get("venta-publico");

    if (!generalWarehouseId || !ventaPublicoWarehouseId) {
      console.error("Almacenes no encontrados");
      return { sizes: [] };
    }

    // Obtener stock desde variant_size_warehouse_stock
    const { data: stockData, error: stockError } = await supabase
      .from("variant_size_warehouse_stock")
      .select("size, warehouse_id, stock_qty")
      .eq("variant_id", variantId)
      .in("warehouse_id", [generalWarehouseId, ventaPublicoWarehouseId]);

    if (stockError) throw stockError;

    // 3. Organizar stock por talle y warehouse
    const stockBySize = new Map();
    
    // Inicializar todos los talles desde variant_sizes
    sizesMap.forEach((sizeInfo, normalizedSize) => {
      stockBySize.set(normalizedSize, {
        size: normalizedSize,
        general: 0,
        ventaPublico: 0
      });
    });

    // Poblar con datos reales de variant_size_warehouse_stock
    if (stockData) {
      stockData.forEach(row => {
        const normalizedSize = normalizeSize(row.size);
        if (!normalizedSize) return;

        if (!stockBySize.has(normalizedSize)) {
          stockBySize.set(normalizedSize, {
            size: normalizedSize,
            general: 0,
            ventaPublico: 0
          });
        }

        const sizeStock = stockBySize.get(normalizedSize);
        const stockQty = row.stock_qty || 0;

        if (String(row.warehouse_id) === String(generalWarehouseId)) {
          sizeStock.general = stockQty;
        } else if (String(row.warehouse_id) === String(ventaPublicoWarehouseId)) {
          sizeStock.ventaPublico = stockQty;
        }
      });
    }

    // 4. Plan 2: sin fallback operativo desde variant_sizes.

    // 5. Retornar estructura con talles
    return {
      sizes: Array.from(stockBySize.values())
    };
  } catch (error) {
    console.error("Error obteniendo stock:", error);
    return {
      sizes: []
    };
  }
}

// Renderizar resultados
function renderResults(products) {
  if (products.length === 0) {
    resultsContainer.innerHTML = `
      <div class="no-results">
        <p>No se encontraron productos</p>
      </div>
    `;
    return;
  }

  let html = "";

  for (const product of products) {
    html += `
      <div class="product-item">
        <div class="product-header">
          <div>
            <div class="product-name">${escapeHtml(product.name)}</div>
            <div class="product-category">${escapeHtml(product.category || "")}</div>
          </div>
        </div>
        <div class="variants-list">
    `;

    for (const variant of product.variants) {
      const stockData = variant.stockData || { sizes: [] };
      const sizes = stockData.sizes || [];

      const sizesDisplay = variant.sizes && variant.sizes.length > 0 
        ? variant.sizes.join(", ") 
        : "Sin talles";

      // Información de la variante (cabecera)
      html += `
        <div class="variant-item" data-variant-id="${variant.id}">
          <div class="variant-info">
            <div class="variant-details">
              <span class="variant-detail"><strong>SKU:</strong> ${escapeHtml(variant.sku || "")}</span>
              <span class="variant-detail"><strong>Color:</strong> ${escapeHtml(variant.color || "")}</span>
              <span class="variant-detail"><strong>Talles:</strong> ${escapeHtml(sizesDisplay)}</span>
            </div>
          </div>
          <div class="sizes-list" style="margin-top: 12px; padding-top: 12px; border-top: 1px solid #e5e5e5;">
      `;

      // Mostrar cada talle con sus controles individuales
      const sourceLabel = currentMode === "to_public" 
        ? "Stock General" 
        : "Stock Venta Público";
      const destinationLabel = currentMode === "to_public" 
        ? "Venta Público" 
        : "General";
      const buttonText = currentMode === "to_public" 
        ? "Mover a Venta Público" 
        : "Devolver a General";

      if (sizes.length === 0) {
        html += `
          <div style="padding: 8px; color: #999; font-size: 14px;">
            No hay talles con stock para mover
          </div>
        `;
      } else {
        sizes.forEach(sizeStock => {
          const normalizedSize = normalizeSize(sizeStock.size);
          const sourceStock = currentMode === "to_public" 
            ? sizeStock.general 
            : sizeStock.ventaPublico;

          html += `
            <div class="size-item" style="display: flex; align-items: center; gap: 12px; padding: 8px; background: #f9f9f9; border-radius: 6px; margin-bottom: 8px; flex-wrap: wrap;">
              <div style="min-width: 80px; font-weight: 600; color: #333;">
                Talle ${normalizedSize}
              </div>
              <div style="min-width: 120px; text-align: center;">
                <div style="font-size: 12px; color: #666; margin-bottom: 2px;">${sourceLabel}</div>
                <div class="stock-value" style="font-size: 16px; font-weight: 600; color: #155724;">${sourceStock}</div>
              </div>
              <div class="move-controls" style="display: flex; align-items: center; gap: 4px; flex-wrap: wrap;">
                <div class="quantity-controls" style="display: flex; align-items: center; gap: 0; border: 1px solid #ddd; border-radius: 6px; overflow: hidden;">
                  <button 
                    class="quantity-btn decrease" 
                    data-variant-id="${variant.id}"
                    data-size="${normalizedSize}"
                    data-action="decrease"
                    ${sourceStock === 0 ? "disabled" : ""}
                    type="button"
                    style="width: 32px; height: 32px; padding: 0; border: none; background: #f0f0f0; color: #333; font-size: 16px; font-weight: 600; cursor: pointer; display: flex; align-items: center; justify-content: center;"
                  >
                    −
                  </button>
                  <input 
                    type="number" 
                    class="quantity-input" 
                    min="0" 
                    max="${sourceStock}"
                    value="0"
                    placeholder="0"
                    data-variant-id="${variant.id}"
                    data-size="${normalizedSize}"
                    ${sourceStock === 0 ? "disabled" : ""}
                    style="width: 50px; padding: 6px 4px; border: none; border-left: 1px solid #ddd; border-right: 1px solid #ddd; text-align: center; font-size: 14px;"
                  />
                  <button 
                    class="quantity-btn increase" 
                    data-variant-id="${variant.id}"
                    data-size="${normalizedSize}"
                    data-action="increase"
                    ${sourceStock === 0 ? "disabled" : ""}
                    type="button"
                    style="width: 32px; height: 32px; padding: 0; border: none; background: #f0f0f0; color: #333; font-size: 16px; font-weight: 600; cursor: pointer; display: flex; align-items: center; justify-content: center;"
                  >
                    +
                  </button>
                </div>
                <button 
                  class="move-btn" 
                  data-variant-id="${variant.id}"
                  data-size="${normalizedSize}"
                  ${sourceStock === 0 ? "disabled" : ""}
                  style="padding: 6px 12px; background: #CD844D; color: white; border: none; border-radius: 6px; cursor: pointer; font-weight: 500; font-size: 13px;"
                >
                  ${buttonText}
                </button>
              </div>
            </div>
          `;
        });
      }

      html += `
          </div>
        </div>
      `;
    }

    html += `
        </div>
      </div>
    `;
  }

  resultsContainer.innerHTML = html;

  // Mostrar/ocultar header con botón "Mover todo"
  const resultsHeader = document.getElementById("results-header");
  if (products && products.length > 0) {
    if (resultsHeader) {
      resultsHeader.style.display = "block";
    }
  } else {
    if (resultsHeader) {
      resultsHeader.style.display = "none";
    }
  }

  // Agregar event listeners a los botones individuales
  document.querySelectorAll(".move-btn").forEach(btn => {
    btn.addEventListener("click", handleMoveStock);
  });
  
  // Agregar event listeners a los botones + y -
  document.querySelectorAll(".quantity-btn").forEach(btn => {
    btn.addEventListener("click", handleQuantityChange);
  });
}

// Manejar cambios de cantidad con botones + y -
function handleQuantityChange(event) {
  const btn = event.target;
  const variantId = btn.getAttribute("data-variant-id");
  const size = btn.getAttribute("data-size");
  const action = btn.getAttribute("data-action");
  
  // Buscar input específico por variant_id y size
  const quantityInput = document.querySelector(
    `.quantity-input[data-variant-id="${variantId}"][data-size="${size}"]`
  );
  
  if (!quantityInput || quantityInput.disabled) return;
  
  const currentValue = parseInt(quantityInput.value, 10) || 0;
  const maxValue = parseInt(quantityInput.max, 10);
  const minValue = parseInt(quantityInput.min, 10) || 0;
  
  let newValue = currentValue;
  
  if (action === "increase") {
    newValue = Math.min(currentValue + 1, maxValue);
  } else if (action === "decrease") {
    newValue = Math.max(currentValue - 1, minValue);
  }
  
  quantityInput.value = newValue;
  
  // Disparar evento input para que otros listeners sepan del cambio
  quantityInput.dispatchEvent(new Event("input", { bubbles: true }));
}

// Manejar movimiento de stock
async function handleMoveStock(event) {
  const btn = event.target;
  const variantId = btn.getAttribute("data-variant-id");
  const size = btn.getAttribute("data-size");
  
  if (!variantId || !size) {
    showMessage("Error: No se encontró información del talle", "error");
    return;
  }

  // Buscar input específico por variant_id y size
  const quantityInput = document.querySelector(
    `.quantity-input[data-variant-id="${variantId}"][data-size="${size}"]`
  );
  
  if (!quantityInput) {
    showMessage("Error: No se encontró el input de cantidad", "error");
    return;
  }

  const quantity = parseInt(quantityInput.value, 10);

  if (!quantity || quantity <= 0 || isNaN(quantity)) {
    showMessage("Por favor, ingresa una cantidad válida mayor a 0", "error");
    return;
  }

  const maxStock = parseInt(quantityInput.max, 10);
  if (quantity > maxStock) {
    showMessage(`No puedes mover más de ${maxStock} unidades (stock disponible)`, "error");
    return;
  }

  btn.disabled = true;
  btn.textContent = "Moviendo...";

  try {
    // Determinar almacenes según el modo
    const fromWarehouse = currentMode === "to_public" ? "general" : "venta-publico";
    const toWarehouse = currentMode === "to_public" ? "venta-publico" : "general";
    const actionText = currentMode === "to_public" ? "movieron a Venta al Público" : "devolvieron a General";
    
    const normalizedSize = normalizeSize(size);
    
    const operationId = generateOperationId();
    const { data } = await rpcMoveSizeStockWithIdempotency(
      {
        p_variant_id: variantId,
        p_size: normalizedSize,
        p_from_warehouse_code: fromWarehouse,
        p_to_warehouse_code: toWarehouse,
        p_quantity: quantity,
        p_notes: currentMode === "to_public"
          ? `Movido desde panel de admin`
          : `Devuelto a General desde panel de admin`,
      },
      "move_stock_single",
      operationId
    );

    showMessage(
      `✅ Se ${actionText} ${quantity} unidades del talle ${normalizedSize} exitosamente`,
      "success"
    );

    // Actualizar stock en la UI para este talle específico
    const sizeItem = btn.closest(".size-item");
    const stockValueEl = sizeItem.querySelector(".stock-value");
    const newStock = data.from_stock_after;
    
    if (stockValueEl) {
      stockValueEl.textContent = newStock;
    }
    quantityInput.max = newStock;
    quantityInput.value = "0";
    
    // Actualizar estado de botones y inputs
    if (newStock === 0) {
      quantityInput.disabled = true;
      btn.disabled = true;
      const decreaseBtn = sizeItem.querySelector(`.quantity-btn.decrease[data-variant-id="${variantId}"][data-size="${normalizedSize}"]`);
      const increaseBtn = sizeItem.querySelector(`.quantity-btn.increase[data-variant-id="${variantId}"][data-size="${normalizedSize}"]`);
      if (decreaseBtn) decreaseBtn.disabled = true;
      if (increaseBtn) increaseBtn.disabled = true;
    } else {
      quantityInput.disabled = false;
      btn.disabled = false;
      const decreaseBtn = sizeItem.querySelector(`.quantity-btn.decrease[data-variant-id="${variantId}"][data-size="${normalizedSize}"]`);
      const increaseBtn = sizeItem.querySelector(`.quantity-btn.increase[data-variant-id="${variantId}"][data-size="${normalizedSize}"]`);
      if (decreaseBtn) decreaseBtn.disabled = false;
      if (increaseBtn) increaseBtn.disabled = false;
    }

  } catch (error) {
    console.error("Error moviendo stock:", error);
    showMessage("Error al mover stock: " + (error.message || "Error desconocido"), "error");
  } finally {
    btn.disabled = false;
    const buttonText = currentMode === "to_public" 
      ? "Mover a Venta Público" 
      : "Devolver a General";
    btn.textContent = buttonText;
  }
}

// Mostrar mensaje
function showMessage(text, type = "info") {
  messageContainer.innerHTML = `
    <div class="message ${type}">
      ${escapeHtml(text)}
    </div>
  `;

  // Auto-ocultar después de 5 segundos
  setTimeout(() => {
    messageContainer.innerHTML = "";
  }, 5000);
}

// Escapar HTML
function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// Buscar sugerencias para autocompletado
async function loadSuggestions(term) {
  if (!term || term.trim().length < 2) {
    suggestionsDropdown.style.display = "none";
    return;
  }

  try {
    const searchTerm = term.trim().toLowerCase();
    
    const { data: products, error } = await supabase
      .from("products")
      .select("id, name, category")
      .in("status", ["active", "pending_stock", "draft"])
      .ilike("name", `%${searchTerm}%`)
      .limit(10);

    if (error) throw error;

    if (!products || products.length === 0) {
      suggestionsDropdown.style.display = "none";
      return;
    }

    // Actualizar datalist
    productsDatalist.innerHTML = "";
    products.forEach(p => {
      const option = document.createElement("option");
      option.value = p.name;
      productsDatalist.appendChild(option);
    });

    // Mostrar sugerencias en dropdown
    suggestionsList.innerHTML = products.map(p => `
      <div class="suggestion-item" data-product-name="${escapeHtml(p.name)}">
        <div class="suggestion-name">${escapeHtml(p.name)}</div>
        <div class="suggestion-details">${escapeHtml(p.category || "")}</div>
      </div>
    `).join("");

    // Agregar event listeners a las sugerencias
    suggestionsList.querySelectorAll(".suggestion-item").forEach(item => {
      item.addEventListener("click", () => {
        const productName = item.getAttribute("data-product-name");
        searchInput.value = productName;
        suggestionsDropdown.style.display = "none";
        searchProducts(productName);
      });
    });

    suggestionsDropdown.style.display = "block";
  } catch (error) {
    console.error("Error cargando sugerencias:", error);
    suggestionsDropdown.style.display = "none";
  }
}

// Event listener para búsqueda y autocompletado
searchInput.addEventListener("input", (e) => {
  if (isQrReaderMode) {
    clearTimeout(qrInputTimeout);
    clearTimeout(searchTimeout);
    clearTimeout(suggestionsTimeout);
    suggestionsDropdown.style.display = "none";
    const raw = e.target.value.trim();
    if (raw.length === 0) return;
    qrInputTimeout = setTimeout(() => {
      const current = searchInput.value.trim();
      if (!current) return;
      if (isCompleteReaderQr(current)) {
        addToQrQueue(current);
      }
    }, QR_INPUT_DEBOUNCE_MS);
    return;
  }

  clearTimeout(searchTimeout);
  clearTimeout(suggestionsTimeout);
  const term = e.target.value.trim();

  // Mostrar sugerencias mientras escribe
  suggestionsTimeout = setTimeout(() => {
    loadSuggestions(term);
  }, 200);

  // Búsqueda completa después de un delay más largo
  if (term.length >= 2) {
    searchTimeout = setTimeout(() => {
      searchProducts(term);
    }, 500);
  } else {
    resultsContainer.innerHTML = `
      <div class="no-results">
        <p>Ingresa al menos 2 caracteres para buscar</p>
      </div>
    `;
  }
});

searchInput.addEventListener("keydown", (e) => {
  if (!isQrReaderMode) return;
  if (e.key === "Enter") {
    e.preventDefault();
    clearTimeout(qrInputTimeout);
    const v = searchInput.value.trim();
    if (isCompleteReaderQr(v)) {
      addToQrQueue(v);
    }
  }
});

// Ocultar sugerencias al hacer clic fuera
document.addEventListener("click", (e) => {
  if (!searchInput.contains(e.target) && !suggestionsDropdown.contains(e.target)) {
    suggestionsDropdown.style.display = "none";
  }
});

// Manejar movimiento de todas las variantes (por talle individual)
async function handleMoveAll() {
  if (isQrReaderMode) {
    await handleMoveQrPendingAll();
    return;
  }

  console.log("🔄 handleMoveAll llamado");
  const moveAllBtn = document.getElementById("move-all-btn");
  const moveAllStatus = document.getElementById("move-all-status");
  
  if (!moveAllBtn) {
    console.error("❌ Botón move-all-btn no encontrado");
    return;
  }
  
  // Obtener todas las combinaciones variant_id + size con cantidad > 0
  const sizeItems = document.querySelectorAll(".size-item");
  const movesToProcess = [];
  
  for (const item of sizeItems) {
    const variantItem = item.closest(".variant-item");
    if (!variantItem) continue;
    
    const variantId = variantItem.getAttribute("data-variant-id");
    const size = item.querySelector(".quantity-input")?.getAttribute("data-size");
    
    if (!variantId || !size) continue;
    
    const quantityInput = item.querySelector(`.quantity-input[data-variant-id="${variantId}"][data-size="${size}"]`);
    
    if (!quantityInput || quantityInput.disabled) continue;
    
    const quantity = parseInt(quantityInput.value, 10);
    if (!quantity || quantity <= 0 || isNaN(quantity)) continue;
    
    const maxStock = parseInt(quantityInput.max, 10);
    if (quantity > maxStock) {
      showMessage(`No puedes mover más de ${maxStock} unidades para el talle ${size}`, "error");
      return;
    }
    
    movesToProcess.push({ variantId, size, quantity, quantityInput, item });
  }
  
  if (movesToProcess.length === 0) {
    showMessage("No hay talles con cantidades válidas para mover", "error");
    return;
  }
  
  moveAllBtn.disabled = true;
  moveAllBtn.textContent = "Moviendo...";
  moveAllStatus.textContent = `Procesando ${movesToProcess.length} movimiento(s)...`;
  
  let successCount = 0;
  let errorCount = 0;
  
  try {
    // Procesar movimientos en paralelo (con límite de concurrencia)
    const batchSize = 5;
    for (let i = 0; i < movesToProcess.length; i += batchSize) {
      const batch = movesToProcess.slice(i, i + batchSize);
      
      // Determinar almacenes según el modo
      const fromWarehouse = currentMode === "to_public" ? "general" : "venta-publico";
      const toWarehouse = currentMode === "to_public" ? "venta-publico" : "general";
      
      const results = await Promise.allSettled(
        batch.map(async ({ variantId, size, quantity }) => {
          const normalizedSize = normalizeSize(size);
          const operationId = generateOperationId();
          const { data } = await rpcMoveSizeStockWithIdempotency(
            {
              p_variant_id: variantId,
              p_size: normalizedSize,
              p_from_warehouse_code: fromWarehouse,
              p_to_warehouse_code: toWarehouse,
              p_quantity: quantity,
              p_notes: currentMode === "to_public"
                ? `Movido desde panel de admin (mover todo)`
                : `Devuelto a General desde panel de admin (mover todo)`,
            },
            "move_stock_bulk_item",
            operationId
          );

          return { variantId, size: normalizedSize, quantity, data };
        })
      );
      
      // Actualizar UI para cada movimiento exitoso
      results.forEach((result, index) => {
        const { variantId, size, quantity, quantityInput, item } = batch[index];
        
        if (result.status === "fulfilled") {
          successCount++;
          const normalizedSize = normalizeSize(size);
          const stockValueEl = item.querySelector(".stock-value");
          const newStock = result.value.data.from_stock_after;
          
          if (stockValueEl) {
            stockValueEl.textContent = newStock;
          }
          quantityInput.max = newStock;
          quantityInput.value = "0";
          
          // Actualizar estado de botones y inputs
          if (newStock === 0) {
            quantityInput.disabled = true;
            const moveBtn = item.querySelector(`.move-btn[data-variant-id="${variantId}"][data-size="${normalizedSize}"]`);
            const decreaseBtn = item.querySelector(`.quantity-btn.decrease[data-variant-id="${variantId}"][data-size="${normalizedSize}"]`);
            const increaseBtn = item.querySelector(`.quantity-btn.increase[data-variant-id="${variantId}"][data-size="${normalizedSize}"]`);
            if (moveBtn) moveBtn.disabled = true;
            if (decreaseBtn) decreaseBtn.disabled = true;
            if (increaseBtn) increaseBtn.disabled = true;
          } else {
            quantityInput.disabled = false;
            const moveBtn = item.querySelector(`.move-btn[data-variant-id="${variantId}"][data-size="${normalizedSize}"]`);
            const decreaseBtn = item.querySelector(`.quantity-btn.decrease[data-variant-id="${variantId}"][data-size="${normalizedSize}"]`);
            const increaseBtn = item.querySelector(`.quantity-btn.increase[data-variant-id="${variantId}"][data-size="${normalizedSize}"]`);
            if (moveBtn) moveBtn.disabled = false;
            if (decreaseBtn) decreaseBtn.disabled = false;
            if (increaseBtn) increaseBtn.disabled = false;
          }
        } else {
          errorCount++;
          console.error(`Error moviendo variante ${variantId}, talle ${size}:`, result.reason);
        }
      });
      
      moveAllStatus.textContent = `Procesando... ${Math.min(i + batchSize, movesToProcess.length)}/${movesToProcess.length}`;
    }
    
    if (successCount > 0) {
      showMessage(
        `✅ Se movieron ${successCount} talle(s) exitosamente${errorCount > 0 ? ` (${errorCount} error(es))` : ""}`,
        successCount === movesToProcess.length ? "success" : "error"
      );
    } else {
      showMessage("Error: No se pudo mover ningún talle", "error");
    }
    
  } catch (error) {
    console.error("Error en movimiento masivo:", error);
    showMessage("Error al mover stock: " + (error.message || "Error desconocido"), "error");
  } finally {
    moveAllBtn.disabled = false;
    updateMoveAllButtonText();
    moveAllStatus.textContent = "";
  }
}

// Actualizar texto del botón según el modo
function updateMoveAllButtonText() {
  const moveAllBtn = document.getElementById("move-all-btn");
  if (moveAllBtn) {
    moveAllBtn.textContent = currentMode === "to_public" 
      ? "📦 Mover Todo a Venta Público" 
      : "↩️ Devolver Todo a General";
  }
}

// Toggle entre modos
function toggleMode() {
  currentMode = currentMode === "to_public" ? "to_general" : "to_public";
  
  const modeToggle = document.getElementById("mode-toggle");
  if (modeToggle) {
    modeToggle.textContent = currentMode === "to_public" 
      ? "📦 Mover a Venta Público" 
      : "↩️ Devolver a General";
  }
  
  updateMoveAllButtonText();

  if (isQrReaderMode) {
    refreshPendingMovesStock()
      .then(() => {
        renderQrPendingList();
        setReaderModeUi(true);
      })
      .catch((err) => console.error(err));
    return;
  }

  // Si hay resultados, re-renderizarlos con el nuevo modo
  const currentSearch = searchInput.value.trim();
  if (currentSearch.length >= 2) {
    searchProducts(currentSearch);
  }
}

// Event listener para botón "Mover todo" usando event delegation
// Esto funciona incluso si el botón se crea dinámicamente
document.addEventListener("click", (e) => {
  if (e.target && (e.target.id === "move-all-btn" || e.target.closest("#move-all-btn"))) {
    e.preventDefault();
    e.stopPropagation();
    console.log("🖱️ Click detectado en botón Mover Todo");
    handleMoveAll();
  }
  
  // Toggle de modo
  if (e.target && (e.target.id === "mode-toggle" || e.target.closest("#mode-toggle"))) {
    e.preventDefault();
    e.stopPropagation();
    toggleMode();
  }
});

// Inicializar texto del botón de modo
updateMoveAllButtonText();

if (qrReaderModeEl) {
  qrReaderModeEl.addEventListener("change", (e) => {
    isQrReaderMode = e.target.checked;
    setReaderModeUi(isQrReaderMode);
    if (isQrReaderMode) {
      suggestionsDropdown.style.display = "none";
      clearTimeout(searchTimeout);
      clearTimeout(suggestionsTimeout);
      clearTimeout(qrInputTimeout);
      qrProcessingQueue = [];
      isProcessingQr = false;
      renderQrPendingList();
      if (shouldAutoFocusMoveStockReaderInput()) searchInput.focus();
    } else {
      clearMoveStockCaches();
      const term = searchInput.value.trim();
      if (term.length >= 2) {
        searchProducts(term);
      } else {
        resultsContainer.innerHTML = `
          <div class="no-results">
            <p>Ingresa un término de búsqueda para comenzar</p>
          </div>
        `;
        const resultsHeader = document.getElementById("results-header");
        if (resultsHeader) resultsHeader.style.display = "none";
      }
    }
  });
}

if (clearQrListBtn) {
  clearQrListBtn.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    pendingMoves.clear();
    qrProcessingQueue = [];
    isProcessingQr = false;
    renderQrPendingList();
    setReaderModeUi(true);
    if (shouldAutoFocusMoveStockReaderInput()) searchInput.focus();
  });
}

// Búsqueda inicial si hay texto en el input
if (searchInput.value.trim().length >= 2) {
  searchProducts(searchInput.value.trim());
}

