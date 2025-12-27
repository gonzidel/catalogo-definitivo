// scripts/ofertas.js
(function () {
  const sheetID = "1kdhxSWHl3Rg0tXpaRsKhR_m30oTZhzqYj5ypsjtcTig";
  const sheets = ["Calzado", "Ropa", "Lenceria", "Marroquineria"];

  // Nombre fijo de la columna que marca la oferta
  window.ofertaKey = "Oferta";

  // 1) Recoge todas las filas de las 4 hojas donde Mostrar=TRUE y Oferta=TRUE
  window.getAllOfferRows = async function () {
    const all = await Promise.all(
      sheets.map((s) =>
        fetch(`https://opensheet.elk.sh/${sheetID}/${s}`)
          .then((res) => res.json())
          .catch(() => [])
      )
    );
    return all
      .flat()
      .filter((r) => r.Mostrar === "TRUE" && r[window.ofertaKey] === "TRUE");
  };

  // 2) Muestra u oculta el botón “Ofertas 🔥” según haya o no filas
  window.toggleOfertaBtn = async function () {
    const btn = document.getElementById("btn-ofertas");
    const rows = await window.getAllOfferRows();
    // always label “Ofertas 🔥”
    btn.textContent = "Ofertas 🔥";
    btn.style.display = rows.length ? "" : "none";
  };
})();
