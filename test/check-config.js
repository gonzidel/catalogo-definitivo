const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const required = [
  "index.html",
  "scripts/config.js",
  "scripts/config.local.example.js",
];

let failed = false;
required.forEach((f) => {
  const p = path.join(root, f);
  if (!fs.existsSync(p)) {
    console.error("Falta archivo requerido:", f);
    failed = true;
  } else {
    console.log("OK:", f);
  }
});

if (failed) process.exit(2);
console.log("Comprobación básica OK");
