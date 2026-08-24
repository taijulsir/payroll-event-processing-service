# syntax=docker/dockerfile:1

# ---- build: install deps, produce the static export ----
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .

# NEXT_PUBLIC_* variables are inlined into the JS bundle at build time (Next.js's own
# convention — there is no server at runtime to read them from later), so this must be a
# build ARG, not a runtime environment variable. Defaults to the API's own default port,
# published to the host by docker-compose.yml's `api` service — a browser-reachable address,
# never a Compose-internal service name (see lib/api.ts's own comment for the full reasoning).
ARG NEXT_PUBLIC_API_BASE_URL=http://localhost:3000
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL

RUN npm run build

# ---- runtime: nginx serving the static export (architecture.md §19/§20: "a small static
# build served by a lightweight server") — no Node.js process runs in production. ----
FROM nginx:1.27-alpine AS runtime
COPY --from=build /app/out /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
