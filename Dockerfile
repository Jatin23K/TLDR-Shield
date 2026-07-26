# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:22-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

# ── Production stage ─────────────────────────────────────────────────────────
FROM node:22-slim AS production
WORKDIR /app

ENV NODE_ENV=production

# Copy only what's needed for production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy compiled server + frontend from build stage
COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/dist ./dist
# Firebase client config is now inlined in src/firebase.ts — no JSON file needed

EXPOSE 8080

CMD ["node", "dist-server/server.js"]
