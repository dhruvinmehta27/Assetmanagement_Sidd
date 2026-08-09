/** @type {import('next').NextConfig} */
const nextConfig = {
  // App Router route handlers stream the request body, so no special body-size
  // config is needed here. Note: on Vercel, serverless functions cap the
  // request payload at ~4.5 MB — well above a typical contract note PDF.

  // The desktop build ships a self-contained Node server inside the .app, so
  // `next build` must emit `.next/standalone/server.js` with its own trimmed
  // node_modules. Vercel ignores this setting, so the web deploy is unaffected.
  output: "standalone",
};

export default nextConfig;
