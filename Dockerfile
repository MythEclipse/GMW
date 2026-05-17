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
RUN pnpm install --frozen-lockfile

# Copy the rest of the application
COPY . .

# Build step if required (e.g. build:web)
RUN pnpm run build:web || true

# Set node environment
ENV NODE_ENV=production

# Start the application
CMD ["pnpm", "run", "start"]
