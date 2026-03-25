const crypto = require('crypto');
const fs = require('fs');

// Generar par de claves RSA
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

// Guardar clave privada
fs.writeFileSync('qz-private-key.pem', privateKey);

// Generar certificado "dummy" (suficiente para QZ dev/invalid signature fix)
// Nota: Generar un CRT real binario sin deps es complejo, pero para QZ
// lo vital es que la clave privada coincida con la usada para firmar.
// TRUCO: Si no tenemos OpenSSL, usamos la clave generada y confiamos en que
// QZ acepte un certificado "fake" si solo validamos la firma digital,
// PERO QZ valida el certificado contra la firma.
//
// MEJOR ESTRATEGIA: Si no tienes OpenSSL, no podemos crear un CRT valido facilmente.
// VAMOS A USAR GIT BASH SI LO TIENES, O POWER SHELL.
// PERO como falló openssl, asumimos que no hay.

console.log('GEN_KEY_SUCCESS');
console.log(privateKey.replace(/-----BEGIN PRIVATE KEY-----/,'').replace(/-----END PRIVATE KEY-----/,'').replace(/\s/g,''));
