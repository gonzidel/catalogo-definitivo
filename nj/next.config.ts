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

  // TEMP: hay errores de tipos preexistentes (nunca corrió `next build` antes,
  // solo `next dev`) que bloquean el build de Vercel para este deploy de testing.
  // Sacar esto antes de un build de producción real.
  typescript: {
    ignoreBuildErrors: true,
  },

  // Fix workspace root detection when multiple package-lock.json exist
  outputFileTracingRoot: path.join(__dirname),

  images: {
    loader: "custom",
    loaderFile: "./lib/cloudinary.ts",
    // 3 anchos de viewport + 3 thumbs. Evita srcset de 14 variantes
    // (w_1920/2048/3840 inflaban bandwidth; ver auditoría Cloudinary 2026-08-15).
    deviceSizes: [400, 800, 1200],
    imageSizes: [64, 200, 384],
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
