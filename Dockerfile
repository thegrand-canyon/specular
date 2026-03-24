# Use Node.js 22 (matching your local environment)
FROM node:22-slim

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy application code
COPY . .

# Compile contracts (if needed)
RUN npm run compile || true

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3001

# Expose port
EXPOSE 3001

# Start with explicit memory allocation (512 MB)
CMD ["node", "--max-old-space-size=512", "src/api/MultiNetworkAPI.js"]
