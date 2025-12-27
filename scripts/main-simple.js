// scripts/main-simple.js - Versión simplificada que funciona inmediatamente
// Esta versión carga productos directamente desde Google Sheets sin dependencias complejas

// Constantes
const SHEET_ID = "1kdhxSWHl3Rg0tXpaRsKhR_m30oTZhzqYj5ypsjtcTig";
const CATEGORIAS = ["Calzado", "Ropa", "Lenceria", "Marroquineria"];

// Utilidades básicas
function parseFecha(str) {
  if (!str) return new Date(2000, 0, 1);
  const [d, m, y] = str.split("/").map((n) => parseInt(n, 10));
  if (!d || !m || !y) return new Date(2000, 0, 1);
  return new Date(y, m - 1, d);
}

function cloudinaryOptimized(url, w) {
  if (!url || typeof url !== "string") return url || "";
  url = url.startsWith("http://") ? url.replace("http://", "https://") : url;
  return url.replace("/upload/", `/upload/f_auto,q_auto,c_scale,w_${w}/`);
}

// Función principal de carga de categoría
async function cargarCategoria(cat) {
  console.log("🔄 Cargando categoría:", cat);

  const loader = document.getElementById("loader");
  const cont = document.getElementById("catalogo");

  if (loader) loader.classList.add("show");
  if (cont) cont.innerHTML = "";

  try {
    let data = [];

    // Intentar cargar desde Google Sheets
    if (cat === "Novedades" || cat === "Ofertas") {
      // Para categorías especiales, cargar todas las categorías
      const promises = CATEGORIAS.map((categoria) =>
        fetch(`https://opensheet.elk.sh/${SHEET_ID}/${categoria}`)
          .then((r) => r.json())
          .catch(() => [])
      );
      const allData = await Promise.all(promises);
      data = allData.flat();
    } else {
      // Para categorías normales, cargar solo esa categoría
      const response = await fetch(
        `https://opensheet.elk.sh/${SHEET_ID}/${cat}`
      );
      data = await response.json();
    }

    console.log(`📊 Datos cargados para ${cat}:`, data.length, "productos");

    // Filtrar productos que se deben mostrar
    let items = data.filter((i) => i.Mostrar === "TRUE");
    console.log(`✅ Productos válidos:`, items.length);

    // Ordenar por fecha de ingreso
    items.sort((a, b) => {
      const fechaA = parseFecha(a.FechaIngreso);
      const fechaB = parseFecha(b.FechaIngreso);
      return fechaB - fechaA;
    });

    // Filtrar según categoría especial
    if (cat === "Novedades") {
      const hoy = new Date();
      const hace7 = new Date(
        hoy.getFullYear(),
        hoy.getMonth(),
        hoy.getDate() - 7
      );
      items = items.filter(
        (i) => i.FechaIngreso && parseFecha(i.FechaIngreso) >= hace7
      );
      console.log(`🆕 Novedades (últimos 7 días):`, items.length);
    }

    if (cat === "Ofertas") {
      items = items.filter((i) => i.Oferta === "TRUE");
      console.log(`🔥 Ofertas:`, items.length);
    }

    if (items.length === 0) {
      if (cont) {
        cont.innerHTML =
          '<div class="no-data">No hay productos disponibles en esta categoría</div>';
      }
      console.log("⚠️ No hay productos para mostrar");
      return;
    }

    // Agrupar productos por artículo
    const grupos = items.reduce((acc, i) => {
      const art = i.Articulo?.trim();
      if (!art) return acc;

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
        color: i.Color || "Sin color",
        talles: i.Numeracion?.split(",").map((t) => t.trim()) || ["Único"],
        images: Object.keys(i)
          .filter((k) => k.toLowerCase().startsWith("imagen"))
          .map((k) => i[k])
          .filter(Boolean),
      });

      return acc;
    }, {});

    console.log(`📦 Productos agrupados:`, Object.keys(grupos).length);

    // Renderizar productos
    renderizarProductos(Object.values(grupos), cont);

    // Configurar eventos
    configurarEventos();
  } catch (error) {
    console.error("❌ Error cargando categoría:", error);
    if (cont) {
      cont.innerHTML = `
        <div class="error-message" style="text-align: center; padding: 40px; color: #666; background: #f8f9fa; border-radius: 8px; margin: 20px;">
          <h3>⚠️ Error al cargar productos</h3>
          <p>No se pudieron cargar los productos. Verifica tu conexión a internet.</p>
          <button onclick="location.reload()" style="background: #CD844D; color: white; border: none; padding: 10px 20px; border-radius: 5px; cursor: pointer; margin-top: 15px;">Reintentar</button>
        </div>
      `;
    }
  } finally {
    if (loader) loader.classList.remove("show");
  }
}

