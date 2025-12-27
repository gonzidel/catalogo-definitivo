// scripts/tag-service.js
// Servicio para operaciones con tags jerárquicos y similitud

import { supabase } from './supabase-client.js';

export class TagService {
  // Obtener tipos por categoría
  async getTypesByCategory(category) {
    const { data, error } = await supabase
      .rpc('get_types_by_category', { cat: category });
    return error ? [] : (data || []);
  }

  // Obtener atributos por tipo
  async getAttributesByType(typeId) {
    const { data, error } = await supabase
      .rpc('get_attributes_by_type', { type_id: typeId });
    return error ? [] : (data || []);
  }

  // Obtener detalles de un producto (TODOS, desde product_tag_details)
  async getProductDetails(productId) {
    const { data, error } = await supabase
      .rpc('get_product_details', { product_id: productId });
    return error ? [] : (data || []);
  }

  // Obtener highlights de un producto (máx 2, desde product_tags.tag3_ids)
  async getProductHighlights(productId) {
    const { data, error } = await supabase
      .rpc('get_product_highlights', { product_id: productId });
    return error ? [] : (data || []);
  }

  // Buscar productos similares
  async findSimilarProducts(productId, sizeFilter = null, limit = 6) {
    const { data, error } = await supabase
      .rpc('find_similar_products', {
        source_product_id: productId,
        size_filter: sizeFilter,
        limit_count: limit
      });
    return error ? [] : (data || []);
  }
}

export const tagService = new TagService();

