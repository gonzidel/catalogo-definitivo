import type { NextConfig } from "next";
import path from "path";

if (process.env.NODE_ENV === "development") {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.join(__dirname),

  async rewrites() {
    return {
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
