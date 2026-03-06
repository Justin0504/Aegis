FROM node:20-alpine AS builder
WORKDIR /app
COPY packages/core-schema ./packages/core-schema
COPY packages/gateway-mcp ./packages/gateway-mcp
COPY package.json package-lock.json ./
RUN npm ci
RUN cd packages/core-schema && npm run build
RUN cd packages/gateway-mcp && npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/packages/gateway-mcp/dist ./dist
COPY --from=builder /app/packages/gateway-mcp/package.json ./
COPY --from=builder /app/node_modules ./node_modules
EXPOSE 8080
CMD ["node", "dist/server.js"]
