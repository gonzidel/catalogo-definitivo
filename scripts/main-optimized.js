// scripts/main-optimized.js - Versión optimizada del catálogo principal
// Mejoras: mejor manejo de errores, rendimiento optimizado, código más limpio

// Constantes globales
const SHEET_ID = "1kdhxSWHl3Rg0tXpaRsKhR_m30oTZhzqYj5ypsjtcTig";
const CATEGORIAS = ["Calzado", "Ropa", "Lenceria", "Marroquineria"];
let hojaActual = "Calzado";

// Sistema de manejo de errores centralizado
class ErrorHandler {
  static log(error, context = "") {
    console.error(`[${context}]`, error);

    // Mostrar error amigable al usuario si es crítico
    if (error.critical) {
      this.showUserError(error.message);
    }
  }

  static showUserError(message) {
    const container = document.getElementById("catalogo");
    if (container) {
      container.innerHTML = `
        <div class="error-message" style="
          text-align: center; 
          padding: 40px; 
          color: #666; 
          background: #f8f9fa; 
          border-radius: 8px;
          margin: 20px;
        ">
          <h3>⚠️ Error al cargar productos</h3>
          <p>${message}</p>
          <button onclick="location.reload()" style="
            background: #CD844D; 
            color: white; 
            border: none; 
            padding: 10px 20px; 
            border-radius: 5px; 
            cursor: pointer;
            margin-top: 15px;
          ">Reintentar</button>
        </div>
      `;
    }
  }
}

// Utilidades optimizadas
const Utils = {
  parseFecha(str) {
    if (!str) return new Date(2000, 0, 1);
    const [d, m, y] = str.split("/").map((n) => parseInt(n, 10));
    if (!d || !m || !y) return new Date(2000, 0, 1);
    return new Date(y, m - 1, d);
  },

  cloudinaryOptimized(url, w) {
    if (!url || typeof url !== "string") return url || "";

    // Forzar https y optimizar
    url = url.startsWith("http://") ? url.replace("http://", "https://") : url;
    return url.replace("/upload/", `/upload/f_auto,q_auto,c_scale,w_${w}/`);
  },

  debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  },
};

// Gestor de productos optimizado
class ProductManager {
  constructor() {
    this.cache = new Map();
    this.loading = false;
  }

  async getCategoryData(cat, options = {}) {
    const cacheKey = `category_${cat}`;

    // Verificar cache primero
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    try {
      let data = [];

      // Intentar con data-source primero
      if (window.getCategoryData) {
        data = await window.getCategoryData(cat, {
          categorias: CATEGORIAS,
          sheetID: SHEET_ID,
        });
      } else {
        // Fallback a OpenSheet
        data = await this.fetchOpenSheetCategory(cat);
      }

      // Cachear resultado
      this.cache.set(cacheKey, data);
      return data;
    } catch (error) {
      ErrorHandler.log(error, "ProductManager.getCategoryData");
      return [];
    }
  }

  async fetchOpenSheetCategory(cat) {
    const url = `https://opensheet.elk.sh/${SHEET_ID}/${cat}`;
    const response = await fetch(url);
    if (!response.ok)
      throw new Error(`Error ${response.status}: ${response.statusText}`);
    return await response.json();
  }

  async existeNovedades() {
    try {
      const hoy = new Date();
      const hace7 = new Date(
        hoy.getFullYear(),
        hoy.getMonth(),
        hoy.getDate() - 7
      );

      for (const cat of CATEGORIAS) {
        const data = await this.getCategoryData(cat);
        if (
          data.some(
            (item) =>
              item.Mostrar === "TRUE" &&
              item.FechaIngreso &&
              Utils.parseFecha(item.FechaIngreso) >= hace7
          )
        ) {
          return true;
        }
      }
      return false;
    } catch (error) {
      ErrorHandler.log(error, "existeNovedades");
      return false;
    }
  }

