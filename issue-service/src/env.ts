// Builds DATABASE_URL from discrete DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD env
// vars, same convention as message-service's src/env.ts, but defaulting to the
// "issuedb" database (k8s/postgres.yaml) on the same Cloud SQL instance. DB_SSLMODE
// (optional) becomes ?sslmode=, as in message-service. Must be imported before
// "@prisma/client" anywhere in the process, since PrismaClient reads it at construction
// time (see src/prisma.ts).
if (!process.env.DATABASE_URL) {
  const host = process.env.DB_HOST ?? "localhost";
  const port = process.env.DB_PORT ?? "5432";
  const name = process.env.DB_NAME ?? "issuedb";
  const user = process.env.DB_USER ?? "issue_app";
  const password = process.env.DB_PASSWORD ?? "issue_app";
  const sslmode = process.env.DB_SSLMODE;
  process.env.DATABASE_URL =
    `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}` +
    `@${host}:${port}/${name}` +
    (sslmode ? `?sslmode=${encodeURIComponent(sslmode)}` : "");
}
