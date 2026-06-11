// admin/curated-banner-admin.js — Admin banners curados por variante (estándar y especial)

const MAX_VARIANTS = 20;

const BANNER_ADMIN_PRESETS = {
  curated: {
    tagValue: "__curated__",
    idPrefix: "cba",
    previewMode: "carousel",
    hasSpecialTextFields: false,
    labels: {
      lead: "Banners curados por variante visual. Carrusel 2×2 en el home.",
      btnNew: "Nuevo banner curado",
      editorNew: "Nuevo banner curado",
      editorEdit: "Editar banner curado",
      titleLabel: "Título visible *",
      titlePlaceholder: "Ej: Especiales para el frío",
      savedOk: "Banner curado guardado",
      deleteConfirm: "¿Eliminar este banner curado y todas sus variantes?",
      deletedOk: "Banner eliminado",
      emptyList: "No hay banners curados. Creá uno con el botón de arriba.",
    },
  },
  special: {
    tagValue: "__curated_special__",
    idPrefix: "csba",
    previewMode: "special",
    hasSpecialTextFields: true,
    labels: {
      lead: "Banner destacado con 3 fotos superpuestas. Se muestra arriba del banner dinámico en el home.",
      btnNew: "Nuevo banner especial",
      editorNew: "Nuevo banner especial",
      editorEdit: "Editar banner especial",
      titleLabel: "Título principal *",
      titlePlaceholder: "Ej: Día del Padre",
      overlineLabel: "Etiqueta superior *",
      overlinePlaceholder: "Ej: OCASIÓN ESPECIAL",
      ctaLabel: "Texto del botón",
      ctaPlaceholder: "Ver selección",
      savedOk: "Banner especial guardado",
      deleteConfirm: "¿Eliminar este banner especial y todas sus variantes?",
      deletedOk: "Banner eliminado",
      emptyList: "No hay banners especiales. Creá uno con el botón de arriba.",
    },
  },
};

const CATALOG_SELECT =
  'variant_id,Articulo,Descripcion,Color,Precio,"Imagen Principal",OfertaActiva,PrecioOferta';

function parseSpecialBannerMeta(description) {
  const defaults = { overline: "OCASIÓN ESPECIAL", ctaLabel: "Ver selección" };
  if (!description?.trim()) return { ...defaults };
  try {
    const parsed = JSON.parse(description);
    return {
      overline: String(parsed.overline ?? defaults.overline).trim(),
      ctaLabel: String(parsed.ctaLabel ?? defaults.ctaLabel).trim(),
    };
  } catch {
    return { overline: description.trim(), ctaLabel: defaults.ctaLabel };
  }
}

function serializeSpecialBannerMeta(overline, ctaLabel) {
  return JSON.stringify({
    overline: String(overline || "OCASIÓN ESPECIAL").trim(),
    ctaLabel: String(ctaLabel || "Ver selección").trim(),
  });
}

