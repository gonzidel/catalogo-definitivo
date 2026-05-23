from pathlib import Path

p = Path(__file__).resolve().parents[1] / "admin" / "publications.js"
text = p.read_text(encoding="utf-8")

helpers = r"""function isProductOutOfStock(item) {
  return item?.hasStock === false;
}

function renderProductCardMedia(item, productNameEscaped) {
  const imgSrc = item.firstImage ? cloudinaryOptimized(item.firstImage, 400) : "";
  const imageUrlEscaped = imgSrc ? String(imgSrc).replace(/"/g, "&quot;") : "";
  const imageBlock = item.firstImage
    ? `<img src="${imageUrlEscaped}" alt="${productNameEscaped}" class="product-image" loading="lazy" onerror="this.style.display='none'">`
    : '<div class="product-image product-image--placeholder">Sin imagen</motion>';
  const stockWarning = isProductOutOfStock(item)
    ? '<p class="product-stock-warning">Sin stock</p>'
    : "";
  return imageBlock + stockWarning;
}

function formatCardSizesLabel(item) {
  if (isProductOutOfStock(item) && (!item.sizes || item.sizes.length === 0)) {
    return "—";
  }
  return formatSizes(item.sizes);
}

"""

helpers = helpers.replace("Sin imagen</motion>';", "Sin imagen</motion>';")
helpers = helpers.replace("</motion>';", "</div>';")

marker = "// Función auxiliar para crear una tarjeta de producto"
if "function isProductOutOfStock" not in text:
    text = text.replace(marker, helpers + marker)

replacements = [
    (
        """  const imgSrc = item.firstImage ? cloudinaryOptimized(item.firstImage, 400) : "";
  const imageUrlEscaped = imgSrc ? String(imgSrc).replace(/"/g, "&quot;") : "";
  const productNameEscaped = String(item.productName).replace(/"/g, "&quot;");
  const numericPrice = getNumericPrice(item.price);
  const formattedPrice = numericPrice !== null ? formatCurrency(numericPrice) : null;
  const editPriceArg = numericPrice !== null ? numericPrice : "null";
  
  return `
    <div class="product-color-card ${isSelected ? 'selected' : ''}" data-product-id="${productIdEscaped}" data-color="${colorEscaped}">
      <div class="checkbox-wrapper">
        <input type="checkbox" ${isSelected ? 'checked' : ''} 
               onchange="togglePublication('${productIdEscaped}', '${colorEscaped}')" />
      </div>
      ${item.firstImage ? `<img src="${imageUrlEscaped}" alt="${productNameEscaped}" class="product-image" loading="lazy" onerror="this.style.display='none'">` : '<motion class="product-image" style="background:#f0f0f0;display:flex;align-items:center;justify-content:center;color:#999;">Sin imagen</div>'}
      <div class="product-info">
        <span class="product-color-badge">${colorEscaped}</span>
        <h3>${productNameEscaped}</h3>
        <p><strong>Categoría:</strong> ${item.category || 'N/A'}</p>
        ${formattedPrice ? `<p><strong>Precio:</strong> ${formattedPrice}</p>` : '<p><strong>Precio:</strong> N/A</p>'}
        <p><strong>Creado:</strong> ${new Date(item.created_at).toLocaleDateString('es-AR')}</p>
        <div class="sizes-info">Talles: ${formatSizes(item.sizes)}</div>""",
        """  const productNameEscaped = String(item.productName).replace(/"/g, "&quot;");
  const numericPrice = getNumericPrice(item.price);
  const formattedPrice = numericPrice !== null ? formatCurrency(numericPrice) : null;
  const editPriceArg = numericPrice !== null ? numericPrice : "null";
  
  return `
    <div class="product-color-card ${isSelected ? 'selected' : ''}" data-product-id="${productIdEscaped}" data-color="${colorEscaped}">
      <div class="checkbox-wrapper">
        <input type="checkbox" ${isSelected ? 'checked' : ''} 
               onchange="togglePublication('${productIdEscaped}', '${colorEscaped}')" />
      </div>
      ${renderProductCardMedia(item, productNameEscaped)}
      <div class="product-info">
        <span class="product-color-badge">${colorEscaped}</span>
        <h3>${productNameEscaped}</h3>
        <p><strong>Categoría:</strong> ${item.category || 'N/A'}</p>
        ${formattedPrice ? `<p><strong>Precio:</strong> ${formattedPrice}</p>` : '<p><strong>Precio:</strong> N/A</p>'}
        <p><strong>Creado:</strong> ${new Date(item.created_at).toLocaleDateString('es-AR')}</p>
        <div class="sizes-info">Talles: ${formatCardSizesLabel(item)}</div>""",
    ),
]

replacements[0] = (
    replacements[0][0].replace("<motion class=\"product-image\"", "<div class=\"product-image\""),
    replacements[0][1],
)

replacements.extend([
    (
        "${item.firstImage ? `<img src=\"${imageUrlEscaped}\" alt=\"${productNameEscaped}\" class=\"product-image\" loading=\"lazy\" onerror=\"this.style.display='none'\">` : '<div class=\"product-image\" style=\"background:#f0f0f0;display:flex;align-items:center;justify-content:center;color:#999;\">Sin imagen</div>'}",
        "${renderProductCardMedia(item, productNameEscaped)}",
    ),
    (
        '<div class="sizes-info">Talles: ${formatSizes(item.sizes)}</div>',
        '<div class="sizes-info">Talles: ${formatCardSizesLabel(item)}</div>',
    ),
    (
        """              sizes: [],
              imageUrls: [],
              firstImage: null,
              price: null,
            };""",
        """              sizes: [],
              imageUrls: [],
              firstImage: null,
              price: null,
              hasStock: false,
            };""",
    ),
])

for old, new in replacements:
    if old not in text:
        raise SystemExit(f"missing: {old[:100]!r}")
    text = text.replace(old, new)

p.write_text(text, encoding="utf-8")
print("ok")
