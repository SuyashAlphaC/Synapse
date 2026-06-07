import type { NextConfig } from 'next';
import path from 'node:path';

const repoRoot = path.join(__dirname, '../..');

// Production/Vercel: widen to monorepo root for tracing and package resolution.
// Dev: scope to the dashboard app so Turbopack does not watch the entire repo.
const useMonorepoRoot = process.env.NODE_ENV === 'production' || process.env.VERCEL === '1';

const nextConfig: NextConfig = {
  turbopack: {
    root: useMonorepoRoot ? repoRoot : __dirname,
  },
  ...(useMonorepoRoot ? { outputFileTracingRoot: repoRoot } : {}),
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
