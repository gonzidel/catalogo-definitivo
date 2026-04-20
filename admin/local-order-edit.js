// admin/local-order-edit.js — Ventana de edición de pedido local
import { requireAuth } from "./admin-auth.js";
import { supabase } from "../scripts/supabase-client.js";
import { SUPABASE_URL, QZ_SIGN_SECRET } from "../scripts/config.js";
import { normalizeSize } from "../scripts/utils/size-normalizer.js";

function generateOperationId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const nowHex = Date.now().toString(16).padStart(12, "0");
  const randHex = Math.random().toString(16).slice(2).padEnd(20, "0").slice(0, 20);
  return `${nowHex.slice(0, 8)}-${nowHex.slice(8, 12)}-4${randHex.slice(0, 3)}-a${randHex.slice(3, 6)}-${randHex.slice(6, 18)}`;
}

await requireAuth();

const TICKET_WIDTH = 42;

function padRight(text, width) {
  text = String(text ?? "");
  if (width <= 0) return "";
  return text.length >= width ? text.slice(0, width) : text + " ".repeat(width - text.length);
}
function padLeft(text, width) {
  text = String(text ?? "");
  if (width <= 0) return "";
  return text.length >= width ? text.slice(0, width) : " ".repeat(width - text.length) + text;
}
function center(text, width = TICKET_WIDTH) {
  text = String(text ?? "");
  if (width <= 0) return "";
  if (text.length >= width) return text.slice(0, width);
  const left = Math.floor((width - text.length) / 2);
  return " ".repeat(left) + text;
}

const TIMEZONE_BUENOS_AIRES = "America/Argentina/Buenos_Aires";

function buildEscposTicket(saleDetails, customer, finalTotal) {
  const sale = saleDetails.sale;
  const items = saleDetails.items || [];
  const saleDate = new Date(sale.created_at);
  const dateStr = saleDate.toLocaleDateString("es-AR", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: TIMEZONE_BUENOS_AIRES });
  const timeStr = saleDate.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit", timeZone: TIMEZONE_BUENOS_AIRES });
  let ticket = [];
  ticket.push(center("FYL moda"));
  ticket.push("-".repeat(TICKET_WIDTH));
  ticket.push("");
  ticket.push(`Venta: ${sale.sale_number}`);
  ticket.push(`Fecha: ${dateStr}`);
  ticket.push(`Hora: ${timeStr}`);
  if (customer) {
    const customerName = `${customer.first_name} ${customer.last_name || ""}`.trim();
    ticket.push(`Cliente: ${customerName.substring(0, TICKET_WIDTH - 9)}`);
  }
  ticket.push("");
  ticket.push("-".repeat(TICKET_WIDTH));
  ticket.push(center("DETALLE DE LA COMPRA"));
  ticket.push("-".repeat(TICKET_WIDTH));
  const colProducto = 22, colCant = 4, colPrecio = 8, colTotal = 8;
  ticket.push(padRight("Producto", colProducto) + padLeft("Cant", colCant) + padLeft("Precio", colPrecio) + padLeft("Total", colTotal));
  ticket.push("-".repeat(TICKET_WIDTH));
  items.forEach((item) => {
    const price = parseFloat(item.price ?? item.price_snapshot ?? 0);
    const total = price * item.qty;
    let productName = `${item.product_name || "N/A"}`;
    if (item.color) productName += ` - ${item.color}`;
    if (item.size) productName += ` (${item.size})`;
    const name = productName.slice(0, colProducto);
    ticket.push(padRight(name, colProducto) + padLeft(String(item.qty), colCant) + padLeft(`$${price.toLocaleString("es-AR")}`, colPrecio) + padLeft(`$${total.toLocaleString("es-AR")}`, colTotal));
  });
  ticket.push("-".repeat(TICKET_WIDTH));
  ticket.push("");
  if (sale.credit_used > 0) {
    ticket.push(`Credito Aplicado: ${padLeft("-$" + parseFloat(sale.credit_used).toLocaleString("es-AR"), TICKET_WIDTH - 20)}`);
    ticket.push("");
  }
  const totalAmount = finalTotal != null ? parseFloat(finalTotal) : parseFloat(sale.total_amount);
  ticket.push(padLeft(`TOTAL: $${totalAmount.toLocaleString("es-AR")}`, TICKET_WIDTH));
  ticket.push("");
  ticket.push("-".repeat(TICKET_WIDTH));
  ticket.push(center("DOCUMENTO NO VALIDO"));
  ticket.push(center("COMO FACTURA"));
  ticket.push("");
  if (customer?.qr_code) {
    ticket.push(center("Escanea para ver tu"));
    ticket.push(center("historial y creditos:"));
  }
  return ticket.join("\n");
}