// Función para renderizar productos
function renderizarProductos(productos, container) {
  productos
    .sort((a, b) => {
      const fechaA = parseFecha(a.FechaIngreso);
      const fechaB = parseFecha(b.FechaIngreso);
      return fechaB - fechaA;
    })
    .forEach((producto) => {
      const gal = renderizarGaleria(producto);
      const colores = renderizarColores(producto);
      const variants = renderizarVariantes(producto);
      const tags = renderizarTags(producto);

      const productoHTML = `
        <div class="card producto"
             data-filtro1="${producto.Filtro1 || ""}"
             data-filtro2="${producto.Filtro2 || ""}"
             data-filtro3="${producto.Filtro3 || ""}">
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
          <img class="main-image" loading="lazy" 
               src="${cloudinaryOptimized(producto.VariantePrincipal, 800)}" 
               alt="${producto.Articulo}"/>
          <div class="image-loader"><div class="spinner"></div></div>
          <div class="gallery">${gal}</div>
          ${
            producto.Oferta === "TRUE"
              ? '<div class="tags"><div class="talle tag-chip oferta-chip" data-oferta="1">Oferta</div></div>'
              : ""
          }
          ${tags}
          <div class="title-row">
            <h3>Art: <span class="article-box">${producto.Articulo}</span>${
        producto.Oferta === "TRUE"
          ? ' <span class="article-fire">🔥</span>'
          : ""
      }</h3>
            <div class="colors">${colores}</div>
          </div>
          <div class="description">${producto.Descripcion || ""}</div>
          <div class="price-container">
            <div class="price">${producto.Precio || ""}</div>
            ${
              producto.Oferta === "TRUE"
                ? '<div class="wholesale">Precio mayorista</div>'
                : ""
            }
          </div>
          ${variants}
        </div>
      `;

      container.innerHTML += productoHTML;
    });
}

// Funciones auxiliares de renderizado
function renderizarGaleria(producto) {
  return producto.DetalleColor.flatMap((v) => v.images)
    .map((src) => {
      const thumb = cloudinaryOptimized(src, 200);
      const full = cloudinaryOptimized(src, 800);
      return `<img loading="lazy" src="${thumb}" data-full="${full}" alt="Miniatura de producto" class="miniatura">`;
    })
    .join("");
}

function renderizarColores(producto) {
  return producto.DetalleColor.map(
    (v) =>
      `<button class='color-btn' data-src="${v.images[0] || ""}">${
        v.color
      }</button>`
  ).join("");
}

function renderizarVariantes(producto) {
  return producto.DetalleColor.map((v) => {
    const chips = v.talles.map((t) => `<div class="talle">${t}</div>`).join("");
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
          <button class="reserve-btn" data-articulo="${producto.Articulo}" data-color="${v.color}">Agregar</button>
        </div>
      </div>
    `;
  }).join("");
}

function renderizarTags(producto) {
  const tagList = [producto.Filtro1, producto.Filtro2, producto.Filtro3].filter(
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

// Configurar eventos
function configurarEventos() {
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
    btn.addEventListener("click", function () {
      const controls = this.closest(".reserve-controls");
      const qty = parseInt(controls.querySelector(".res-qty").value || "1", 10);
      const size = controls.querySelector(".res-size").value;
      const articulo = this.dataset.articulo;
      const color = this.dataset.color;

      const card = this.closest(".card");
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
        this.textContent = "Agregado";
        this.style.background = "#4CAF50";
        setTimeout(() => {
          this.textContent = "Agregar";
          this.style.background = "";
        }, 1200);
      } else {
        alert("Sistema de carrito no disponible");
      }
    });
  });

  // Tags
  document.querySelectorAll(".card .tag-chip").forEach((chip) => {
    chip.addEventListener("click", function () {
      const tag = this.dataset.tag || this.textContent.trim();
      const input = document.getElementById("searchInput");
      if (input) {
        input.value = tag;
        input.dispatchEvent(new Event("input"));
      }
    });
  });

  // Botones de compartir
  document.querySelectorAll(".card .share-btn").forEach((btn) => {
    btn.addEventListener("click", async function () {
      const card = this.closest(".card");
      const mainImg = card.querySelector(".main-image");
      const imgUrl = mainImg.src;

      if (navigator.share) {
        try {
          await navigator.share({ url: imgUrl });
        } catch (e) {
          console.log("Compartir cancelado");
        }
      } else {
        alert("La función de compartir no está disponible en este dispositivo");
      }
    });
  });
}

// Función para cambiar categoría
async function cambiarCategoria(cat) {
  console.log("🔄 Cambiando a categoría:", cat);

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

  await cargarCategoria(cat);
}

// Función para descargar imagen
async function downloadImage(btn) {
  try {
    const card = btn.closest(".card");
    const src = card.querySelector(".main-image").src;

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
    console.error("Error descargando imagen:", error);
    // Fallback directo
    const a = document.createElement("a");
    a.href = src;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
}

// Verificar si hay novedades
async function existeNovedades() {
  try {
    const hoy = new Date();
    const hace7 = new Date(
      hoy.getFullYear(),
      hoy.getMonth(),
      hoy.getDate() - 7
    );

    for (const cat of CATEGORIAS) {
      const response = await fetch(
        `https://opensheet.elk.sh/${SHEET_ID}/${cat}`
      );
      const data = await response.json();

      if (
        data.some(
          (item) =>
            item.Mostrar === "TRUE" &&
            item.FechaIngreso &&
            parseFecha(item.FechaIngreso) >= hace7
        )
      ) {
        return true;
      }
    }
    return false;
  } catch (error) {
    console.error("Error verificando novedades:", error);
    return false;
  }
}

