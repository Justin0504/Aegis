# Development Dockerfile for hot-reloading
FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* turbo.json ./
COPY packages/core-schema/package.json ./packages/core-schema/
COPY apps/compliance-cockpit/package.json ./apps/compliance-cockpit/

RUN npm ci

# Copy configs
COPY packages/core-schema/tsconfig.json ./packages/core-schema/
COPY apps/compliance-cockpit/tsconfig.json ./apps/compliance-cockpit/
COPY apps/compliance-cockpit/next.config.js ./apps/compliance-cockpit/
COPY apps/compliance-cockpit/tailwind.config.ts ./apps/compliance-cockpit/
COPY apps/compliance-cockpit/postcss.config.js ./apps/compliance-cockpit/

# Copy source files (will be overridden by volume mounts)
COPY packages/core-schema/src ./packages/core-schema/src
COPY apps/compliance-cockpit/src ./apps/compliance-cockpit/src
COPY apps/compliance-cockpit/public ./apps/compliance-cockpit/public

EXPOSE 3000

# Default command (overridden in docker-compose.dev.yml)
CMD ["npm", "run", "dev"]