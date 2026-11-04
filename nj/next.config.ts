import type { NextConfig } from "next";
import path from "path";
import { LEGACY_HOSTING_ORIGIN, LEGACY_LANDING_SLUGS } from "./lib/rollout/legacy-hosting";

if (process.env.NODE_ENV === "development") {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.join(__dirname),

  async redirects() {
    // Temporales: URLs del hosting viejo que hoy responden en www no deben pasar a 404.
    if (process.env.NEXT_PUBLIC_ROLLOUT_ENABLED !== "1") return [];
    return [
      { source: "/catalogo.html", destination: "/", permanent: false },
      { source: "/index.html", destination: "/", permanent: false },
      { source: "/client/:path*", destination: "/", permanent: false },
    ];
  },

  async rewrites() {
    // Con nj sirviendo la raíz, las landings deben seguir respondiendo igual que hoy;
    // si no, la ruta dinámica [categoria] las convierte en 404.
    const beforeFiles =
      process.env.NEXT_PUBLIC_ROLLOUT_ENABLED === "1"
        ? [
            ...LEGACY_LANDING_SLUGS.flatMap((slug) => [
              { source: `/${slug}`, destination: `${LEGACY_HOSTING_ORIGIN}/${slug}` },
              { source: `/${slug}/:path*`, destination: `${LEGACY_HOSTING_ORIGIN}/${slug}` },
            ]),
            { source: "/icons/:path*", destination: `${LEGACY_HOSTING_ORIGIN}/icons/:path*` },
            { source: "/styles.css", destination: `${LEGACY_HOSTING_ORIGIN}/styles.css` },
          ]
        : [];
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
