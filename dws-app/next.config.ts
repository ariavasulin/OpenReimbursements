import type { NextConfig } from "next";

const supabaseHostname = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname;

const nextConfig: NextConfig = {
  serverExternalPackages: ['@boundaryml/baml', 'ffmpeg-static'],
  // ffmpeg-static reaches its binary via path.join, not require(), so output
  // tracing can't see it — the repair route would deploy without ffmpeg and
  // fail every video action at runtime. Name it explicitly.
  outputFileTracingIncludes: {
    '/api/photos/repair': ['./node_modules/ffmpeg-static/ffmpeg'],
    '/mcp/*': ['./src/lib/mcp/harness/**/*.md'],
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: supabaseHostname,
        port: "",
        pathname: "/storage/v1/object/public/**",
      },
    ],
  },
  // The public share page and its API (photo-albums plan, AC-22). Never cached, so turning a link
  // off takes effect at once; never indexed; and the address, which IS the secret, is never sent on
  // as a referrer. The API route sets the same headers itself; this covers the page as well.
  async headers() {
    const shared = [
      { key: 'Cache-Control', value: 'no-store' },
      { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
      { key: 'Referrer-Policy', value: 'no-referrer' },
    ];
    return [{ source: '/s/:path*', headers: shared }, { source: '/api/share/:path*', headers: shared }];
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
