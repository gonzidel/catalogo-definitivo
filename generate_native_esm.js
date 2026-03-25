import crypto from 'crypto';
import fs from 'fs';

// 1. Generar par de claves RSA 2048
// Esto reemplaza "openssl genrsa" y asegura un formato compatible
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: {
        type: 'spki',
        format: 'pem' // Devuelve -----BEGIN PUBLIC KEY-----
    },
    privateKeyEncoding: {
        type: 'pkcs8',
        format: 'pem' // Devuelve -----BEGIN PRIVATE KEY-----
    }
});

// 2. Guardar clave PRIVADA (usada por Supabase para firmar)
fs.writeFileSync('qz-private-key.pem', privateKey);

// 3. Guardar clave PÚBLICA (esta parte es el "dummy CRT")
// QZ Tray necesita leer un archivo que parezca un certificado X.509 (.crt).
// Sin OpenSSL, no podemos firmar un CRT real con metadatos (CN=...).
// PERO, podemos intentar engañar a QZ (o simplemente usar la public key si QZ lo soporta)
// Sin embargo, lo CORRECTO y DEFINITIVO es generar un CSR y autofirmarlo,
// lo cual es muy difícil en JS puro sin librerías externas (forge/node-forge).

// ESTRATEGIA DE EMERGENCIA:
// Vamos a imprimir la CLAVE PRIVADA LIMPIA en consola para que el usuario la suba a Supabase.
// Y vamos a advertir que SIN OPENSSL no podemos arreglar el lado del cliente (qz-site.crt)
// a menos que el usuario tenga Git Bash o instale OpenSSL.
// Sin embargo, el usuario mostró que tiene MINGW64 (Git Bash).

// Vamos a intentar detectar si estamos en un entorno que sí puede ejecutar algo útil? No.
// Vamos a imprimir la clave para Supabase primero.

const privateKeyClean = privateKey
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/[\r\n\s]/g, '');

console.log("--- CLAVE PRIVADA PARA SUPABASE (QZ_PRIVATE_KEY_B64) ---");
console.log(privateKeyClean);
console.log("--------------------------------------------------------");

console.log("⚠️ AVISO CRÍTICO: Se generó 'qz-private-key.pem'.");
console.log("❌ NO SE PUDO GENERAR 'certs/qz-site.crt' VÁLIDO porque no tienes OpenSSL en el PATH de Windows.");
console.log("👉 Si usas Git Bash (MINGW64), ejecuta este comando AHI MISMO para generar el certificado:");
console.log('openssl req -new -x509 -key qz-private-key.pem -out certs/qz-site.crt -days 3650 -subj "//CN=QZ Tray Certificate"');
