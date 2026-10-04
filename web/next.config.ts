import type { NextConfig } from "next";

/**
 * Static export.
 *
 * With inference running in the browser there are no route handlers left, so
 * every byte this app serves is a static file. That is not a downgrade — it
 * is the point. Static assets on Cloudflare are free and unmetered, and they
 * do not invoke a Worker, so the frontend costs nothing to serve at any
 * volume and the only billable surface left is whatever we add later for
 * accounts and sync.
 *
 * Consequences to keep in mind when editing:
 *  - No route handlers, no middleware, no server components with runtime
 *    data. Anything dynamic happens in the client or not at all.
 *  - `headers()` is not available here; security headers ship in
 *    `public/_headers`, which Cloudflare applies at the edge.
 */
const nextConfig: NextConfig = {
  output: "export",
  images: {
    // The optimizer is a server; there isn't one. Images in this app are
    // either build-time assets or base64 data URLs generated at runtime,
    // so there is nothing for it to optimize anyway.
    unoptimized: true,
  },
};

export default nextConfig;
