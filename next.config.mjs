/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    // Lets src/instrumentation.ts start the office engine when the server boots
    instrumentationHook: true,
  },
};

export default nextConfig;
