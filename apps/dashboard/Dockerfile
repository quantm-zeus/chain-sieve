# syntax=docker/dockerfile:1.7
FROM node:22.23.1-alpine AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.13.1 --activate
COPY . .
RUN --mount=type=cache,id=chain-sieve-pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm --filter @ciag/dashboard build

FROM node:22.23.1-alpine AS runtime
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3001
WORKDIR /app
COPY --from=build --chown=node:node /app/apps/dashboard/build ./build
USER node
EXPOSE 3001
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 CMD ["node", "-e", "fetch('http://127.0.0.1:3001/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "build"]