async function setupQZSignature() {
  if (typeof qz === "undefined" || !qz?.security) return;
  try {
    const certResponse = await fetch("/certs/qz-site.crt", { cache: "no-store" });
    const certText = await certResponse.text();
    qz.security.setCertificatePromise((resolve, reject) => {
      const match = certText.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/);
      resolve(match ? match[0] : certText);
    });
    qz.security.setSignatureAlgorithm("SHA512");
    qz.security.setSignaturePromise(async (toSign) => {
      const secret = QZ_SIGN_SECRET || window.QZ_SIGN_SECRET || "";
      const res = await fetch(`${SUPABASE_URL}/functions/v1/qz-sign`, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8", "x-qz-secret": secret },
        body: toSign,
      });
      if (!res.ok) throw new Error(`Firma: ${res.status}`);
      return (await res.text()).trim();
    });
  } catch (e) {
    console.warn("QZ firma:", e);
  }
}

async function qzConnect() {
  if (typeof qz === "undefined" || !qz?.websocket) throw new Error("QZ no disponible");
  await setupQZSignature();
  if (!qz.websocket.isActive()) await qz.websocket.connect();
}

async function qzGetPrinterConfig() {
  const printerName = await qz.printers.getDefault();
  return qz.configs.create(printerName);
}

async function loadQZTray() {
  if (typeof qz !== "undefined" && qz) {
    await setupQZSignature();
    return;
  }
  if (document.querySelector('script[src*="qz-tray.js"]')) {
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (typeof qz !== "undefined" && qz) {
        await setupQZSignature();
        return;
      }
    }
    throw new Error("QZ no cargó");
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/qz-tray@2.2.5/qz-tray.js";
    script.async = true;
    script.onload = () => setTimeout(() => (typeof qz !== "undefined" && qz ? setupQZSignature().then(resolve) : reject(new Error("QZ no disponible"))), 500);
    script.onerror = () => reject(new Error("Error cargando QZ"));
    document.head.appendChild(script);
  });
}

