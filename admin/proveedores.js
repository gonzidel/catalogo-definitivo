// admin/proveedores.js — lectura de supplier_message_ingest (RLS admin)
import { supabase } from "../scripts/supabase-client.js";
import { preloadAuthState, can, isAdminUser } from "./auth-state.js";

const tbody = document.getElementById("ingest-tbody");
const loadErr = document.getElementById("load-err");
const btnRefresh = document.getElementById("btn-refresh");
const detailModal = document.getElementById("detail-modal");
const detailPre = document.getElementById("detail-pre");
const detailClose = document.getElementById("detail-close");

let _proveedoresAuthAllowed = false;
let _proveedoresAuthChecked = false;

const proveedoresAuthReady = (async () => {
  try {
    const { user } = await preloadAuthState();
    if (!user) {
      window.location.href = "./index.html";
      return false;
    }
    const ok = can("proveedores", "view") || isAdminUser();
    if (!ok) {
      window.location.href = "./index.html";
      return false;
    }
    _proveedoresAuthAllowed = true;
    return true;
  } catch (authErr) {
    console.warn("[proveedores] auth gate error:", authErr);
    window.location.href = "./index.html";
    return false;
  } finally {
    _proveedoresAuthChecked = true;
  }
})();

async function ensureProveedoresAuth() {
  if (_proveedoresAuthChecked && !_proveedoresAuthAllowed) return false;
  const ok = await proveedoresAuthReady;
  return ok && _proveedoresAuthAllowed;
}

function runProveedoresTask(label, task) {
  Promise.resolve()
    .then(task)
    .catch((err) => {
      console.error(`[proveedores] ${label} failed:`, err);
      if (loadErr) {
        loadErr.textContent = err?.message || "Error inesperado";
        loadErr.style.display = "block";
      }
    });
}

function fmtDate(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString("es-AR", { dateStyle: "short", timeStyle: "short" });
  } catch {
    return iso;
  }
}

function badgeNeedsReview(v) {
  const b = document.createElement("span");
  b.className = "badge " + (v ? "badge-warn" : "badge-ok");
  b.textContent = v ? "Sí" : "No";
  return b;
}

function badgeStatus(status) {
  const b = document.createElement("span");
  b.className = "badge badge-muted";
  b.textContent = status || "—";
  return b;
}

function supplierCell(row) {
  const fromOrder = row.supplier_orders?.[0]?.supplier_name;
  const inf = row.inferred_supplier_name;
  const s = (fromOrder && fromOrder.trim()) || (inf && inf.trim()) || null;
  return s || "—";
}

async function loadIngestList() {
  if (!tbody) return;
  loadErr.style.display = "none";
  tbody.innerHTML = `<tr><td colspan="5" class="muted">Cargando…</td></tr>`;

  const { data, error } = await supabase
    .from("supplier_message_ingest")
    .select(
      "id, created_at, parsed_status, needs_review, is_processed, inferred_supplier_name, message_type, supplier_orders(supplier_name)"
    )
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    loadErr.textContent = error.message || String(error);
    loadErr.style.display = "block";
    tbody.innerHTML = `<tr><td colspan="5" class="muted">No se pudo cargar la lista.</td></tr>`;
    return;
  }

  if (!data?.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="muted">Sin registros aún.</td></tr>`;
    return;
  }

  tbody.innerHTML = "";
  for (const row of data) {
    const tr = document.createElement("tr");
    const td0 = document.createElement("td");
    td0.textContent = fmtDate(row.created_at);
    const td1 = document.createElement("td");
    td1.textContent = supplierCell(row);
    const td2 = document.createElement("td");
    td2.appendChild(badgeStatus(row.parsed_status));
    const td3 = document.createElement("td");
    td3.appendChild(badgeNeedsReview(!!row.needs_review));
    const td4 = document.createElement("td");
    td4.className = "cell-actions";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn-link";
    btn.textContent = "Ver detalle";
    btn.addEventListener("click", () => {
      runProveedoresTask("open_detail", async () => {
        if (!(await ensureProveedoresAuth())) return;
        await openDetail(row.id);
      });
    });
    td4.appendChild(btn);
    tr.append(td0, td1, td2, td3, td4);
    tbody.appendChild(tr);
  }
}

async function openDetail(id) {
  detailPre.textContent = "Cargando…";
  detailModal.classList.add("open");

  const { data, error } = await supabase
    .from("supplier_message_ingest")
    .select(
      `
      *,
      supplier_orders (
        id,
        supplier_name,
        order_date,
        status,
        notes,
        created_at,
        supplier_order_lines (
          id,
          raw_line_text,
          article_code,
          color,
          size,
          quantity,
          unit,
          confidence,
          review_status
        )
      )
    `
    )
    .eq("id", id)
    .maybeSingle();

  if (error) {
    detailPre.textContent = JSON.stringify({ error: error.message }, null, 2);
    return;
  }

  let signedHint = null;
  if (data?.storage_bucket && data?.storage_object_path) {
    const { data: signed, error: se } = await supabase.storage
      .from(data.storage_bucket)
      .createSignedUrl(data.storage_object_path, 3600);
    if (!se && signed?.signedUrl) {
      signedHint = signed.signedUrl;
    }
  }

  const payload = { ...data, _signed_url_preview_1h: signedHint };
  detailPre.textContent = JSON.stringify(payload, null, 2);
}

function closeDetail() {
  detailModal.classList.remove("open");
}

async function init() {
  const ok = await ensureProveedoresAuth();
  if (!ok) return;
  await loadIngestList();
}

btnRefresh?.addEventListener("click", () => {
  runProveedoresTask("refresh_list", async () => {
    if (!(await ensureProveedoresAuth())) return;
    await loadIngestList();
  });
});
detailClose?.addEventListener("click", closeDetail);
detailModal?.addEventListener("click", (e) => {
  if (e.target === detailModal) closeDetail();
});

init().catch((e) => {
  console.error(e);
  if (loadErr) {
    loadErr.textContent = e?.message || String(e);
    loadErr.style.display = "block";
  }
});
