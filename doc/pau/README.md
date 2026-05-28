# PAU — Panel de Atención Unificado

**Estado:** operativo en repo (2026-05).  
**Nota Obsidian (detalle completo):** `docs/FYL-Obsidian/40-PAU-PANEL-ATENCION-UNIFICADO.md`

## Qué es

Interfaz **mobile-first** en admin para atender pedidos por WhatsApp: buscar clienta, escanear QR o elegir productos manualmente, agregar al pedido y cerrar — sin cargar el módulo pesado `orders.html`.

| Entrada | Ruta |
|---------|------|
| Admin dashboard | `admin/index.html` → tarjeta **PAU** (`data-module="orders"`) |
| URL directa | `admin/pau.html` |
| Deep link teléfono | `admin/pau.html?text=…` o `?phone=…` (Web Share / wrapper Android) |

## Archivos

| Archivo | Rol |
|---------|-----|
| `admin/pau.html` | Shell UI: landing, confirmación teléfono, compose, diálogos |
| `admin/pau.js` | Estado, eventos, flujos UX |
| `admin/pau.css` | Estilos mobile-first (max ~480px) |
| `admin/orders-ops.js` | Operaciones pedido **sin DOM** (compartido con PAU) |
| `admin/orders-domain.js` | Búsqueda/ranking clientas, split depósitos |
| `admin/order-creator.js` | `createNewOrder`, `addItemsToExistingOrder`, QR |
| `admin/customer-create-shared.js` | Alta clienta (`rpc_create_admin_customer`) |

**No importa** `admin/orders.js` (evita duplicar UI de Pedidos).

## Permisos

| Permiso | Efecto |
|---------|--------|
| `orders` **view** | Entrada a PAU (sin view → redirect index) |
| `orders` **edit** | Obligatorio para usar PAU (sin edit → redirect) |
| `customers` **edit** | Muestra botón **Crear clienta** |

## Flujo resumido

```
Landing (buscar clienta)
  → [reloj] últimas 5 clientas (localStorage)
  → [resultado / historial / crear] selectCustomer
Compose (escanear / manual → borrador)
  → Agregar al pedido → orders-ops → vuelve a Landing
  → Cerrar pedido → Contra Rem. | Pagado | Enviar al local
```

## Persistencia `localStorage`

| Clave | Uso |
|-------|-----|
| `pau_activeCustomerId` | Sesión activa (se **borra al recargar** la página) |
| `pau_activeOrderId` | Idem |
| `pau_draftItems` | Borrador JSON (idem al recargar) |
| `pau_recentCustomers` | **Últimas 5 clientas abiertas** (persiste entre recargas) |
| `pau_lastPhoneShared` | Dígitos normalizados al pegar/compartir teléfono |

Al **F5** en PAU siempre arranca en búsqueda, salvo `?text=` / `?phone=` en la URL.

## Backend (mismos contratos que Pedidos)

- Crear/reusar pedido: `createNewOrder` / `findActiveOrderForCustomer`
- Ítems: `addItemsToExistingOrder` + `enrichDraftItemsWithStock` (split general/venta)
- Cerrar: `rpc_close_order` vía `closeOrder(orderId, paymentMethod)`
- Local: `rpc_send_order_to_local` vía `sendOrderToLocal(orderId)`

Métodos de pago PAU: `"Contra Reembolso"` y `"Pagado"` (`ORDER_PAYMENT_METHOD` en `orders-ops.js`).

## Verificación rápida

```bash
node --check admin/pau.js
node --check admin/orders-ops.js
```

Smoke manual: buscar clienta → escanear 1 QR → Agregar al pedido → debe volver al buscador; reloj debe listar la clienta.

## Documentación extendida

Ver `docs/FYL-Obsidian/40-PAU-PANEL-ATENCION-UNIFICADO.md` (modos UI, manual picker, chips, errores stock, troubleshooting).
