import { cloudinaryOptimized } from "./data-manager.js";

export function showLoader() {
  document.getElementById("loader").classList.add("show");
}

export function hideLoader() {
  document.getElementById("loader").classList.remove("show");
}

export function showError(message) {
  const cont = document.getElementById("catalogo");
  cont.innerHTML = `<div class="error-message">${message}</div>`;
}

export function showNoData() {
  const cont = document.getElementById("catalogo");
  cont.innerHTML =
    '<div class="no-data">No hay productos disponibles en esta categoría</div>';
}

export function renderProductCard(m) {
  const gal = m.DetalleColor.flatMap((v) => v.images)
    .map((src) => {
      const thumb = cloudinaryOptimized(src, 200);
      const full = cloudinaryOptimized(src, 800);
      return `
        <img
          loading="lazy"
          src="${thumb}"
          data-full="${full}"
          alt="Miniatura de producto">
      `;
    })
    .join("");

  const colores = m.DetalleColor.map((v) => {
    const hexColor = v.hex_color || "#CD844D"; // Color por defecto si no hay hex_color
    const displayNumber = v.ColorDisplayNumber || v.display_number;
    // Calcular si el color es claro u oscuro para ajustar el color del texto
    const rgb = hexToRgb(hexColor);
    const brightness = rgb ? (rgb.r * 299 + rgb.g * 587 + rgb.b * 114) / 1000 : 128;
    const textColor = brightness > 128 ? "#000000" : "#FFFFFF";
    
    // Agregar el número si existe
    const numberHtml = displayNumber 
      ? `<span class="color-number" style="color: ${textColor}; font-weight: bold; font-size: 0.85em; pointer-events: none; position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%);">${displayNumber}</span>` 
      : "";
    
    return `<button class='color-btn' 
                    data-src="${v.images[0]}" 
                    data-number="${displayNumber || ''}"
                    style="background-color: ${hexColor}; color: ${textColor}; border: 1px solid ${hexColor}; position: relative; display: flex; align-items: center; justify-content: center;">${numberHtml}</button>`;
  }).join("");

  const varsHtml = m.DetalleColor.map((v) => {
    const chips = v.talles.map((t) => `<div class="talle">${t}</div>`).join("");
    return `<div class="variant"><strong>${v.color}:</strong><div class="talles">${chips}</div></div>`;
  }).join("");

  return `
    <div class="card producto"
         data-filtro1="${m.Filtro1}"
         data-filtro2="${m.Filtro2}"
         data-filtro3="${m.Filtro3}">
      <div class="download-container">
        <button class="download-btn" onclick="downloadImage(this)" title="Descargar imagen">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
            <path d="M5 20h14v-2H5v2zm7-18v12l4-4h-3v-4h-2v4H8l4 4z" fill="#fff"/>
          </svg>
        </button>
      </div>

      <img class="main-image" loading="lazy" src="${cloudinaryOptimized(
        m.VariantePrincipal,
        800
      )}" alt="${m.Articulo}"/>
      <div class="image-loader"><div class="spinner"></div></div>

      <div class="gallery">${gal}</div>
      <div class="title-row">
        <h3>Art: <span class="article-box">${m.Articulo}</span>${
    m.Oferta === "TRUE" ? ' <span class="article-fire">🔥</span>' : ""
  }</h3>
        <div class="colors">${colores}</div>
      </div>
      <div class="description">${m.Descripcion}</div>
      <div class="price-container">
        <div class="price">${m.Precio}</div>
        <div class="wholesale">Precio por mayor</div>
      </div>
      ${varsHtml}
    </div>`;
}

// Función auxiliar para convertir hex a RGB
function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : null;
}

export function updateActiveButton(cat) {
  document.querySelectorAll(".menu button").forEach((btn) => {
    btn.classList.remove("active");
  });
  const btnActivo = document.querySelector(
    `.menu button[onclick="cambiarCategoria('${cat}')"]`
  );
  if (btnActivo) btnActivo.classList.add("active");
}

export function clearSearch() {
  document.getElementById("searchInput").value = "";
  document.querySelectorAll(".card").forEach((card) => {
    card.style.display = "block";
  });
}
