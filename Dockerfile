FROM node:24-bookworm-slim
LABEL org.opencontainers.image.source="https://github.com/fruttidrama-afk/Frutti-Drama-Publisher"
LABEL org.opencontainers.image.description="Publisher Factory autonomous publisher runtime"
WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium ffmpeg xvfb xdotool scrot tini ca-certificates curl gnupg fonts-liberation fonts-noto-color-emoji \
  && mkdir -p /etc/apt/keyrings \
  && if [ "$(dpkg --print-architecture)" = "amd64" ]; then \
       curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /etc/apt/keyrings/google-chrome.gpg; \
       echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list; \
       apt-get update; \
       apt-get install -y --no-install-recommends google-chrome-stable; \
     fi \
  && rm -rf /var/lib/apt/lists/*
COPY package.json ./
RUN npm install --omit=dev
COPY activation-gate.mjs factory-hub.mjs unattended-supervisor.js runtime-config.js runtime-init.js free-browser-provider.js flow-bootstrap.js server.js publication.js publication-facebook.js publication-copy.js frutti-creative-package.js frutti-autonomous-source.js review-storage.js publisher-selftest.mjs facebook-publication-selftest.mjs verify-runtime-contract.mjs runtime-fresh-start-selftest.mjs publisher.config.schema.json ./
COPY reconciliation-studio.mjs ./
COPY public/reconciliation.html ./public/reconciliation.html
COPY scripts/flow-security-signals.mjs scripts/flow-unusual-cooldown.mjs scripts/safety-gate-selftest.mjs scripts/operator-gate.test.mjs scripts/oci-browser-offline-probe.mjs scripts/oci-runtime-offline-probe.mjs scripts/hub-offline-probe.mjs scripts/reconciliation-offline-probe.mjs scripts/hub-activation-offline-probe.mjs scripts/oci-compose-offline-probe.sh ./scripts/
# Include non-secret deployment policy for in-image fail-closed safety assertion.
COPY deploy/oracle-free/compose.yaml ./deploy/oracle-free/compose.yaml
COPY GOOGLE_FLOW_AUTOMATION_MASTER_SOP.md GOOGLE_FLOW_AUTOMATION_SOP.json FLOW_AI_IMPLEMENTATION_BRIEF.md FLOW_RECOVERY_RUNBOOK.md FLOW_GOLDEN_TEST.md FLOW_FAILURE_CATALOG.md FLOW_CHANGELOG.md FLOW_SOP_KNOWLEDGE_MANIFEST.json ./
RUN node --test scripts/operator-gate.test.mjs \
  && node --check activation-gate.mjs \
  && node --check factory-hub.mjs \
  && node scripts/safety-gate-selftest.mjs \
  && node --check scripts/flow-unusual-cooldown.mjs \
  && node --check scripts/flow-security-signals.mjs \
  && node --check unattended-supervisor.js \
  && node --check runtime-config.js \
  && node --check runtime-init.js \
  && node --check free-browser-provider.js \
  && node --check flow-bootstrap.js \
  && node --check publication.js \
  && node --check publication-facebook.js \
  && node --check publication-copy.js \
  && node --check frutti-creative-package.js \
  && node --check frutti-autonomous-source.js \
  && node --check review-storage.js \
  && node --check server.js \
  && node verify-runtime-contract.mjs \
  && node runtime-fresh-start-selftest.mjs \
  && node publisher-selftest.mjs \
  && node facebook-publication-selftest.mjs \
  && node scripts/hub-offline-probe.mjs \
  && node scripts/reconciliation-offline-probe.mjs \
  && node scripts/hub-activation-offline-probe.mjs
COPY public ./public
ENV NODE_ENV=production
ENV CHROMIUM_PATH=/usr/bin/chromium
ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["node","--import=./unattended-supervisor.js","--import=./runtime-init.js","--import=./free-browser-provider.js","--import=./flow-bootstrap.js","server.js"]