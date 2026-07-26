import { pathToFileURL } from "node:url";
import { PostgresStore } from "./postgres-store.js";

export const seedDatabase = async () => {
  const store = new PostgresStore();
  try {
    return await store.seedIfEmpty();
  } finally {
    await store.close();
  }
};

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";

if (import.meta.url === entry) {
  seedDatabase()
    .then(({ seeded }) => {
      console.log(
        seeded
          ? "Sample data inserted."
          : "Database already contains users; sample seed skipped."
      );
    })
    .catch((error) => {
      console.error("Database seed failed:", error);
      process.exitCode = 1;
    });
}
