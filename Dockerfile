# Three stages: install the packages, build the server, then copy only the self-contained
# server (next.config.mjs, BUILD_DOCKER) into a slim image.

FROM node:22-alpine AS deps
# better-sqlite3 is compiled here; the tools stay in this stage and never reach the image
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
# The desktop app's Electron and the test browser are not part of the server: skip their downloads
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN BUILD_DOCKER=1 npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
COPY --from=build --chown=node:node /app/public ./public

# The office keeps its database and the generated projects here; mount a volume on it
RUN mkdir -p /app/workspace && chown node:node /app/workspace

# Run as an unprivileged user
USER node

EXPOSE 3000
ENV PORT=3000
# Inside a container the server has to listen on every interface; publish the port
# to this computer only (docker run -p 127.0.0.1:3000:3000 …), as the office has no login.
# (Docker sets HOSTNAME to the container id, which the server would otherwise listen on.)
ENV HOSTNAME=0.0.0.0

CMD ["node", "server.js"]
