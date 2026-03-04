# Development Dockerfile for hot-reloading
FROM node:20-alpine

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* turbo.json ./
COPY packages/core-schema/package.json ./packages/core-schema/
COPY packages/gateway-mcp/package.json ./packages/gateway-mcp/

RUN npm ci

# Copy TypeScript configs
COPY packages/core-schema/tsconfig.json ./packages/core-schema/
COPY packages/gateway-mcp/tsconfig.json ./packages/gateway-mcp/

# Copy source files (will be overridden by volume mounts)
COPY packages/core-schema/src ./packages/core-schema/src
COPY packages/gateway-mcp/src ./packages/gateway-mcp/src

# Create data directory
RUN mkdir -p /data

EXPOSE 8080

# Default command (overridden in docker-compose.dev.yml)
CMD ["npm", "run", "dev"]