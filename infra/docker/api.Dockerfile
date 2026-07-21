FROM node:24.14.0-alpine AS build
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build
EXPOSE 3000
CMD ["pnpm", "--filter", "@ciag/api", "start"]
