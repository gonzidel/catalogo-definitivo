# Guía de Pruebas para Integración QZ Tray

Esta guía detalla los pasos para verificar la corrección completa de la integración de QZ Tray tras los cambios recientes.

## 1. Prerequisitos

*   **QZ Tray**: Asegúrese de que la aplicación de escritorio QZ Tray (versión 2.2.5 recomendada) esté ejecutándose.
*   **Servidor Local**: Su aplicación web debe estar corriendo (ej. `http://localhost:5500`).
*   **Supabase**: El servicio de Supabase y Edge Functions deben estar operativos.

## 2. Limpieza de Entorno

Antes de comenzar, es recomendable limpiar el estado anterior:

1.  Cierre la pestañas de la aplicación.
2.  Reinicie QZ Tray (Exit y abrir de nuevo).
3.  Borre la caché del navegador para su sitio local (`Ctrl + Shift + R` o `Cmd + Shift + R`).

## 3. Verificación Página por Página

### A. Página de Etiquetas (admin/labels.html)
1.  Navegue a `/admin/labels.html`.
2.  Abra la consola del desarrollador (`F12` -> Console).
3.  Verifique que aparezca el mensaje: `✅ QZ Security Configured`.
4.  Verifique que aparezca: `✅ QZ Tray conectado`.
5.  **Prueba de Impresión**: Intente imprimir una etiqueta ZPL.
    *   Debe aparecer el diálogo de QZ Tray pidiendo permiso **SOLO SI** no ha seleccionado "Remember this decision" antes.
    *   **IMPORTANTE**: Si aparece el diálogo, verifique que **NO** diga "Anonymous Request" ni "Invalid Certificate". Debe mostrarse como un sitio confiable (o al menos con identidad válida).
    *   Si selecciona "Remember this decision" y "Allow", las futuras impresiones no deben mostrar popup.

### B. Ventas al Público (admin/public-sales.html y cajas)
1.  Navegue a `/admin/public-sales.html` (y `-caja2.html`, `-caja3.html`).
2.  Observe la consola. Debe ver los mismos mensajes de éxito (`QZ Security Configured`, `QZ Tray conectado`).
3.  Cargue una venta de prueba.
4.  Haga clic en **Imprimir Ticket**.
5.  El ticket debe imprimirse sin errores en la consola y sin popups de advertencia de seguridad (si ya fue autorizado).

### C. Pedidos Cerrados y Enviados (admin/closed-orders.html / sent-orders.html)
1.  Navegue a estas páginas.
2.  Intente utilizar la función de impresión (ej. "Imprimir Listas" o "Imprimir Rótulos" en `sent-orders`).
3.  Verifique que la conexión se establece correctamente y la impresión funciona.

## 4. Solución de Problemas Comunes

*   **Error "sendData is not a function"**:
    *   Causa: Versión antigua de librería QZ Tray.
    *   Solución: Ya aplicada. Verifique que el `<script>` src sea `cdn.jsdelivr.net/npm/qz-tray@2.2.5/qz-tray.js`.

*   **Popup "Anonymous Request" / "Invalid Certificate"**:
    *   Causa: El certificado enviado contiene metadatos extra ("Bag Attributes").
    *   Solución: Ya aplicada. El código ahora sanitiza el certificado extrayendo solo el bloque `BEGIN/END CERTIFICATE`.

*   **Error 401 Unauthorized en consola para `qz-sign`**:
    *   Causa: Token incorrecto o falta de secreto compartida.
    *   Solución: Ya aplicada. Se usa el header `x-qz-secret` con un fallback hardcoded si `config.local.js` falla.
