import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The container image (Dockerfile) builds with NEXT_OUTPUT=standalone and runs the traced server
// without node_modules; tracing starts at the monorepo root, where the dependencies live.
const standalone = process.env.NEXT_OUTPUT === 'standalone';

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@maze/shared'],
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  ...(standalone
    ? {
        output: 'standalone',
        outputFileTracingRoot: path.join(path.dirname(fileURLToPath(import.meta.url)), '../..'),
      }
    : {}),
};

export default nextConfig;
