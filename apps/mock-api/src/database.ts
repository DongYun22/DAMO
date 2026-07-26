import { Pool, type PoolConfig } from "pg";
import { databaseUrl } from "./config.js";

const poolConfig = (): PoolConfig => {
  const connectionString = databaseUrl();
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL이 설정되지 않았습니다. apps/mock-api/.env.local 또는 배포 환경변수를 확인해 주세요."
    );
  }

  const isLocal =
    connectionString.includes("localhost") ||
    connectionString.includes("127.0.0.1");

  return {
    connectionString,
    max: Number(process.env.DAMO_DB_POOL_MAX ?? 5),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: isLocal ? undefined : { rejectUnauthorized: false }
  };
};

export const createDatabasePool = () => new Pool(poolConfig());
