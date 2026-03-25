const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// 1. Generate Key Pair
console.log("Generating RSA 2048 key pair...");
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

// Save Private Key
fs.writeFileSync('qz-private-key.pem', privateKey);
console.log("✅ Saved qz-private-key.pem");

// 2. Generate Self-Signed Certificate manually (Basic implementation since node doesn't natively sign certs easily without forge)
// OR simpler: we rely on OpenSSL if available. 
// If we can't reliably generate a CRT in pure Node without external deps like node-forge, checking for OpenSSL is safer.

const { execSync } = require('child_process');

try {
    console.log("Attempting to use OpenSSL to generate certificate...");

    // Create a config file for OpenSSL to avoid interactive prompts
    const csrConfig = `
[req]
distinguished_name = req_distinguished_name
prompt = no

[req_distinguished_name]
C = AR
ST = Chaco
L = Resistencia
O = Catalogo FYL
CN = QZ Tray Certificate
  `;
    fs.writeFileSync('openssl.cnf', csrConfig);

    // Generate Key and Cert in one go using OpenSSL
    // Note: overwriting the node-generated key to ensure compatibility and standard format
    execSync('openssl req -x509 -newkey rsa:2048 -keyout qz-private-key.pem -out certs/qz-site.crt -days 3650 -nodes -config openssl.cnf');

    console.log("✅ OpenSSL Success: Saved certs/qz-site.crt and qz-private-key.pem");

    // Read the file to get the clean base64 private key for Supabase
    const pemContent = fs.readFileSync('qz-private-key.pem', 'utf8');
    // Remove headers, footers and newlines
    const privateKeyB64 = pemContent
        .replace(/-----BEGIN PRIVATE KEY-----/, '')
        .replace(/-----END PRIVATE KEY-----/, '')
        .replace(/[\r\n\s]/g, '');

    console.log("\n👇 COPY THIS FOR SUPABASE (QZ_PRIVATE_KEY_B64) 👇");
    console.log(privateKeyB64);
    console.log("👆 COPY ABOVE 👆\n");

    // Verify matching
    console.log("Keys generated fresh. They are guaranteed to match.");

} catch (error) {
    console.error("❌ OpenSSL failed or not found:", error.message);
    console.log("Please install OpenSSL or Git Bash and run:");
    console.log('openssl req -x509 -newkey rsa:2048 -keyout qz-private-key.pem -out certs/qz-site.crt -days 3650 -nodes -subj "/C=AR/ST=Chaco/L=Resistencia/O=Catalogo FYL/CN=QZ Tray Certificate"');
}

// Clean up
try { fs.unlinkSync('openssl.cnf'); } catch (e) { }