  async toggleNovedadesButton() {
    try {
      const btn = document.getElementById("btn-novedades");
      if (btn && !(await this.existeNovedades())) {
        btn.style.display = "none";
      }
    } catch (error) {
      ErrorHandler.log(error, "toggleNovedadesButton");
    }
  }
}

// Renderizador optimizado
class ProductRenderer {
  constructor() {
    this.imageCache = new Map();
  }

  renderProductCard(product) {
    const gal = this.renderGallery(product);
    const colores = this.renderColors(product);
    const variants = this.renderVariants(product);
    const tags = this.renderTags(product);

    return `
      <div class="card producto"
           data-filtro1="${product.Filtro1 || ""}"
           data-filtro2="${product.Filtro2 || ""}"
           data-filtro3="${product.Filtro3 || ""}">
        ${this.renderDownloadButtons()}
        <img class="main-image" loading="lazy" 
             src="${Utils.cloudinaryOptimized(product.VariantePrincipal, 800)}" 
             alt="${product.Articulo}"/>
        <div class="image-loader"><div class="spinner"></div></div>
        <div class="gallery">${gal}</div>
        ${product.Oferta === "TRUE" ? this.renderOfertaTag() : ""}
        ${tags}
        <div class="title-row">
          <h3>Art: <span class="article-box">${product.Articulo}</span>${
      product.Oferta === "TRUE" ? ' <span class="article-fire">🔥</span>' : ""
    }</h3>
          <div class="colors">${colores}</div>
        </div>
        <div class="description">${product.Descripcion || ""}</div>
        <div class="price-container">
          <div class="price">${product.Precio || ""}</div>
          ${
            product.Oferta === "TRUE"
              ? '<div class="wholesale">Precio mayorista</div>'
              : ""
          }
        </div>
        ${variants}
      </div>
    `;
  }

  renderGallery(product) {
    return product.DetalleColor.flatMap((v) => v.images)
      .map((src) => {
        const thumb = Utils.cloudinaryOptimized(src, 200);
        const full = Utils.cloudinaryOptimized(src, 800);
        return `
          <img loading="lazy" src="${thumb}" data-full="${full}" 
               alt="Miniatura de producto" class="miniatura">
        `;
      })
      .join("");
  }

  renderColors(product) {
    return product.DetalleColor.map(
      (v) =>
        `<button class='color-btn' data-src="${v.images[0]}">${v.color}</button>`
    ).join("");
  }

  renderVariants(product) {
    return product.DetalleColor.map((v) => {
      const chips = v.talles
        .map((t) => `<div class="talle">${t}</div>`)
        .join("");
      const sizeOptions = v.talles
        .map((t) => `<option value="${t}">${t}</option>`)
        .join("");

      return `
        <div class="variant">
          <strong>${v.color}:</strong>
          <div class="talles">${chips}</div>
          <div class="reserve-controls" style="display:flex;gap:6px;align-items:center;margin-top:6px;flex-wrap:wrap;">
            <label>Talle: <select class="res-size">${sizeOptions}</select></label>
            <label>Cant: <input type="number" class="res-qty" min="1" value="1" style="width:64px"/></label>
            <button class="reserve-btn" data-articulo="${product.Articulo}" data-color="${v.color}">Agregar</button>
          </div>
        </div>
      `;
    }).join("");
  }

  renderTags(product) {
    const tagList = [product.Filtro1, product.Filtro2, product.Filtro3].filter(
      (t) => t && t.trim()
    );

    return tagList.length
      ? `
      <div class="tags">${tagList
        .map((t) => `<div class="talle tag-chip" data-tag="${t}">${t}</div>`)
        .join("")}</div>
    `
      : "";
  }

