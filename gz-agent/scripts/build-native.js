#!/usr/bin/env node
// gz-agent/scripts/build-native.js
// Compila native/GZNative.cs -> native/GZNative.exe UNA sola vez, usando el
// compilador de C# que trae Windows (.NET Framework, csc.exe). Así en
// producción no hace falta compilar ni levantar PowerShell por cada trabajo
// de impresión o consulta de impresoras: solo se ejecuta el .exe ya
// compilado (rápido y sin ventana), en vez de spawnear PowerShell + WMI o
// Add-Type cada vez (lento y con ventana visible cada click).
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "native", "GZNative.cs");
const OUT = path.join(ROOT, "native", "GZNative.exe");

function findCsc() {
  const winDir = process.env.WINDIR || "C:\\Windows";
  const candidates = [
    path.join(winDir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    path.join(winDir, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
  ];
  return candidates.find((c) => fs.existsSync(c)) || null;
}

function main() {
  if (process.platform !== "win32") {
    console.warn("[GZ] build-native: no es Windows, se omite.");
    return;
  }
  if (fs.existsSync(OUT) && fs.statSync(OUT).mtimeMs > fs.statSync(SRC).mtimeMs) {
    console.log("[GZ] GZNative.exe ya está actualizado, se omite recompilar.");
    return;
  }
  const csc = findCsc();
  if (!csc) {
    console.warn(
      "[GZ] build-native: no se encontró csc.exe (.NET Framework). GZNative.exe no se compiló — GZ no va a poder imprimir ni listar impresoras hasta compilarlo."
    );
    return;
  }
  execFileSync(
    csc,
    ["/nologo", "/target:exe", "/r:System.Drawing.dll", "/out:" + OUT, SRC],
    { stdio: "inherit" }
  );
  console.log("✓ GZNative.exe compilado:", OUT);
}

main();
