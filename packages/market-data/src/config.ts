export interface JupiterAccount {
  /** Safe identifier for diagnostics; never expose the credential. */
  id: string;
  key: string;
  /** Stable across replicas and credential rotation. */
  organisation: string;
}

export function loadJupiterAccounts(env: NodeJS.ProcessEnv = process.env): JupiterAccount[] {
  const accounts: JupiterAccount[] = [];
  for (let i = 1; i <= 10; i++) {
    const id = `JUP_ACC_${i}`;
    const key = env[id]?.trim();
    if (key) accounts.push({ id, key, organisation: id });
  }
  // Legacy keys belong to ONE organisation and must share its budget.
  if (!accounts.length) {
    const keys = (env.JUPITER_API_KEYS ?? "").split(",").map(key => key.trim()).filter(Boolean);
    const organisation = env.JUPITER_ORGANISATION_ID?.trim();
    if (keys.length && !organisation) throw new Error("Legacy Jupiter keys require JUPITER_ORGANISATION_ID");
    keys.forEach((key, i) => accounts.push({ id: `legacy_${i + 1}`, key, organisation: organisation! }));
  } else if (env.JUPITER_API_KEYS?.trim()) {
    throw new Error("Configure JUP_ACC_1..10 or legacy JUPITER_API_KEYS, not both");
  }
  if (!accounts.length) throw new Error("Configure at least one server-only JUP_ACC_1..10 credential");
  if (new Set(accounts.map(account => account.key)).size !== accounts.length) {
    throw new Error("Duplicate Jupiter credentials are not allowed");
  }
  return accounts;
}
