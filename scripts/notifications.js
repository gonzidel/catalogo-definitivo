import { supabase as sharedSupabase } from "./supabase-client.js";

const BADGE_ID = "notification-badge";
const BTN_ID = "header-notifications";
const PANEL_ID = "notifications-panel";
const BACKDROP_ID = "notifications-backdrop";
const LIST_ID = "notifications-list";
const EMPTY_ID = "notifications-empty";
const CLOSE_ID = "notifications-close";

const TYPE_LABELS = {
  ORDER_MISSING_ITEMS: "Faltantes",
  ORDER_ALL_RESERVED: "Reservado",
  ORDER_PACKAGED_TODAY: "Envío",
};

const MARK_READ_ON_CLICK_TYPES = new Set(["ORDER_MISSING_ITEMS"]);

function safeText(v) {
  return String(v ?? "").trim();
}

function chipKindFromType(type) {
  const t = safeText(type);
  if (t === "ORDER_ALL_RESERVED") return "reserved";
  if (t === "ORDER_MISSING_ITEMS") return "missing";
  return "default";
}

function getActionUrl(n) {
  const p = n?.payload && typeof n.payload === "object" ? n.payload : null;
  const url = safeText(p?.action_url || n?.action_url || "");
  if (!url) return "client/dashboard.html";
  return url;
}

function toBuenosAiresDate(d) {
  const date = d instanceof Date ? d : new Date(d);
  const parts = new Intl.DateTimeFormat("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const y = Number(parts.find((p) => p.type === "year")?.value || 0) || 0;
  const m = Number(parts.find((p) => p.type === "month")?.value || 0) || 0;
  const day = Number(parts.find((p) => p.type === "day")?.value || 0) || 0;
  return { y, m, day };
}

function formatWhenAr(iso) {
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime())) return "";

  const now = new Date();
  const a = toBuenosAiresDate(date);
  const b = toBuenosAiresDate(now);

  const time = new Intl.DateTimeFormat("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);

  const sameDay = a.y === b.y && a.m === b.m && a.day === b.day;
  if (sameDay) return `Hoy ${time}`;

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const c = toBuenosAiresDate(yesterday);
  const isYesterday = a.y === c.y && a.m === c.m && a.day === c.day;
  if (isYesterday) return `Ayer ${time}`;

  const full = new Intl.DateTimeFormat("es-AR", {
    timeZone: "America/Argentina/Buenos_Aires",
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
  }).format(date);
  return `${full} ${time}`;
}

async function waitForSupabase(ms = 12000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const s = sharedSupabase || window.supabase || window.supabaseClient;
    if (s && typeof s.from === "function" && s.auth) return s;
    await new Promise((r) => setTimeout(r, 150));
  }
  return null;
}

function setBadgeVisible(visible) {
  const badge = document.getElementById(BADGE_ID);
  if (!badge) return;
  badge.style.display = visible ? "block" : "none";
}

function openPanel() {
  const panel = document.getElementById(PANEL_ID);
  const backdrop = document.getElementById(BACKDROP_ID);
  if (!panel || !backdrop) return;
  panel.classList.add("is-open");
  backdrop.classList.add("is-open");
  panel.setAttribute("aria-hidden", "false");
  backdrop.setAttribute("aria-hidden", "false");
  try {
    document.body.classList.add("modal-open");
  } catch (_) {
    /* ignore */
  }
}

function closePanel() {
  const panel = document.getElementById(PANEL_ID);
  const backdrop = document.getElementById(BACKDROP_ID);
  if (!panel || !backdrop) return;
  panel.classList.remove("is-open");
  backdrop.classList.remove("is-open");
  panel.setAttribute("aria-hidden", "true");
  backdrop.setAttribute("aria-hidden", "true");
  try {
    document.body.classList.remove("modal-open");
  } catch (_) {
    /* ignore */
  }
}

function isPanelOpen() {
  const panel = document.getElementById(PANEL_ID);
  return !!panel?.classList?.contains("is-open");
}

