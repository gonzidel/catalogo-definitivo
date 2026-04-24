// admin/proveedores.js — lectura de supplier_message_ingest (RLS admin)
import { supabase } from "../scripts/supabase-client.js";
import { preloadAuthState, can, isAdminUser } from "./auth-state.js";

const tbody = document.getElementById("ingest-tbody");
const loadErr = document.getElementById("load-err");
const btnRefresh = document.getElementById("btn-refresh");
const suppliersTbody = document.getElementById("suppliers-tbody");
const btnReloadSuppliers = document.getElementById("btn-reload-suppliers");
const detailModal = document.getElementById("detail-modal");
const detailPre = document.getElementById("detail-pre");
const detailClose = document.getElementById("detail-close");
const newSupplierForm = document.getElementById("new-supplier-form");
const newSupplierName = document.getElementById("new-supplier-name");
const newSupplierSlug = document.getElementById("new-supplier-slug");
const newSupplierAliases = document.getElementById("new-supplier-aliases");
const newSupplierActive = document.getElementById("new-supplier-active");
const newSupplierNotes = document.getElementById("new-supplier-notes");
const newRuleCurrency = document.getElementById("new-rule-currency");
const newRuleDiscount = document.getElementById("new-rule-discount");
const newRuleUnit = document.getElementById("new-rule-unit");
const newRulePairs = document.getElementById("new-rule-pairs");
const newRuleBasis = document.getElementById("new-rule-basis");
const newSupplierMsg = document.getElementById("new-supplier-msg");

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

