// `npm run dist:mac` builds a self-contained server for the desktop app into its own folder,
// so it never disturbs a running `npm run dev`.
const desktop = process.env.BUILD_DESKTOP === '1';

/** @type {import('next').NextConfig} */
const nextConfig = {
  ...(desktop ? { output: 'standalone', distDir: '.next-desktop' } : {}),
  experimental: {
    // Lets src/instrumentation.ts start the office engine when the server boots
    instrumentationHook: true,
  },
};

export default nextConfig;
