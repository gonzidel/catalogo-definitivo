import type { NextConfig } from "next";
import path from "path";

// Allow self-signed / incomplete certificate chains in local dev
// (Node.js on Windows often can't verify Supabase's certificate chain)
if (process.env.NODE_ENV === "development") {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

const nextConfig: NextConfig = {
  basePath: "/catalogo1",

  // Fix workspace root detection when multiple package-lock.json exist
  outputFileTracingRoot: path.join(__dirname),

  images: {
    loader: "custom",
    loaderFile: "./lib/cloudinary.ts",
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
