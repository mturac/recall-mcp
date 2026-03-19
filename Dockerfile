FROM node:20-bookworm-slim

# Install system dependencies required for sqlite and compiling native addons
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (including native modules)
RUN npm install

# Copy source code and config
COPY tsconfig.json ./
COPY src/ ./src/

# Compile TypeScript
RUN npm run build

# Create directories for DB and Models to allow easy volume mounting
RUN mkdir -p /app/data /app/models /app/.cache

# Set environment variables
ENV NODE_ENV=production
ENV DB_PATH=/app/data/recall_brain.db
ENV TRANSFORMERS_CACHE=/app/.cache
# Default authentication token (override in docker-compose.yml)
ENV RECALL_AUTH_KEY=replace_me_with_a_secure_token

# Expose the new Express API port
EXPOSE 3000

# Start the web server
CMD ["node", "dist/index.js"]