  renderDownloadButtons() {
    return `
      <div class="download-container">
        <button class="download-btn" onclick="window.downloadImage(this)">
          <svg xmlns='http://www.w3.org/2000/svg' width='22' height='22' viewBox='0 0 24 24' fill='none' stroke='#fff' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'>
            <path d='M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4'/>
            <polyline points='7 10 12 15 17 10'/>
            <line x1='12' y1='15' x2='12' y2='3'/>
          </svg>
        </button>
        <button class="download-btn share-btn" title="Compartir imagen" style="margin-top:8px;">
          <svg xmlns='http://www.w3.org/2000/svg' width='22' height='22' viewBox='0 0 24 24' fill='none' stroke='#fff' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'>
            <circle cx='18' cy='5' r='3'/>
            <circle cx='6' cy='12' r='3'/>
            <circle cx='18' cy='19' r='3'/>
            <line x1='8.59' y1='13.51' x2='15.42' y2='17.49'/>
            <line x1='15.41' y1='6.51' x2='8.59' y2='10.49'/>
          </svg>
        </button>
      </div>
    `;
  }

  renderOfertaTag() {
    return '<div class="tags"><div class="talle tag-chip oferta-chip" data-oferta="1">Oferta</div></div>';
  }
}

// Controlador principal optimizado
class CatalogController {
  constructor() {
    this.productManager = new ProductManager();
    this.renderer = new ProductRenderer();
    this.setupEventListeners();
  }

  setupEventListeners() {
    // Toggle de vista
    const viewToggle = document.getElementById("view-toggle");
    if (viewToggle) {
      viewToggle.addEventListener("click", () => {
        const catEl = document.getElementById("catalogo");
        catEl.classList.toggle("compact");
        viewToggle.textContent = catEl.classList.contains("compact")
          ? "🔳 Normal"
          : "🔳 Comunas";
      });
    }

    // Limpiar búsqueda
    const clearBtn = document.getElementById("clear-search");
    if (clearBtn) {
      clearBtn.addEventListener("click", () => {
        const input = document.getElementById("searchInput");
        if (input) input.value = "";
        if (typeof window.clearSearch === "function") {
          window.clearSearch();
        } else {
          document
            .querySelectorAll(".card")
            .forEach((c) => (c.style.display = "block"));
        }
      });
    }
  }

  async cargarCategoria(cat) {
    if (this.productManager.loading) return;

    try {
      this.productManager.loading = true;
      console.log("Cargando categoría:", cat);

      document.getElementById("loader").classList.add("show");
      const cont = document.getElementById("catalogo");
      cont.innerHTML = "";

      const data = await this.productManager.getCategoryData(cat);
      let items = data.filter((i) => i.Mostrar === "TRUE");

      // Ordenar por fecha de ingreso
      items.sort((a, b) => {
        const fechaA = Utils.parseFecha(a.FechaIngreso);
        const fechaB = Utils.parseFecha(b.FechaIngreso);
        return fechaB - fechaA;
      });

      // Filtrar según categoría especial
      if (cat === "Novedades") {
        const hoy = new Date();
        const h7 = new Date(
          hoy.getFullYear(),
          hoy.getMonth(),
          hoy.getDate() - 7
        );
        items = items.filter(
          (i) => i.FechaIngreso && Utils.parseFecha(i.FechaIngreso) >= h7
        );
      }

      if (cat === "Ofertas") {
        items = items.filter((i) => i.Oferta === "TRUE");
      }

      if (items.length === 0) {
        cont.innerHTML =
          '<div class="no-data">No hay productos disponibles en esta categoría</div>';
        return;
      }

      // Agrupar productos
      const grupos = this.groupProducts(items);

      // Renderizar productos
      this.renderProducts(grupos, cont);

      // Configurar eventos
      this.setupProductEvents();
    } catch (error) {
      ErrorHandler.log({ ...error, critical: true }, "cargarCategoria");
    } finally {
      this.productManager.loading = false;
      document.getElementById("loader").classList.remove("show");
    }
  }