function slugify(raw) {
  return String(raw || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeAliases(raw) {
  const seen = new Set();
  const out = [];
  for (const part of String(raw || "").split(",")) {
    const cleaned = part
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim()
      .toLowerCase();
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
}

function setNewSupplierMsg(text, type = "muted") {
  if (!newSupplierMsg) return;
  newSupplierMsg.textContent = text || "";
  newSupplierMsg.className =
    type === "ok"
      ? "msg-ok"
      : type === "warn"
      ? "msg-warn"
      : type === "err"
      ? "msg-err"
      : "muted";
}

function defaultPairsByUnit(unit) {
  if (unit === "docena") return 12;
  if (unit === "tarea") return 24;
  if (unit === "par") return 1;
  return null;
}

function defaultBasisByUnit(unit) {
  if (unit === "docena") return "per_docena";
  if (unit === "tarea") return "per_tarea";
  if (unit === "bulto") return "per_bulto";
  return "per_par";
}

function rulesActiveBadge(hasActive) {
  const b = document.createElement("span");
  b.className = "badge " + (hasActive ? "badge-ok" : "badge-warn");
  b.textContent = hasActive ? "Sí" : "No";
  return b;
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

async function loadSuppliersList() {
  if (!suppliersTbody) return;
  suppliersTbody.innerHTML = `<tr><td colspan="5" class="muted">Cargando…</td></tr>`;

  const [suppliersRes, activeRulesRes] = await Promise.all([
    supabase
      .from("purchase_suppliers")
      .select("id,display_name,slug,aliases,active")
      .order("display_name"),
    supabase.from("purchase_supplier_rule_versions").select("supplier_id").eq("is_active", true),
  ]);

  if (suppliersRes.error) {
    suppliersTbody.innerHTML = `<tr><td colspan="5">${suppliersRes.error.message}</td></tr>`;
    return;
  }
  if (activeRulesRes.error) {
    suppliersTbody.innerHTML = `<tr><td colspan="5">${activeRulesRes.error.message}</td></tr>`;
    return;
  }

  const rows = suppliersRes.data || [];
  const activeSet = new Set((activeRulesRes.data || []).map((r) => r.supplier_id).filter(Boolean));

  if (!rows.length) {
    suppliersTbody.innerHTML = `<tr><td colspan="5" class="muted">Sin proveedores aún.</td></tr>`;
    return;
  }

  suppliersTbody.innerHTML = "";
  for (const row of rows) {
    const tr = document.createElement("tr");
    const tdName = document.createElement("td");
    tdName.textContent = row.display_name || "—";
    const tdSlug = document.createElement("td");
    tdSlug.innerHTML = `<code>${row.slug || "—"}</code>`;
    const tdAliases = document.createElement("td");
    tdAliases.textContent = Array.isArray(row.aliases) && row.aliases.length ? row.aliases.join(", ") : "—";
    const tdActive = document.createElement("td");
    tdActive.appendChild(badgeNeedsReview(!row.active));
    tdActive.firstChild.textContent = row.active ? "Sí" : "No";
    const tdRules = document.createElement("td");
    tdRules.appendChild(rulesActiveBadge(activeSet.has(row.id)));
    tr.append(tdName, tdSlug, tdAliases, tdActive, tdRules);
    suppliersTbody.appendChild(tr);
  }
}

async function validateSlugUnique(slug) {
  const { data, error } = await supabase.from("purchase_suppliers").select("id").eq("slug", slug).limit(1);
  if (error) throw error;
  return !!(data && data.length);
}

function buildBasicRules() {
  const currency = (newRuleCurrency?.value || "ARS").trim().toUpperCase();
  const discountPct = Number(newRuleDiscount?.value ?? 0);
  const unit = newRuleUnit?.value || "par";
  const basis = newRuleBasis?.value || "per_par";
  const pairsRaw = newRulePairs?.value;
  const pairsPerUnit = pairsRaw === "" ? null : Number(pairsRaw);

  if (!Number.isFinite(discountPct)) {
    throw new Error("Descuento inválido: debe ser número.");
  }
  if (unit === "bulto" && (!Number.isFinite(pairsPerUnit) || pairsPerUnit <= 0)) {
    throw new Error("Para unidad bulto debés completar pares por unidad.");
  }
  if (unit !== "bulto" && pairsPerUnit != null && (!Number.isFinite(pairsPerUnit) || pairsPerUnit <= 0)) {
    throw new Error("Pares por unidad inválido.");
  }

  const tareaPairs = unit === "tarea" && Number.isFinite(pairsPerUnit) && pairsPerUnit > 0 ? pairsPerUnit : 24;
  const rules = {
    currency: currency || "ARS",
    default_discount_pct: discountPct,
    units: {
      par: {
        pairs_per_unit: 1,
        default_price_basis: unit === "par" ? basis : "per_par",
        match: ["par", "pares", "prs", "pr"],
      },
      tarea: {
        pairs_per_unit: tareaPairs,
        default_price_basis: unit === "tarea" ? basis : "per_tarea",
        allowed_price_bases: ["per_tarea", "per_par"],
        match: ["tarea", "tareas", "tar"],
      },
      docena: {
        pairs_per_unit: 12,
        default_price_basis: unit === "docena" ? basis : "per_docena",
        allowed_price_bases: ["per_docena", "per_par"],
        match: ["docena", "docenas", "doc", "dz"],
      },
    },
  };

  if (unit === "bulto" && Number.isFinite(pairsPerUnit) && pairsPerUnit > 0) {
    rules.units.bulto = {
      pairs_per_unit: pairsPerUnit,
      default_price_basis: basis,
      allowed_price_bases: ["per_bulto", "per_par"],
      match: ["bulto", "bultos"],
    };
  }

  return rules;
}

async function createSupplierWithRules() {
  const displayName = (newSupplierName?.value || "").trim();
  const slug = (newSupplierSlug?.value || "").trim().toLowerCase();
  const aliases = normalizeAliases(newSupplierAliases?.value || "");
  const active = !!newSupplierActive?.checked;
  const notesRaw = (newSupplierNotes?.value || "").trim();
  const notes = notesRaw || null;

  if (!displayName) throw new Error("Nombre de proveedor requerido.");
  if (!slug) throw new Error("Slug requerido.");
  if (!/^[a-z0-9-]+$/.test(slug)) {
    throw new Error("Slug inválido: solo minúsculas, números y guiones.");
  }

  const slugTaken = await validateSlugUnique(slug);
  if (slugTaken) throw new Error("El slug ya existe. Elegí otro.");

  const { data: inserted, error: insertErr } = await supabase
    .from("purchase_suppliers")
    .insert({
      slug,
      display_name: displayName,
      aliases,
      active,
      notes,
    })
    .select("id,display_name,slug")
    .single();

  if (insertErr) {
    if ((insertErr.message || "").toLowerCase().includes("row-level security")) {
      throw new Error("Error creando proveedor: RLS bloqueó la inserción. Revisá policies o usá una RPC segura.");
    }
    throw new Error("Error creando proveedor: " + (insertErr.message || String(insertErr)));
  }

  const rules = buildBasicRules();
  const { error: rulesErr } = await supabase.rpc("purchase_create_rule_version", {
    p_supplier_id: inserted.id,
    p_rules: rules,
  });

  if (rulesErr) {
    if ((rulesErr.message || "").toLowerCase().includes("row-level security")) {
      throw new Error(
        "Proveedor creado, pero faltan reglas (RLS bloqueó purchase_create_rule_version)."
      );
    }
    throw new Error("Proveedor creado, pero faltan reglas: " + (rulesErr.message || String(rulesErr)));
  }

  return inserted;
}

function resetNewSupplierForm() {
  newSupplierForm?.reset();
  if (newSupplierSlug) newSupplierSlug.dataset.touched = "";
  if (newRuleCurrency) newRuleCurrency.value = "ARS";
  if (newRuleDiscount) newRuleDiscount.value = "0";
  if (newRuleUnit) newRuleUnit.value = "par";
  if (newRulePairs) newRulePairs.value = "1";
  if (newRuleBasis) newRuleBasis.value = "per_par";
  newRuleUnit?.dispatchEvent(new Event("change"));
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
  setNewSupplierMsg("");
  newRuleUnit?.dispatchEvent(new Event("change"));
  await loadSuppliersList();
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

newSupplierName?.addEventListener("input", () => {
  if (!newSupplierSlug) return;
  const generated = slugify(newSupplierName.value);
  if (!newSupplierSlug.value || newSupplierSlug.dataset.touched !== "true") {
    newSupplierSlug.value = generated;
  }
});

newSupplierSlug?.addEventListener("input", () => {
  newSupplierSlug.dataset.touched = "true";
  newSupplierSlug.value = slugify(newSupplierSlug.value);
});

newRuleUnit?.addEventListener("change", () => {
  const unit = newRuleUnit.value;
  const pairsDefault = defaultPairsByUnit(unit);
  const basisDefault = defaultBasisByUnit(unit);
  if (newRuleBasis) newRuleBasis.value = basisDefault;
  if (newRulePairs) {
    newRulePairs.disabled = unit === "par" || unit === "docena";
    newRulePairs.required = unit === "bulto";
    if (pairsDefault != null) newRulePairs.value = String(pairsDefault);
    else if (unit === "bulto" && !newRulePairs.value) newRulePairs.value = "";
  }
});

newSupplierForm?.addEventListener("submit", (e) => {
  e.preventDefault();
  runProveedoresTask("create_supplier", async () => {
    if (!(await ensureProveedoresAuth())) return;
    setNewSupplierMsg("Guardando…");
    try {
      await createSupplierWithRules();
      setNewSupplierMsg("Proveedor creado correctamente", "ok");
      resetNewSupplierForm();
      await loadSuppliersList();
    } catch (err) {
      const msg = err?.message || String(err);
      if (msg.toLowerCase().includes("proveedor creado, pero faltan reglas")) {
        setNewSupplierMsg("Proveedor creado, pero faltan reglas", "warn");
      } else if (msg.toLowerCase().includes("error creando proveedor")) {
        setNewSupplierMsg("Error creando proveedor", "err");
      } else {
        setNewSupplierMsg(msg, "err");
      }
    }
  });
});

btnReloadSuppliers?.addEventListener("click", () => {
  runProveedoresTask("reload_suppliers", async () => {
    if (!(await ensureProveedoresAuth())) return;
    await loadSuppliersList();
  });
});

init().catch((e) => {
  console.error(e);
  if (loadErr) {
    loadErr.textContent = e?.message || String(e);
    loadErr.style.display = "block";
  }
});
