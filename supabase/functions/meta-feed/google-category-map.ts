import { canonicalTagKey, normalizeRootCategoryKey } from "./tag-normalize.ts";

const FALLBACK_BY_ROOT: Record<string, string> = {
  calzado: "Apparel & Accessories > Shoes",
  ropa: "Apparel & Accessories > Clothing",
  otros: "Apparel & Accessories",
};

/** Clave filtro1 → taxonomía Google (sin importar raíz cuando es específico). */
const FILTRO1_GOOGLE: Record<string, string> = {
  bota: "Apparel & Accessories > Shoes > Boots",
  borcego: "Apparel & Accessories > Shoes > Boots",
  texana: "Apparel & Accessories > Shoes > Boots",
  botin: "Apparel & Accessories > Shoes > Boots",
  pantufla: "Apparel & Accessories > Shoes > Slippers",
  ojota: "Apparel & Accessories > Shoes > Sandals",
  sandalia: "Apparel & Accessories > Shoes > Sandals",
  chancleta: "Apparel & Accessories > Shoes > Sandals",
  hawaiana: "Apparel & Accessories > Shoes > Sandals",
  zapatilla: "Apparel & Accessories > Shoes > Athletic Shoes",
  deportivo: "Apparel & Accessories > Shoes > Athletic Shoes",
  running: "Apparel & Accessories > Shoes > Athletic Shoes",
  mocasin: "Apparel & Accessories > Shoes > Loafers & Slip-Ons",
  stiletto: "Apparel & Accessories > Shoes > Heels",
  taco: "Apparel & Accessories > Shoes > Heels",
  tacones: "Apparel & Accessories > Shoes > Heels",
  bailarina: "Apparel & Accessories > Shoes > Flats",
  maryjane: "Apparel & Accessories > Shoes > Flats",
  alpargata: "Apparel & Accessories > Shoes > Espadrilles",
  chatita: "Apparel & Accessories > Shoes > Flats",
  campera: "Apparel & Accessories > Clothing > Outerwear",
  abrigo: "Apparel & Accessories > Clothing > Outerwear",
  parka: "Apparel & Accessories > Clothing > Outerwear",
  sobretodo: "Apparel & Accessories > Clothing > Outerwear",
  buzo: "Apparel & Accessories > Clothing > Activewear",
  hoodie: "Apparel & Accessories > Clothing > Activewear",
  sweater: "Apparel & Accessories > Clothing > Activewear",
  pullover: "Apparel & Accessories > Clothing > Activewear",
  remera: "Apparel & Accessories > Clothing > Shirts & Tops",
  musculosa: "Apparel & Accessories > Clothing > Shirts & Tops",
  top: "Apparel & Accessories > Clothing > Shirts & Tops",
  jean: "Apparel & Accessories > Clothing > Pants",
  pantalon: "Apparel & Accessories > Clothing > Pants",
  calza: "Apparel & Accessories > Clothing > Pants",
  legging: "Apparel & Accessories > Clothing > Pants",
  short: "Apparel & Accessories > Clothing > Shorts",
  bermuda: "Apparel & Accessories > Clothing > Shorts",
  vestido: "Apparel & Accessories > Clothing > Dresses",
  pollera: "Apparel & Accessories > Clothing > Skirts",
  falda: "Apparel & Accessories > Clothing > Skirts",
  pijama: "Apparel & Accessories > Clothing > Sleepwear & Loungewear",
  conjunto: "Apparel & Accessories > Clothing > Jumpsuits & Rompers",
  enterito: "Apparel & Accessories > Clothing > Jumpsuits & Rompers",
  marroquineria: "Apparel & Accessories > Handbags, Wallets & Cases",
  cartera: "Apparel & Accessories > Handbags, Wallets & Cases",
  bolso: "Apparel & Accessories > Handbags, Wallets & Cases",
  mochila: "Apparel & Accessories > Handbags, Wallets & Cases",
  lenceria: "Apparel & Accessories > Clothing > Underwear & Socks",
  bombacha: "Apparel & Accessories > Clothing > Underwear & Socks",
  corpino: "Apparel & Accessories > Clothing > Underwear & Socks",
  accesorio: "Apparel & Accessories > Clothing Accessories",
  cinturon: "Apparel & Accessories > Clothing Accessories",
  gorro: "Apparel & Accessories > Clothing Accessories",
  bufanda: "Apparel & Accessories > Clothing Accessories",
  bijouterie: "Apparel & Accessories > Jewelry",
  bijou: "Apparel & Accessories > Jewelry",
  aros: "Apparel & Accessories > Jewelry",
  collar: "Apparel & Accessories > Jewelry",
};

export function mapGoogleCategory(categoryRaw: string, filtro1Raw: string): string {
  const root = normalizeRootCategoryKey(categoryRaw);
  const filtroKey = canonicalTagKey(filtro1Raw);
  if (filtroKey && FILTRO1_GOOGLE[filtroKey]) {
    return FILTRO1_GOOGLE[filtroKey];
  }
  if (root && FALLBACK_BY_ROOT[root]) {
    return FALLBACK_BY_ROOT[root];
  }
  return "Apparel & Accessories";
}
