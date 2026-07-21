FROM node:24.14.0-alpine AS build
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm --filter @ciag/dashboard build
ENV HOST=0.0.0.0
ENV PORT=3001
EXPOSE 3001
CMD ["node", "apps/dashboard/build"]
