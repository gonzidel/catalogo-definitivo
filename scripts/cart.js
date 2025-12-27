// scripts/cart.js
import { supabase } from "./supabase-client.js";

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

async function findVariantId({ articulo, color, size }) {
  const { data, error } = await supabase
    .from("product_variants")
    .select("id, color, size, products!inner(name)")
    .eq("products.name", articulo)
    .eq("color", color)
    .eq("size", size)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Variante no encontrada");
  return data.id;
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
