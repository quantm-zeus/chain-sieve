FROM node:22.23.1-alpine AS build
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build
EXPOSE 3000
CMD ["pnpm", "--filter", "@ciag/api", "start"]
