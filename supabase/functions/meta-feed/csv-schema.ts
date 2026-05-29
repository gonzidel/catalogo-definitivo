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

/** Headers CSV exportados — Meta feed Fase 2 (22 columnas). */
export const META_CSV_HEADERS_PHASE2 = [
  ...META_CSV_HEADERS_PHASE1,
  "google_product_category",
  "custom_label_0",
  "custom_label_1",
  "custom_label_2",
  "custom_label_3",
  "custom_label_4",
  "internal_label",
] as const;

/** Headers CSV exportados — Meta feed Fase 3 (24 columnas, feed completo). */
export const META_CSV_HEADERS_PHASE3 = [
  "id",
  "item_group_id",
  "title",
  "description",
  "availability",
  "condition",
  "price",
  "sale_price",
  "link",
  "image_link",
  "additional_image_link",
  "brand",
  "color",
  "size",
  "gender",
  "product_type",
  "google_product_category",
  "custom_label_0",
  "custom_label_1",
  "custom_label_2",
  "custom_label_3",
  "custom_label_4",
] as const;

/** Feed activo en producción — actualizar al avanzar de fase. */
export const META_CSV_HEADERS = META_CSV_HEADERS_PHASE3;

export type MetaCsvHeaderPhase2 = (typeof META_CSV_HEADERS_PHASE2)[number];
export type MetaCsvHeaderPhase3 = (typeof META_CSV_HEADERS_PHASE3)[number];