// Función de diagnóstico
function ejecutarDiagnostico() {
  console.log("🔍 DIAGNÓSTICO RÁPIDO - CATÁLOGO FYL");
  console.log("=====================================");

  // 1. Verificar configuración
  console.log("\n1. 📋 CONFIGURACIÓN:");
  console.log("USE_SUPABASE:", window.USE_SUPABASE || "No definido");
  console.log(
    "USE_OPEN_SHEET_FALLBACK:",
    window.USE_OPEN_SHEET_FALLBACK || "No definido"
  );
  console.log("SUPABASE_URL:", window.SUPABASE_URL || "No definido");

  // 2. Verificar funciones disponibles
  console.log("\n2. 🔧 FUNCIONES DISPONIBLES:");
  console.log("cargarCategoria:", typeof window.cargarCategoria);
  console.log("cambiarCategoria:", typeof window.cambiarCategoria);
  console.log("downloadImage:", typeof window.downloadImage);

  // 3. Verificar estado del catálogo
  console.log("\n3. 🎯 ESTADO DEL CATÁLOGO:");
  const catalogo = document.getElementById("catalogo");
  const loader = document.getElementById("loader");
  console.log("Elemento catálogo:", catalogo ? "Encontrado" : "NO ENCONTRADO");
  console.log("Elemento loader:", loader ? "Encontrado" : "NO ENCONTRADO");
  console.log(
    "Contenido del catálogo:",
    catalogo?.innerHTML?.substring(0, 100) + "..."
  );

  console.log("\n=====================================");
  console.log("🔍 DIAGNÓSTICO COMPLETADO");
}

// Inicialización
window.addEventListener("DOMContentLoaded", async () => {
  console.log("🚀 Inicializando catálogo simplificado...");

  // Ejecutar diagnóstico
  ejecutarDiagnostico();

  try {
    // Cargar categoría inicial
    const inicial = (await existeNovedades()) ? "Novedades" : "Calzado";
    await cambiarCategoria(inicial);

    // Ocultar botón de novedades si no hay novedades
    const btnNovedades = document.getElementById("btn-novedades");
    if (btnNovedades && !(await existeNovedades())) {
      btnNovedades.style.display = "none";
    }

    console.log("✅ Catálogo inicializado correctamente");
  } catch (error) {
    console.error("❌ Error inicializando catálogo:", error);
  }
});

// Configurar eventos de la interfaz
document.addEventListener("DOMContentLoaded", () => {
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
      document
        .querySelectorAll(".card")
        .forEach((c) => (c.style.display = "block"));
    });
  }
});

// Exportar funciones globales
window.cargarCategoria = cargarCategoria;
window.cambiarCategoria = cambiarCategoria;
window.downloadImage = downloadImage;
window.existeNovedades = existeNovedades;
window.parseFecha = parseFecha;
window.cloudinaryOptimized = cloudinaryOptimized;
