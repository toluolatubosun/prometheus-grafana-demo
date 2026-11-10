FROM node:20-alpine
WORKDIR /app

# Install Corepack and enable it to use pnpm
RUN corepack enable

# Copy package.json and pnpm-lock.yaml first to leverage Docker cache for dependencies
COPY package.json pnpm-lock.yaml ./
RUN pnpm install

# Now copy the rest of the application code
COPY . .

EXPOSE 3000
CMD ["pnpm", "run", "dev"]
