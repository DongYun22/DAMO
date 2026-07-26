import { shouldUsePostgres } from "./config.js";
import { PostgresStore } from "./postgres-store.js";
import { MockStore } from "./store.js";

export const store = shouldUsePostgres()
  ? new PostgresStore()
  : new MockStore();

export const storageKind = store instanceof PostgresStore ? "postgres" : "memory";

export const checkStorage = async () => {
  if (store instanceof PostgresStore) await store.healthCheck();
};
