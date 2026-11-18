import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";

// CSP: Next.js App Router injects inline bootstrap scripts, so 'unsafe-inline' is required for script-src
// unless nonces are wired through a proxy. Dev additionally needs 'unsafe-eval' (React refresh / HMR).
// Tighten with nonces later (see SECURITY.md). Payment/Sentry origins are allow-listed explicitly.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isProd ? "" : " 'unsafe-eval'"} https://js.stripe.com https://checkout.razorpay.com`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https://api.stripe.com https://api.razorpay.com https://lumberjack.razorpay.com https://*.sentry.io https://*.ingest.sentry.io" +
    (isProd ? "" : " ws: wss:"),
  "frame-src 'self' https://js.stripe.com https://hooks.stripe.com https://api.razorpay.com https://checkout.razorpay.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
  ...(isProd ? ["upgrade-insecure-requests"] : []),
].join("; ");

const baseHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(self)" },
  { key: "X-DNS-Prefetch-Control", value: "on" },
  ...(isProd
    ? [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }]
    : []),
];

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  // Dev-only escape hatch: browser->terminal log forwarding can retrigger HMR in a reload loop on some Windows setups.
  ...(process.env.NEXT_NO_BROWSER_LOGS ? { logging: { browserToTerminal: false } } : {}),
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  async headers() {
    return [
      // Embed widget routes may be framed by customer sites.
      {
        source: "/embed/:path*",
        headers: [
          ...baseHeaders,
          { key: "Content-Security-Policy", value: csp.replace("frame-ancestors 'self'", "frame-ancestors *") },
        ],
      },
      {
        source: "/((?!embed).*)",
        headers: [
          ...baseHeaders,
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Content-Security-Policy", value: csp },
        ],
      },
    ];
  },
};

export default nextConfig;
