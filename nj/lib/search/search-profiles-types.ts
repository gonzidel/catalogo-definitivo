/**
 * Tipos públicos del perfil de búsqueda (Fase B).
 * La tabla product_search_profiles solo expone filas approved a anon.
 */

export type SearchProfileStatus = "draft" | "approved" | "rejected" | "stale";

export interface SearchProfilePublic {
  articulo: string;
  search_terms: string[];
  style_terms: string[];
  occasion_terms: string[];
  color_families: string[];
  audience: string | null;
  season: string | null;
}

export interface SearchProfileRow extends SearchProfilePublic {
  id: string;
  product_id: string;
  status: SearchProfileStatus;
  source_hash: string;
  provider: string | null;
  model: string | null;
  prompt_version: string | null;
  confidence: number | null;
  cost_usd: number | null;
  generated_at: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
}
