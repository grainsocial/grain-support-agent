# The preview runner: builds a branch of grain and photographs its pages,
# against a dev stack of its own. It runs code a fix agent wrote, so it holds
# no secrets, mounts nothing from production, and talks to nothing but the
# support agent and the package registries.
FROM node:25-bookworm

# Toolchain for better-sqlite3, which plc-sqlite, the PDS and grain all build.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# The did:plc directory, on SQLite.
ARG PLC_SQLITE_REF=main
RUN git clone --depth 1 --branch "$PLC_SQLITE_REF" https://tangled.org/chadtmiller.com/plc-sqlite /opt/plc \
    && cd /opt/plc && npm ci --omit=dev

# The reference PDS.
WORKDIR /opt/pds
COPY pds/package.json pds/index.js ./
RUN npm install --omit=dev --no-audit --no-fund

# The runner, and the Chromium its Playwright drives.
WORKDIR /opt/runner
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npx playwright install --with-deps chromium
COPY src ./src

EXPOSE 8090
CMD ["node", "src/server.ts"]
