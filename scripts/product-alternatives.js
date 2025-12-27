// scripts/product-alternatives.js
// Sistema de productos alternativos cuando un producto/variante está sin stock

import { supabase as supabaseClient } from "./supabase-client.js";

let supabase = supabaseClient;

/**
 * Busca productos alternativos basándose en similitud usando find_similar_products.
 * Versión mejorada que usa el sistema de similitud con scoring.
 * @param {Object} params - Parámetros de búsqueda
 * @param {string} params.productId - ID del producto original (nuevo, preferido)
 * @param {string} params.articulo - Nombre del artículo original (legacy, usado si no hay productId)
 * @param {string} params.talle - Talle deseado
 * @param {string[]} params.tags - Tags del producto original (legacy, no usado en nueva versión)
 * @param {string} params.color - Color del producto original (opcional)
 * @param {number} limit - Límite de productos a retornar (default: 6)
 * @returns {Promise<Array>} Lista de productos alternativos
 */
export async function buscarProductosAlternativos({
  productId = null,
  articulo = null,
  talle,
  tags = [],
  color = null,
  limit = 6,
}) {
  try {
    if (!supabase) {
      console.warn("⚠️ Supabase no disponible para buscar alternativas");
      return [];
    }

    console.log("🔍 Buscando productos alternativos:", {
      productId,
      articulo,
      talle,
      color,
      limit,
    });

    // Si no hay productId, intentar obtenerlo por nombre (legacy)
    let sourceProductId = productId;
    if (!sourceProductId && articulo) {
      const { data: product } = await supabase
        .from("products")
        .select("id")
        .eq("name", articulo)
        .eq("status", "active")
        .maybeSingle();
      if (product) {
        sourceProductId = product.id;
      }
    }

    if (!sourceProductId) {
      console.warn("⚠️ No se pudo determinar productId para buscar similares");
      return [];
    }

    // Usar la nueva función find_similar_products
    const { data: similares, error: similaresError } = await supabase
      .rpc('find_similar_products', {
        source_product_id: sourceProductId,
        size_filter: talle || null,
        limit_count: limit
      });

    if (similaresError) {
      console.error("❌ Error buscando similares:", similaresError);
      return [];
    }

    if (!similares || similares.length === 0) {
      console.log("ℹ️ No se encontraron productos similares");
      return [];
    }

    // Enriquecer con imágenes y datos adicionales
    const productosEnriquecidos = await Promise.all(
      similares.map(async (item) => {
        // Obtener variante específica (color y talle)
        const { data: variant } = await supabase
          .from('product_variants')
          .select('id, color, size, price, stock_qty, reserved_qty')
          .eq('product_id', item.product_id)
          .eq('color', item.color)
          .in('size', item.available_sizes || [])
          .eq('active', true)
          .maybeSingle();

        // Obtener imagen principal
        const { data: image } = await supabase
          .from('variant_images')
          .select('url')
          .eq('variant_id', variant?.id)
          .eq('position', 1)
          .maybeSingle();

        // Obtener todos los colores disponibles para este producto y talle
        const { data: coloresDisponibles } = await supabase
          .from('product_variants')
          .select('color, price, stock_qty, reserved_qty')
          .eq('product_id', item.product_id)
          .in('size', item.available_sizes || [])
          .eq('active', true);

        const coloresConStock = (coloresDisponibles || []).filter((c) => {
          const stock = Number(c.stock_qty ?? 0);
          const reserved = Number(c.reserved_qty ?? 0);
          return stock - reserved > 0;
        });

        // Obtener highlights para mostrar como tags
        const { data: highlights } = await supabase
          .rpc('get_product_highlights', { product_id: item.product_id });

        const stockDisponible = variant 
          ? Number(variant.stock_qty ?? 0) - Number(variant.reserved_qty ?? 0)
          : 0;

        return {
          product_id: item.product_id,
          articulo: item.name,
          categoria: item.category,
          descripcion: '',
          color: item.color,
          talle: item.available_sizes?.[0] || talle,
          precio: Number(item.price ?? 0) || 0,
          imagen: image?.url || null,
          stock_disponible: stockDisponible,
          colores_disponibles: coloresConStock.map((c) => ({
            color: c.color,
            precio: Number(c.price ?? 0) || 0,
            stock: Number(c.stock_qty ?? 0) - Number(c.reserved_qty ?? 0),
          })),
          tags: (highlights || []).map(h => h.name),
          similitud: item.similarity_score / 100, // Normalizar score a 0-1 para compatibilidad
          variant_id: variant?.id,
        };
      })
    );

    console.log(
      `✅ Encontrados ${productosEnriquecidos.length} productos alternativos`
    );

    return productosEnriquecidos;
  } catch (error) {
    console.error("❌ Error buscando productos alternativos:", error);
    return [];
  }
}

/**
 * Crea y muestra un modal con productos alternativos
 * @param {Object} params - Parámetros para el modal
 * @param {string} params.mensaje - Mensaje principal del modal
 * @param {Array} params.productos - Lista de productos alternativos
 * @param {Function} params.onProductoSeleccionado - Callback cuando se selecciona un producto
 * @param {Function} params.onCerrar - Callback cuando se cierra el modal
 */
