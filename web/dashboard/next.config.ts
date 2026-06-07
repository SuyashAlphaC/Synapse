import type { NextConfig } from 'next';
import path from 'node:path';

const repoRoot = path.join(__dirname, '../..');

const nextConfig: NextConfig = {
  // Monorepo root — must match between Turbopack and serverless file tracing.
  turbopack: {
    root: repoRoot,
  },
  outputFileTracingRoot: repoRoot,
  outputFileTracingIncludes: {
    '/api/messaging/create-channel': [
      '../../examples/messaging-runtime-bridge/dist/rpc.bundle.mjs',
    ],
  },
  transpilePackages: [
    '@synapse-core/vault',
    '@synapse-core/client',
    '@synapse-core/memwal-bridge',
    '@synapse-core/adapter-langgraph',
  ],
  serverExternalPackages: ['esbuild'],
};

export default nextConfig;
