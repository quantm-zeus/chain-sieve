# Local development

Install exact Node.js 22.23.1 and pnpm 10.13.1 (Corepack is supported), copy `.env.example` to `.env`, run `docker compose up -d`, then `pnpm install --frozen-lockfile`, `pnpm migration:verify`, and `pnpm dev`. API defaults to port 3000 and dashboard to 5173. Filesystem object storage is the default; MinIO is available on port 9000. No live provider key is needed or accepted by the bootstrap.
