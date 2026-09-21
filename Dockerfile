FROM node:24-bookworm-slim
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
COPY runtime-config.js runtime-init.js free-browser-provider.js flow-bootstrap.js server.js publication.js publication-copy.js ./
RUN node --check runtime-config.js \
  && node --check runtime-init.js \
  && node --check free-browser-provider.js \
  && node --check flow-bootstrap.js \
  && node --check publication.js \
  && node --check publication-copy.js \
  && node --check server.js
COPY public ./public
ENV NODE_ENV=production
ENV CHROMIUM_PATH=/usr/bin/chromium
CMD ["node","--import=./runtime-init.js","--import=./free-browser-provider.js","--import=./flow-bootstrap.js","server.js"]
