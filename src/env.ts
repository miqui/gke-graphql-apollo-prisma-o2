// Builds DATABASE_URL from the same discrete DB_HOST/DB_PORT/DB_NAME/DB_USER/
// DB_PASSWORD env vars the old Spring datasource used (k8s/configmap.yaml and the
// message-service-db-credentials Secret) - Prisma itself only understands a single
// connection-string env var. DB_SSLMODE (optional) becomes ?sslmode=: Cloud SQL
// requires TLS ("require"); unset locally, so plain connections keep working. Must be
// imported before "@prisma/client" anywhere in the process, since PrismaClient reads it
// at construction time (see src/prisma.ts).
if (!process.env.DATABASE_URL) {
  const host = process.env.DB_HOST ?? "localhost";
  const port = process.env.DB_PORT ?? "5432";
  const name = process.env.DB_NAME ?? "messagedb";
  const user = process.env.DB_USER ?? "message_app";
  const password = process.env.DB_PASSWORD ?? "message_app";
  const sslmode = process.env.DB_SSLMODE;
  process.env.DATABASE_URL =
    `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}` +
    `@${host}:${port}/${name}` +
    (sslmode ? `?sslmode=${encodeURIComponent(sslmode)}` : "");
}