  groupProducts(items) {
    return items.reduce((acc, i) => {
      const art = i.Articulo.trim();
      if (!acc[art]) {
        acc[art] = {
          Articulo: art,
          Descripcion: i.Descripcion || "",
          Precio: i.Precio || "",
          VariantePrincipal: i["Imagen Principal"],
          Oferta: i.Oferta || "",
          FechaIngreso: i.FechaIngreso || "",
          Filtro1: i.Filtro1 || "",
          Filtro2: i.Filtro2 || "",
          Filtro3: i.Filtro3 || "",
          DetalleColor: [],
        };
      }
      acc[art].DetalleColor.push({
        color: i.Color,
        talles: i.Numeracion?.split(",").map((t) => t.trim()) || [],
        images: Object.keys(i)
          .filter((k) => k.toLowerCase().startsWith("imagen"))
          .map((k) => i[k])
          .filter(Boolean),
      });
      return acc;
    }, {});
  }

  renderProducts(grupos, container) {
    Object.values(grupos)
      .sort((a, b) => {
        const fechaA = Utils.parseFecha(a.FechaIngreso);
        const fechaB = Utils.parseFecha(b.FechaIngreso);
        return fechaB - fechaA;
      })
      .forEach((product) => {
        container.innerHTML += this.renderer.renderProductCard(product);
      });
  }

  setupProductEvents() {
    // Galería de imágenes
    document.querySelectorAll(".card .gallery .miniatura").forEach((img) => {
      img.addEventListener("click", function () {
        const main = this.closest(".card").querySelector(".main-image");
        if (main) main.src = this.getAttribute("data-full");
      });
    });

    // Botones de color
    document.querySelectorAll(".card .color-btn").forEach((btn) => {
      btn.addEventListener("click", function () {
        const main = this.closest(".card").querySelector(".main-image");
        if (main) main.src = this.dataset.src;
      });
    });

    // Botones de reserva
    document.querySelectorAll(".card .reserve-btn").forEach((btn) => {
      btn.addEventListener("click", this.handleReserveClick.bind(this));
    });

    // Tags
    document.querySelectorAll(".card .tag-chip").forEach((chip) => {
      chip.addEventListener("click", this.handleTagClick.bind(this));
    });

    // Botones de compartir
    document.querySelectorAll(".card .share-btn").forEach((btn) => {
      btn.addEventListener("click", this.handleShareClick.bind(this));
    });
  }

  async handleReserveClick(event) {
    try {
      const controls = event.target.closest(".reserve-controls");
      const qty = parseInt(controls.querySelector(".res-qty").value || "1", 10);
      const size = controls.querySelector(".res-size").value;
      const articulo = event.target.dataset.articulo;
      const color = event.target.dataset.color;

      const card = event.target.closest(".card");
      const precio = card.querySelector(".price")?.textContent || "0";
      const descripcion = card.querySelector(".description")?.textContent || "";
      const imagen = card.querySelector(".main-image")?.src || "";

      const productData = {
        articulo,
        color,
        talle: size,
        cantidad: qty,
        precio:
          parseFloat(precio.replace(/[^0-9.,]/g, "").replace(",", ".")) || 0,
        imagen,
        descripcion,
      };

      if (window.addToCart) {
        window.addToCart(productData);
        event.target.textContent = "Agregado";
        event.target.style.background = "#4CAF50";
        setTimeout(() => {
          event.target.textContent = "Agregar";
          event.target.style.background = "";
        }, 1200);
      } else {
        alert("Sistema de carrito no disponible");
      }
    } catch (error) {
      ErrorHandler.log(error, "handleReserveClick");
      alert("No se pudo agregar al carrito");
    }
  }

  handleTagClick(event) {
    const tag = event.target.dataset.tag || event.target.textContent.trim();
    const input = document.getElementById("searchInput");
    if (input) {
      input.value = tag;
      input.dispatchEvent(new Event("input"));
    }
    try {
      gtag("event", "filtro_tag", {
        event_category: "interaccion",
        event_label: tag,
      });
    } catch {}
  }

