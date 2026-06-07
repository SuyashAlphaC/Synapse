import type { NextConfig } from 'next';
import path from 'node:path';

const nextConfig: NextConfig = {
  // Pin the workspace root so the monorepo's outer lockfile doesn't
  // confuse Turbopack's auto-detection.
  turbopack: {
    root: __dirname,
  },
  // Include the esbuild-bundled messaging bridge (Sui 1.x isolated) in the
  // create-channel serverless function — avoids compiling it against dashboard Sui 2.x.
  outputFileTracingRoot: path.join(__dirname, '../..'),
  outputFileTracingIncludes: {
    '/api/messaging/create-channel': [
      '../../examples/messaging-runtime-bridge/dist/rpc.bundle.mjs',
    ],
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
