// scripts/generate-private-key-b64.js
// Genera el base64 de la clave privada para QZ_PRIVATE_KEY_B64 en Supabase

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PEM_FILE = path.join(__dirname, '..', 'qz-private-from-p12.pem');

if (!fs.existsSync(PEM_FILE)) {
  console.error('❌ Archivo no encontrado:', PEM_FILE);
  console.error('   Primero extrae la clave privada desde el .p12:');
  console.error('   openssl pkcs12 -in C:\\qz\\qz-certificate.p12 -nocerts -nodes -out qz-private-from-p12.pem -passin pass:changeit');
  process.exit(1);
}

try {
  const pem = fs.readFileSync(PEM_FILE, 'utf8');
  const b64 = Buffer.from(pem, 'utf8').toString('base64');
  
  console.log('✅ Base64 generado correctamente');
  console.log('');
  console.log('📋 Copia este valor y pégalo en Supabase Secrets como QZ_PRIVATE_KEY_B64:');
  console.log('');
  console.log(b64);
  console.log('');
  console.log('📝 Pasos siguientes:');
  console.log('   1. Ir a: https://supabase.com/dashboard/project/dtfznewwvsadkorxwzft/settings/functions');
  console.log('   2. Buscar o crear QZ_PRIVATE_KEY_B64');
  console.log('   3. Pegar el base64 de arriba');
  console.log('   4. Guardar');
  console.log('   5. Redeployar: supabase functions deploy qz-sign');
} catch (error) {
  console.error('❌ Error generando base64:', error.message);
  process.exit(1);
}

