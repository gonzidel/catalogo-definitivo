// scripts/data-manager.js
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutos
const dataCache = {};

export async function fetchWithCache(url, key) {
  console.log("Fetching URL:", url); // Debug
  const now = Date.now();
  const cached = dataCache[key];

  if (cached && now - cached.timestamp < CACHE_DURATION) {
    console.log("Using cached data for:", key); // Debug
    return cached.data;
  }

  try {
    console.log("Fetching fresh data for:", key); // Debug
    const response = await fetch(url);
    if (!response.ok) {
      console.error("Error response:", response.status, response.statusText); // Debug
      throw new Error(
        `Error en la respuesta de la API: ${response.status} ${response.statusText}`
      );
    }
    const data = await response.json();
    console.log("Data received for:", key, "Items:", data.length); // Debug

    dataCache[key] = {
      data,
      timestamp: now,
    };
    return data;
  } catch (error) {
    console.error("Error fetching data for", key, ":", error);
    throw error;
  }
}

export function parseFecha(fechaStr) {
  if (!fechaStr) return new Date(0);
  const [dia, mes, anio] = fechaStr.split("/").map(Number);
  return new Date(anio, mes - 1, dia);
}

export function cloudinaryOptimized(url) {
  if (!url) return "";
  return url.replace("/upload/", "/upload/c_scale,w_800,q_auto,f_auto/");
}

export async function getCategoryData(categoria, sheetID, categorias) {
  console.log("Getting category data for:", categoria); // Debug
  try {
    // Si es una categoría especial (Novedades u Ofertas), buscar en todas las hojas
    if (categoria === "Novedades" || categoria === "Ofertas") {
      console.log("Fetching special category:", categoria); // Debug
      const allData = [];
      for (const cat of categorias) {
        const url = `https://opensheet.elk.sh/${sheetID}/${cat}`;
        console.log("Fetching from sheet:", cat); // Debug
        const data = await fetchWithCache(url, cat);
        allData.push(...data);
      }
      console.log("Total items for special category:", allData.length); // Debug
      return allData;
    }

    // Para categorías normales, buscar solo en la hoja correspondiente
    const url = `https://opensheet.elk.sh/${sheetID}/${categoria}`;
    console.log("Fetching normal category from URL:", url); // Debug
    const data = await fetchWithCache(url, categoria);
    console.log(
      "Items received for category:",
      categoria,
      "Count:",
      data.length
    ); // Debug
    return data;
  } catch (error) {
    console.error(`Error al obtener datos de ${categoria}:`, error);
    return [];
  }
}
