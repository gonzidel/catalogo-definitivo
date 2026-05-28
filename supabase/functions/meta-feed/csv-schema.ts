/** Headers CSV exportados — Meta feed Fase 1 (14 columnas). */
export const META_CSV_HEADERS_PHASE1 = [
  "id",
  "item_group_id",
  "title",
  "description",
  "availability",
  "condition",
  "price",
  "link",
  "image_link",
  "brand",
  "color",
  "size",
  "gender",
  "product_type",
] as const;

export type MetaCsvHeaderPhase1 = (typeof META_CSV_HEADERS_PHASE1)[number];
