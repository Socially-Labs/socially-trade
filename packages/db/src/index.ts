import pg from "pg";

export type DbClient = pg.PoolClient;
export type DbPool = pg.Pool;

export function createPool(connectionString = process.env.DATABASE_URL): pg.Pool {
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }

  const pool = new pg.Pool({ connectionString, max: 10 });
  pool.on("error", (error) => console.error("Idle PostgreSQL client error", error));
  return pool;
}

export async function inTransaction<T>(
  pool: pg.Pool,
  work: (client: DbClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
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
