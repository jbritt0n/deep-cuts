# Deep Cuts — always-on server image (Phase 9e). Serves the built UI and the read-only query API over
# HTTP against a DuckDB file mounted at /data. Connectors (Spotify polling, Last.fm, MusicBrainz…) are
# NOT in this image — they run in the desktop app; see docs/DOCKER.md for how the record gets here.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx vite build --mode browser

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY dev-server.mjs ./
COPY src-tauri/sql ./src-tauri/sql
RUN mkdir -p /data && chown node:node /data
USER node
ENV HOST=0.0.0.0 PORT=4747 DEEPCUTS_DB=/data/deep-cuts.duckdb DEEPCUTS_STATIC=/app/dist DEEPCUTS_TZ=UTC
EXPOSE 4747
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:4747/_health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dev-server.mjs"]
