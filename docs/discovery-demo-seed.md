# Discovery demo fixtures

Run `pnpm build` then `node scripts/seed-discovery-demo.mjs` to preview. `node scripts/seed-discovery-demo.mjs --apply` applies additive migration 037 and inserts the fixtures into a **local development** database. Migration 036 must already exist. The helper refuses production/nonlocal databases. Repeat runs preserve the same records and do not reset history or duplicate balances. Unexpected partial ownership causes a rollback rather than an overwrite.

Five fictional Captains, five vaults, and 22 shared fictional Crew accounts are created. All names/descriptions identify demo data; public DTOs include `isDemo`. Contributions, cancellations, and claims are blocked for seeded vaults, and contribution quotes report `demo_read_only`. The lifecycle worker excludes demo vaults from its due-round queue. Seed auth subjects are distinct from Privy identities and do not grant login access.

| Captain | Vault | Principal USDC | Approx. simulated 30D return | Crew |
| --- | --- | ---: | ---: | ---: |
| Elias Silver | Silver Tide | 18,000 | +0.33% | 14 |
| Mara Flint | Coral Compass | 24,500 | +3.27% | 22 |
| Isolde Drake | Stormwake | 9,600 | −14.62% | 9 |
| Rowan Vale | Golden Horizon | 27,500 | +8.91% | 18 |
| Silas Crow | Quiet Harbor | 3,200 | 0.00% / funding | 5 |

Figures describe the captured fixture, not promises or live Hyperliquid returns. Four vaults have a funding mark 35 days before seeding and 13 monthly P&L samples across the last 30 days. Quiet Harbor is a new fundraising round with one mark, demonstrating a chart without enough history. All rounds respect our 30,000 USDC principal limit. The passage of time changes selected-period baselines normally.

## Data provenance and accounting

`seed/discovery/hyperliquid-reference.json` records the public source URL, retrieval time, selected vault addresses, TVL, APR, and monthly **dollar P&L** samples. Source: [Hyperliquid public vault statistics](https://stats-data.hyperliquid.xyz/Mainnet/vaults); field semantics are described by [Hyperliquid's vault API](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint#retrieve-details-for-a-vault).

The series is scaled to constant fictional principal using `samplePnl / (referenceTVL - finalSamplePnl)`. This is a synthetic shape, **not** the source vault's TWR, because real cash-flow histories differ. APR is saved only as reference and never treated as a 30D return. Real trader names, account identities, images, and trading fills are not imported. Provenance stays in the seed metadata table; public profiles show original fictional identities.

Seed grants and contributions have balanced USDC and share ledger entries. Synthetic profit/loss marks balance against a named demo market counterparty. They use `demo_performance_mark` events and the normal NAV triggers to populate aggregate observations and rollups. No financial projection is overwritten directly. Fund and user reconciliation are checked in an isolated integration schema. Demo entries generate no notification delivery intents.

## Artwork

Five original pirate ship/coast covers were generated with the built-in imagegen tool and saved in `apk/assets/images/discovery-demo/`. Exact prompts and filenames are in that directory's `provenance.json`. The app bundles compressed JPEGs (about 1.8 MB total) and uses the existing five pirate Captain portraits. `discovery_demo_seeds.media_key` links each DB pair to its bundled cover; `apk/src/components/discover/demo-discovery-media.ts` maps stable seed IDs to those assets. Captain cards, public profiles, and vault views use the artwork offline. User-provided image URLs still take precedence.

No external object storage setup is required. For live local previews, search `demo_` on the Captains tab or `Demo` on the Vaults tab. Browser screenshots are under `apk/.ui-review/discovery-demo/`.
