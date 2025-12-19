import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  serverExternalPackages: ['@boundaryml/baml'],
  webpack: (config) => {
    config.resolve.alias['@baml'] = path.resolve(__dirname, 'baml_client');
    return config;
  },
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
