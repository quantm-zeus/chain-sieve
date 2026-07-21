# Local containers

From the repository root run `docker compose up -d`, wait for PostgreSQL, MinIO, and `minio-init`, then run `pnpm db:migrate`. PostgreSQL listens on 5432; MinIO listens on 9000 and its console on 9001. The init service creates the local immutable-artifact bucket. Credentials in the example are development-only.
