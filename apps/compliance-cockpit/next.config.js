/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@agentguard/core-schema'],
  async rewrites() {
    return [
      {
        source: '/api/gateway/:path*',
        destination: process.env.NEXT_PUBLIC_GATEWAY_URL || 'http://localhost:8080/api/v1/:path*',
      },
    ];
  },
};

module.exports = nextConfig;