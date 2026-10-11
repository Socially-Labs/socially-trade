import pg from "pg";
import { envInteger } from "@socially/domain";
export { paperObservation, orderReservations, cancelFundOrders } from "./paper.js";
export type { PaperObservation } from "./paper.js";

export { appendFundEvent } from "./events.js";
export { ledgerAccountId } from "./ledger.js";
export { saveFundNav } from "./nav.js";

export type DbRow = pg.QueryResultRow;
export type DbClient = pg.PoolClient;
export type DbPool = pg.Pool;

export function createPool(connectionString = process.env.DATABASE_URL): pg.Pool {
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }

  const pool = new pg.Pool({ connectionString, max: envInteger('DB_POOL_MAX',10),
    connectionTimeoutMillis: envInteger('DB_CONNECT_TIMEOUT_MS',5000),
    statement_timeout: envInteger('DB_STATEMENT_TIMEOUT_MS',10000),
    lock_timeout: envInteger('DB_LOCK_TIMEOUT_MS',3000),
    idle_in_transaction_session_timeout: envInteger('DB_IDLE_TRANSACTION_TIMEOUT_MS',15000) });
  pool.on("error", (error) => console.error("Idle PostgreSQL client error", error));
  return pool;
}

export async function inTransaction<T>(
  pool: pg.Pool,
  work: (client: DbClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(`BEGIN; SET LOCAL lock_timeout='${envInteger('DB_LOCK_TIMEOUT_MS',3000)}ms'; SET LOCAL statement_timeout='${envInteger('DB_STATEMENT_TIMEOUT_MS',10000)}ms'`);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

