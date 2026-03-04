# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy workspace files
COPY package.json package-lock.json* turbo.json ./
COPY packages/core-schema/package.json ./packages/core-schema/
COPY packages/gateway-mcp/package.json ./packages/gateway-mcp/

# Install dependencies
RUN npm ci

# Copy source files
COPY packages/core-schema ./packages/core-schema
COPY packages/gateway-mcp ./packages/gateway-mcp

# Build the packages
RUN npm run build --workspace=@agentguard/core-schema
RUN npm run build --workspace=@agentguard/gateway-mcp

# Production stage
FROM node:20-alpine

WORKDIR /app

# Install production dependencies only
COPY --from=builder /app/package.json /app/package-lock.json* ./
COPY --from=builder /app/packages/core-schema/package.json ./packages/core-schema/
COPY --from=builder /app/packages/gateway-mcp/package.json ./packages/gateway-mcp/

RUN npm ci --production

# Copy built files
COPY --from=builder /app/packages/core-schema/dist ./packages/core-schema/dist
COPY --from=builder /app/packages/gateway-mcp/dist ./packages/gateway-mcp/dist

# Create data directory
RUN mkdir -p /data && chown -R node:node /data

# Switch to non-root user
USER node

# Expose port
EXPOSE 8080

# Start the gateway
CMD ["node", "packages/gateway-mcp/dist/server.js"]