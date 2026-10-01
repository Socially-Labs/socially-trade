import type { DbPool } from "@socially/db";

type FundJob = { kind: "VALUATION" } | { kind: "FEES"; feeDay: string } | { kind: "EXPIRED"; now: Date };

/** Visit the eligible fund range in bounded pages; a quiet first page must not starve later funds. */
export async function* eligibleFundBatches(pool: DbPool, job: FundJob): AsyncGenerator<Array<{ id: string }>> {
  const upper = (await pool.query<{ id: string }>(
    "SELECT id FROM funds WHERE status IN ('ACTIVE','FROZEN') ORDER BY id DESC LIMIT 1",
  )).rows[0]?.id;
  if (!upper) return;
  let after: string | null = null;
  const condition = job.kind === "VALUATION"
    ? "EXISTS(SELECT 1 FROM positions p WHERE p.fund_id=f.id AND p.quantity>0)"
    : job.kind === "FEES"
      ? "NOT EXISTS(SELECT 1 FROM fee_assessments a WHERE a.fund_id=f.id AND a.fee_day=$3)"
      : "EXISTS(SELECT 1 FROM trials t WHERE t.fund_id=f.id AND t.ends_at<=$3)";
  for (;;) {
    const page: { rows: Array<{ id: string }> } = await pool.query<{ id: string }>(
      `SELECT f.id FROM funds f WHERE f.status IN ('ACTIVE','FROZEN')
       AND ($1::uuid IS NULL OR f.id>$1) AND f.id<=$2 AND ${condition} ORDER BY f.id LIMIT 100`,
      job.kind === "VALUATION" ? [after, upper] : [after, upper, job.kind === "FEES" ? job.feeDay : job.now],
    );
    if (!page.rows.length) return;
    yield page.rows;
    if (page.rows.length < 100) return;
    after = page.rows[page.rows.length - 1]!.id;
  }
}
