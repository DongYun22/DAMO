import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const localEnvPath = path.resolve(moduleDirectory, "../.env.local");

if (existsSync(localEnvPath)) {
  process.loadEnvFile(localEnvPath);
}

export const databaseUrl = () => process.env.DATABASE_URL?.trim() ?? "";

export const webBaseUrl = () =>
  (process.env.WEB_BASE_URL?.trim() || "http://localhost:5173").replace(/\/$/, "");

const isNodeTest = () =>
  Boolean(process.env.NODE_TEST_CONTEXT) || process.argv.includes("--test");

export const shouldUsePostgres = () =>
  process.env.DAMO_STORAGE !== "memory" &&
  !isNodeTest() &&
  databaseUrl().length > 0;
