FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        python3 \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY *.py *.mjs ./

ENV VK_DATA_DIR=/data \
    BROWSER_CDP_URL=http://127.0.0.1:9222

ENTRYPOINT ["node", "/app/vk_browser_publisher.mjs"]
