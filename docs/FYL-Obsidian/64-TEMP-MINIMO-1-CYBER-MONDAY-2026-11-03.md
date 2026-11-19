# Temporal: mínimo 1 + Cyber Monday (NJ)

**Clasificación: EN EVALUACIÓN / temporal**  
Fecha: 2026-11-03  
Rama: `feat/minimo-temporal-1`  
Punto de control: `nj/lib/config/temp-order-min.ts`

## Qué cambió

- El mínimo para cerrar pedido en NJ baja de 4 a **1 producto** (`TEMP_MIN_ONE_ENABLED`).
- Se oculta el bloque UI "Mínimo del pedido" en `ActiveOrderTab`.
- El carrusel de recomendados queda **siempre visible** con pedido activo y unidades > 0 (`TEMP_RECOMMENDED_ALWAYS_ON`).
- Textos públicos (Cómo comprar, FAQ, SEO) hablan de "desde 1 producto" (`TEMP_PUBLIC_COPY_MIN_ONE`).
- El banner del inicio pasa a promo **Cyber Monday** (`TEMP_CYBER_BANNER`) con ícono `icono-cybermonday.*` (sin texto incrustado).

## Qué NO cambió

- La regla **CANÓNICA** del negocio sigue siendo **4 productos surtidos** (`docs/02_MODELO_NEGOCIO.md`).
- No hay migración SQL ni cambio de RPCs: el mínimo ya se controlaba en frontend.
- Avisos WhatsApp / notificaciones (`pedido_plazo_faltan_productos`, `MIN_MISSING`, `missing_to_min`) **siguen usando 4**. Riesgo: pedidos de 1–3 unidades pueden recibir un aviso "te faltan productos para la compra mínima de 4".
- Landing vanilla / `main` congelada: no se tocó.

## Cómo revertir

1. En `nj/lib/config/temp-order-min.ts`, poner los cuatro flags en `false`.
2. Redeploy NJ (preview o prod controlado).
3. Alternativa: `git revert` de los commits de la rama / reasignar alias Vercel al deploy anterior.

Con flags en `false` vuelve: mínimo 4, recomendados condicionales, textos "4 productos", banner COMPRA MÍNIMA + `icono-carrito-x4`.

## Verificación sugerida

- Pedido con 1 unidad: se puede cerrar; sin bloque de mínimo; recomendados visibles.
- Banner inicio: etiqueta CYBER MONDAY + copy acordado.
- Flags off: comportamiento idéntico al original.

## Impacto operativo esperado

Más pedidos chicos (1 unidad) para armar/despachar mientras dure la promo.
