import { randomUUID } from "node:crypto";
import type { DbClient } from "./index.js";

/** Post a fund event and its delivery intent in the caller's transaction. */
export async function appendFundEvent(
  client: DbClient,
  fundId: string,
  type: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const sequence = await client.query<{ event_sequence: string }>(
    "UPDATE funds SET event_sequence = event_sequence + 1 WHERE id = $1 RETURNING event_sequence::text",
    [fundId],
  );
  if (!sequence.rows[0]) throw new Error("Fund not found while appending an event");
  const eventId = randomUUID();
  await client.query(
    "INSERT INTO fund_events (id, fund_id, sequence, type, payload) VALUES ($1, $2, $3, $4, $5)",
    [eventId, fundId, sequence.rows[0].event_sequence, type, payload],
  );
  await client.query(
    "INSERT INTO outbox_events (id, fund_event_id, type, payload) VALUES ($1, $2, $3, $4)",
    [randomUUID(), eventId, type, payload],
  );
  return eventId;
}
