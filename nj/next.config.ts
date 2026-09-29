import type { NextConfig } from "next";
import path from "path";
import { legacyHostingRedirects, legacyHostingRewrites } from "./lib/rollout/legacy-hosting";

if (process.env.NODE_ENV === "development") {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

const ownsRoot = process.env.NEXT_PUBLIC_ROLLOUT_ENABLED === "1";

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.join(__dirname),

  async redirects() {
    return ownsRoot ? legacyHostingRedirects() : [];
  },

  async rewrites() {
    // Con nj sirviendo la raíz, landings y admin vanilla deben seguir respondiendo igual que hoy;
    // si no, la ruta dinámica [categoria] o la falta del archivo los convierte en 404.
    const beforeFiles = ownsRoot ? legacyHostingRewrites() : [];
    return {
      beforeFiles,
      afterFiles: [
        { source: "/nj", destination: "/" },
        { source: "/nj/:path*", destination: "/:path*" },
      ],
    };
  },

  images: {
    loader: "custom",
    loaderFile: "./lib/cloudinary.ts",
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

  experimental: {
    optimisticClientCache: true,
  },
};

export default nextConfig;
