# Migration workflow

SQL in `infra/migrations` is authoritative and ordered. Persistence tasks own migrations. Test empty-to-latest, rerun-safe statements where applicable, startup after migration, constraints, and the Drizzle mirror. Never rewrite a merged migration; add a forward corrective migration and document rollback or compensation.
