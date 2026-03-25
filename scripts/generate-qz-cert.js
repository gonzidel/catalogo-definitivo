// scripts/generate-qz-cert.js
// Script para generar certificado y llave privada para QZ Tray
// Usa Node.js crypto nativo (no requiere OpenSSL)

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log('🔐 Generando certificado y llave privada para QZ Tray...\n');

// 1. Generar llave privada RSA 2048 bits
console.log('1. Generando llave privada RSA 2048 bits...');
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: {
    type: 'spki',
    format: 'pem'
  },
  privateKeyEncoding: {
    type: 'pkcs8',
    format: 'pem'
  }
});

// Guardar llave privada en formato PEM (PKCS#8)
const privateKeyPemPath = path.join(__dirname, '..', 'qz-private-key.pem');
fs.writeFileSync(privateKeyPemPath, privateKey);
console.log('✅ Llave privada guardada en:', privateKeyPemPath);

// 2. Convertir PEM a DER (binario)
console.log('\n2. Convirtiendo PKCS#8 PEM a DER...');
const privateKeyDer = crypto.createPrivateKey(privateKey).export({
  type: 'pkcs8',
  format: 'der'
});

const privateKeyDerPath = path.join(__dirname, '..', 'qz-private.pk8.der');
fs.writeFileSync(privateKeyDerPath, privateKeyDer);
console.log('✅ Llave privada DER guardada en:', privateKeyDerPath);

// 3. Generar certificado autofirmado (X.509) usando OpenSSL
console.log('\n3. Generando certificado autofirmado (X.509)...');
const { execSync } = await import('child_process');
const certPath = path.join(__dirname, '..', 'qz-certificate.crt');
try {
  // Generar certificado usando OpenSSL
  execSync(
    `openssl req -new -x509 -key "${privateKeyPemPath}" -out "${certPath}" -days 365 -subj "/CN=QZ Tray Certificate/O=Catalogo FYL/C=AR"`,
    { stdio: 'inherit' }
  );
  console.log('✅ Certificado guardado en:', certPath);
} catch (error) {
  console.log('⚠️  No se pudo generar certificado automáticamente (OpenSSL no encontrado)');
  console.log('   Ejecuta manualmente:');
  console.log(`   openssl req -new -x509 -key "${privateKeyPemPath}" -out "${certPath}" -days 365 -subj "/CN=QZ Tray Certificate/O=Catalogo FYL/C=AR"`);
}

// 4. Convertir DER a base64
console.log('\n4. Convirtiendo DER a base64...');
const privateKeyDerB64 = privateKeyDer.toString('base64');
const privateKeyDerB64Path = path.join(__dirname, '..', 'qz-private.pk8.der.b64');
fs.writeFileSync(privateKeyDerB64Path, privateKeyDerB64);
console.log('✅ Base64 guardado en:', privateKeyDerB64Path);

// 5. Generar PKCS#12 (.p12) usando OpenSSL
console.log('\n5. Generando archivo PKCS#12 (.p12)...');
const p12Path = path.join(__dirname, '..', 'qz-certificate.p12');
try {
  // Usar OpenSSL para generar .p12
  execSync(
    `openssl pkcs12 -export -out "${p12Path}" -inkey "${privateKeyPemPath}" -in "${certPath}" -passout pass:changeit -name "QZ Tray Certificate"`,
    { stdio: 'inherit' }
  );
  console.log('✅ Archivo .p12 generado en:', p12Path);
} catch (error) {
  console.log('⚠️  No se pudo generar .p12 automáticamente (OpenSSL no encontrado)');
  console.log('   Ejecuta manualmente:');
  console.log(`   openssl pkcs12 -export -out "${p12Path}" -inkey "${privateKeyPemPath}" -in "${certPath}" -passout pass:changeit -name "QZ Tray Certificate"`);
}

console.log('\n✅ Certificado generado exitosamente!');
console.log('\n📋 Próximos pasos:');
console.log('1. Configurar secret en Supabase:');
console.log(`   supabase secrets set QZ_PRIVATE_KEY_B64="$(cat qz-private.pk8.der.b64)" --project-ref dtfznewwvsadkorxwzft`);
console.log('\n2. Importar qz-certificate.p12 en QZ Tray (IMPORTANTE para habilitar "Remember this decision"):');
console.log('   - Click derecho en icono QZ Tray → Advanced → Site Manager...');
console.log('   - Click "Browse..." → Seleccionar qz-certificate.p12');
console.log('   - Password: changeit');
console.log('\n3. Reiniciar QZ Tray después de importar el certificado');
console.log('\n⚠️  NOTA: Sin importar el certificado, QZ Tray NO permitirá "Remember this decision"');