export async function initCuratedBannerAdmin({ supabase, root, messageEl = null, preset = "curated" }) {
  if (!root || !supabase) return;

  const config = BANNER_ADMIN_PRESETS[preset] ?? BANNER_ADMIN_PRESETS.curated;
  const p = config.idPrefix;
  const TAG_FIELDS = { tag_value: config.tagValue, tag_filter: config.tagValue };

  let banners = [];
  let draftItems = [];
  let editingBanner = null;
  let searchTimer = null;
  let slugCheckTimer = null;
  let slugValidationGen = 0;
  let slugUi = { conflict: false, checking: false, suggestion: null };
  let dragFromIndex = -1;

  root.innerHTML = buildShellHtml(config);

  const refs = {
    list: root.querySelector(`#${p}-banner-list`),
    btnNew: root.querySelector(`#${p}-btn-new`),
    editorBackdrop: root.querySelector(`#${p}-editor-modal`),
    editorClose: root.querySelector(`#${p}-editor-close`),
    editorCancel: root.querySelector(`#${p}-editor-cancel`),
    editorForm: root.querySelector(`#${p}-editor-form`),
    editorDelete: root.querySelector(`#${p}-editor-delete`),
    editorTitle: root.querySelector(`#${p}-editor-title`),
    bannerId: root.querySelector(`#${p}-banner-id`),
    titleInput: root.querySelector(`#${p}-title`),
    slugInput: root.querySelector(`#${p}-slug`),
    slugError: root.querySelector(`#${p}-slug-error`),
    slugSuggest: root.querySelector(`#${p}-slug-suggest`),
    submitBtn: root.querySelector(`#${p}-editor-submit`),
    descInput: root.querySelector(`#${p}-description`),
    overlineInput: root.querySelector(`#${p}-overline`),
    ctaInput: root.querySelector(`#${p}-cta`),
    enabledInput: root.querySelector(`#${p}-enabled`),
    sortInput: root.querySelector(`#${p}-sort-order`),
    searchInput: root.querySelector(`#${p}-search`),
    searchResults: root.querySelector(`#${p}-search-results`),
    itemsList: root.querySelector(`#${p}-items-list`),
    itemsCount: root.querySelector(`#${p}-items-count`),
    previewHost: root.querySelector(`#${p}-preview-host`),
  };

  refs.btnNew?.addEventListener("click", () => openEditor(null));
  refs.editorClose?.addEventListener("click", closeEditor);
  refs.editorCancel?.addEventListener("click", closeEditor);
  refs.editorBackdrop?.addEventListener("click", (e) => {
    if (e.target === refs.editorBackdrop) closeEditor();
  });
  refs.editorForm?.addEventListener("submit", onSaveBanner);
  refs.editorDelete?.addEventListener("click", onDeleteBanner);
  refs.searchInput?.addEventListener("input", onSearchInput);
  refs.titleInput?.addEventListener("input", onTitleInput);
  refs.slugInput?.addEventListener("input", onSlugInput);
  refs.slugInput?.addEventListener("blur", onSlugBlur);
  refs.slugSuggest?.addEventListener("click", onSlugSuggestClick);
  refs.overlineInput?.addEventListener("input", () => refreshPreview());
  refs.ctaInput?.addEventListener("input", () => refreshPreview());

  await loadBannerList();

  function showMessage(text, type = "success") {
    if (!messageEl) return;
    messageEl.textContent = text;
    messageEl.className = `message ${type} show`;
    setTimeout(() => messageEl.classList.remove("show"), 4000);
  }

  async function loadBannerList() {
    if (!refs.list) return;
    refs.list.innerHTML = '<p class="cba-muted">Cargando banners…</p>';

    const { data, error } = await supabase
      .from("custom_product_banners")
      .select(
        "id, name, title, slug, enabled, sort_order, tag_value, description, custom_product_banner_items(count)"
      )
      .eq("tag_value", config.tagValue)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: false });

    if (error) {
      refs.list.innerHTML = `<p class="cba-error">Error: ${escapeHtml(error.message)}</p>`;
      return;
    }

    banners = data || [];
    renderBannerList();
  }

  function renderBannerList() {
    if (!refs.list) return;

    const curated = banners;
    const legacyOnly = [];

    if (curated.length === 0 && legacyOnly.length === 0) {
      refs.list.innerHTML = `<p class="cba-muted">${escapeHtml(config.labels.emptyList)}</p>`;
      return;
    }

    let html = "";
    if (curated.length) {
      html += curated.map((b) => renderBannerCard(b)).join("");
    }
    refs.list.innerHTML = html;

    refs.list.querySelectorAll("[data-cba-edit]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-cba-edit");
        const row = banners.find((b) => b.id === id);
        if (row) openEditor(row);
      });
    });

    refs.list.querySelectorAll("[data-cba-toggle]").forEach((input) => {
      input.addEventListener("change", async () => {
        const id = input.getAttribute("data-cba-toggle");
        const { error } = await supabase
          .from("custom_product_banners")
          .update({ enabled: input.checked })
          .eq("id", id);
        if (error) showMessage(error.message, "error");
        else await loadBannerList();
      });
    });

    refs.list.querySelectorAll("[data-cba-sort-up]").forEach((btn) => {
      btn.addEventListener("click", () => moveBannerSort(btn.getAttribute("data-cba-sort-up"), -1));
    });
    refs.list.querySelectorAll("[data-cba-sort-down]").forEach((btn) => {
      btn.addEventListener("click", () => moveBannerSort(btn.getAttribute("data-cba-sort-down"), 1));
    });
  }

  function renderBannerCard(b) {
    const count = b.custom_product_banner_items?.[0]?.count ?? 0;
    const title = b.title || b.name || "Sin título";
    return `
      <article class="cba-card" data-banner-id="${b.id}">
        <div class="cba-card-main">
          <h4 class="cba-card-title">${escapeHtml(title)}</h4>
          <p class="cba-card-meta">
            <span class="cba-pill">${count} variantes</span>
            <span class="cba-pill cba-pill-muted">${escapeHtml(b.slug || "sin-slug")}</span>
          </p>
        </div>
        <div class="cba-card-actions">
          <label class="switch" title="Habilitar">
            <input type="checkbox" data-cba-toggle="${b.id}" ${b.enabled ? "checked" : ""}>
            <span class="slider"></span>
          </label>
          <button type="button" class="btn btn-secondary cba-icon-btn" data-cba-sort-up="${b.id}" title="Subir orden">↑</button>
          <button type="button" class="btn btn-secondary cba-icon-btn" data-cba-sort-down="${b.id}" title="Bajar orden">↓</button>
          <button type="button" class="btn btn-primary" data-cba-edit="${b.id}">Editar</button>
        </div>
      </article>
    `;
  }

  async function moveBannerSort(id, delta) {
    const curated = banners.sort(
      (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0)
    );
    const idx = curated.findIndex((b) => b.id === id);
    if (idx < 0) return;
    const swapIdx = idx + delta;
    if (swapIdx < 0 || swapIdx >= curated.length) return;

    const a = curated[idx];
    const b = curated[swapIdx];
    const aOrder = a.sort_order ?? idx;
    const bOrder = b.sort_order ?? swapIdx;

    const { error: e1 } = await supabase
      .from("custom_product_banners")
      .update({ sort_order: bOrder })
      .eq("id", a.id);
    const { error: e2 } = await supabase
      .from("custom_product_banners")
      .update({ sort_order: aOrder })
      .eq("id", b.id);

    if (e1 || e2) showMessage((e1 || e2).message, "error");
    else await loadBannerList();
  }

  async function openEditor(bannerRow) {
    editingBanner = bannerRow;
    draftItems = [];
    dragFromIndex = -1;

    if (refs.editorTitle) {
      refs.editorTitle.textContent = bannerRow
        ? config.labels.editorEdit
        : config.labels.editorNew;
    }
    if (refs.bannerId) refs.bannerId.value = bannerRow?.id || "";
    if (refs.titleInput) refs.titleInput.value = bannerRow?.title || bannerRow?.name || "";
    if (refs.slugInput) refs.slugInput.value = bannerRow?.slug || "";
    if (config.hasSpecialTextFields) {
      const meta = parseSpecialBannerMeta(bannerRow?.description);
      if (refs.overlineInput) refs.overlineInput.value = meta.overline;
      if (refs.ctaInput) refs.ctaInput.value = meta.ctaLabel;
      if (refs.descInput) refs.descInput.value = "";
    } else if (refs.descInput) {
      refs.descInput.value = bannerRow?.description || "";
    }
    if (refs.enabledInput) refs.enabledInput.checked = bannerRow?.enabled !== false;
    if (refs.sortInput) refs.sortInput.value = String(bannerRow?.sort_order ?? 0);
    if (refs.searchInput) refs.searchInput.value = "";
    if (refs.searchResults) refs.searchResults.innerHTML = "";
    if (refs.editorDelete) refs.editorDelete.hidden = !bannerRow?.id;

    if (bannerRow?.id) {
      const { data, error } = await supabase
        .from("custom_product_banners")
        .select(
          `id, title, slug, custom_product_banner_items (
            id, product_variant_id, product_id, position
          )`
        )
        .eq("id", bannerRow.id)
        .order("position", {
          foreignTable: "custom_product_banner_items",
          ascending: true,
        })
        .maybeSingle();

      if (error) {
        showMessage(error.message, "error");
        return;
      }

      const items = data?.custom_product_banner_items || [];
      const variantIds = items.map((i) => i.product_variant_id).filter(Boolean);
      const catalogMap = await fetchCatalogByVariantIds(variantIds);
      const skuMap = await fetchSkuMap(variantIds);

      draftItems = items.map((item) => ({
        product_variant_id: item.product_variant_id,
        product_id: item.product_id,
        position: item.position,
        sku: skuMap.get(item.product_variant_id) || "",
        catalog: catalogMap.get(item.product_variant_id) || null,
      }));
    }

    renderDraftItems();
    await refreshPreview();

    resetSlugValidationUi();
    await validateSlugState();

    if (refs.editorBackdrop) {
      refs.editorBackdrop.classList.add("active");
    }
    refs.titleInput?.focus();
  }

  function closeEditor() {
    if (refs.editorBackdrop) {
      refs.editorBackdrop.classList.remove("active");
    }
    editingBanner = null;
    draftItems = [];
    resetSlugValidationUi();
  }

  function getEditingBannerId() {
    return String(refs.bannerId?.value || "").trim();
  }

  async function isSlugTaken(slug, excludeId = "") {
    const normalized = slugify(slug);
    if (!normalized) return false;

    let query = supabase.from("custom_product_banners").select("id").eq("slug", normalized).limit(1);
    if (excludeId) {
      query = query.neq("id", excludeId);
    }
    const { data, error } = await query;
    if (error) throw error;
    return Array.isArray(data) && data.length > 0;
  }

  async function resolveAvailableSlug(baseSlug, excludeId = "") {
    const base = slugify(baseSlug);
    if (!base) return "";

    for (let n = 0; n < 99; n++) {
      const candidate = n === 0 ? base : `${base}-${n + 1}`;
      if (candidate.length > 80) break;
      const taken = await isSlugTaken(candidate, excludeId);
      if (!taken) return candidate;
    }
    return base;
  }

  function resetSlugValidationUi() {
    slugUi = { conflict: false, checking: false, suggestion: null };
    if (refs.slugError) {
      refs.slugError.hidden = true;
      refs.slugError.textContent = "Este slug ya existe";
    }
    if (refs.slugSuggest) refs.slugSuggest.hidden = true;
    if (refs.slugInput) refs.slugInput.removeAttribute("aria-invalid");
    syncSubmitButton();
  }

  function renderSlugValidationUi() {
    const { conflict, checking, suggestion } = slugUi;
    if (refs.slugInput) {
      if (conflict) refs.slugInput.setAttribute("aria-invalid", "true");
      else refs.slugInput.removeAttribute("aria-invalid");
    }
    if (refs.slugError) {
      if (conflict) {
        refs.slugError.hidden = false;
        refs.slugError.textContent = checking ? "Comprobando slug…" : "Este slug ya existe";
      } else if (checking) {
        refs.slugError.hidden = false;
        refs.slugError.textContent = "Comprobando slug…";
        refs.slugError.style.color = "#888";
      } else {
        refs.slugError.hidden = true;
        refs.slugError.style.color = "";
      }
    }
    if (refs.slugSuggest) {
      if (conflict && suggestion && suggestion !== slugify(refs.slugInput?.value || "")) {
        refs.slugSuggest.hidden = false;
        refs.slugSuggest.textContent = `Usar «${suggestion}»`;
      } else {
        refs.slugSuggest.hidden = true;
      }
    }
    syncSubmitButton();
  }

  function syncSubmitButton() {
    if (!refs.submitBtn) return;
    const titleOk = Boolean(refs.titleInput?.value?.trim());
    const slugVal = slugify(refs.slugInput?.value || "");
    const slugOk = Boolean(slugVal);
    const blocked = !titleOk || !slugOk || slugUi.checking || slugUi.conflict;
    refs.submitBtn.disabled = blocked;
  }

  function scheduleSlugValidation() {
    clearTimeout(slugCheckTimer);
    slugCheckTimer = setTimeout(() => {
      validateSlugState().catch((err) => {
        console.warn("[curated-banner-admin] slug validation:", err);
      });
    }, 320);
  }

  async function validateSlugState() {
    const gen = ++slugValidationGen;
    const excludeId = getEditingBannerId();
    const raw = refs.slugInput?.value?.trim() || "";
    const slug = slugify(raw);

    if (!slug) {
      slugUi = { conflict: false, checking: false, suggestion: null };
      if (gen === slugValidationGen) renderSlugValidationUi();
      return { ok: false, slug: "" };
    }

    slugUi = { ...slugUi, checking: true, conflict: false };
    if (gen === slugValidationGen) renderSlugValidationUi();

    const taken = await isSlugTaken(slug, excludeId);
    if (gen !== slugValidationGen) return { ok: false, slug };

    if (taken) {
      const suggestion = await resolveAvailableSlug(slug, excludeId);
      if (gen !== slugValidationGen) return { ok: false, slug };
      slugUi = { conflict: true, checking: false, suggestion };
      renderSlugValidationUi();
      return { ok: false, slug, suggestion };
    }

    slugUi = { conflict: false, checking: false, suggestion: null };
    renderSlugValidationUi();
    return { ok: true, slug };
  }

  async function onTitleInput() {
    if (refs.slugInput && !refs.slugInput.dataset.touched) {
      const excludeId = getEditingBannerId();
      const base = slugify(refs.titleInput?.value || "");
      refs.slugInput.value = base ? await resolveAvailableSlug(base, excludeId) : "";
      scheduleSlugValidation();
    }
    syncSubmitButton();
  }

  function onSlugInput() {
    if (refs.slugInput) refs.slugInput.dataset.touched = "1";
    scheduleSlugValidation();
  }

  async function onSlugBlur() {
    if (refs.slugInput && !refs.slugInput.value.trim() && refs.titleInput) {
      const excludeId = getEditingBannerId();
      const base = slugify(refs.titleInput.value);
      refs.slugInput.value = base ? await resolveAvailableSlug(base, excludeId) : "";
    }
    await validateSlugState();
  }

  function onSlugSuggestClick(e) {
    e.preventDefault();
    if (!slugUi.suggestion || !refs.slugInput) return;
    refs.slugInput.value = slugUi.suggestion;
    refs.slugInput.dataset.touched = "1";
    validateSlugState().catch(() => {});
  }

  function onSearchInput() {
    clearTimeout(searchTimer);
    const term = refs.searchInput?.value?.trim() || "";
    if (term.length < 2) {
      if (refs.searchResults) refs.searchResults.innerHTML = "";
      return;
    }
    searchTimer = setTimeout(() => runSearch(term), 320);
  }

  async function runSearch(term) {
    if (!refs.searchResults) return;
    refs.searchResults.innerHTML = '<li class="cba-muted">Buscando…</li>';

    const picked = new Set(draftItems.map((i) => i.product_variant_id));
    const productIdsUsed = new Set(draftItems.map((i) => i.product_id));

    try {
      const rows = await searchCatalogVariants(term);
      if (!rows.length) {
        refs.searchResults.innerHTML = '<li class="cba-muted">Sin resultados con stock en catálogo.</li>';
        return;
      }

      refs.searchResults.innerHTML = rows
        .map((row) => {
          const vid = row.variant_id;
          const disabled =
            picked.has(vid) ||
            (row._product_id && productIdsUsed.has(row._product_id) && !picked.has(vid));
          const reason = picked.has(vid)
            ? "Ya en el banner"
            : disabled
              ? "Otro color del mismo producto ya está"
              : "";
          return `
            <li class="cba-search-row ${disabled ? "is-disabled" : ""}">
              <img class="cba-search-thumb" src="${escapeAttr(cloudinaryOptimized(row["Imagen Principal"], 120))}" alt="" loading="lazy">
              <div class="cba-search-body">
                <strong>${escapeHtml(row.Articulo || "")}</strong>
                <span class="cba-search-sub">${escapeHtml(row.Color || "")} · SKU ${escapeHtml(row._sku || "—")}</span>
                <span class="cba-search-desc">${escapeHtml(truncate(row.Descripcion, 48))}</span>
              </div>
              <button type="button" class="btn btn-primary cba-add-btn" data-add-variant="${vid}" data-product-id="${row._product_id || ""}" ${disabled ? "disabled" : ""} title="${escapeAttr(reason)}">
                Agregar
              </button>
            </li>
          `;
        })
        .join("");

      refs.searchResults.querySelectorAll("[data-add-variant]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const variantId = btn.getAttribute("data-add-variant");
          const productId = btn.getAttribute("data-product-id");
          const row = rows.find((r) => r.variant_id === variantId);
          if (row) addVariantToDraft(row, productId);
        });
      });
    } catch (err) {
      refs.searchResults.innerHTML = `<li class="cba-error">${escapeHtml(err.message)}</li>`;
    }
  }

  async function searchCatalogVariants(term) {
    const safe = term.replace(/[%_,.()]/g, " ").trim();
    const pattern = `%${safe}%`;

    const byTextPromise = supabase
      .from("catalog_public_available_view")
      .select(CATALOG_SELECT)
      .or(`Articulo.ilike.${pattern},Descripcion.ilike.${pattern}`)
      .limit(40);

    const bySkuPromise = supabase
      .from("product_variants")
      .select("id, sku, product_id, color, active")
      .ilike("sku", pattern)
      .eq("active", true)
      .limit(25);

    const [{ data: textRows, error: textErr }, { data: skuVariants, error: skuErr }] =
      await Promise.all([byTextPromise, bySkuPromise]);

    if (textErr) throw textErr;
    if (skuErr) throw skuErr;

    const merged = new Map();

    for (const row of textRows || []) {
      if (!row?.variant_id) continue;
      merged.set(row.variant_id, { ...row, _product_id: null, _sku: "" });
    }

    const skuIds = (skuVariants || []).map((v) => v.id);
    if (skuIds.length) {
      const { data: catRows, error: catErr } = await supabase
        .from("catalog_public_available_view")
        .select(CATALOG_SELECT)
        .in("variant_id", skuIds);
      if (catErr) throw catErr;

      const variantById = new Map((skuVariants || []).map((v) => [v.id, v]));
      for (const row of catRows || []) {
        const v = variantById.get(row.variant_id);
        merged.set(row.variant_id, {
          ...row,
          _product_id: v?.product_id || null,
          _sku: v?.sku || "",
        });
      }
    }

    const variantIds = [...merged.keys()];
    if (!variantIds.length) return [];

    const skuMap = await fetchSkuMap(variantIds);
    const productMap = await fetchProductIdMap(variantIds);

    return [...merged.values()]
      .map((row) => ({
        ...row,
        _sku: row._sku || skuMap.get(row.variant_id) || "",
        _product_id: row._product_id || productMap.get(row.variant_id) || null,
      }))
      .slice(0, 30);
  }

  async function fetchSkuMap(variantIds) {
    const map = new Map();
    if (!variantIds.length) return map;
    const { data } = await supabase
      .from("product_variants")
      .select("id, sku")
      .in("id", variantIds);
    for (const v of data || []) map.set(v.id, v.sku || "");
    return map;
  }

  async function fetchProductIdMap(variantIds) {
    const map = new Map();
    if (!variantIds.length) return map;
    const { data } = await supabase
      .from("product_variants")
      .select("id, product_id")
      .in("id", variantIds);
    for (const v of data || []) map.set(v.id, v.product_id);
    return map;
  }

  async function fetchCatalogByVariantIds(variantIds) {
    const map = new Map();
    if (!variantIds.length) return map;
    const { data, error } = await supabase
      .from("catalog_public_available_view")
      .select(CATALOG_SELECT)
      .in("variant_id", variantIds);
    if (error) throw error;
    for (const row of data || []) map.set(row.variant_id, row);
    return map;
  }

  function addVariantToDraft(row, productIdHint) {
    if (draftItems.length >= MAX_VARIANTS) {
      showMessage(`Máximo ${MAX_VARIANTS} variantes por banner`, "error");
      return;
    }
    const variantId = row.variant_id;
    const productId = productIdHint || row._product_id;

    if (draftItems.some((i) => i.product_variant_id === variantId)) {
      showMessage("Esa variante ya está en el banner", "error");
      return;
    }
    if (productId && draftItems.some((i) => i.product_id === productId)) {
      showMessage("Solo un color por producto en el mismo banner", "error");
      return;
    }

    draftItems.push({
      product_variant_id: variantId,
      product_id: productId || "",
      position: draftItems.length + 1,
      sku: row._sku || "",
      catalog: row,
    });

    normalizePositions();
    renderDraftItems();
    refreshPreview();
    if (refs.searchInput?.value.trim().length >= 2) runSearch(refs.searchInput.value.trim());
  }

  function removeDraftItem(variantId) {
    draftItems = draftItems.filter((i) => i.product_variant_id !== variantId);
    normalizePositions();
    renderDraftItems();
    refreshPreview();
  }

  function normalizePositions() {
    draftItems.forEach((item, idx) => {
      item.position = idx + 1;
    });
  }

  function moveDraftItem(index, delta) {
    const target = index + delta;
    if (target < 0 || target >= draftItems.length) return;
    const copy = [...draftItems];
    const [item] = copy.splice(index, 1);
    copy.splice(target, 0, item);
    draftItems = copy;
    normalizePositions();
    renderDraftItems();
    refreshPreview();
  }

  function renderDraftItems() {
    if (refs.itemsCount) {
      refs.itemsCount.textContent = `${draftItems.length} / ${MAX_VARIANTS}`;
    }
    if (!refs.itemsList) return;

    if (!draftItems.length) {
      refs.itemsList.innerHTML = '<li class="cba-muted">Agregá variantes desde el buscador.</li>';
      return;
    }

    refs.itemsList.innerHTML = draftItems
      .map((item, index) => {
        const cat = item.catalog || {};
        const img = cat["Imagen Principal"] || "";
        return `
          <li class="cba-item-row" draggable="true" data-index="${index}">
            <span class="cba-drag-handle" title="Arrastrar">⠿</span>
            <span class="cba-item-pos">${item.position}</span>
            <img class="cba-item-thumb" src="${escapeAttr(cloudinaryOptimized(img, 80))}" alt="">
            <div class="cba-item-body">
              <strong>${escapeHtml(cat.Articulo || "—")}</strong>
              <span class="cba-search-sub">${escapeHtml(cat.Color || "")} · SKU ${escapeHtml(item.sku || "—")}</span>
            </div>
            <div class="cba-item-move">
              <button type="button" class="btn btn-secondary cba-icon-btn" data-move-up="${index}" ${index === 0 ? "disabled" : ""}>↑</button>
              <button type="button" class="btn btn-secondary cba-icon-btn" data-move-down="${index}" ${index === draftItems.length - 1 ? "disabled" : ""}>↓</button>
            </div>
            <button type="button" class="btn btn-danger cba-icon-btn" data-remove="${item.product_variant_id}" title="Quitar">×</button>
          </li>
        `;
      })
      .join("");

    refs.itemsList.querySelectorAll("[data-remove]").forEach((btn) => {
      btn.addEventListener("click", () => removeDraftItem(btn.getAttribute("data-remove")));
    });
    refs.itemsList.querySelectorAll("[data-move-up]").forEach((btn) => {
      btn.addEventListener("click", () => moveDraftItem(Number(btn.getAttribute("data-move-up")), -1));
    });
    refs.itemsList.querySelectorAll("[data-move-down]").forEach((btn) => {
      btn.addEventListener("click", () => moveDraftItem(Number(btn.getAttribute("data-move-down")), 1));
    });

    refs.itemsList.querySelectorAll(".cba-item-row").forEach((row) => {
      row.addEventListener("dragstart", (e) => {
        dragFromIndex = Number(row.getAttribute("data-index"));
        row.classList.add("is-dragging");
        e.dataTransfer?.setData("text/plain", String(dragFromIndex));
      });
      row.addEventListener("dragend", () => {
        row.classList.remove("is-dragging");
        dragFromIndex = -1;
      });
      row.addEventListener("dragover", (e) => {
        e.preventDefault();
        row.classList.add("is-drag-over");
      });
      row.addEventListener("dragleave", () => row.classList.remove("is-drag-over"));
      row.addEventListener("drop", (e) => {
        e.preventDefault();
        row.classList.remove("is-drag-over");
        const from =
          dragFromIndex >= 0 ? dragFromIndex : Number(e.dataTransfer?.getData("text/plain"));
        const to = Number(row.getAttribute("data-index"));
        if (Number.isFinite(from) && Number.isFinite(to) && from !== to) {
          const copy = [...draftItems];
          const [item] = copy.splice(from, 1);
          copy.splice(to, 0, item);
          draftItems = copy;
          normalizePositions();
          renderDraftItems();
          refreshPreview();
        }
      });
    });
  }

  async function refreshPreview() {
    if (!refs.previewHost) return;

    const title = refs.titleInput?.value?.trim() || config.labels.titlePlaceholder;
    const missingIds = draftItems
      .filter((i) => !i.catalog?.Articulo)
      .map((i) => i.product_variant_id);

    if (missingIds.length) {
      const map = await fetchCatalogByVariantIds(missingIds);
      draftItems.forEach((item) => {
        if (!item.catalog && map.has(item.product_variant_id)) {
          item.catalog = map.get(item.product_variant_id);
        }
      });
    }

    const cards = draftItems
      .map((item) => item.catalog)
      .filter((c) => c && c["Imagen Principal"]);

    if (!cards.length) {
      refs.previewHost.innerHTML =
        '<p class="cba-muted" style="padding:12px">Agregá variantes para ver la vista previa.</p>';
      return;
    }

    if (config.previewMode === "special") {
      const meta = parseSpecialBannerMeta(
        serializeSpecialBannerMeta(
          refs.overlineInput?.value,
          refs.ctaInput?.value
        )
      );
      const hero = cards.slice(0, 3);
      const count = cards.length;
      refs.previewHost.innerHTML = `
        <div class="curated-special-banner csba-preview-banner">
          <div class="curated-special-banner__photos">
            ${hero
              .map(
                (row, index) => `
              <div class="curated-special-banner__photo" data-index="${index}">
                <img class="curated-special-banner__photo-img" src="${escapeAttr(cloudinaryOptimized(row["Imagen Principal"], 240))}" alt="" loading="lazy">
              </div>`
              )
              .join("")}
          </div>
          <div class="curated-special-banner__copy">
            <span class="curated-special-banner__overline">${escapeHtml(meta.overline)}</span>
            <h2 class="curated-special-banner__title">${escapeHtml(title)}</h2>
            <p class="curated-special-banner__subtitle">${count} producto${count === 1 ? "" : "s"} seleccionado${count === 1 ? "" : "s"}</p>
            <span class="curated-special-banner__cta">${escapeHtml(meta.ctaLabel)} →</span>
          </div>
        </div>
      `;
      return;
    }

    refs.previewHost.innerHTML = `
      <div class="custom-banner-container cba-preview-banner">
        <div class="custom-banner-header">
          <h2 class="custom-banner-title">${escapeHtml(title)}</h2>
          <span class="cba-preview-ver-todo">Ver todo ›</span>
        </div>
        <div class="custom-banner-scroll">
          ${cards.map((row) => renderPreviewCard(row)).join("")}
        </div>
      </div>
    `;

    const scroll = refs.previewHost.querySelector(".custom-banner-scroll");
    enableTouchScroll(scroll);
  }

  function renderPreviewCard(row) {
    const precio =
      row.OfertaActiva && row.PrecioOferta ? row.PrecioOferta : row.Precio;
    const nombre = row.Articulo || row.Descripcion || "Producto";
    return `
      <div class="custom-banner-card">
        <div class="custom-banner-badge">${escapeHtml(nombre)}</div>
        <img class="custom-banner-card-image" src="${escapeAttr(cloudinaryOptimized(row["Imagen Principal"], 400))}" alt="${escapeAttr(nombre)}" loading="lazy">
        <div class="custom-banner-card-content">
          <div class="custom-banner-card-price">${escapeHtml(formatPrice(precio))}</div>
        </div>
      </div>
    `;
  }

  function enableTouchScroll(el) {
    if (!el) return;
    let startX = 0;
    let scrollLeft = 0;
    el.addEventListener(
      "touchstart",
      (e) => {
        startX = e.touches[0].pageX;
        scrollLeft = el.scrollLeft;
      },
      { passive: true }
    );
    el.addEventListener(
      "touchmove",
      (e) => {
        const x = e.touches[0].pageX;
        el.scrollLeft = scrollLeft - (x - startX);
      },
      { passive: true }
    );
  }

  async function onSaveBanner(e) {
    e.preventDefault();

    const title = refs.titleInput?.value?.trim();
    if (!title) {
      showMessage("El título es obligatorio", "error");
      return;
    }

    let slug = slugify(refs.slugInput?.value?.trim() || slugify(title));
    if (!slug) {
      showMessage("Slug inválido", "error");
      return;
    }

    const excludeId = getEditingBannerId();
    const slugState = await validateSlugState();
    if (!slugState.ok) {
      if (slugUi.conflict && slugUi.suggestion) {
        slug = slugUi.suggestion;
        if (refs.slugInput) refs.slugInput.value = slug;
        const retry = await validateSlugState();
        if (!retry.ok) {
          showMessage("Este slug ya existe", "error");
          return;
        }
      } else {
        showMessage("Este slug ya existe", "error");
        return;
      }
    } else {
      slug = slugState.slug;
    }

    if (await isSlugTaken(slug, excludeId)) {
      slug = await resolveAvailableSlug(slug, excludeId);
      if (refs.slugInput) refs.slugInput.value = slug;
      if (!slug || (await isSlugTaken(slug, excludeId))) {
        showMessage("Este slug ya existe", "error");
        await validateSlugState();
        return;
      }
    }

    if (draftItems.length > MAX_VARIANTS) {
      showMessage(`Máximo ${MAX_VARIANTS} variantes`, "error");
      return;
    }

    const productIds = draftItems.map((i) => i.product_id).filter(Boolean);
    if (new Set(productIds).size !== productIds.length) {
      showMessage("Hay productos duplicados (solo un color por producto)", "error");
      return;
    }

    const bannerPayload = {
      name: title,
      title,
      slug,
      description: config.hasSpecialTextFields
        ? serializeSpecialBannerMeta(
            refs.overlineInput?.value,
            refs.ctaInput?.value
          )
        : refs.descInput?.value?.trim() || null,
      enabled: refs.enabledInput?.checked !== false,
      sort_order: Number(refs.sortInput?.value) || 0,
      ...TAG_FIELDS,
    };

    const submitBtn = refs.submitBtn;
    if (submitBtn) submitBtn.disabled = true;

    try {
      let bannerId = refs.bannerId?.value || "";

      if (bannerId) {
        const { error } = await supabase
          .from("custom_product_banners")
          .update(bannerPayload)
          .eq("id", bannerId);
        if (error) throw error;
      } else {
        const { data, error } = await supabase
          .from("custom_product_banners")
          .insert([bannerPayload])
          .select("id")
          .single();
        if (error) throw error;
        bannerId = data.id;
      }

      const { error: delErr } = await supabase
        .from("custom_product_banner_items")
        .delete()
        .eq("banner_id", bannerId);
      if (delErr) throw delErr;

      if (draftItems.length) {
        const rows = draftItems.map((item, idx) => ({
          banner_id: bannerId,
          product_variant_id: item.product_variant_id,
          product_id: item.product_id || null,
          position: idx + 1,
        }));

        const withProductIds = await ensureProductIds(rows);
        const { error: insErr } = await supabase
          .from("custom_product_banner_items")
          .insert(withProductIds);
        if (insErr) throw insErr;
      }

      showMessage(config.labels.savedOk, "success");
      closeEditor();
      await loadBannerList();
    } catch (err) {
      showMessage(err.message || "Error al guardar", "error");
    } finally {
      syncSubmitButton();
    }
  }

  async function ensureProductIds(rows) {
    const missing = rows.filter((r) => !r.product_id).map((r) => r.product_variant_id);
    if (!missing.length) return rows;
    const map = await fetchProductIdMap(missing);
    return rows.map((r) => ({
      ...r,
      product_id: r.product_id || map.get(r.product_variant_id) || null,
    }));
  }

  async function onDeleteBanner() {
    const id = refs.bannerId?.value;
    if (!id) return;
    if (!confirm(config.labels.deleteConfirm)) return;

    const { error } = await supabase.from("custom_product_banners").delete().eq("id", id);
    if (error) {
      showMessage(error.message, "error");
      return;
    }
    showMessage(config.labels.deletedOk, "success");
    closeEditor();
    await loadBannerList();
  }
}

