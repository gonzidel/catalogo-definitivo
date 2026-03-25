// scripts/verify-cert-key-match.js
// Verifica que el certificado público y la clave privada coincidan

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const OPENSSL_PATH = 'C:\\Program Files\\Git\\usr\\bin\\openssl.exe';
const CERT_PATH = path.join(__dirname, '..', 'certs', 'qz-site.crt');
const P12_PATH = 'C:\\qz\\qz-certificate.p12';
const P12_PASSWORD = 'changeit';
const PRIVATE_KEY_PATH = path.join(__dirname, '..', 'qz-private.pem');

function checkOpenSSL() {
  if (!fs.existsSync(OPENSSL_PATH)) {
    console.error('❌ OpenSSL no encontrado en:', OPENSSL_PATH);
    console.error('   Instala Git Bash o OpenSSL para Windows');
    return false;
  }
  return true;
}

function getCertModulus() {
  try {
    const output = execSync(
      `"${OPENSSL_PATH}" x509 -in "${CERT_PATH}" -noout -modulus`,
      { encoding: 'utf-8' }
    );
    const modulus = output.trim();
    const md5 = execSync(
      `echo "${modulus}" | "${OPENSSL_PATH}" md5`,
      { encoding: 'utf-8' }
    ).trim();
    return { modulus, md5 };
  } catch (error) {
    console.error('❌ Error obteniendo modulus del certificado:', error.message);
    return null;
  }
}

function extractPrivateKey() {
  if (!fs.existsSync(PRIVATE_KEY_PATH)) {
    console.log('📦 Extrayendo clave privada desde .p12...');
    try {
      execSync(
        `"${OPENSSL_PATH}" pkcs12 -in "${P12_PATH}" -nocerts -nodes -out "${PRIVATE_KEY_PATH}" -passin pass:${P12_PASSWORD}`,
        { stdio: 'inherit' }
      );
      console.log('✅ Clave privada extraída a:', PRIVATE_KEY_PATH);
    } catch (error) {
      console.error('❌ Error extrayendo clave privada:', error.message);
      return false;
    }
  }
  return true;
}

function getPrivateKeyModulus() {
  if (!fs.existsSync(PRIVATE_KEY_PATH)) {
    if (!extractPrivateKey()) {
      return null;
    }
  }

  try {
    const output = execSync(
      `"${OPENSSL_PATH}" pkey -in "${PRIVATE_KEY_PATH}" -noout -modulus`,
      { encoding: 'utf-8' }
    );
    const modulus = output.trim();
    const md5 = execSync(
      `echo "${modulus}" | "${OPENSSL_PATH}" md5`,
      { encoding: 'utf-8' }
    ).trim();
    return { modulus, md5 };
  } catch (error) {
    console.error('❌ Error obteniendo modulus de la clave privada:', error.message);
    return null;
  }
}

function generateBase64ForSupabase() {
  if (!fs.existsSync(PRIVATE_KEY_PATH)) {
    console.error('❌ Clave privada no encontrada:', PRIVATE_KEY_PATH);
    return null;
  }

  try {
    const pemContent = fs.readFileSync(PRIVATE_KEY_PATH, 'utf-8');
    // Convertir a base64 (UTF-8 encoding)
    const base64 = Buffer.from(pemContent, 'utf-8').toString('base64');
    return base64;
  } catch (error) {
    console.error('❌ Error generando base64:', error.message);
    return null;
  }
}

// Ejecutar verificación
console.log('🔍 Verificando coincidencia certificado/clave privada...\n');

if (!checkOpenSSL()) {
  process.exit(1);
}

if (!fs.existsSync(CERT_PATH)) {
  console.error('❌ Certificado no encontrado:', CERT_PATH);
  process.exit(1);
}

if (!fs.existsSync(P12_PATH)) {
  console.error('❌ Archivo .p12 no encontrado:', P12_PATH);
  process.exit(1);
}

const certModulus = getCertModulus();
if (!certModulus) {
  process.exit(1);
}

console.log('1️⃣  Modulo del certificado (MD5):', certModulus.md5);

const keyModulus = getPrivateKeyModulus();
if (!keyModulus) {
  process.exit(1);
}

console.log('2️⃣  Modulo de la clave privada (MD5):', keyModulus.md5);
console.log('');

if (certModulus.md5 === keyModulus.md5) {
  console.log('✅ COINCIDEN - El certificado y la clave privada son pareja');
  console.log('');
  console.log('📋 Próximos pasos:');
  console.log('   1. Verificar que QZ_PRIVATE_KEY_B64 en Supabase sea de esta clave');
  console.log('   2. Si no, actualizar con el base64 generado abajo');
} else {
  console.log('❌ NO COINCIDEN - El certificado y la clave privada NO son pareja');
  console.log('');
  console.log('⚠️  PROBLEMA: La firma será inválida porque usas una clave privada diferente');
  console.log('');
  console.log('🔧 SOLUCIÓN:');
  console.log('   1. La clave privada extraída es del mismo .p12 que el certificado');
  console.log('   2. Actualiza QZ_PRIVATE_KEY_B64 en Supabase con el base64 generado abajo');
  console.log('   3. Redeploy la Edge Function');
}

console.log('');
console.log('📦 Base64 de la clave privada para Supabase:');
console.log('   (Copia este valor y pégalo en QZ_PRIVATE_KEY_B64)');
console.log('');

const base64 = generateBase64ForSupabase();
if (base64) {
  console.log(base64);
  console.log('');
  console.log('💡 Comando para actualizar en Supabase:');
  console.log(`   supabase secrets set QZ_PRIVATE_KEY_B64="${base64}" --project-ref dtfznewwvsadkorxwzft`);
} else {
  console.log('❌ No se pudo generar el base64');
}

