const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const root = path.resolve(__dirname, "..");

// Patrones a buscar (sensibles)
const PATTERNS = [
  {
    name: "Private key block",
    re: /-----BEGIN (?:RSA |ENCRYPTED )?PRIVATE KEY-----/i,
  },
  {
    name: "Firebase private_key field",
    re: /"private_key"\s*:\s*"-----BEGIN /i,
  },
  { name: "API key (AIza)", re: /AIza[0-9A-Za-z\-_]{35}/g },
  { name: "AWS Access Key ID (AKIA)", re: /AKIA[0-9A-Z]{16}/g },
  { name: "Generic long key", re: /[A-Za-z0-9_-]{40,}/g },
];

function isBinaryFile(buffer) {
  for (let i = 0; i < buffer.length && i < 8000; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

function maskMatch(match) {
  if (!match) return "";
  const s = String(match);
  if (s.length <= 12) return s;
  return s.slice(0, 6) + "..." + s.slice(-6);
}

function getStagedFiles() {
  try {
    const out = execSync("git diff --cached --name-only", { encoding: "utf8" });
    return out.split(/\r?\n/).filter(Boolean);
  } catch (err) {
    return [];
  }
}

const staged = getStagedFiles();
if (staged.length === 0) {
  console.log("No hay archivos staged. Saltando escaneo.");
  process.exit(0);
}

let findings = [];
for (const rel of staged) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) continue; // deleted or moved
  try {
    const buff = fs.readFileSync(file);
    if (isBinaryFile(buff)) continue;
    const txt = buff.toString("utf8");
    for (const p of PATTERNS) {
      const re = p.re;
      if (re.global) {
        let m;
        while ((m = re.exec(txt)) !== null) {
          findings.push({ file: rel, name: p.name, excerpt: maskMatch(m[0]) });
        }
      } else {
        const m = txt.match(re);
        if (m)
          findings.push({ file: rel, name: p.name, excerpt: maskMatch(m[0]) });
      }
    }
  } catch (err) {
    // ignore
  }
}

if (findings.length === 0) {
  console.log("No se detectaron secretos en los archivos staged.");
  process.exit(0);
}

console.error("Se detectaron posibles secretos en archivos staged:");
for (const f of findings) {
  console.error(`- ${f.file}: ${f.name} -> ${f.excerpt}`);
}
console.error(
  "\nCorrige o mueve los secretos (ej. a scripts/config.local.js), o usa `git commit --no-verify` si estás seguro."
);
process.exit(3);
