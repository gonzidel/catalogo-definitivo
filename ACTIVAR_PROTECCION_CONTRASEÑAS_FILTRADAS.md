# Activar Protección de Contraseñas Filtradas

Esta guía explica cómo activar la protección contra contraseñas que han sido filtradas en bases de datos públicas.

## 🔴 Advertencia: Leaked Password Protection Disabled

**Problema**: Supabase Auth puede verificar si las contraseñas han sido comprometidas usando HaveIBeenPwned.org, pero esta función está deshabilitada.

**Riesgo**: Los usuarios pueden usar contraseñas que han sido filtradas en brechas de seguridad, lo que aumenta el riesgo de ataques.

## ✅ Solución: Activar desde el Dashboard

Esta configuración **NO se puede activar mediante SQL**. Debe hacerse desde el Dashboard de Supabase.

### Pasos para Activar:

1. **Accede al Dashboard de Supabase**
   - Ve a [https://app.supabase.com](https://app.supabase.com)
   - Selecciona tu proyecto

2. **Navega a Email Settings**
   - En el menú lateral izquierdo, haz clic en **"Authentication"**
   - Luego haz clic en **"Settings"** (o "Configuración")
   - En el menú de configuración, busca y haz clic en **"Email"** (o desde Attack Protection → "Configure email provider")

3. **Busca "Prevent use of leaked passwords"**
   - En la página de configuración de Email, desplázate hasta encontrar:
     - **"Prevent use of leaked passwords"** ← Esta es la opción que necesitas
     - Tiene un ícono de información (i) al lado
     - Descripción: "Rejects the use of known or easy to guess passwords on sign up or password change. Powered by the HaveIBeenPwned.org Pwned Passwords API."

4. **Activa el toggle**
   - Encuentra el toggle/interruptor de **"Prevent use of leaked passwords"**
   - Actualmente está **OFF** (círculo blanco a la izquierda, switch gris)
   - Haz clic en el toggle para activarlo (debería cambiar a verde con el círculo a la derecha)

5. **Guarda los cambios**
   - Desplázate hacia abajo si es necesario
   - Los cambios se guardan automáticamente o busca un botón de guardar
   - La advertencia debería desaparecer después de activar esta opción

## 📋 Ubicación Exacta en el Dashboard

```
Supabase Dashboard
  └── Tu Proyecto
      └── Authentication (menú lateral)
          └── Settings / Configuración
              └── Email
                  └── Prevent use of leaked passwords ✅
```

**Alternativa**: También puedes acceder desde:
```
Attack Protection → Configure email provider → Prevent use of leaked passwords
```

**Nota**: No necesitas tener "Enable Email provider" activado para usar esta función. La protección de contraseñas filtradas funciona independientemente.

## 🔍 ¿Qué hace esta función?

Cuando está activada:

- **Verifica contraseñas**: Cada vez que un usuario intenta crear una cuenta o cambiar su contraseña, Supabase verifica si esa contraseña ha aparecido en alguna brecha de seguridad conocida.

- **Usa HaveIBeenPwned.org**: Esta es una base de datos pública y confiable que contiene más de 11 mil millones de contraseñas filtradas.

- **Previene uso de contraseñas débiles**: Si una contraseña ha sido filtrada, Supabase rechazará su uso y pedirá al usuario que elija una contraseña diferente.

- **Método seguro**: La verificación se hace usando el API de k-anonymity de HaveIBeenPwned, que **NO envía la contraseña completa** al servicio externo, solo un hash parcial para verificar.

## ⚙️ Configuración Adicional (Opcional)

Mientras estás en la sección de Password, también puedes configurar:

- **Minimum password length**: Longitud mínima de contraseña
- **Password strength requirements**: Requisitos de fortaleza (mayúsculas, números, símbolos, etc.)

## 🔐 Mejores Prácticas

1. **Activa esta función**: Es una protección importante sin costo adicional.

2. **Combina con otras medidas**:
   - Requisitos de fortaleza de contraseña
   - Autenticación de dos factores (2FA)
   - Límites de intentos de inicio de sesión

3. **Educa a tus usuarios**: Informa a los usuarios por qué se rechaza su contraseña si ha sido filtrada.

## 📚 Referencias

- [Supabase Password Security Documentation](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection)
- [HaveIBeenPwned - About](https://haveibeenpwned.com/About)
- [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)

## ⚠️ Nota Importante

- Esta función requiere una conexión a internet para verificar contra HaveIBeenPwned.org
- No afecta el rendimiento significativamente, ya que solo se verifica durante el registro o cambio de contraseña
- Es completamente gratuita y recomendada por Supabase

---

**Última actualización**: Guía para activar protección de contraseñas filtradas en Supabase Dashboard.

