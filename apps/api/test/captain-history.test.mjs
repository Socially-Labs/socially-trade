import assert from 'node:assert/strict';
import test from 'node:test';
import pg from 'pg';
import { captainHistory } from '../src/captain-history.ts';

test('an empty discovery page makes no history query', async () => {
  const history = await captainHistory({ query: () => { throw new Error('Unexpected query'); } }, []);
  assert.equal(history.size, 0);
});
const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
test('history counts distinct valid UTC days, excluding gaps, unknown marks and future records', { skip: !url }, async () => {
  assert.match(new URL(url).hostname, /^(localhost|127\.0\.0\.1|\[::1\])$/);
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  const id = '11111111-1111-4111-8111-111111111111', empty = '22222222-2222-4222-8222-222222222222';
  try {
    await client.query('BEGIN');
    await client.query('CREATE TEMP TABLE captain_portfolio_observations(captain_id uuid,recorded_at timestamptz,index_value numeric,has_gap boolean) ON COMMIT DROP');
    await client.query(`INSERT INTO captain_portfolio_observations VALUES
      ($1,'2020-01-01T01:00:00Z',100,false),($1,'2020-01-01T23:00:00Z',101,false),
      ($1,'2020-01-02T01:00:00+02:00',102,false),($1,'2020-01-02T02:00:00Z',103,false),
      ($1,'2020-01-03T00:00:00Z',NULL,false),($1,'2020-01-04T00:00:00Z',104,true),
      ($1,transaction_timestamp()+interval '1 day',105,false)`, [id]);
    const history = await captainHistory(client, [id, empty]);
    assert.deepEqual(history.get(id), { recordedDays: 2 });
    assert.deepEqual(history.get(empty), { recordedDays: 0 });
  } finally { await client.query('ROLLBACK'); await client.end(); }
});
