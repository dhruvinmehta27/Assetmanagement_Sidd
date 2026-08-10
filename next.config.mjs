/**
 * Two build flavours share this config:
 *
 *   web     (`next build`)                — deployed to Vercel, unchanged
 *   desktop (`DESKTOP_BUILD=1 next build`) — bundled into the Electron app
 *
 * Everything desktop-specific is gated behind DESKTOP_BUILD rather than applied
 * unconditionally, because `output: "standalone"` is not inert on the web side:
 * it breaks `next start`. Gating keeps the web build byte-identical to what it
 * was before the desktop work.
 */
const isDesktop = process.env.DESKTOP_BUILD === "1";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // App Router route handlers stream the request body, so no special body-size
  // config is needed here. Note: on Vercel, serverless functions cap the
  // request payload at ~4.5 MB — well above a typical contract note PDF.

  ...(isDesktop
    ? {
        // Emit `.next/standalone/server.js` with its own trimmed node_modules,
        // so the Electron bundle carries a self-contained server.
        output: "standalone",

        // The app renders no images at all (no next/image, no <img>), so the
        // image optimizer is dead weight in the bundle.
        images: { unoptimized: true },

        // `unoptimized` alone does not stop the tracer pulling in sharp and its
        // libvips binary. Next loads sharp lazily, only when it actually
        // optimizes an image — which, with no images, never happens. Excluding
        // it drops ~19 MB and leaves the bundle free of platform-specific
        // binaries, which is what makes a Windows build straightforward later.
        outputFileTracingExcludes: {
          "*": ["node_modules/@img/**", "node_modules/sharp/**"],
        },
      }
    : {}),
};

export default nextConfig;
