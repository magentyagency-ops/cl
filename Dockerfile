# --- build : compile le TypeScript ---
FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# --- image finale : Node + ffmpeg + yt-dlp ---
FROM node:22-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 python3-venv ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
RUN python3 -m venv .venv && .venv/bin/pip install --no-cache-dir yt-dlp
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY public ./public

ENV MODE=web NODE_ENV=production PORT=8080
EXPOSE 8080
USER node
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
