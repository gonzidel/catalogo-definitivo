import type { NextConfig } from "next";
import path from "path";

// Allow self-signed / incomplete certificate chains in local dev
// (Node.js on Windows often can't verify Supabase's certificate chain)
if (process.env.NODE_ENV === "development") {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

const nextConfig: NextConfig = {
  // basePath: '/nj' en dev Y en producción (prueba paralela sin cutover)
  basePath: "/nj",

  // Fix workspace root detection when multiple package-lock.json exist
  outputFileTracingRoot: path.join(__dirname),

  images: {
    loader: "custom",
    loaderFile: "./lib/cloudinary.ts",
    // Anchos acotados: el default de Next incluye 2048/3840 (4K), que en un
    // catálogo de fotos de producto solo sirve para inflar bandwidth de Cloudinary
    // sin beneficio visual real (ver auditoría de consumo, ago 2026).
    deviceSizes: [640, 750, 828, 1080, 1200, 1920],
    imageSizes: [16, 32, 48, 64, 96, 128, 256, 384],
    remotePatterns: [
      {
        protocol: "https",
        hostname: "res.cloudinary.com",
        pathname: "/dnuedzuzm/**",
      },
    ],
  },

  // Evitar conflictos de prefetch con la app vanilla en producción
  experimental: {
    optimisticClientCache: true,
  },
};

export default nextConfig;
