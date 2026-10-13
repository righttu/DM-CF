import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

await applyD1Migrations(
  (env as { DEMO_DB: D1Database }).DEMO_DB,
  (env as { TEST_MIGRATIONS: never }).TEST_MIGRATIONS
);
