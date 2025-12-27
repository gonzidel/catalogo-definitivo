// test-auth-console.js - Script para probar en la consola del navegador

// Ejecutar este script en la consola del navegador para diagnosticar el problema

console.log("🔧 Iniciando diagnóstico de autenticación...");

// 1. Verificar si Supabase está cargado
if (typeof window.supabase === "undefined") {
  console.error("❌ Supabase no está disponible globalmente");
} else {
  console.log("✅ Supabase disponible");
}

// 2. Verificar sesión actual
window.supabase.auth.getSession().then(({ data: { session }, error }) => {
  if (error) {
    console.error("❌ Error obteniendo sesión:", error);
  } else if (session) {
    console.log("✅ Usuario autenticado:", session.user.email);
    console.log("📊 Datos del usuario:", {
      email: session.user.email,
      avatar_url: session.user.user_metadata?.avatar_url,
      picture: session.user.user_metadata?.picture,
      full_name: session.user.user_metadata?.full_name,
    });
  } else {
    console.log("👤 No hay sesión activa");
  }
});

// 3. Verificar si el botón existe
const clienteLink = document.querySelector(".cliente-link");
if (clienteLink) {
  console.log("✅ Botón Área de Clientes encontrado");
  console.log("📋 Contenido actual:", clienteLink.innerHTML);
} else {
  console.error("❌ Botón Área de Clientes no encontrado");
}

// 4. Verificar si las funciones están disponibles
if (typeof window.updateClientAreaLink === "function") {
  console.log("✅ Función updateClientAreaLink disponible");
} else {
  console.error("❌ Función updateClientAreaLink no disponible");
}

if (typeof window.forceUpdateAuth === "function") {
  console.log("✅ Función forceUpdateAuth disponible");
} else {
  console.error("❌ Función forceUpdateAuth no disponible");
}

// 5. Intentar forzar actualización
if (typeof window.forceUpdateAuth === "function") {
  console.log("🔄 Intentando forzar actualización...");
  window.forceUpdateAuth();
} else {
  console.log("⚠️ No se puede forzar actualización, función no disponible");
}

// 6. Verificar resultado después de 2 segundos
setTimeout(() => {
  const clienteLinkAfter = document.querySelector(".cliente-link");
  if (clienteLinkAfter) {
    const hasImage = clienteLinkAfter.querySelector("img");
    const hasName = clienteLinkAfter.querySelector("span");

    if (hasImage && hasName) {
      console.log("✅ Avatar mostrado correctamente");
      console.log("🖼️ Imagen:", hasImage.src);
      console.log("👤 Nombre:", hasName.textContent);
    } else {
      console.log("⚠️ Avatar no mostrado");
      console.log("📋 Contenido actual:", clienteLinkAfter.innerHTML);
    }
  }
}, 2000);

console.log("🔧 Diagnóstico completado. Revisa los resultados arriba.");
