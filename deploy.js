#!/usr/bin/env node

// Script de despliegue automatizado para Firebase Hosting
// Este script valida las variables de entorno, genera config.local.js y despliega

import { execSync } from "child_process";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log("🚀 Iniciando despliegue del Catálogo FYL a Firebase Hosting\n");

// Verificar variables de entorno
const url = process.env.SUPABASE_URL;
const anon = process.env.SUPABASE_ANON_KEY;

if (!url || !anon) {
  console.error("❌ ERROR: Variables de entorno no configuradas\n");
  console.error("Configura las siguientes variables antes de desplegar:");
  console.error("  - SUPABASE_URL");
  console.error("  - SUPABASE_ANON_KEY\n");
  console.error("Ejemplos:");
  console.error("  PowerShell: $env:SUPABASE_URL=\"https://xxxxx.supabase.co\"");
  console.error("  CMD:        set SUPABASE_URL=https://xxxxx.supabase.co");
  console.error("  Linux/Mac:  export SUPABASE_URL=\"https://xxxxx.supabase.co\"\n");
  process.exit(1);
}

// Paso 1: Generar config.local.js
console.log("📝 Paso 1: Generando configuración...");
try {
  const generateScript = path.join(__dirname, "scripts", "generate-config.mjs");
  // Usar node con la ruta del script para compatibilidad multiplataforma
  execSync(`node "${generateScript}"`, { stdio: "inherit", cwd: __dirname, shell: true });
  console.log("✅ Configuración generada correctamente\n");
} catch (error) {
  console.error("❌ ERROR: No se pudo generar la configuración");
  console.error(error.message);
  process.exit(1);
}

// Paso 1b: Empaquetar @supabase/supabase-js (mismo origen; evita fallos en Safari iOS con CDNs)
console.log("📦 Paso 1b: Empaquetando cliente Supabase para hosting estático...");
try {
  execSync("npm run bundle:supabase", { stdio: "inherit", cwd: __dirname, shell: true });
  console.log("✅ Bundle Supabase listo\n");
} catch (error) {
  console.error("❌ ERROR: No se pudo generar scripts/vendor/supabase-js.bundle.js");
  console.error(error.message);
  process.exit(1);
}

// Paso 2: Verificar que Firebase CLI está instalado
console.log("🔍 Paso 2: Verificando Firebase CLI...");
try {
  execSync("firebase --version", { stdio: "pipe", shell: true });
  console.log("✅ Firebase CLI detectado\n");
} catch (error) {
  console.error("❌ ERROR: Firebase CLI no está instalado");
  console.error("\nInstala Firebase CLI:");
  console.error("  npm install -g firebase-tools");
  console.error("\nLuego inicia sesión:");
  console.error("  firebase login\n");
  process.exit(1);
}

// Paso 3: Verificar que config.local.js existe antes del deploy
console.log("🔍 Paso 3: Verificando que config.local.js se generó correctamente...");
try {
  const configPath = path.join(__dirname, "scripts", "config.local.js");
  if (!fs.existsSync(configPath)) {
    console.error("❌ ERROR: config.local.js no existe después de generarlo");
    process.exit(1);
  }
  const configContent = fs.readFileSync(configPath, "utf8");
  if (!configContent.includes("SUPABASE_ANON_KEY") || !configContent.includes('"eyJ')) {
    console.error("❌ ERROR: config.local.js no contiene una clave válida");
    process.exit(1);
  }
  console.log("✅ config.local.js verificado correctamente\n");
} catch (error) {
  console.error("❌ ERROR: No se pudo verificar config.local.js");
  console.error(error.message);
  process.exit(1);
}

// Paso 4: Desplegar a Firebase Hosting
console.log("🌐 Paso 4: Desplegando a Firebase Hosting...");
try {
  execSync("firebase deploy --only hosting", { stdio: "inherit", cwd: __dirname, shell: true });
  console.log("\n✅ Despliegue completado exitosamente!");
  console.log("\n📌 Tu catálogo está disponible en:");
  console.log("   https://catalogo-fyl-test.web.app");
  console.log("   https://catalogo-fyl-test.firebaseapp.com");
  console.log("\n💡 Verifica que config.local.js esté accesible en:");
  console.log("   https://catalogo-fyl-test.web.app/scripts/config.local.js");
  console.log("\n💡 Puedes configurar un dominio personalizado desde Firebase Console");
} catch (error) {
  console.error("\n❌ ERROR: El despliegue falló");
  console.error("Verifica que:");
  console.error("  1. Estás autenticado: firebase login");
  console.error("  2. El proyecto está configurado: firebase use catalogo-fyl-test");
  console.error("  3. Tienes permisos para desplegar en este proyecto");
  process.exit(1);
}

