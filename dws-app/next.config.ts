import type { NextConfig } from "next";

const supabaseHostname = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname;

const nextConfig: NextConfig = {
  serverExternalPackages: ['@boundaryml/baml', 'ffmpeg-static'],
  // ffmpeg-static reaches its binary via path.join, not require(), so output
  // tracing can't see it — the repair route would deploy without ffmpeg and
  // fail every video action at runtime. Name it explicitly.
  outputFileTracingIncludes: {
    '/api/photos/repair': ['./node_modules/ffmpeg-static/ffmpeg'],
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: supabaseHostname,
        port: "",
        pathname: "/storage/v1/object/public/**",
      },
      {
        // Repair sweep renders derivatives through the transform endpoint.
        protocol: "https",
        hostname: supabaseHostname,
        port: "",
        pathname: "/storage/v1/render/image/**",
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
