import type { NextConfig } from "next";

const headers = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(self), geolocation=(), payment=()" },
];

// Production only: the dev server needs eval for hot reload. Next's own inline
// scripts need 'unsafe-inline' without a nonce, so this is a backstop, not a seal.
const csp = [
  "default-src 'self'", "img-src 'self' blob: data: https:", "media-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'", "script-src 'self' 'unsafe-inline'", "connect-src 'self'",
  "frame-ancestors 'none'", "base-uri 'self'", "object-src 'none'", "form-action 'self' https://www.sandbox.paypal.com",
].join("; ");
if (process.env.NODE_ENV === "production") headers.push({ key: "Content-Security-Policy", value: csp });
else headers.push({ key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'" });

const nextConfig: NextConfig = {
  distDir: process.env.NEXT_DIST_DIR ?? ".next",
  cacheComponents: true,
  partialPrefetching: true,
  poweredByHeader: false,
  headers: async () => [{ source: "/:path*", headers }],
};

export default nextConfig;
