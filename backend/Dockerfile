# syntax=docker/dockerfile:1

# ---- deps: install once, reused by build and prod stages ----
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

# ---- build: compile TypeScript ----
FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# ---- prod deps: production-only node_modules ----
FROM node:20-alpine AS prod-deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

# ---- runtime: minimal final image, shared by both api and worker services ----
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S app -G app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER app

# docker-compose overrides `command:` to select api (dist/main.js) vs worker
# (dist/worker.js, added in Phase 5) from this same image.
CMD ["node", "dist/main.js"]