function buildShellHtml(config) {
  const p = config.idPrefix;
  const labels = config.labels;
  const specialFields = config.hasSpecialTextFields
    ? `
              <div class="form-group">
                <label for="${p}-overline">${labels.overlineLabel}</label>
                <input type="text" id="${p}-overline" required maxlength="60" placeholder="${escapeAttr(labels.overlinePlaceholder)}" autocomplete="off">
              </div>
              <div class="form-group">
                <label for="${p}-cta">${labels.ctaLabel}</label>
                <input type="text" id="${p}-cta" maxlength="40" placeholder="${escapeAttr(labels.ctaPlaceholder)}" value="Ver selección" autocomplete="off">
              </div>`
    : `
              <div class="form-group">
                <label for="${p}-description">Descripción (opcional)</label>
                <input type="text" id="${p}-description" maxlength="200" autocomplete="off">
              </div>`;

  return `
    <div class="cba-panel">
      <div class="cba-toolbar">
        <p class="cba-lead">${escapeHtml(labels.lead)}</p>
        <button type="button" id="${p}-btn-new" class="btn btn-primary">${escapeHtml(labels.btnNew)}</button>
      </div>
      <div id="${p}-banner-list" class="cba-banner-list" aria-live="polite">
        <p class="cba-muted">Cargando banners…</p>
      </div>
    </div>

    <div id="${p}-editor-modal" class="modal cba-editor-modal" role="dialog" aria-modal="true">
      <div class="modal-content cba-editor-content">
        <div class="modal-header">
          <h2 id="${p}-editor-title">Banner</h2>
          <button type="button" class="modal-close" id="${p}-editor-close" aria-label="Cerrar">&times;</button>
        </div>
        <form id="${p}-editor-form">
          <input type="hidden" id="${p}-banner-id" value="">
          <div class="cba-editor-grid">
            <section class="cba-section">
              <h3 class="cba-section-title">Datos del banner</h3>
              <div class="form-group">
                <label for="${p}-title">${labels.titleLabel}</label>
                <input type="text" id="${p}-title" required maxlength="80" placeholder="${escapeAttr(labels.titlePlaceholder)}" autocomplete="off">
              </div>
              <div class="form-group">
                <label for="${p}-slug">Slug URL</label>
                <input type="text" id="${p}-slug" maxlength="80" placeholder="dia-del-padre" autocomplete="off" aria-describedby="${p}-slug-error">
                <small id="${p}-slug-error" class="cba-slug-error" hidden>Este slug ya existe</small>
                <button type="button" id="${p}-slug-suggest" class="cba-slug-suggest" hidden></button>
                <small class="cba-hint">Página de colección: /banner/{slug}</small>
              </div>
              ${specialFields}
              <div class="cba-row-fields">
                <div class="form-group">
                  <label for="${p}-sort-order">Orden entre banners</label>
                  <input type="number" id="${p}-sort-order" min="0" step="1" value="0">
                </div>
                <label class="cba-check">
                  <input type="checkbox" id="${p}-enabled" checked> Habilitado
                </label>
              </div>
            </section>

            <section class="cba-section">
              <h3 class="cba-section-title">Variantes <span id="${p}-items-count" class="cba-count">0 / ${MAX_VARIANTS}</span></h3>
              <div class="form-group">
                <label for="${p}-search">Buscar variante</label>
                <input type="search" id="${p}-search" placeholder="Artículo, descripción o SKU…" autocomplete="off">
              </div>
              <ul id="${p}-search-results" class="cba-search-results"></ul>
              <ul id="${p}-items-list" class="cba-items-list"></ul>
            </section>

            <section class="cba-section cba-preview-section">
              <h3 class="cba-section-title">Vista previa (catálogo real)</h3>
              <div class="cba-phone-frame">
                <div id="${p}-preview-host" class="cba-preview-host"></div>
              </div>
            </section>
          </div>
          <div class="cba-editor-actions">
            <button type="button" class="btn btn-danger" id="${p}-editor-delete" hidden>Eliminar banner</button>
            <div class="cba-editor-actions-right">
              <button type="button" class="btn btn-secondary" id="${p}-editor-cancel">Cancelar</button>
              <button type="submit" id="${p}-editor-submit" class="btn btn-primary">Guardar</button>
            </div>
          </div>
        </form>
      </div>
    </div>
  `;
}

function slugify(text) {
  return String(text || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function formatPrice(value) {
  const n = Number(String(value || "").replace(/[^\d.,]/g, "").replace(",", "."));
  if (!Number.isFinite(n) || n <= 0) return String(value || "");
  return new Intl.NumberFormat("es-AR", {
    style: "currency",
    currency: "ARS",
    maximumFractionDigits: 0,
  }).format(n);
}

function cloudinaryOptimized(url, width) {
  if (!url) return "";
  if (url.includes("cloudinary.com")) {
    return url.replace(/\/upload\//, `/upload/w_${width},q_auto,f_auto/`);
  }
  return url;
}

function truncate(str, max) {
  const s = String(str || "");
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

function escapeHtml(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeAttr(text) {
  return escapeHtml(text).replace(/'/g, "&#39;");
}