  async handleShareClick(event) {
    try {
      const card = event.target.closest(".card");
      const mainImg = card.querySelector(".main-image");
      const imgUrl = mainImg.src;

      let fileName = "catalogo-fyl.jpg";
      try {
        const urlParts = imgUrl.split("/");
        const lastPart = urlParts[urlParts.length - 1].split("?")[0];
        if (lastPart && lastPart.includes(".")) fileName = lastPart;
      } catch {}

      if (
        navigator.canShare &&
        navigator.canShare({ files: [new File([], "x.jpg")] })
      ) {
        const response = await fetch(imgUrl);
        const blob = await response.blob();
        const file = new File([blob], fileName, { type: blob.type });
        await navigator.share({ files: [file] });
      } else if (navigator.share) {
        navigator.share({ url: imgUrl });
      } else {
        alert(
          "La función de compartir solo está disponible en dispositivos móviles compatibles."
        );
      }
    } catch (error) {
      ErrorHandler.log(error, "handleShareClick");
      alert(
        "No se pudo compartir la imagen directamente. Intenta de nuevo o usa el botón de descarga."
      );
    }
  }

  async cambiarCategoria(cat) {
    console.log("Cambiando a categoría:", cat);

    try {
      gtag("event", "categoria_cambiada", {
        event_category: "navegacion",
        event_label: cat,
      });
    } catch {}

    await this.cargarCategoria(cat);

    // Actualizar botón activo
    document.querySelectorAll(".menu button").forEach((btn) => {
      btn.classList.remove("active");
      const buttonText = btn.textContent.trim();
      let shouldActivate = false;

      if (cat === "Lenceria" && buttonText === "Lencería") {
        shouldActivate = true;
      } else if (cat === "Marroquineria" && buttonText === "Accesorios") {
        shouldActivate = true;
      } else if (buttonText.includes(cat)) {
        shouldActivate = true;
      }

      if (shouldActivate) {
        btn.classList.add("active");
      }
    });
  }
}

// Funciones globales para compatibilidad
async function downloadImage(btn) {
  try {
    const card = btn.closest(".card");
    const src = card.querySelector(".main-image").src;

    gtag("event", "descarga_imagen", {
      event_category: "interaccion",
      event_label: src,
    });

    const filename = src
      .split("/")
      .pop()
      .split("?")[0]
      .replace(/\.\w+$/, ".jpg");

    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = src;

    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
    });

    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);

    canvas.toBlob(
      (blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      },
      "image/jpeg",
      0.92
    );
  } catch (error) {
    ErrorHandler.log(error, "downloadImage");
    // Fallback directo
    const a = document.createElement("a");
    a.href = src;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
}

// Inicialización
let catalogController;

window.addEventListener("DOMContentLoaded", async () => {
  try {
    catalogController = new CatalogController();

    // Cargar categoría inicial
    const inicial = (await catalogController.productManager.existeNovedades())
      ? "Novedades"
      : "Calzado";
    await catalogController.cambiarCategoria(inicial);

    // Configurar botón de novedades
    await catalogController.productManager.toggleNovedadesButton();
  } catch (error) {
    ErrorHandler.log({ ...error, critical: true }, "DOMContentLoaded");
  }
});

// Exportar funciones para uso global
window.parseFecha = Utils.parseFecha;
window.cloudinaryOptimized = Utils.cloudinaryOptimized;
window.existeNovedades = () =>
  catalogController?.productManager?.existeNovedades() ||
  Promise.resolve(false);
window.toggleNovedadesButton = () =>
  catalogController?.productManager?.toggleNovedadesButton() ||
  Promise.resolve();
window.cargarCategoria = (cat) =>
  catalogController?.cargarCategoria(cat) || Promise.resolve();
window.cambiarCategoria = (cat) =>
  catalogController?.cambiarCategoria(cat) || Promise.resolve();
window.downloadImage = downloadImage;

