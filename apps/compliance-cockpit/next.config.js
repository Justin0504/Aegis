/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@agentguard/core-schema'],
  env: {
    APP_VERSION: require('./package.json').version,
  },
};

module.exports = nextConfig;