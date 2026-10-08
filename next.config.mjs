// `npm run dist:mac` builds a self-contained server for the desktop app into its own folder,
// so it never disturbs a running `npm run dev`.
const desktop = process.env.BUILD_DESKTOP === '1';

/** @type {import('next').NextConfig} */
const nextConfig = {
  ...(desktop ? { output: 'standalone', distDir: '.next-desktop' } : {}),
  // Native or Node-only packages the server loads at run time instead of bundling
  serverExternalPackages: ['better-sqlite3', 'isomorphic-git', 'ws'],
  // The office's own data and build output are never part of the server bundle
  outputFileTracingExcludes: { '*': ['workspace/**', 'dist-desktop/**', 'build-desktop/**', 'tests/**', 'electron/**', 'scripts/**', 'src/**', '.git/**', '.env*'] },
};

export default nextConfig;
