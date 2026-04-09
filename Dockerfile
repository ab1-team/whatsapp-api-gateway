# Build stage
FROM node:22-alpine

# Install build dependencies for better-sqlite3 (jika nanti dibutuhkan) atau dependensi lain
RUN apk add --no-cache python3 make g++

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (production only)
RUN npm install --omit=dev

# Copy source code
COPY . .

# Create necessary directories
RUN mkdir -p data sessions

# Environment variables
ENV NODE_ENV=production
ENV PORT=3000

# Expose port
EXPOSE 3000

# Run the app
CMD ["npm", "start"]
