/** @type {import('next').NextConfig} */
const nextConfig = {
  // App Router route handlers stream the request body, so no special body-size
  // config is needed here. Note: on Vercel, serverless functions cap the
  // request payload at ~4.5 MB — well above a typical contract note PDF.
};

export default nextConfig;
