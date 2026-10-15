import type { NextConfig } from "next";

const apiOrigin = process.env.MIZVO_API_ORIGIN ?? "http://127.0.0.1:4000";

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      { source: "/api/auth/:path*", destination: `${apiOrigin}/api/auth/:path*` },
      { source: "/api/businesses", destination: `${apiOrigin}/api/businesses` },
      {
        source: "/api/businesses/:path*",
        destination: `${apiOrigin}/api/businesses/:path*`,
      },
    ];
  },
};

export default nextConfig;
