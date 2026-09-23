FROM node:24-bookworm-slim
LABEL org.opencontainers.image.source="https://github.com/fruttidrama-afk/Frutti-Drama-Publisher"
LABEL org.opencontainers.image.description="Publisher Factory autonomous publisher runtime"
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium ffmpeg xvfb xdotool scrot ca-certificates curl gnupg fonts-liberation fonts-noto-color-emoji \
  && mkdir -p /etc/apt/keyrings \
  && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /etc/apt/keyrings/google-chrome.gpg \
  && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends google-chrome-stable \
  && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install --omit=dev
COPY runtime-config.js runtime-init.js free-browser-provider.js flow-bootstrap.js server.js publication.js publication-copy.js review-storage.js publisher-selftest.mjs verify-runtime-contract.mjs runtime-fresh-start-selftest.mjs publisher.config.schema.json ./
COPY GOOGLE_FLOW_AUTOMATION_MASTER_SOP.md GOOGLE_FLOW_AUTOMATION_SOP.json FLOW_AI_IMPLEMENTATION_BRIEF.md FLOW_RECOVERY_RUNBOOK.md FLOW_GOLDEN_TEST.md FLOW_FAILURE_CATALOG.md FLOW_CHANGELOG.md FLOW_SOP_KNOWLEDGE_MANIFEST.json ./
RUN node --check runtime-config.js \
  && node --check runtime-init.js \
  && node --check free-browser-provider.js \
  && node --check flow-bootstrap.js \
  && node --check publication.js \
  && node --check publication-copy.js \
  && node --check review-storage.js \
  && node --check server.js \
  && node verify-runtime-contract.mjs \
  && node runtime-fresh-start-selftest.mjs \
  && node publisher-selftest.mjs
COPY public ./public
ENV NODE_ENV=production
ENV CHROMIUM_PATH=/usr/bin/chromium
CMD ["node","--import=./runtime-init.js","--import=./free-browser-provider.js","--import=./flow-bootstrap.js","server.js"]
