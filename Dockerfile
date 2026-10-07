FROM node:20-alpine

# Install build tools for native node modules (like better-sqlite3)
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy package files and install dependencies
COPY package.json package-lock.json* ./
RUN npm ci

# Copy all project files
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

# Build the Next.js application
RUN npm run build

# The office keeps its database and the generated projects here; mount a volume on it
RUN mkdir -p /app/workspace && chown -R node:node /app/workspace /app/.next

# Run as an unprivileged user
USER node

EXPOSE 3000
ENV PORT=3000

# Inside a container the server has to listen on every interface; publish the port
# to this computer only (docker run -p 127.0.0.1:3000:3000 …), as the office has no login.
CMD ["npx", "next", "start", "-H", "0.0.0.0"]
