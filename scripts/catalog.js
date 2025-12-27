// scripts/catalog.js
const sheetID = "1kdhxSWHl3Rg0tXpaRsKhR_m30oTZhzqYj5ypsjtcTig";
const sheets = ["Calzado", "Ropa", "Lenceria", "Marroquineria"];
let hojaActual = "Calzado";

function parseFecha(str) {
  const [d, m, y] = str.split("/").map((n) => parseInt(n, 10));
  return new Date(y, m - 1, d);
}

async function existeNovedades() {
  const flat = (
    await Promise.all(
      sheets.map((s) =>
        fetch(`https://opensheet.elk.sh/${sheetID}/${s}`).then((r) => r.json())
      )
    )
  ).flat();
  const h7 = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  return flat.some(
    (r) =>
      r.Mostrar === "TRUE" && r.FechaIngreso && parseFecha(r.FechaIngreso) >= h7
  );
}

function downloadImage(btn) {
  if (!confirm("¿Deseas descargar la imagen principal?")) return;
  const card = btn.closest(".card"),
    src = card.querySelector(".main-image").src;
  fetch(src)
    .then((r) => r.blob())
    .then((b) => {
      const url = URL.createObjectURL(b),
        a = document.createElement("a");
      a.href = url;
      a.download = src.split("/").pop().split("?")[0];
      document.body.append(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    })
    .catch((_) => window.open(src, "_blank"));
}

async function fetchRaw(cat) {
  if (cat === "Novedades") {
    const all = await Promise.all(
      sheets.map((s) =>
        fetch(`https://opensheet.elk.sh/${sheetID}/${s}`).then((r) => r.json())
      )
    );
    return all.flat();
  }
  return fetch(`https://opensheet.elk.sh/${sheetID}/${cat}`).then((r) =>
    r.json()
  );
}

async function cargarCategoria(cat) {
  const cont = document.getElementById("catalogo");
  cont.innerHTML = "";

  let raw;
  if (cat === "Ofertas") {
    raw = await window.getAllOfferRows();
  } else {
    raw = await fetchRaw(cat);
  }

  // filtro inicial Mostrar=TRUE
  let items = raw.filter((r) => r.Mostrar === "TRUE");

  if (cat === "Novedades") {
    const h7 = new Date(Date.now() - 7 * 24 * 3600 * 1000);
    items = items.filter(
      (r) => r.FechaIngreso && parseFecha(r.FechaIngreso) >= h7
    );
  }

  // agrupar por Articulo
  const grupos = items.reduce((acc, i) => {
    const k = i.Articulo.trim();
    if (!acc[k]) {
      acc[k] = {
        Articulo: k,
        Descripcion: i.Descripcion || "",
        Precio: i.Precio || "",
        VariantePrincipal: i["Imagen Principal"],
        DetalleColor: [],
      };
    }
    acc[k].DetalleColor.push({
      color: i.Color,
      talles: i.Numeracion?.split(",").map((t) => t.trim()) || [],
      images: [
        i["Imagen Principal"],
        i["Imagen 2"],
        i["Imagen 3"],
        i["Imagen 4"],
      ].filter(Boolean),
    });
    return acc;
  }, {});

  cont.onclick = (e) => {
    if (e.target.classList.contains("color-btn")) {
      e.target.closest(".card").querySelector(".main-image").src =
        e.target.dataset.src;
    }
  };

  Object.values(grupos).forEach((m) => {
    const gal = m.DetalleColor.flatMap((v) => v.images.slice(1))
      .map(
        (src) => `<img src="${src}" onclick="event.stopPropagation();
                  this.closest('.card').querySelector('.main-image').src='${src}'">`
      )
      .join("");

    const colores = m.DetalleColor.map(
      (v) =>
        `<button class="color-btn" data-src="${v.images[0]}">${v.color}</button>`
    ).join("");

    const fire =
      cat === "Ofertas" ? `<span class="article-fire">🔥</span>` : "";

    const varsHtml = m.DetalleColor.map((v) => {
      const chips = v.talles
        .map((t) => `<div class="talle">${t}</div>`)
        .join("");
      return `<div class="variant"><strong>${v.color}:</strong>
                <div class="talles">${chips}</div>
              </div>`;
    }).join("");

    cont.innerHTML += `
      <div class="card">
        <button class="download-btn" onclick="downloadImage(this)" title="Descargar">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
            <path fill="#000" d="M5 20h14v-2H5v2zm7-18v12l4-4h-3v-4h-2v4H8l4 4z"/>
          </svg>
        </button>
        <img class="main-image" src="${m.VariantePrincipal}" alt="${m.Articulo}"/>
        <div class="gallery">${gal}</div>
        <div class="title-row">
          <h3>Art: <span class="article-box">${m.Articulo}</span>${fire}</h3>
          <div class="colors">${colores}</div>
        </div>
        <div class="description">${m.Descripcion}</div>
        <div class="price-container">
          <div class="price">${m.Precio}</div>
          <div class="wholesale">Precio por mayor</div>
        </div>
        ${varsHtml}
      </div>`;
  });
}

function cambiarCategoria(n) {
  hojaActual = n;
  cargarCategoria(n);
}

window.addEventListener("DOMContentLoaded", async () => {
  // 1) Inicializa botón Ofertas (nombre + visibilidad)
  await initOfertaKey();
  await toggleOfertaBtn();

  // 2) Muestra Novedades o Calzado por defecto
  const inicio = (await existeNovedades()) ? "Novedades" : "Calzado";
  hojaActual = inicio;
  cargarCategoria(inicio);

  // ocultar botón Novedades si arrancamos en Calzado
  document.getElementById("btn-novedades").style.display =
    inicio === "Novedades" ? "" : "none";
});
