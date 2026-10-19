# Grab a Clip backend + frontend
#
# yt-dlp and ffmpeg are native binaries that cannot run in Vercel Functions.
# This image is the deployable downloader; the Vercel deployment can serve the
# static frontend and point at this container with GAC_API_BASE (see DEPLOY.md).

# Deno runtime for yt-dlp's JavaScript challenges. The `bin` image contains the
# binary at /deno; copying it avoids a network installer in the build.
FROM denoland/deno:bin AS deno

FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=3000 \
    YTDLP_BIN=yt-dlp \
    FFMPEG_BIN=ffmpeg \
    FFPROBE_BIN=ffprobe

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg python3 python3-pip \
 && rm -rf /var/lib/apt/lists/*

# Install yt-dlp from PyPI. The standalone GitHub release asset can be blocked
# or served as a non-binary page by CI proxies; pip is reliable. The build stops
# here if the installed binary cannot run.
RUN python3 -m pip install --no-cache-dir --break-system-packages -U yt-dlp \
 && yt-dlp --version

COPY --from=deno /deno /usr/local/bin/deno
RUN deno --version

# Fail the image build if the media tools are unusable.
RUN ffmpeg -version >/dev/null && ffprobe -version >/dev/null

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD curl -fsS http://localhost:3000/api/health || exit 1

CMD ["node", "server/index.js"]
