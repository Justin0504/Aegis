# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy workspace files
COPY package.json package-lock.json* turbo.json ./
COPY packages/core-schema/package.json ./packages/core-schema/
COPY apps/compliance-cockpit/package.json ./apps/compliance-cockpit/

# Install dependencies
RUN npm ci

# Copy source files
COPY packages/core-schema ./packages/core-schema
COPY apps/compliance-cockpit ./apps/compliance-cockpit

# Build the packages
RUN npm run build --workspace=@agentguard/core-schema
RUN npm run build --workspace=@agentguard/compliance-cockpit

# Production stage
FROM node:20-alpine AS runner

WORKDIR /app

# Install production dependencies
COPY --from=builder /app/package.json /app/package-lock.json* ./
COPY --from=builder /app/packages/core-schema/package.json ./packages/core-schema/
COPY --from=builder /app/apps/compliance-cockpit/package.json ./apps/compliance-cockpit/

RUN npm ci --production

# Copy Next.js build
COPY --from=builder /app/apps/compliance-cockpit/.next ./apps/compliance-cockpit/.next
COPY --from=builder /app/apps/compliance-cockpit/public ./apps/compliance-cockpit/public
COPY --from=builder /app/packages/core-schema/dist ./packages/core-schema/dist

# Create nextjs user
RUN addgroup -g 1001 -S nodejs
RUN adduser -S nextjs -u 1001

# Change ownership
RUN chown -R nextjs:nodejs /app

# Switch to non-root user
USER nextjs

# Expose port
EXPOSE 3000

# Start Next.js
ENV NODE_ENV=production
WORKDIR /app/apps/compliance-cockpit
CMD ["npm", "start"]