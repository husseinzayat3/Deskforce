FROM node:20-alpine

# Install build tools for native node modules (like better-sqlite3)
RUN apk add --no-cache python3 make g++ 

WORKDIR /app

# Copy package files and install dependencies
COPY package.json package-lock.json* ./
RUN npm ci

# Copy all project files
COPY . .

# Build the Next.js application
RUN npm run build

# Next.js telemetry is disabled
ENV NEXT_TELEMETRY_DISABLED 1
ENV NODE_ENV production

# Create workspace directory with proper permissions
RUN mkdir -p /app/workspace && chmod 777 /app/workspace

EXPOSE 3000
ENV PORT 3000

# Start the application
CMD ["npm", "run", "start"]
