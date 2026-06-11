import type { CuratedVariantCardEnriched } from "@/types/banners";

/** Cantidad par en carrusel; el último impar queda solo en Ver todo. */
export function getCarouselCards(
  cards: CuratedVariantCardEnriched[]
): CuratedVariantCardEnriched[] {
  if (cards.length <= 1) return [];
  if (cards.length % 2 === 1) return cards.slice(0, -1);
  return cards;
}

/** Pares apilados verticalmente (arriba / abajo), sin celdas vacías. */
export function toColumnPairs(
  cards: CuratedVariantCardEnriched[]
): [CuratedVariantCardEnriched, CuratedVariantCardEnriched][] {
  const visible = getCarouselCards(cards);
  const pairs: [CuratedVariantCardEnriched, CuratedVariantCardEnriched][] = [];
  for (let i = 0; i < visible.length; i += 2) {
    pairs.push([visible[i], visible[i + 1]]);
  }
  return pairs;
}

/** Cada página horizontal muestra hasta 2 columnas (= 4 productos en 2×2). */
export function chunkPairPages(
  pairs: [CuratedVariantCardEnriched, CuratedVariantCardEnriched][],
  pairsPerPage = 2
): [CuratedVariantCardEnriched, CuratedVariantCardEnriched][][] {
  const pages: [CuratedVariantCardEnriched, CuratedVariantCardEnriched][][] = [];
  for (let i = 0; i < pairs.length; i += pairsPerPage) {
    pages.push(pairs.slice(i, i + pairsPerPage));
  }
  return pages;
}
