FROM node:22-bookworm-slim

# Install dependencies required by node-canvas, ffmpeg, and yt-dlp
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    curl \
    git \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp

# Enable pnpm
RUN corepack enable

WORKDIR /app

# Install dependencies first for better caching
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml* ./
COPY vendor/discord-video-stream/package.json ./vendor/discord-video-stream/package.json
COPY vendor/discord.js-selfbot-v13/package.json ./vendor/discord.js-selfbot-v13/package.json
# Allow install to proceed in CI/docker build even if lockfile is slightly out of date.
# Prefer updating pnpm-lock.yaml in the repo as a long-term fix.
RUN pnpm install --no-frozen-lockfile

# Copy the rest of the application
COPY . .

# Build vendor packages and app bundles during image build
RUN pnpm run prepare:vendor
RUN pnpm run build

# Set node environment
ENV NODE_ENV=production

# Start the application
CMD ["pnpm", "run", "start"]