async function printSaleWithQZ(saleDetails, customer, finalTotal) {
  if (typeof qz === "undefined" || !qz) throw new Error("QZ no disponible");
  await qzConnect();
  const config = await qzGetPrinterConfig();
  const ticketText = buildEscposTicket(saleDetails, customer, finalTotal);
  const data = ["\x1B\x40", ticketText + "\n\n"];
  if (customer?.qr_code) {
    const url = `${window.location.origin}/customer.html?code=${customer.qr_code}`;
    const qrApiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=180x180&margin=10&data=${encodeURIComponent(url)}`;
    data.push("\x1B\x61\x01");
    data.push({ type: "raw", format: "image", flavor: "file", data: qrApiUrl, options: { language: "ESCPOS" } });
    data.push("\x1B\x64\x03");
    data.push("\x1B\x61\x00");
  }
  data.push("\x1D\x56\x42\x00");
  await qz.print(config, data);
}

// --- Estado y DOM
let orderId = null;
let order = null;
let customer = null;
let items = []; // { variant_id?, product_name, color?, size?, quantity, price_snapshot, isExtra? }
let manualCurrentProduct = null;
let manualCurrentVariants = [];
let manualSelectedColor = null;
let manualSelectedSize = null;

const messageContainer = document.getElementById("message-container");
const orderInfoCard = document.getElementById("order-info-card");
const orderNumberEl = document.getElementById("order-number");
const customerNameEl = document.getElementById("customer-name");
const customerNumberEl = document.getElementById("customer-number");
const orderTotalDisplay = document.getElementById("order-total-display");
const itemsTbody = document.getElementById("items-tbody");
const itemsTotalLine = document.getElementById("items-total-line");
const specialExtraName = document.getElementById("special-extra-name");
const specialExtraAmount = document.getElementById("special-extra-amount");
const addSpecialExtraBtn = document.getElementById("add-special-extra-btn");
const manualProduct = document.getElementById("manual-product");
const autocompleteDropdown = document.getElementById("autocomplete-dropdown");
const manualProductInfo = document.getElementById("manual-product-info");
const manualProductName = document.getElementById("manual-product-name");
const manualProductPrice = document.getElementById("manual-product-price");
const manualColorButtons = document.getElementById("manual-color-buttons");
const manualSizeButtons = document.getElementById("manual-size-buttons");
const manualAddBtn = document.getElementById("manual-add-btn");
const saveBtn = document.getElementById("save-btn");
const finalizeBtn = document.getElementById("finalize-btn");
const closeBtn = document.getElementById("close-btn");

function showMessage(msg, type = "success") {
  messageContainer.innerHTML = `<div class="message ${type}">${escapeHtml(msg)}</div>`;
  messageContainer.scrollIntoView({ behavior: "smooth" });
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function getTotal() {
  return items.reduce((sum, it) => sum + it.quantity * parseFloat(it.price_snapshot || 0), 0);
}

function renderItems() {
  const total = getTotal();
  if (items.length === 0) {
    itemsTbody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: #999;">No hay ítems</td></tr>';
  } else {
    itemsTbody.innerHTML = items.map((it, idx) => {
      const subtotal = it.quantity * parseFloat(it.price_snapshot || 0);
      const isExtra = !it.variant_id;
      const nameCell = isExtra
        ? `<span style="font-style: italic;">${escapeHtml(it.product_name)}</span> <span style="font-size: 11px; color: #0066cc;">(Extra)</span>`
        : escapeHtml(it.product_name) + (it.color ? ` - ${escapeHtml(it.color)}` : "") + (it.size ? ` (${escapeHtml(it.size)})` : "");
      return `<tr class="${isExtra ? "item-extra" : ""}" data-idx="${idx}">
        <td>${nameCell}</td>
        <td><div class="qty-cell"><input type="number" min="1" value="${it.quantity}" data-idx="${idx}" class="item-qty" />${!isExtra ? "" : ""}</div></td>
        <td>$${parseFloat(it.price_snapshot || 0).toLocaleString("es-AR")}</td>
        <td>$${subtotal.toLocaleString("es-AR")}</td>
        <td><button type="button" class="btn btn-danger" data-remove-idx="${idx}" style="padding: 4px 8px;">Quitar</button></td>
      </tr>`;
    }).join("");
  }
  itemsTotalLine.textContent = `Total: $${total.toLocaleString("es-AR")}`;
  if (orderTotalDisplay) orderTotalDisplay.textContent = `$${total.toLocaleString("es-AR")}`;

  itemsTbody.querySelectorAll(".item-qty").forEach((input) => {
    input.addEventListener("change", (e) => {
      const idx = parseInt(e.target.dataset.idx, 10);
      const q = parseInt(e.target.value, 10);
      if (!isNaN(q) && q >= 1 && items[idx]) {
        items[idx].quantity = q;
        renderItems();
      }
    });
  });
  itemsTbody.querySelectorAll("[data-remove-idx]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.dataset.removeIdx, 10);
      items.splice(idx, 1);
      renderItems();
    });
  });
}

function buildPayloadItems() {
  return items.map((it) => ({
    variant_id: it.variant_id || null,
    product_name: it.product_name || "Producto",
    color: it.color || "",
    size: it.size || "",
    quantity: it.quantity,
    price_snapshot: parseFloat(it.price_snapshot || 0),
    imagen: it.imagen || null,
  }));
}

async function loadOrder() {
  const params = new URLSearchParams(window.location.search);
  orderId = params.get("order_id");
  if (!orderId) {
    showMessage("Falta order_id en la URL", "error");
    return;
  }

  const { data: orderData, error: orderError } = await supabase
    .from("local_orders")
    .select("id, order_number, customer_id, total_amount, status")
    .eq("id", orderId)
    .single();

  if (orderError || !orderData) {
    showMessage("Pedido no encontrado", "error");
    return;
  }
  order = orderData;

  const { data: customerData, error: customerError } = await supabase
    .from("public_sales_customers")
    .select("id, first_name, last_name, customer_number, phone, email, document_number, qr_code")
    .eq("id", order.customer_id)
    .single();

  if (customerError || !customerData) {
    showMessage("Cliente no encontrado", "error");
    return;
  }
  customer = customerData;

  const { data: itemsData, error: itemsError } = await supabase.rpc("rpc_get_local_order_items", {
    p_local_order_id: orderId,
  });

  if (itemsError) {
    showMessage("Error al cargar ítems: " + itemsError.message, "error");
    return;
  }

  items = (itemsData || []).map((row) => ({
    variant_id: row.variant_id,
    product_name: row.product_name,
    color: row.color,
    size: row.size,
    quantity: row.quantity,
    price_snapshot: row.price_snapshot,
    imagen: row.imagen,
  }));

  orderInfoCard.style.display = "block";
  orderNumberEl.textContent = order.order_number || orderId.slice(0, 8);
  customerNameEl.textContent = `${customer.first_name} ${customer.last_name || ""}`.trim();
  customerNumberEl.textContent = customer.customer_number ? `(Nº ${customer.customer_number})` : "";
  renderItems();
}

// Extras especiales
addSpecialExtraBtn.addEventListener("click", () => {
  const name = specialExtraName.value.trim();
  const amount = parseFloat(specialExtraAmount.value);
  if (!name) {
    showMessage("Ingrese el nombre del extra", "error");
    return;
  }
  if (isNaN(amount) || amount < 0) {
    showMessage("Ingrese un monto válido", "error");
    return;
  }
  items.push({
    variant_id: null,
    product_name: `Extra: ${name}`,
    color: "",
    size: "",
    quantity: 1,
    price_snapshot: amount,
    isExtra: true,
  });
  specialExtraName.value = "";
  specialExtraAmount.value = "";
  renderItems();
  showMessage("Extra agregado", "success");
});

// Guardar
saveBtn.addEventListener("click", async () => {
  if (!orderId || items.length === 0) {
    showMessage("No hay ítems para guardar", "error");
    return;
  }
  saveBtn.disabled = true;
  try {
    const pItems = buildPayloadItems();
    const { data, error } = await supabase.rpc("rpc_update_local_order", {
      p_local_order_id: orderId,
      p_items: pItems,
    });
    if (error) throw error;
    order.total_amount = data.total_amount;
    renderItems();
    showMessage("Cambios guardados correctamente", "success");
  } catch (e) {
    showMessage("Error al guardar: " + e.message, "error");
  } finally {
    saveBtn.disabled = false;
  }
});

// Finalizar: crear venta, marcar pedido completado, imprimir
finalizeBtn.addEventListener("click", async () => {
  if (!orderId || !customer || items.length === 0) {
    showMessage("No hay ítems para finalizar", "error");
    return;
  }
  finalizeBtn.disabled = true;
  try {
    const pItems = buildPayloadItems();
    const saleItems = [];
    for (const it of pItems) {
      if (it.variant_id) {
        saleItems.push({
          variant_id: it.variant_id,
          qty: it.quantity,
          price: it.price_snapshot,
          is_return: false,
          from_local_order: true,
          source: { venta_publico: it.quantity, general: 0 },
        });
      } else {
        saleItems.push({
          product_name: it.product_name,
          qty: it.quantity,
          price: it.price_snapshot,
          is_return: false,
          is_special_extra: true,
        });
      }
    }
    const finalTotal = getTotal();
    const createSaleOperationId = generateOperationId();
    const { data: saleData, error: saleError } = await supabase.rpc("rpc_create_public_sale", {
      p_items: saleItems,
      p_customer_id: customer.id,
      p_notes: `Pedido local ${order.order_number || orderId}`,
      p_apply_credit: true,
      p_operation_id: createSaleOperationId,
      p_request: { source: 'admin/local-order-edit.js', action: 'finalize_local_order' },
    });
    if (saleError) throw saleError;

    await supabase.from("local_orders").update({ status: "completed", updated_at: new Date().toISOString() }).eq("id", orderId);

    const { data: saleDetails, error: detailsError } = await supabase.rpc("rpc_get_public_sale_details", {
      p_sale_id: saleData.sale_id,
    });
    if (!detailsError && saleDetails) {
      try {
        await loadQZTray();
        if (typeof qz !== "undefined" && qz) {
          await printSaleWithQZ(saleDetails, customer, finalTotal);
        }
      } catch (printErr) {
        console.warn("Impresión QZ:", printErr);
      }
    }

    showMessage(`Pedido finalizado. Venta ${saleData.sale_number} registrada.`, "success");
    if (window.opener) window.opener.location && window.opener.location.reload();
    setTimeout(() => window.close(), 1500);
  } catch (e) {
    showMessage("Error al finalizar: " + e.message, "error");
  } finally {
    finalizeBtn.disabled = false;
  }
});

closeBtn.addEventListener("click", () => window.close());

// Buscador manual: autocomplete por nombre
let searchTimeout;
manualProduct.addEventListener("input", () => {
  clearTimeout(searchTimeout);
  const q = manualProduct.value.trim();
  autocompleteDropdown.innerHTML = "";
  autocompleteDropdown.style.display = "none";
  if (q.length < 2) return;
  searchTimeout = setTimeout(async () => {
    const { data: products } = await supabase
      .from("products")
      .select("id, name")
      .ilike("name", `%${q}%`)
      .in("status", ["active", "pending_stock", "draft"])
      .limit(8);
    if (!products?.length) return;
    autocompleteDropdown.innerHTML = products.map((p) => `<div class="autocomplete-item" data-id="${p.id}" data-name="${escapeHtml(p.name)}">${escapeHtml(p.name)}</div>`).join("");
    autocompleteDropdown.style.display = "block";
    autocompleteDropdown.querySelectorAll(".autocomplete-item").forEach((el) => {
      el.addEventListener("click", () => {
        manualProduct.value = el.dataset.name;
        autocompleteDropdown.style.display = "none";
        loadProductVariants(el.dataset.id);
      });
    });
  }, 300);
});

async function loadProductVariants(productId) {
  const { data: variants, error } = await supabase
    .from("product_variants")
    .select("id, sku, color, price, products!inner(id, name)")
    .eq("product_id", productId)
    .eq("active", true);

  if (error || !variants?.length) {
    showMessage("No hay variantes activas para este producto", "error");
    return;
  }

  const variantIds = variants.map((v) => v.id);
  const { data: sizesData } = await supabase
    .from("variant_sizes")
    .select("variant_id, size")
    .in("variant_id", variantIds)
    .order("size");

  const sizesByVariant = new Map();
  (sizesData || []).forEach((row) => {
    if (!sizesByVariant.has(row.variant_id)) sizesByVariant.set(row.variant_id, []);
    const norm = normalizeSize(row.size);
    if (norm) sizesByVariant.get(row.variant_id).push(norm);
  });

  manualCurrentProduct = variants[0].products;
  manualCurrentVariants = [];
  variants.forEach((v) => {
    const sizes = sizesByVariant.get(v.id) || [];
    if (sizes.length) {
      sizes.forEach((s) => manualCurrentVariants.push({ ...v, size: s }));
    } else {
      manualCurrentVariants.push({ ...v, size: null });
    }
  });

  manualProductInfo.style.display = "block";
  manualProductName.textContent = manualCurrentProduct.name;
  manualProductPrice.textContent = `$${variants[0].price.toLocaleString("es-AR")}`;
  manualSelectedColor = null;
  manualSelectedSize = null;

  const colors = [...new Set(manualCurrentVariants.map((x) => x.color).filter(Boolean))];
  manualColorButtons.innerHTML = colors.map((c) => `<button type="button" class="btn btn-secondary manual-color" data-color="${escapeHtml(c)}" style="margin: 2px;">${escapeHtml(c)}</button>`).join("");
  manualColorButtons.querySelectorAll(".manual-color").forEach((btn) => {
    btn.addEventListener("click", () => {
      manualSelectedColor = btn.dataset.color;
      manualColorButtons.querySelectorAll(".manual-color").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      renderSizeButtons();
    });
  });

  if (colors.length && !manualSelectedColor) {
    manualSelectedColor = colors[0];
    manualColorButtons.querySelector(".manual-color")?.classList.add("active");
  }
  renderSizeButtons();
}

function renderSizeButtons() {
  const variantsFiltered = manualCurrentVariants.filter((v) => v.color === manualSelectedColor);
  const sizes = [...new Set(variantsFiltered.map((v) => v.size).filter(Boolean))];
  manualSizeButtons.innerHTML = sizes.map((s) => `<button type="button" class="btn btn-secondary manual-size" data-size="${escapeHtml(s)}" data-variant-id="${variantsFiltered.find((v) => v.size === s)?.id}" data-price="${variantsFiltered.find((v) => v.size === s)?.price}" style="margin: 2px;">${escapeHtml(s)}</button>`).join("");
  manualSizeButtons.querySelectorAll(".manual-size").forEach((btn) => {
    btn.addEventListener("click", () => {
      manualSelectedSize = { size: btn.dataset.size, variantId: btn.dataset.variantId, price: parseFloat(btn.dataset.price) };
      manualSizeButtons.querySelectorAll(".manual-size").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      manualAddBtn.disabled = false;
    });
  });
  manualAddBtn.disabled = true;
}

manualAddBtn.addEventListener("click", () => {
  if (!manualSelectedSize || !manualCurrentProduct) return;
  const v = manualCurrentVariants.find((x) => x.id === manualSelectedSize.variantId);
  if (!v) return;
  items.push({
    variant_id: manualSelectedSize.variantId,
    product_name: manualCurrentProduct.name,
    color: manualSelectedColor || "",
    size: manualSelectedSize.size || "",
    quantity: 1,
    price_snapshot: manualSelectedSize.price,
  });
  manualProduct.value = "";
  manualProductInfo.style.display = "none";
  manualCurrentProduct = null;
  manualCurrentVariants = [];
  manualSelectedColor = null;
  manualSelectedSize = null;
  renderItems();
  showMessage("Producto agregado al pedido", "success");
});

document.addEventListener("click", (e) => {
  if (!manualProduct.contains(e.target) && !autocompleteDropdown.contains(e.target)) {
    autocompleteDropdown.style.display = "none";
  }
});

// Inicio
loadOrder();