function renderNotifications(list) {
  const wrap = document.getElementById(LIST_ID);
  const empty = document.getElementById(EMPTY_ID);
  if (!wrap || !empty) return;

  wrap.innerHTML = "";
  const arr = Array.isArray(list) ? list : [];
  empty.style.display = arr.length ? "none" : "block";

  for (const n of arr) {
    const type = safeText(n.type) || "INFO";
    const msg = safeText(n.message);
    const when = formatWhenAr(n.created_at);
    const unread = !n.read;
    const chipKind = chipKindFromType(type);

    const el = document.createElement("div");
    el.className = `notifications-item ntype-${chipKind}${unread ? " is-unread" : ""}`;
    el.setAttribute("role", "button");
    el.tabIndex = 0;
    el.dataset.notificationId = String(n.id);
    el.dataset.notificationType = type;
    el.dataset.notificationUrl = getActionUrl(n);

    el.innerHTML = `
      <div class="notifications-item__chip">${TYPE_LABELS[type] || "Aviso"}</div>
      <div class="notifications-item__meta">${when}</div>
      <div class="notifications-item__msg">${msg || "Notificación"}</div>
    `;
    wrap.appendChild(el);
  }
}

async function markReadByIds(supabase, ids) {
  const list = Array.isArray(ids) ? ids.filter(Boolean) : [];
  if (!list.length) return;
  await supabase
    .from("customer_notifications")
    .update({ read: true, read_at: new Date().toISOString() })
    .in("id", list);
}

async function markReadOnOpen(supabase, customerId) {
  const { data } = await supabase
    .from("customer_notifications")
    .select("id,type")
    .eq("customer_id", customerId)
    .eq("read", false)
    .order("created_at", { ascending: false })
    .limit(50);

  const ids = (data || [])
    .filter((n) => !MARK_READ_ON_CLICK_TYPES.has(safeText(n.type)))
    .map((n) => n.id);

  await markReadByIds(supabase, ids);
}

async function loadNotifications(supabase, customerId) {
  const { data, error } = await supabase
    .from("customer_notifications")
    .select("id,customer_id,order_id,type,message,payload,read,created_at,read_at")
    .eq("customer_id", customerId)
    .order("created_at", { ascending: false })
    .limit(30);

  if (error) {
    console.warn("[notifications] error load:", error);
    renderNotifications([]);
    setBadgeVisible(false);
    return [];
  }

  const list = data || [];
  const hasUnread = list.some((n) => !n.read);
  setBadgeVisible(hasUnread);
  renderNotifications(list);
  return list;
}

async function setupRealtime(supabase, customerId, onChange) {
  try {
    const channel = supabase.channel(`customer_notifications:${customerId}`);
    channel.on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "customer_notifications",
        filter: `customer_id=eq.${customerId}`,
      },
      () => onChange?.()
    );
    await channel.subscribe();
    return channel;
  } catch (e) {
    console.warn("[notifications] realtime not available:", e);
    return null;
  }
}

async function initNotifications() {
  const btn = document.getElementById(BTN_ID);
  const closeBtn = document.getElementById(CLOSE_ID);
  const backdrop = document.getElementById(BACKDROP_ID);
  if (!btn) return;

  const supabase = await waitForSupabase();
  if (!supabase) return;

  const { data: userData, error: userErr } = await supabase.auth.getUser();
  const customerId = userData?.user?.id;
  if (userErr || !customerId) {
    setBadgeVisible(false);
    return;
  }

  let cached = await loadNotifications(supabase, customerId);
  let channel = await setupRealtime(supabase, customerId, async () => {
    cached = await loadNotifications(supabase, customerId);
  });

  btn.addEventListener("click", async (e) => {
    e.preventDefault();
    if (isPanelOpen()) {
      closePanel();
      return;
    }
    openPanel();
    await markReadOnOpen(supabase, customerId);
    cached = await loadNotifications(supabase, customerId);
  });

  closeBtn?.addEventListener("click", () => closePanel());
  backdrop?.addEventListener("click", () => closePanel());

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isPanelOpen()) closePanel();
  });

  document.addEventListener("click", async (e) => {
    const item = e.target.closest?.(".notifications-item");
    if (!item) return;
    const id = item.dataset.notificationId;
    const type = safeText(item.dataset.notificationType);
    const url = safeText(item.dataset.notificationUrl);

    if (id && MARK_READ_ON_CLICK_TYPES.has(type)) {
      await markReadByIds(supabase, [Number(id)]);
      cached = await loadNotifications(supabase, customerId);
    }

    closePanel();
    if (url) window.location.href = url;
  });

  // Cleanup best-effort (single-page hash nav can reload modules)
  window.addEventListener("beforeunload", async () => {
    try {
      if (channel) await supabase.removeChannel(channel);
    } catch (_) {
      /* ignore */
    }
  });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => initNotifications());
} else {
  initNotifications();
}

