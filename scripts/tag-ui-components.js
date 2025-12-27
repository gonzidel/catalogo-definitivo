// scripts/tag-ui-components.js
// Componentes UI para mostrar tags (highlights y filtros avanzados)

import { tagService } from './tag-service.js';

// Renderizar chips usando HIGHLIGHTS (no details)
export function renderTagChips(productId, containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;

  tagService.getProductHighlights(productId).then(highlights => {
    container.innerHTML = highlights.map(h => 
      `<span class="tag-chip">${h.name}</span>`
    ).join('');
  });
}

export function renderAdvancedFilters(containerId, onFilterChange) {
  const container = document.getElementById(containerId);
  if (!container) return;

  container.innerHTML = `
    <div class="advanced-filters collapsed">
      <button class="filter-toggle">🔽 Refinar búsqueda</button>
      <div class="filter-content" style="display:none;">
        <div id="detail-filters"></div>
      </div>
    </div>
  `;

  const toggle = container.querySelector('.filter-toggle');
  const content = container.querySelector('.filter-content');
  
  toggle.addEventListener('click', () => {
    const isCollapsed = content.style.display === 'none';
    content.style.display = isCollapsed ? 'block' : 'none';
    toggle.textContent = isCollapsed ? '🔼 Ocultar filtros' : '🔽 Refinar búsqueda';
  });
}

