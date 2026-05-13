import crypto from 'crypto';
import fs from 'fs';
import { execSync } from 'child_process';

const __dirname = process.cwd();

// 1. Generate Key Pair
console.log("Generating RSA 2048 key pair...");

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
    // Ensure directory exists
    if (!fs.existsSync('certs')) {
        fs.mkdirSync('certs');
    }

    // Generate
    execSync('openssl req -x509 -newkey rsa:2048 -keyout qz-private-key.pem -out certs/qz-site.crt -days 3650 -nodes -config openssl.cnf');

    console.log("✅ OpenSSL Success: Saved certs/qz-site.crt and qz-private-key.pem");

    // Read the file to get the clean base64 private key for Supabase
    const pemContent = fs.readFileSync('qz-private-key.pem', 'utf8');
    // Remove headers, footers and newlines: clean ONLY the key part
    // OpenSSL generates -----BEGIN PRIVATE KEY-----
    const lines = pemContent.split('\n');
    const cleanLines = lines.filter(line => !line.includes('-----'));
    const privateKeyB64 = cleanLines.join('').replace(/[\r\n\s]/g, '');

    console.log("\n👇 COPY THIS FOR SUPABASE (QZ_PRIVATE_KEY_B64) 👇");
    console.log(privateKeyB64);
    console.log("👆 COPY ABOVE 👆\n");

    // Verify matching
    console.log("Keys generated fresh. They are guaranteed to match.");
    console.log("Use this command to update supabase:");
    console.log(`npx supabase secrets set QZ_PRIVATE_KEY_B64=${privateKeyB64}`);

} catch (error) {
    console.error("❌ OpenSSL failed or not found:", error.message);
}

// Clean up
try { fs.unlinkSync('openssl.cnf'); } catch (e) { }
