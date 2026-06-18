# Katra Server Dockerfile
FROM node:20-alpine

RUN apk add --no-cache curl wget git ca-certificates

WORKDIR /app

# Copy package files and install dependencies
COPY server/package*.json ./
RUN npm install --production

# Copy source and build
COPY server/ ./
RUN node esbuild.config.mjs

# Expose ports (API + MCP)
EXPOSE 9002 3100

# Run the server
CMD ["node", "--import", "dotenv/config", "build/index.js"]
