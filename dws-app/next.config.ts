import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ['@boundaryml/baml'],
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "qebbmojnqzwwdpkhuyyd.supabase.co",
        port: "",
        pathname: "/storage/v1/object/public/**",
      },
    ],
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  /* config options here */
};

export default nextConfig;
