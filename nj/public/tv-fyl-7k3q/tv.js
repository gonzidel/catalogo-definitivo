/* FyL Local TV — grilla multi-producto, ES5-safe (no ?. / ??) */
(function () {
  "use strict";

  var CLOUD_NAME = "dnuedzuzm";

  /** Override opcional solo para pruebas: ?pl=PLAYLIST_ID */
  var DEFAULT_PLAYLIST_ID = "";

  /** Prefijo /nj cuando la app corre bajo /nj */
  function apiBase() {
    var path = window.location.pathname || "";
    if (path.indexOf("/nj/") === 0 || path === "/nj") return "/nj";
    return "";
  }

  var PAGE_MS = 14000;
  var COLOR_MS = 3500;
  var BANNER_MS = 12000;
  var BANNER_EVERY_N_PAGES = 2;
  var REFRESH_MS = 5 * 60 * 1000;
  var GRID_COLS = 4;
  var GRID_ROWS = 2;
  var PAGE_SIZE = GRID_COLS * GRID_ROWS;
  var THEMES = ["warm", "dark", "cream"];
  var THEME_STORAGE_KEY = "fyl_tv_theme";

  var TRANSITION_MS = 420;

  var state = {
    slides: [],
    products: [],
    index: 0,
    slideStartedAt: 0,
    colorStartedAt: 0,
    cardColorIndex: {},
    timer: null,
    refreshTimer: null,
    burnShift: 0,
    ytPlayer: null,
    ytReady: false,
    musicStarted: false,
    playlistId: "",
    batchLabel: "",
    theme: "warm",
    transitioning: false,
  };

  var els = {};

  function qs(id) {
    return document.getElementById(id);
  }

  function cacheEls() {
    els.root = qs("tv-root");
    els.grid = qs("slide-grid");
    els.productGrid = qs("product-grid");
    els.banners = qs("slide-banners");
    els.idle = qs("slide-idle");
    els.bannersGrid = qs("banners-grid");
    els.pageTitle = qs("page-title");
    els.pageSub = qs("page-sub");
    els.clock = qs("clock");
    els.progress = qs("progress-bar");
    els.musicPrompt = qs("music-prompt");
    els.ytWrap = qs("yt-wrap");
    els.themeBtn = qs("theme-btn");
    els.musicBtn = qs("music-btn");
  }

  function getQueryParam(name) {
    var search = window.location.search || "";
    var match = search.match(new RegExp("[?&]" + name + "=([^&]*)"));
    return match ? decodeURIComponent(match[1].replace(/\+/g, " ")) : "";
  }

  function argentinaDateKey(isoOrDate) {
    var d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
    if (isNaN(d.getTime())) return "";
    try {
      return d.toLocaleDateString("en-CA", {
        timeZone: "America/Argentina/Buenos_Aires",
      });
    } catch (e) {
      var offset = -3 * 60;
      var local = new Date(d.getTime() + offset * 60 * 1000);
      var y = local.getUTCFullYear();
      var m = String(local.getUTCMonth() + 1);
      var day = String(local.getUTCDate());
      if (m.length < 2) m = "0" + m;
      if (day.length < 2) day = "0" + day;
      return y + "-" + m + "-" + day;
    }
  }

  function formatCurrency(n) {
    var num = Number(n);
    if (!isFinite(num)) return "N/A";
    try {
      return (
        "$" +
        num.toLocaleString("es-AR", {
          minimumFractionDigits: 0,
          maximumFractionDigits: 0,
        })
      );
    } catch (e) {
      return "$" + Math.round(num);
    }
  }

  function withCloudinaryTransform(src, transform) {
    if (!src || typeof src !== "string") return "";
    var clean = src.indexOf("//") === 0 ? "https:" + src : src;
    if (clean.indexOf("res.cloudinary.com") === -1) return clean;
    return clean.replace("/upload/", "/upload/" + transform + "/");
  }

  function resolveImage(img, width) {
    var transform =
      width >= 900 ? "t_fyl_pdp/f_auto/q_auto" : "t_fyl_card/f_auto/q_auto";
    if (!img) return "";
    if (typeof img === "string") {
      if (img.indexOf("res.cloudinary.com") !== -1) {
        return withCloudinaryTransform(img, transform);
      }
      if (img.indexOf("http") === 0 || img.indexOf("//") === 0) return img;
      return (
        "https://res.cloudinary.com/" +
        CLOUD_NAME +
        "/image/upload/" +
        transform +
        "/" +
        img
      );
    }
    if (img.public_id) {
      return (
        "https://res.cloudinary.com/" +
        CLOUD_NAME +
        "/image/upload/" +
        transform +
        "/" +
        img.public_id
      );
    }
    var url = img.url || img.secure_url || "";
    if (url.indexOf("res.cloudinary.com") !== -1) {
      return withCloudinaryTransform(url, transform);
    }
    return url;
  }

  function isTruthy(v) {
    return v === true || v === "true" || v === "t" || v === 1 || v === "1";
  }

  function parsePrice(v) {
    if (v == null || v === "") return null;
    var n = Number(String(v).replace(",", "."));
    return isFinite(n) ? n : null;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function apiGet(path) {
    var url = apiBase() + path;
    return fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
    }).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) {
          throw new Error("HTTP " + res.status + ": " + t);
        });
      }
      return res.json();
    });
  }

  function rowHasImage(row) {
    return !!(
      row["Imagen Principal"] ||
      row["Imagen 1"] ||
      row["Imagen 2"] ||
      row["Imagen 3"]
    );
  }

  function groupProducts(rows) {
    var map = {};
    var order = [];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var art = String(row.Articulo || "").trim();
      if (!art || !rowHasImage(row)) continue;
      if (!map[art]) {
        map[art] = {
          articulo: art,
          categoria: row.Categoria || "",
          fechaPublicacion: row.FechaPublicacion || "",
          ofertaActiva: false,
          precio: parsePrice(row.Precio),
          precioOferta: null,
          colors: [],
          colorKeys: {},
          fromBatch: false,
          fromOffer: false,
        };
        order.push(art);
      }
      var g = map[art];
      if (isTruthy(row.OfertaActiva)) {
        g.ofertaActiva = true;
        g.fromOffer = true;
        var po = parsePrice(row.PrecioOferta);
        if (po != null) g.precioOferta = po;
      }
      if (
        row.FechaPublicacion &&
        (!g.fechaPublicacion || row.FechaPublicacion > g.fechaPublicacion)
      ) {
        g.fechaPublicacion = row.FechaPublicacion;
      }

      var colorName = String(row.Color || "Sin color").trim();
      var colorKey = colorName.toLowerCase();
      var images = [];
      var imgFields = [
        "Imagen Principal",
        "Imagen 1",
        "Imagen 2",
        "Imagen 3",
      ];
      for (var j = 0; j < imgFields.length; j++) {
        if (row[imgFields[j]]) images.push(row[imgFields[j]]);
      }
      if (!images.length) continue;

      var colorObj = {
        color: colorName,
        hex: row.ColorHex || "",
        displayNumber:
          row.ColorDisplayNumber != null ? Number(row.ColorDisplayNumber) : null,
        images: images,
        precio: parsePrice(row.Precio),
        ofertaActiva: isTruthy(row.OfertaActiva),
        precioOferta: parsePrice(row.PrecioOferta),
      };

      if (g.colorKeys[colorKey]) {
        var existing = g.colorKeys[colorKey];
        if (colorObj.ofertaActiva) {
          existing.ofertaActiva = true;
          if (colorObj.precioOferta != null) {
            existing.precioOferta = colorObj.precioOferta;
          }
        }
        for (var k = 0; k < colorObj.images.length; k++) {
          existing.images.push(colorObj.images[k]);
        }
      } else {
        g.colors.push(colorObj);
        g.colorKeys[colorKey] = colorObj;
      }
    }

    var result = [];
    for (var o = 0; o < order.length; o++) {
      var item = map[order[o]];
      item.colors.sort(function (a, b) {
        var na = a.displayNumber;
        var nb = b.displayNumber;
        if (na != null && nb != null && na !== nb) return na - nb;
        if (na != null && nb == null) return -1;
        if (na == null && nb != null) return 1;
        return String(a.color).localeCompare(String(b.color), "es");
      });
      if (!item.colors.length) continue;
      if (item.precio == null && item.colors[0].precio != null) {
        item.precio = item.colors[0].precio;
      }
      result.push(item);
    }
    return result;
  }

  function extractBanners(rows) {
    var seen = {};
    var banners = [];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (!isTruthy(row.OfertaActiva)) continue;
      var url = String(row.OfferImageUrl || "").trim();
      if (!url) continue;
      var key = String(row.OfferCampaignId || url);
      if (seen[key]) continue;
      seen[key] = true;
      banners.push({
        url: url,
        title: String(row.OfferTitle || "").trim(),
        campaignId: row.OfferCampaignId || null,
      });
    }
    return banners;
  }

  function chunkBanners(banners) {
    if (!banners.length) return [];
    if (banners.length <= 3) return [banners.slice()];
    var chunks = [];
    var i = 0;
    while (i < banners.length) {
      var remaining = banners.length - i;
      var size = 3;
      if (remaining === 4) size = 2;
      else if (remaining === 5) size = i === 0 ? 3 : 2;
      else if (remaining === 2) size = 2;
      else if (remaining === 1) size = 1;
      chunks.push(banners.slice(i, i + size));
      i += size;
    }
    return chunks;
  }

  function chunkProducts(products, size) {
    var pages = [];
    for (var i = 0; i < products.length; i += size) {
      pages.push(products.slice(i, i + size));
    }
    return pages;
  }

  function buildSlides(products, bannerBatches, batchDay) {
    var productPages = chunkProducts(products, PAGE_SIZE);
    var slides = [];
    var bannerIdx = 0;
    for (var i = 0; i < productPages.length; i++) {
      slides.push({
        type: "grid",
        products: productPages[i],
        pageNum: i + 1,
        pageTotal: productPages.length,
        batchDay: batchDay,
      });
      if (
        bannerBatches.length &&
        (i + 1) % BANNER_EVERY_N_PAGES === 0 &&
        bannerIdx < bannerBatches.length
      ) {
        slides.push({
          type: "banners",
          banners: bannerBatches[bannerIdx],
        });
        bannerIdx++;
      }
    }
    while (bannerIdx < bannerBatches.length) {
      slides.push({
        type: "banners",
        banners: bannerBatches[bannerIdx],
      });
      bannerIdx++;
    }
    return slides;
  }

  function fetchCatalogRows() {
    return apiGet("/api/tv/catalog");
  }

  function processRows(rows) {
    if (!rows || !rows.length) {
      return { slides: [], products: [], batchDay: "", label: "Sin datos" };
    }

    var withPub = [];
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].FechaPublicacion) withPub.push(rows[i]);
    }

    var maxDay = "";
    for (var j = 0; j < withPub.length; j++) {
      var day = argentinaDateKey(withPub[j].FechaPublicacion);
      if (day && day > maxDay) maxDay = day;
    }

    var batchRows = [];
    if (maxDay) {
      for (var k = 0; k < withPub.length; k++) {
        if (argentinaDateKey(withPub[k].FechaPublicacion) === maxDay) {
          batchRows.push(withPub[k]);
        }
      }
    }

    var offerRows = [];
    for (var o = 0; o < rows.length; o++) {
      if (isTruthy(rows[o].OfertaActiva)) offerRows.push(rows[o]);
    }

    var batchProducts = groupProducts(batchRows);
    for (var b = 0; b < batchProducts.length; b++) {
      batchProducts[b].fromBatch = true;
    }

    var offerProducts = groupProducts(offerRows);
    var byArt = {};
    for (var p = 0; p < batchProducts.length; p++) {
      byArt[batchProducts[p].articulo] = batchProducts[p];
    }
    for (var q = 0; q < offerProducts.length; q++) {
      var op = offerProducts[q];
      if (byArt[op.articulo]) {
        byArt[op.articulo].fromOffer = true;
        byArt[op.articulo].ofertaActiva = true;
        if (op.precioOferta != null) {
          byArt[op.articulo].precioOferta = op.precioOferta;
        }
      } else {
        op.fromOffer = true;
        byArt[op.articulo] = op;
        batchProducts.push(op);
      }
    }

    var banners = extractBanners(rows);
    var bannerBatches = chunkBanners(banners);
    var slides = buildSlides(batchProducts, bannerBatches, maxDay);

    var labelDay = maxDay ? maxDay.split("-").reverse().join("/") : "";
    return {
      slides: slides,
      products: batchProducts,
      batchDay: maxDay,
      label: labelDay
        ? "Publicados " + labelDay + " · Ofertas"
        : "Ofertas activas",
    };
  }

  /* ——— Theme ——— */
  function applyTheme(theme) {
    if (THEMES.indexOf(theme) === -1) theme = "warm";
    state.theme = theme;
    document.body.setAttribute("data-theme", theme);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch (e) {}
    if (els.themeBtn) {
      var labels = { warm: "Fondo cálido", dark: "Fondo oscuro", cream: "Fondo claro" };
      els.themeBtn.textContent = labels[theme] || "Fondo";
    }
  }

  function cycleTheme() {
    var idx = THEMES.indexOf(state.theme);
    var next = THEMES[(idx + 1) % THEMES.length];
    applyTheme(next);
  }

  function initTheme() {
    var saved = "";
    try {
      saved = localStorage.getItem(THEME_STORAGE_KEY) || "";
    } catch (e) {}
    var fromQuery = getQueryParam("theme");
    applyTheme(fromQuery || saved || "warm");
    if (els.themeBtn) {
      els.themeBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        cycleTheme();
      });
    }
  }

  /* ——— Render ——— */
  function showSlideEl(which) {
    els.grid.classList.toggle("is-hidden", which !== "grid");
    els.banners.classList.toggle("is-hidden", which !== "banners");
    els.idle.classList.toggle("is-hidden", which !== "idle");
  }

  function effectivePrice(product, color) {
    var c = color || (product.colors && product.colors[0]);
    if (c && c.ofertaActiva && c.precioOferta != null) return c.precioOferta;
    if (product.ofertaActiva && product.precioOferta != null) {
      return product.precioOferta;
    }
    if (c && c.precio != null) return c.precio;
    return product.precio;
  }

  function listPrice(product, color) {
    var c = color || (product.colors && product.colors[0]);
    if (c && c.precio != null) return c.precio;
    return product.precio;
  }

  function isOfferNow(product, color) {
    var c = color || (product.colors && product.colors[0]);
    if (c && c.ofertaActiva) return true;
    return !!product.ofertaActiva;
  }

  function cardKey(product) {
    return product.articulo;
  }

  function colorIndexFor(product) {
    var key = cardKey(product);
    var idx = state.cardColorIndex[key] || 0;
    var len = product.colors && product.colors.length ? product.colors.length : 1;
    return idx % len;
  }

  function renderPriceHtml(product, color) {
    var offer = isOfferNow(product, color);
    var eff = effectivePrice(product, color);
    var list = listPrice(product, color);
    var html = "";
    if (offer && list != null && eff != null && list !== eff) {
      html +=
        '<span class="card-price-list">' + formatCurrency(list) + "</span>";
      html +=
        '<span class="card-price is-offer">' +
        formatCurrency(eff) +
        "</span>";
    } else if (eff != null) {
      html +=
        '<span class="card-price' +
        (offer ? " is-offer" : "") +
        '">' +
        formatCurrency(eff) +
        "</span>";
    } else {
      html += '<span class="card-price">Consultar</span>';
    }
    return html;
  }

  function renderDotsHtml(product, activeIdx) {
    var colors = product.colors || [];
    if (colors.length <= 1) {
      if (!colors.length) return "";
      return (
        '<span class="card-dot is-active" style="background:' +
        (colors[0].hex || "#888") +
        '"></span>' +
        '<span class="card-color-label">' +
        escapeHtml(colors[0].color) +
        "</span>"
      );
    }
    var html = "";
    var maxDots = Math.min(colors.length, 6);
    for (var i = 0; i < maxDots; i++) {
      html +=
        '<span class="card-dot' +
        (i === activeIdx ? " is-active" : "") +
        '" style="background:' +
        (colors[i].hex || "#888") +
        '"></span>';
    }
    if (colors.length > maxDots) {
      html +=
        '<span class="card-color-label">+' +
        (colors.length - maxDots) +
        "</span>";
    } else {
      html +=
        '<span class="card-color-label">' +
        escapeHtml(colors[activeIdx].color) +
        "</span>";
    }
    return html;
  }

  function renderProductCard(product) {
    var cIdx = colorIndexFor(product);
    var color = product.colors[cIdx];
    var src = resolveImage(color.images[0], 400);
    var offer = isOfferNow(product, color);
    var ribbonClass = "card-ribbon is-hidden";
    var ribbonText = "";
    if (offer) {
      ribbonClass = "card-ribbon is-offer";
      ribbonText = "Oferta";
    } else if (product.fromBatch) {
      ribbonClass = "card-ribbon is-new";
      ribbonText = "Nuevo";
    }

    return (
      '<article class="product-card" data-art="' +
      escapeHtml(product.articulo) +
      '">' +
      '<div class="card-media">' +
      '<img src="' +
      src.replace(/"/g, "&quot;") +
      '" alt="' +
      escapeHtml(product.articulo) +
      '" />' +
      '<span class="' +
      ribbonClass +
      '">' +
      ribbonText +
      "</span>" +
      "</div>" +
      '<div class="card-body">' +
      '<h2 class="card-name">' +
      escapeHtml(product.articulo) +
      "</h2>" +
      '<div class="card-meta">' +
      '<div class="card-price-wrap">' +
      renderPriceHtml(product, color) +
      "</div>" +
      "</div>" +
      '<div class="card-colors">' +
      renderDotsHtml(product, cIdx) +
      "</div>" +
      "</div>" +
      "</article>"
    );
  }

  function renderGrid(products, pageNum, pageTotal) {
    showSlideEl("grid");
    var cols = products.length <= 6 ? 3 : 4;
    els.productGrid.className =
      "product-grid cols-" + (cols === 3 ? "3" : "4");
    var html = "";
    for (var i = 0; i < products.length; i++) {
      html += renderProductCard(products[i]);
    }
    els.productGrid.innerHTML = html;
    // Force reflow then stagger-in cards
    void els.productGrid.offsetWidth;
    els.productGrid.className =
      "product-grid cols-" + (cols === 3 ? "3" : "4") + " is-ready";
    els.pageTitle.textContent = "Vitrina del día";
    els.pageSub.textContent =
      (state.batchLabel || "Catálogo") +
      " · página " +
      pageNum +
      "/" +
      pageTotal +
      " · " +
      products.length +
      " productos";
  }

  function updateCardColorsInPlace() {
    var slide = state.slides[state.index];
    if (!slide || slide.type !== "grid") return;
    var cards = els.productGrid.querySelectorAll(".product-card");
    for (var i = 0; i < cards.length; i++) {
      var art = cards[i].getAttribute("data-art");
      var product = null;
      for (var p = 0; p < slide.products.length; p++) {
        if (slide.products[p].articulo === art) {
          product = slide.products[p];
          break;
        }
      }
      if (!product || !product.colors || product.colors.length < 2) continue;
      var next = (colorIndexFor(product) + 1) % product.colors.length;
      state.cardColorIndex[cardKey(product)] = next;
      var color = product.colors[next];
      var img = cards[i].querySelector(".card-media img");
      if (img) img.src = resolveImage(color.images[0], 400);
      var priceWrap = cards[i].querySelector(".card-price-wrap");
      if (priceWrap) priceWrap.innerHTML = renderPriceHtml(product, color);
      var dots = cards[i].querySelector(".card-colors");
      if (dots) dots.innerHTML = renderDotsHtml(product, next);
      var ribbon = cards[i].querySelector(".card-ribbon");
      if (ribbon) {
        if (isOfferNow(product, color)) {
          ribbon.className = "card-ribbon is-offer";
          ribbon.textContent = "Oferta";
        } else if (product.fromBatch) {
          ribbon.className = "card-ribbon is-new";
          ribbon.textContent = "Nuevo";
        } else {
          ribbon.className = "card-ribbon is-hidden";
          ribbon.textContent = "";
        }
      }
    }
  }

  function renderBanners(batch) {
    showSlideEl("banners");
    var n = batch.length;
    var layout = "layout-" + Math.min(n, 3);
    els.bannersGrid.className = "banners-grid " + layout;
    var html = "";
    for (var i = 0; i < n; i++) {
      var b = batch[i];
      var src = b.url;
      html += '<div class="banner-card">';
      html +=
        '<div class="banner-bg" style="background-image:url(\'' +
        src.replace(/'/g, "%27") +
        "')\"></div>";
      html +=
        '<img class="banner-img" src="' +
        src.replace(/"/g, "&quot;") +
        '" alt="' +
        escapeHtml(b.title || "Oferta") +
        '" />';
      if (b.title) {
        html +=
          '<p class="banner-title">' + escapeHtml(b.title) + "</p>";
      }
      html += "</div>";
    }
    els.bannersGrid.innerHTML = html;
    els.pageTitle.textContent = "Ofertas";
    els.pageSub.textContent = "Banners de campaña";
  }

  function renderIdle() {
    showSlideEl("idle");
    els.pageTitle.textContent = "FyL Moda";
    els.pageSub.textContent = "Esperando publicaciones…";
  }

  function currentDuration() {
    var slide = state.slides[state.index];
    if (!slide) return PAGE_MS;
    return slide.type === "banners" ? BANNER_MS : PAGE_MS;
  }

  function activeSlideEl() {
    var slide = state.slides[state.index];
    if (!slide) return els.idle;
    if (slide.type === "banners") return els.banners;
    return els.grid;
  }

  function paintCurrent() {
    if (!state.slides.length) {
      renderIdle();
      els.progress.style.width = "0%";
      return;
    }
    var slide = state.slides[state.index];
    state.slideStartedAt = Date.now();
    state.colorStartedAt = Date.now();

    if (slide.type === "banners") {
      renderBanners(slide.banners);
    } else {
      renderGrid(slide.products, slide.pageNum, slide.pageTotal);
    }
    preloadNext();
  }

  function showCurrent(animated) {
    if (!animated) {
      paintCurrent();
      return;
    }
    if (state.transitioning) return;
    state.transitioning = true;

    var currentEl = activeSlideEl();
    if (currentEl) {
      currentEl.classList.add("is-leaving");
      currentEl.classList.remove("is-enter-active", "is-entering");
    }

    setTimeout(function () {
      if (currentEl) {
        currentEl.classList.remove("is-leaving");
      }
      paintCurrent();
      var nextEl = activeSlideEl();
      if (nextEl && nextEl !== els.idle) {
        nextEl.classList.add("is-entering");
        void nextEl.offsetWidth;
        nextEl.classList.remove("is-entering");
        nextEl.classList.add("is-enter-active");
        setTimeout(function () {
          nextEl.classList.remove("is-enter-active");
          state.transitioning = false;
        }, TRANSITION_MS + 80);
      } else {
        state.transitioning = false;
      }
    }, TRANSITION_MS);
  }

  function nextSlide(delta) {
    if (!state.slides.length || state.transitioning) return;
    var d = delta == null ? 1 : delta;
    state.index = (state.index + d + state.slides.length) % state.slides.length;
    showCurrent(true);
  }

  function tick() {
    updateClock();
    updateBurnIn();

    if (!state.slides.length) {
      els.progress.style.width = "0%";
      return;
    }

    var now = Date.now();
    var dur = currentDuration();
    var elapsed = now - state.slideStartedAt;
    els.progress.style.width = Math.min(100, (elapsed / dur) * 100) + "%";

    var slide = state.slides[state.index];
    if (slide && slide.type === "grid" && now - state.colorStartedAt >= COLOR_MS) {
      state.colorStartedAt = now;
      updateCardColorsInPlace();
    }

    if (elapsed >= dur && !state.transitioning) {
      nextSlide(1);
    }
  }

  function updateClock() {
    var now = new Date();
    try {
      els.clock.textContent = now.toLocaleTimeString("es-AR", {
        timeZone: "America/Argentina/Buenos_Aires",
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch (e) {
      var h = now.getHours();
      var m = now.getMinutes();
      els.clock.textContent =
        (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m;
    }
  }

  function updateBurnIn() {
    var mins = Math.floor(Date.now() / 60000) % 5;
    if (mins === state.burnShift) return;
    state.burnShift = mins;
    var dx = (mins % 3) - 1;
    var dy = ((mins + 1) % 3) - 1;
    els.root.style.transform =
      "translate(" + dx * 2 + "px," + dy * 2 + "px)";
  }

  function preloadNext() {
    if (!state.slides.length) return;
    var next = state.slides[(state.index + 1) % state.slides.length];
    var urls = [];
    if (next.type === "grid") {
      for (var i = 0; i < next.products.length; i++) {
        var c = next.products[i].colors[0];
        if (c) urls.push(resolveImage(c.images[0], 400));
      }
    } else if (next.type === "banners") {
      for (var j = 0; j < next.banners.length; j++) {
        urls.push(next.banners[j].url);
      }
    }
    for (var u = 0; u < urls.length; u++) {
      if (!urls[u]) continue;
      var img = new Image();
      img.src = urls[u];
    }
  }

  function applyData(processed) {
    var prevKey = "";
    if (state.slides[state.index]) {
      var cur = state.slides[state.index];
      if (cur.type === "grid" && cur.products[0]) {
        prevKey = "g:" + cur.products[0].articulo;
      } else if (cur.type === "banners" && cur.banners[0]) {
        prevKey = "b:" + cur.banners[0].url;
      }
    }

    state.slides = processed.slides;
    state.products = processed.products;
    state.batchLabel = processed.label;

    if (!state.slides.length) {
      state.index = 0;
      showCurrent();
      return;
    }

    var found = -1;
    for (var i = 0; i < state.slides.length; i++) {
      var s = state.slides[i];
      var key = "";
      if (s.type === "grid" && s.products[0]) key = "g:" + s.products[0].articulo;
      else if (s.type === "banners" && s.banners[0]) key = "b:" + s.banners[0].url;
      if (key && key === prevKey) {
        found = i;
        break;
      }
    }
    state.index = found >= 0 ? found : 0;
    showCurrent();
  }

  function refreshData() {
    fetchPlaylistSettings();
    return fetchCatalogRows()
      .then(function (rows) {
        applyData(processRows(rows));
      })
      .catch(function (err) {
        console.warn("[tv] refresh failed, keeping current data", err);
        if (!state.slides.length) renderIdle();
      });
  }

  function scheduleNightlyReload() {
    function msUntilNight() {
      var now = new Date();
      var target = new Date(now.getTime());
      target.setHours(3, 15, 0, 0);
      if (target <= now) target.setDate(target.getDate() + 1);
      return target - now;
    }
    setTimeout(function () {
      window.location.reload();
    }, msUntilNight());
  }

  /* ——— YouTube (playlist desde Supabase tv_local_settings; se cambia en Admin con login) ——— */
  function syncMusicButtonLabel() {
    if (!els.musicBtn) return;
    els.musicBtn.textContent = state.playlistId ? "Música ✓" : "Música";
  }

  function destroyYtPlayer() {
    if (state.ytPlayer) {
      try {
        state.ytPlayer.destroy();
      } catch (e) {}
    }
    state.ytPlayer = null;
    state.ytReady = false;
    if (els.ytWrap) {
      els.ytWrap.classList.add("is-hidden");
      els.ytWrap.innerHTML = '<div id="yt-player"></div>';
    }
  }

  function setPlaylistFromServer(id, opts) {
    var options = opts || {};
    var next = String(id || "").trim();
    var prev = state.playlistId || "";
    if (next === prev) {
      syncMusicButtonLabel();
      return;
    }

    var wasPlaying = state.musicStarted;
    state.playlistId = next;
    syncMusicButtonLabel();
    destroyYtPlayer();
    state.musicStarted = false;

    if (!state.playlistId) {
      if (els.musicPrompt) els.musicPrompt.classList.add("is-hidden");
      return;
    }

    if (wasPlaying || options.promptIfNew) {
      if (els.musicPrompt) els.musicPrompt.classList.remove("is-hidden");
    }
  }

  function fetchPlaylistSettings() {
    var fromQuery = getQueryParam("pl");
    if (fromQuery) {
      setPlaylistFromServer(fromQuery, { promptIfNew: !state.musicStarted });
      return Promise.resolve(fromQuery);
    }

    return apiGet("/api/tv/settings")
      .then(function (data) {
        var id =
          data && data.youtube_playlist_id ? data.youtube_playlist_id : "";
        setPlaylistFromServer(id, {
          promptIfNew: !state.musicStarted && !!id,
        });
        return id;
      })
      .catch(function (err) {
        console.warn("[tv] no se pudo leer settings:", err);
        if (!state.playlistId && DEFAULT_PLAYLIST_ID) {
          setPlaylistFromServer(DEFAULT_PLAYLIST_ID, { promptIfNew: true });
        }
        return "";
      });
  }

  function initMusicUi() {
    syncMusicButtonLabel();
    if (els.musicPrompt) {
      els.musicPrompt.addEventListener("click", startMusic);
      els.musicPrompt.classList.add("is-hidden");
    }
    if (els.musicBtn) {
      els.musicBtn.addEventListener("click", function (e) {
        e.stopPropagation();
        if (!state.playlistId) return;
        if (!state.musicStarted) startMusic();
        else toggleMusic();
      });
    }
    fetchPlaylistSettings();
  }

  function onKeyDown(e) {
    var key = e.keyCode || e.which;
    if (key === 13 || key === 32) {
      if (state.playlistId && !state.musicStarted) {
        startMusic();
        e.preventDefault();
        return;
      }
      if (state.playlistId) {
        toggleMusic();
        e.preventDefault();
      }
    } else if (key === 37) {
      nextSlide(-1);
      e.preventDefault();
    } else if (key === 39) {
      nextSlide(1);
      e.preventDefault();
    } else if (key === 84 || key === 116) {
      cycleTheme();
      e.preventDefault();
    }
  }

  function startMusic() {
    if (!state.playlistId) return;
    state.musicStarted = true;
    if (els.musicPrompt) els.musicPrompt.classList.add("is-hidden");
    if (els.ytWrap) els.ytWrap.classList.remove("is-hidden");
    if (state.ytPlayer && state.ytReady) {
      try {
        state.ytPlayer.playVideo();
      } catch (err) {}
      return;
    }
    createYtPlayer();
  }

  function toggleMusic() {
    if (!state.ytPlayer || !state.ytReady) return;
    try {
      var st = state.ytPlayer.getPlayerState();
      if (st === 1) state.ytPlayer.pauseVideo();
      else state.ytPlayer.playVideo();
    } catch (e) {}
  }

  function createYtPlayer() {
    if (typeof window.YT === "undefined" || !window.YT.Player) {
      window.onYouTubeIframeAPIReady = createYtPlayer;
      return;
    }
    if (!qs("yt-player") && els.ytWrap) {
      els.ytWrap.innerHTML = '<div id="yt-player"></div>';
    }
    state.ytPlayer = new window.YT.Player("yt-player", {
      height: "101",
      width: "180",
      playerVars: {
        listType: "playlist",
        list: state.playlistId,
        autoplay: 1,
        controls: 0,
        loop: 1,
        modestbranding: 1,
        rel: 0,
        playsinline: 1,
      },
      events: {
        onReady: function (ev) {
          state.ytReady = true;
          try {
            ev.target.setVolume(55);
            ev.target.playVideo();
          } catch (e) {}
        },
        onError: function () {
          console.warn("[tv] YouTube player error — revisá Admin → TV Local");
        },
      },
    });
  }

  window.onYouTubeIframeAPIReady = function () {
    if (state.musicStarted && state.playlistId && !state.ytPlayer) {
      createYtPlayer();
    }
  };

  function boot() {
    cacheEls();
    initTheme();
    initMusicUi();
    updateClock();
    state.timer = setInterval(tick, 200);
    state.refreshTimer = setInterval(refreshData, REFRESH_MS);
    scheduleNightlyReload();
    document.addEventListener("keydown", onKeyDown);
    refreshData();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
