import { inTransaction, type DbPool } from "@socially/db";

const INBOX_TYPES = [
  "order_submitted", "order_filled", "order_rejected", "order_cancelled",
  "drawdown_breaker", "fee_assessed", "trial_completed", "policy_changed",
  "trade_note_posted", "vault_contributed", "crew_joined",
];

interface OutboxRow {
  id: string;
  fund_id: string | null;
  type: string;
  payload: Record<string, unknown>;
}

async function deliverOne(pool: DbPool, outboxId: string): Promise<boolean> {
  return inTransaction(pool, async (client) => {
    const selected = await client.query<OutboxRow>(
      `SELECT o.id, e.fund_id, o.type, o.payload
       FROM outbox_events o JOIN fund_events e ON e.id = o.fund_event_id
       WHERE o.id = $1 AND o.delivered_at IS NULL AND o.next_attempt_at <= now()
       FOR UPDATE OF o SKIP LOCKED`,
      [outboxId],
    );
    const item = selected.rows[0];
    if (!item) return false;
    if (item.fund_id && INBOX_TYPES.includes(item.type)) {
      await client.query(
        `INSERT INTO notifications (outbox_event_id, user_id, fund_id, type, payload)
         SELECT $1, recipients.user_id, $2, $3, $4
         FROM (
           SELECT captain_id AS user_id FROM funds WHERE id = $2 AND ($3 NOT IN ('vault_contributed','crew_joined') OR captain_id::text <> $4::jsonb->>'userId')
           UNION
           SELECT user_id FROM fund_shares WHERE fund_id = $2 AND shares > 0 AND $3 NOT IN ('vault_contributed','crew_joined')
           UNION
           SELECT (payout->>'userId')::uuid FROM jsonb_array_elements(
             CASE WHEN $3='trial_completed' THEN COALESCE($4::jsonb->'payouts','[]'::jsonb)
             ELSE '[]'::jsonb END
           ) payout
         ) recipients ORDER BY recipients.user_id
         ON CONFLICT (outbox_event_id, user_id) DO NOTHING`,
        [item.id, item.fund_id, item.type, item.payload],
      );
    }
    if (!item.fund_id && item.type === 'wallet_received' && typeof item.payload.userId === 'string') {
      await client.query(`INSERT INTO notifications(outbox_event_id,user_id,fund_id,type,payload)
        SELECT $1,id,NULL,$3,$4 FROM users WHERE id=$2::uuid
        ON CONFLICT(outbox_event_id,user_id) DO NOTHING`, [item.id,item.payload.userId,item.type,item.payload]);
    }
    await client.query("UPDATE outbox_events SET delivered_at = now() WHERE id = $1", [item.id]);
    return true;
  });
}

export async function deliverOutbox(pool: DbPool): Promise<number> {
  const candidates = await pool.query<{ id: string }>(
    `SELECT id FROM outbox_events
     WHERE delivered_at IS NULL AND next_attempt_at <= now()
     ORDER BY next_attempt_at, id LIMIT 100`,
  );
  let delivered = 0;
  for (const candidate of candidates.rows) {
    try {
      if (await deliverOne(pool, candidate.id)) delivered++;
    } catch (error) {
      console.error("Outbox delivery failed", { outboxId: candidate.id, error });
      await pool.query(
        `UPDATE outbox_events
         SET attempts = attempts + 1,
             next_attempt_at = now() + interval '30 seconds' * LEAST(100, attempts + 1)
         WHERE id = $1 AND delivered_at IS NULL`,
        [candidate.id],
      );
    }
  }
  return delivered;
}
