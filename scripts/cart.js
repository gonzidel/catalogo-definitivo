// scripts/cart.js
import { supabase } from "./supabase-client.js";
import { normalizeSize } from "./utils/size-normalizer.js";

const countEl = document.getElementById("cart-count");
const submitBtn = document.getElementById("cart-submit");

let localCount = 0;
function setCount(n) {
  localCount = n;
  if (countEl) countEl.textContent = String(n);
}
setCount(0);

async function ensureSession() {
  const { data } = await supabase.auth.getSession();
  if (!data?.session) {
    window.location.href = "/client/login.html";
    return null;
  }
  return data.session.user;
}

async function getCartId() {
  const { data, error } = await supabase.rpc("rpc_get_or_create_cart");
  if (error) throw error;
  return data;
}

/**
 * Busca el ID de una variante por artículo, color y talle.
 * IMPORTANTE: Los talles ahora están en variant_sizes (NO en product_variants.size que está deprecado).
 * 
 * @param {Object} params - Parámetros de búsqueda
 * @param {string} params.articulo - Nombre del artículo
 * @param {string} params.color - Color de la variante
 * @param {string} params.size - Talle a buscar (se normaliza automáticamente)
 * @returns {Promise<string>} - ID de la variante
 */
async function findVariantId({ articulo, color, size }) {
  // 1. Buscar variante por producto y color (sin size, ya que los talles están en variant_sizes)
  const { data: variant, error: variantError } = await supabase
    .from("product_variants")
    .select("id, products!inner(name)")
    .eq("products.name", articulo)
    .eq("color", color)
    .maybeSingle();
  
  if (variantError) throw variantError;
  if (!variant) throw new Error("Variante no encontrada");
  
  // 2. Verificar que el talle existe en variant_sizes (TABLA PRINCIPAL)
  const normalizedSize = normalizeSize(size);
  if (!normalizedSize) {
    throw new Error(`Talle "${size}" no es válido`);
  }
  
  const { data: sizeData, error: sizeError } = await supabase
    .from("variant_sizes")
    .select("id, stock_qty")
    .eq("variant_id", variant.id)
    .eq("size", normalizedSize)
    .maybeSingle();
  
  if (sizeError) throw sizeError;
  if (!sizeData) {
    throw new Error(`Talle ${size} no encontrado para esta variante`);
  }
  
  return variant.id;
}

export async function reserveItem({ articulo, color, size, qty }) {
  const user = await ensureSession();
  if (!user) return;
  const variant = await findVariantId({ articulo, color, size });
  const { error } = await supabase.rpc("rpc_reserve_item", { variant, qty });
  if (error) throw error;
  setCount(localCount + qty);
}

async function submitCart() {
  const user = await ensureSession();
  if (!user) return;
  const cid = await getCartId();
  const { error } = await supabase.rpc("rpc_submit_cart", { cid });
  if (error) {
    alert(error.message);
    return;
  }
  alert("Pedido enviado. Te avisaremos cuando confirmemos disponibilidad.");
  // Redirigir al dashboard del cliente
  window.location.href = "/client/dashboard.html";
}

submitBtn?.addEventListener("click", submitCart);

// Exponer API simple
window.cart = { reserveItem, submitCart };
