# Grab a Clip backend + frontend
#
# yt-dlp and ffmpeg are native binaries that cannot run in Vercel Functions.
# This image is the deployable downloader; the Vercel deployment can serve the
# static frontend and point at this container with GAC_API_BASE (see DEPLOY.md).
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=3000 \
    YTDLP_BIN=yt-dlp \
    FFMPEG_BIN=ffmpeg \
    FFPROBE_BIN=ffprobe

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg unzip \
 && rm -rf /var/lib/apt/lists/*

# Standalone yt-dlp (rebuild/redeploy the image regularly: a stale yt-dlp is the
# usual cause of YouTube 403s).
RUN curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
      -o /usr/local/bin/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp

# Deno solves yt-dlp's JavaScript challenges (--remote-components ejs:github).
RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD curl -fsS http://localhost:3000/api/health || exit 1

CMD ["node", "server/index.js"]
