import assert from "node:assert/strict";
import { test } from "node:test";
import { rewriteClosedOrderMessageTotal } from "./closed-message-total";

const COD = `Hola 👋 Tu pedido fue finalizado correctamente.

🚚 El transporte asignado para tu envío es *SEDE*.

El total de tu pedido es de *$83,300*. Este monto deberás abonarlo *en efectivo al transportista al momento de recibir el paquete*, junto con el costo del envío.

Cualquier duda que tengas sobre tu envío o el pago, podés escribirnos 😊`;

const CORREO = `Hola 👋 Tu pedido fue finalizado correctamente.

📦 El envío se realizará por *Correo Argentino*.

Para realizar el despacho, deberás abonar previamente el valor del pedido y el costo del envío.

Productos: *$87,500*
Envío: *$26,900*
*Total a transferir: $114,400*

Alias: calzados.fyl.2025
CBU/CVU: 0170218940000003684953`;

test("contra reembolso y transferencia reemplazan el total y dejan el resto", () => {
  const next = rewriteClosedOrderMessageTotal(COD, 79300);
  assert.match(next, /El total de tu pedido es de \*\$79,300\*/);
  assert.doesNotMatch(next, /\$83,300/);
  assert.match(next, /transporte asignado para tu envío es \*SEDE\*/);
});

test("correo recalcula productos y total a transferir, y conserva el envío", () => {
  const next = rewriteClosedOrderMessageTotal(CORREO, 83500);
  assert.match(next, /Productos: \*\$83,500\*/);
  assert.match(next, /Envío: \*\$26,900\*/);
  assert.match(next, /\*Total a transferir: \$110,400\*/);
  assert.match(next, /Alias: calzados\.fyl\.2025/);
  assert.match(next, /CBU\/CVU: 0170218940000003684953/);
});

test("un aviso sin monto de pedido no se altera", () => {
  const plain = "Hola, tu pedido está listo para retirar.";
  assert.equal(rewriteClosedOrderMessageTotal(plain, 1000), plain);
});
