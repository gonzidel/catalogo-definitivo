// guarda el estado en una variable global
let isTwoCol = false;

// al click en el botón, invertimos y actualizamos
document.getElementById("toggle-view").addEventListener("click", () => {
  isTwoCol = !isTwoCol;
  applyViewMode();
});

// función que aplica la clase + cambia texto del botón
function applyViewMode() {
  const cont = document.getElementById("catalogo");
  cont.classList.toggle("two-col", isTwoCol);
  document.getElementById("toggle-view").textContent = isTwoCol
    ? "1-columna"
    : "2-columnas";
}

// asegúrate de llamar a applyViewMode tras cada recarga de catálogo
async function cargarCategoria(cat) {
  /* ... tu lógica actual ... */
  // al final:
  applyViewMode();
}
