FROM node:22-slim

# Install Chrome dependencies for Puppeteer and curl for health checks
RUN apt-get update && apt-get install -y \
    chromium \
    chromium-sandbox \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Set Puppeteer to use system Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY tsconfig.json ./

# Install all dependencies (including dev dependencies for build)
RUN npm ci

# Copy source code
COPY src/ ./src/

# Build TypeScript
RUN npm run build

# Run the Express server
CMD ["node", "dist/server.js"]

