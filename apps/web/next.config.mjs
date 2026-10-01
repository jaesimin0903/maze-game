/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['@maze/shared'],
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
};

export default nextConfig;
