const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");

// Ignorar carpetas grandes o de dependencias
const IGNORE = ["node_modules", ".git", "cloudinary-optimize/node_modules"];

// Patrones a buscar (sensibles): bloques de clave privada y tokens comunes
const PATTERNS = [
  {
    name: "Private key block",
    re: /-----BEGIN (?:RSA |ENCRYPTED )?PRIVATE KEY-----/i,
  },
  {
    name: "Firebase private_key field",
    re: /"private_key"\s*:\s*"-----BEGIN /i,
  },
  { name: "Firebase client_email", re: /"client_email"\s*:\s*"[^"]+@/i },
  { name: "API key (AIza)", re: /AIza[0-9A-Za-z\-_]{35}/g },
  { name: "AWS Access Key ID (AKIA)", re: /AKIA[0-9A-Z]{16}/g },
  { name: "Generic long key", re: /[A-Za-z0-9_-]{40,}/g },
];

function shouldIgnore(p) {
  return IGNORE.some(
    (ig) => p.includes(path.sep + ig + path.sep) || p.endsWith(path.sep + ig)
  );
}

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  let files = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (shouldIgnore(full)) continue;
    if (e.isDirectory()) {
      files = files.concat(walk(full));
    } else if (e.isFile()) {
      files.push(full);
    }
  }
  return files;
}

function isBinaryFile(buffer) {
  for (let i = 0; i < buffer.length && i < 8000; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

function maskMatch(match) {
  if (!match) return "";
  const s = String(match);
  if (s.length <= 8) return s;
  return s.slice(0, 4) + "..." + s.slice(-4);
}

let findings = [];

const allFiles = walk(root);
for (const file of allFiles) {
  try {
    const buff = fs.readFileSync(file);
    if (isBinaryFile(buff)) continue;
    const txt = buff.toString("utf8");
    for (const p of PATTERNS) {
      const re = p.re;
      let match;
      if (re.global) {
        while ((match = re.exec(txt)) !== null) {
          findings.push({ file, name: p.name, excerpt: maskMatch(match[0]) });
        }
      } else {
        match = txt.match(re);
        if (match)
          findings.push({ file, name: p.name, excerpt: maskMatch(match[0]) });
      }
    }
  } catch (err) {
    // ignorar archivos no legibles
  }
}

if (findings.length === 0) {
  console.log("No se detectaron patrones sensibles (búsqueda básica).");
  process.exit(0);
}

console.error("Posibles secretos detectados:");
for (const f of findings) {
  console.error(`- ${path.relative(root, f.file)}: ${f.name} -> ${f.excerpt}`);
}
console.error(
  "\nRevisa los archivos listados. Si son falsos positivos, ignóralos; si contienen secretos, muévelos a archivos de entorno o bórralos."
);
process.exit(3);
