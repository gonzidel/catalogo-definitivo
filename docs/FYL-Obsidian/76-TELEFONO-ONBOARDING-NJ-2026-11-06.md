# Teléfono en alta y perfil de cliente (NJ) — 2026-11-06

Rama: `fix/telefono-onboarding` (desde `origin/nj-main`). Alcance: **solo NJ** (`nj/`). El catálogo legacy (`scripts/profile-onboarding-modal.js`, `client/profile.js`, `client/complete-profile.js`) **no se tocó**.

## Problema (TÉCNICA VERIFICADA)

- Validación `^\d{8,10}$`: aceptaba 8 y 9 dígitos, que son números incompletos (un celular nacional argentino siempre tiene 10: característica + número).
- `substring(0, 10)` silencioso al escribir/pegar: `+54 9 362 4720762` quedaba `5493624720`; con el 15 (`362 15 4720762`) se guardaba `3621547207`. Sin aviso.
- El prefijo `+54 9` se mostraba al cliente y la ayuda decía "sin el 9 inicial".
- El formateador agrupaba mal (`+54 9 3624 72-0762`).
- `ProfileTab` guardaba texto libre sin validar.

Datos de producción medidos el 2026-11-06 (`customers`, solo conteos): 1.074 teléfonos `+54 9` de 13 dígitos; 19 con un primer dígito imposible (17 empiezan con `54`); 7 con prefijo y largo anómalo; ~100 sin prefijo con menos de 10 dígitos (importados). **No se corrigieron** (decisión del dueño).

## Cambio

- `nj/lib/utils/phone-ar.ts` (+ `phone-ar.test.ts`): única fuente de normalización/validación.
  - Quita 0, 00, 54, 9 y el 15 posterior a la característica; **no trunca**.
  - Válido = exactamente 10 dígitos, característica `11` o que empiece con 2 o 3, no todos iguales.
  - Mensajes con cuántos dígitos faltan o sobran; nunca mencionan 54 ni 9.
- `ProfileOnboardingModal.tsx`: sin prefijo visible, validación al salir del campo y al guardar, guarda `+54 9 AAA NNN-NNNN`.
- `ProfileTab.tsx`: muestra/edita el número sin `+54 9`; valida solo si el cliente cambió el teléfono (no bloquea editar otros datos por un teléfono viejo).

- `WhatsAppInvalidModal.tsx` (aviso "número inválido" marcado desde el tablero admin, migración 382): usa la misma lógica, sin prefijo visible, y rechaza guardar el mismo número (el trigger solo limpia `whatsapp_invalid_*` si `phone` cambia; antes el modal re-guardaba el mismo número y el aviso reaparecía). Si el número cargado es inválido, el campo arranca vacío. Se eliminó `nj/lib/phone/ar-mobile.ts` (y su test), que duplicaba la lógica vieja y quedó sin usos.
- Caso real (2026-11-07): una clienta guardó `+54 9 5436 44-3211` (el 54 de país quedó como característica). Con el modal anterior se precargaba `543 644-3211` y se podía re-guardar idéntico.
- El aviso es un cartel dentro de la web (solo si la clienta entra logueada y no lo pospone 12 h en ese dispositivo); no se envía por WhatsApp ni mail.

Formato guardado sin cambios de contrato: `customers.phone` sigue siendo `+54 9 …`. Consumidores existentes (`toArgentinaWhatsAppNationalDigits`, `phones_match_by_suffix`) leen solo dígitos.

## Causa raíz confirmada (2026-11-16)

El autocompletado del navegador (`autocomplete="tel"`) rellena el número internacional (`+54 9 362 4720762`, `+54 362 4720762`, `0362 4720762`) y el código viejo lo cortaba a 10 dígitos, perdiendo los finales. Simulación sobre el código viejo: todos los formatos de autocompletado se guardaban mal; solo el nacional de 10 dígitos quedaba bien. Datos: 30 de 1.165 cuentas web (2,6 %) con característica imposible, 27 empiezan con `54`, 6 con pedido abierto. Referencias: libphonenumber (no limitar el largo, interpretar y validar), Mozilla bug 1413118 (autocompletado rellena internacional aunque el campo espere nacional).

Regla que sale de esto: **ningún límite por largo sobre lo que escribe o pega el cliente**. Una primera versión de `sanitizePhoneInput` cortaba a 24 caracteres y un autocompletado con espacios de más perdía los últimos dígitos (test `la limpieza del campo nunca recorta…`). Si sobran dígitos se muestra el error, no se recorta.

## Verificación

- `npx tsx --test lib/utils/phone-ar.test.ts lib/orders/domain-whatsapp.test.ts`: 19/19.
- `npx tsc --noEmit`: 0 errores.
- Suite completa de `nj`: 261/265; fallan 4 selftests de `lib/reconciliation` que no tocan teléfono.

## Deuda / riesgo

- Sin validación en servidor: `rpc_upsert_customer` y `rpc_link_*` siguen aceptando cualquier texto (cambio de RPC = SQL de producción, requiere aprobación explícita). Un cliente con la UI vieja en caché aún puede guardar un número incompleto.
- La vinculación admin↔cuenta usa los últimos 7 dígitos (`phones_match_by_suffix`); con la validación en UI baja el riesgo, no se elimina.
- Agrupación cosmética: para característica de 4 dígitos se muestra con 3 (`2966 123456` → `296 612-3456`); los dígitos son correctos.
- Clientas con teléfono ya guardado mal: pendiente de limpieza, no incluida.
- Legacy (`index.html`) conserva el comportamiento anterior.
