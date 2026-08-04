# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.13.1 --activate
COPY . .
RUN --mount=type=cache,id=chain-sieve-pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm --filter @ciag/api build:production

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
ENV API_HOST=0.0.0.0
ENV API_PORT=3000
ENV OBJECT_STORE_ROOT=/tmp/ciag-object-store
WORKDIR /app
COPY --from=build --chown=node:node /app/dist/api/main.cjs ./main.cjs
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "main.cjs"]
