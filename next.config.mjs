/** @type {import('next').NextConfig} */
const nextConfig = {
  // Allow larger request bodies for PDF uploads to the API route.
  experimental: {
    serverActions: {
      bodySizeLimit: "15mb",
    },
  },
};

export default nextConfig;
