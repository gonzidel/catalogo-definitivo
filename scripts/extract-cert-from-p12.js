// scripts/extract-cert-from-p12.js
// Script para extraer el certificado público .crt desde un archivo .p12
// Uso: node scripts/extract-cert-from-p12.js

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const P12_PATH = 'C:\\qz\\qz-certificate.p12';
const P12_PASSWORD = 'changeit';
const OUTPUT_CRT = path.join(__dirname, '..', 'certs', 'qz-site.crt');

// Verificar que OpenSSL esté disponible
function checkOpenSSL() {
  try {
    execSync('openssl version', { stdio: 'ignore' });
    return true;
  } catch (err) {
    return false;
  }
}

// Extraer certificado desde .p12
function extractCertificate() {
  console.log('🔍 Verificando OpenSSL...');
  
  if (!checkOpenSSL()) {
    console.error('❌ OpenSSL no está disponible en el PATH');
    console.error('   Instala OpenSSL o usa Git Bash (incluye OpenSSL)');
    console.error('   Ruta Git Bash: C:\\Program Files\\Git\\usr\\bin\\openssl.exe');
    process.exit(1);
  }
  
  if (!fs.existsSync(P12_PATH)) {
    console.error(`❌ Archivo .p12 no encontrado: ${P12_PATH}`);
    process.exit(1);
  }
  
  console.log('📦 Extrayendo certificado desde .p12...');
  
  try {
    // Crear carpeta certs si no existe
    const certsDir = path.dirname(OUTPUT_CRT);
    if (!fs.existsSync(certsDir)) {
      fs.mkdirSync(certsDir, { recursive: true });
      console.log(`✅ Carpeta creada: ${certsDir}`);
    }
    
    // Extraer certificado usando OpenSSL
    const command = `openssl pkcs12 -in "${P12_PATH}" -nokeys -out "${OUTPUT_CRT}" -passin pass:${P12_PASSWORD}`;
    
    execSync(command, { stdio: 'inherit' });
    
    if (fs.existsSync(OUTPUT_CRT)) {
      const stats = fs.statSync(OUTPUT_CRT);
      console.log(`✅ Certificado extraído exitosamente`);
      console.log(`   Ubicación: ${OUTPUT_CRT}`);
      console.log(`   Tamaño: ${stats.size} bytes`);
      console.log('');
      console.log('📋 Próximos pasos:');
      console.log('   1. Asegúrate de que el servidor web sirva el archivo desde /certs/qz-site.crt');
      console.log('   2. Verifica que el archivo sea accesible vía HTTP');
      console.log('   3. Reinicia QZ Tray y prueba la conexión');
    } else {
      console.error('❌ Error: El certificado no se generó');
      process.exit(1);
    }
  } catch (error) {
    console.error('❌ Error extrayendo certificado:', error.message);
    process.exit(1);
  }
}

// Ejecutar
extractCertificate();



