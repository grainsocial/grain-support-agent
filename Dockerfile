FROM node:25-slim
# git for the checkout the agent reads, ripgrep for opencode's grep and glob.
RUN apt-get update && apt-get install -y --no-install-recommends git ripgrep ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
ENV PATH=/app/node_modules/.bin:$PATH \
    NODE_ENV=production \
    STATE_DIR=/state \
    PORT=8080
# Not root: the agent reads untrusted text, and the appview's data directory is
# mounted in. uid 1000 is the node user in the base image.
USER node
EXPOSE 8080
CMD ["node", "src/main.ts"]
