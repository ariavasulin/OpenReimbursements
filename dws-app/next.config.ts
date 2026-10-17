import type { NextConfig } from "next";

const supabaseHostname = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname;

const nextConfig: NextConfig = {
  serverExternalPackages: ['@boundaryml/baml', 'ffmpeg-static'],
  // ffmpeg-static reaches its binary via path.join, not require(), so output
  // tracing can't see it — a route would deploy without ffmpeg and fail every
  // video action at runtime. Name it explicitly for each route that runs it:
  // the nightly repair, and the right-after-upload derive (a video poster the
  // browser could not make).
  outputFileTracingIncludes: {
    '/api/photos/repair': ['./node_modules/ffmpeg-static/ffmpeg'],
    '/api/photos/[id]/derive': ['./node_modules/ffmpeg-static/ffmpeg'],
    '/mcp/*': ['./src/lib/mcp/harness/**/*.md'],
  },
  // Only receipt images go through next/image (the receipt viewer). Photos are
  // served straight from Storage; allowing their bucket here would let anyone
  // spend the Vercel image-optimization quota on any photo, no sign-in needed.
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: supabaseHostname,
        port: "",
        pathname: "/storage/v1/object/public/receipt-images/**",
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