export function mostrarModalAlternativas({
  mensaje,
  productos = [],
  onProductoSeleccionado = null,
  onCerrar = null,
}) {
  // Remover modal anterior si existe
  const modalAnterior = document.getElementById("alternativas-modal");
  if (modalAnterior) {
    modalAnterior.remove();
  }

  // Crear modal
  const modal = document.createElement("div");
  modal.id = "alternativas-modal";
  modal.className = "alternativas-modal";
  modal.innerHTML = `
    <div class="alternativas-modal-content">
      <div class="alternativas-modal-header">
        <h2>🛍️ Productos Alternativos</h2>
        <button class="alternativas-modal-close" id="alternativas-close-btn">&times;</button>
      </div>
      <div class="alternativas-modal-body">
        <p class="alternativas-modal-message">${mensaje}</p>
        ${
          productos.length === 0
            ? `<div class="alternativas-empty">
                <p>No se encontraron productos alternativos con stock disponible.</p>
              </div>`
            : `<div class="alternativas-grid" id="alternativas-grid">
                ${productos
                  .map((producto, index) => {
                    const imagenUrl =
                      producto.imagen ||
                      "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200' viewBox='0 0 200 200'%3E%3Crect width='200' height='200' fill='%23f0f0f0'/%3E%3Ctext x='50%25' y='50%25' text-anchor='middle' dy='.3em' fill='%23999'%3ESin imagen%3C/text%3E%3C/svg%3E";
                    return `
                      <div class="alternativa-card" data-product-id="${producto.product_id}" data-variant-id="${producto.variant_id}">
                        <img src="${imagenUrl}" alt="${producto.articulo}" class="alternativa-image" onerror="this.src='data:image/svg+xml,%3Csvg xmlns=\\'http://www.w3.org/2000/svg\\' width=\\'200\\' height=\\'200\\'%3E%3Crect fill=\\'%23f0f0f0\\'/%3E%3Ctext fill=\\'%23999\\'%3ESin imagen%3C/text%3E%3C/svg%3E'">
                        <div class="alternativa-info">
                          <h3 class="alternativa-title">${producto.articulo}</h3>
                          <p class="alternativa-meta">Color: ${producto.color} • Talle: ${producto.talle}</p>
                          ${producto.colores_disponibles.length > 1 ? `<p class="alternativa-colores">También disponible en: ${producto.colores_disponibles.slice(0, 3).map(c => c.color).join(", ")}</p>` : ""}
                          <p class="alternativa-precio">$${producto.precio.toLocaleString("es-AR")}</p>
                          <p class="alternativa-stock">Stock disponible: ${producto.stock_disponible}</p>
                          ${producto.tags.length > 0 ? `<div class="alternativa-tags">${producto.tags.map(t => `<span class="alternativa-tag">${t}</span>`).join("")}</div>` : ""}
                        </div>
                        <button class="alternativa-select-btn" data-index="${index}">Seleccionar este producto</button>
                      </div>
                    `;
                  })
                  .join("")}
              </div>`
        }
      </div>
      <div class="alternativas-modal-footer">
        <button class="alternativas-cerrar-btn" id="alternativas-cerrar-btn">Cerrar</button>
      </div>
    </div>
  `;

  document.body.appendChild(modal);

  // Mostrar modal
  setTimeout(() => {
    modal.classList.add("active");
  }, 10);

  // Event listeners
  const closeBtn = document.getElementById("alternativas-close-btn");
  const cerrarBtn = document.getElementById("alternativas-cerrar-btn");

  const cerrarModal = () => {
    modal.classList.remove("active");
    setTimeout(() => {
      modal.remove();
      if (onCerrar) onCerrar();
    }, 300);
  };

  if (closeBtn) {
    closeBtn.addEventListener("click", cerrarModal);
  }

  if (cerrarBtn) {
    cerrarBtn.addEventListener("click", cerrarModal);
  }

  // Cerrar al hacer clic fuera del modal
  modal.addEventListener("click", (e) => {
    if (e.target === modal) {
      cerrarModal();
    }
  });

  // Cerrar con tecla ESC
  const handleEsc = (e) => {
    if (e.key === "Escape" && modal.classList.contains("active")) {
      cerrarModal();
      document.removeEventListener("keydown", handleEsc);
    }
  };
  document.addEventListener("keydown", handleEsc);

  // Botones de selección de producto
  if (productos.length > 0) {
    document
      .querySelectorAll(".alternativa-select-btn")
      .forEach((btn) => {
        btn.addEventListener("click", (e) => {
          const index = parseInt(btn.dataset.index);
          const producto = productos[index];
          if (producto && onProductoSeleccionado) {
            onProductoSeleccionado(producto);
            cerrarModal();
          }
        });
      });

    // También permitir seleccionar haciendo clic en la tarjeta
    document.querySelectorAll(".alternativa-card").forEach((card) => {
      card.addEventListener("click", (e) => {
        // Solo si no se hizo clic en el botón
        if (!e.target.closest(".alternativa-select-btn")) {
          const productId = card.dataset.productId;
          const producto = productos.find((p) => p.product_id === productId);
          if (producto && onProductoSeleccionado) {
            onProductoSeleccionado(producto);
            cerrarModal();
          }
        }
      });
      card.style.cursor = "pointer";
    });
  }

  return modal;
}

// Exportar funciones globalmente
if (typeof window !== "undefined") {
  window.buscarProductosAlternativos = buscarProductosAlternativos;
  window.mostrarModalAlternativas = mostrarModalAlternativas;
}

