# The support agent: the server and the dashboard it hosts. Built from the
# repository root, since it needs the workspace: docker build -f apps/server/Dockerfile .
FROM node:25-slim AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/preview/package.json apps/preview/
COPY packages/types/package.json packages/types/
COPY packages/ui/package.json packages/ui/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build -w web && npm prune --omit=dev

FROM node:25-slim
# git for the checkouts the agents read, ripgrep for opencode's grep and glob.
RUN apt-get update && apt-get install -y --no-install-recommends git ripgrep ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir /state && chown node:node /state
WORKDIR /repo
COPY --from=build /repo/package.json ./
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages/types ./packages/types
COPY --from=build /repo/apps/server ./apps/server
COPY --from=build /repo/apps/web/dist ./apps/web/dist
ENV PATH=/repo/node_modules/.bin:$PATH \
    NODE_ENV=production \
    STATE_DIR=/state \
    PORT=8080
# Not root: the agent reads untrusted text, and the appview's data directory
# is mounted in. uid 1000 is the node user in the base image.
USER node
WORKDIR /repo/apps/server
EXPOSE 8080
CMD ["node", "src/main.ts"]
