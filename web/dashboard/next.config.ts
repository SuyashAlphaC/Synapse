import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Pin the workspace root so the monorepo's outer lockfile doesn't
  // confuse Turbopack's auto-detection.
  turbopack: {
    root: __dirname,
  },
  // The @synapse-core/* packages ship compiled ESM but Turbopack
  // resolves their subpath `exports` (e.g. @synapse-core/vault/runtime)
  // more reliably when they're listed for transpilation. Lets the
  // in-browser runtime import the shared vault SDK directly.
  transpilePackages: [
    '@synapse-core/vault',
    '@synapse-core/client',
    '@synapse-core/memwal-bridge',
    '@synapse-core/adapter-langgraph',
  ],
  serverExternalPackages: ['esbuild'],
};

export default nextConfig;
