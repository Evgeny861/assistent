# Build stage: compile TS + Vite, install all deps (native build tools needed).
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci
COPY . .
RUN npm run build

# Runtime stage: production dependencies only + compiled artifacts.
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DB_PATH=/data/ideaflow.db
COPY package*.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
# --ignore-scripts: better-sqlite3 ships platform prebuilds (prebuilds/linux-x64.node)
# which it loads directly, so the node-gyp rebuild triggered by its binding.gyp is
# unnecessary in the runtime stage (and would fail: no python/make/g++ here).
# No other prod dependency has install scripts (verified in package-lock.json).
RUN npm ci --omit=dev --ignore-scripts
COPY --from=build /app/apps/api/dist /app/apps/api/dist
COPY --from=build /app/apps/api/backup.mjs /app/apps/api/backup.mjs
COPY --from=build /app/apps/web/dist /app/apps/web/dist
RUN mkdir -p /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)process.exit(1);process.exit(0)}).catch(()=>process.exit(1))"
CMD ["npm","start"]
