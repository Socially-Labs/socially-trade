-- Existing policies remain unchanged. The seed is explicit and mint based.
UPDATE instruments SET mint_address='So11111111111111111111111111111111111111112' WHERE id='SOL';
INSERT INTO instruments(id,symbol,mint_address,decimals,active) VALUES
 ('JUP','JUP','JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',6,true),
 ('JTO','JTO','jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL',9,true),
 ('BONK','BONK','DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',5,true),
 ('USDC','USDC','EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',6,false);
CREATE UNIQUE INDEX instruments_mint_unique ON instruments(mint_address) WHERE mint_address IS NOT NULL;

CREATE TABLE market_token_metadata (
 mint text PRIMARY KEY,
 payload jsonb NOT NULL,
 fetched_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO market_token_metadata(mint,payload)
 SELECT mint_address,jsonb_build_object('mint',mint_address,'symbol',symbol,
  'name',CASE id WHEN 'SOL' THEN 'Solana' WHEN 'JUP' THEN 'Jupiter' WHEN 'JTO' THEN 'Jito' WHEN 'BONK' THEN 'Bonk' ELSE 'USD Coin' END,
  'decimals',decimals,'icon',NULL,'verified',NULL,'suspicious',false,'liquidityUsd',NULL,
  'volume24hUsd',NULL,'change1h',NULL,'change24h',NULL,'providerUpdatedAt',NULL)
 FROM instruments WHERE id IN ('SOL','JUP','JTO','BONK','USDC');
CREATE TABLE market_samples (
 instrument_id text NOT NULL REFERENCES instruments(id),
 source_at timestamptz NOT NULL,
 price_usd numeric(38,18) NOT NULL CHECK(price_usd>0),
 observation_id uuid NOT NULL REFERENCES price_observations(id),
 PRIMARY KEY(instrument_id,source_at)
);
CREATE TABLE market_watchlist (
 user_id uuid NOT NULL REFERENCES users(id),
 mint text NOT NULL REFERENCES market_token_metadata(mint),
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,mint)
);
-- No chart history is invented on migration. Populate only real accepted prices.
INSERT INTO market_samples(instrument_id,source_at,price_usd,observation_id)
 SELECT DISTINCT ON (instrument_id,source_at) instrument_id,source_at,price_usd,id
 FROM price_observations WHERE source='JUPITER_PRICE_V3' AND price_usd>0
 ORDER BY instrument_id,source_at,received_at DESC;

ALTER TABLE nav_snapshots ADD COLUMN market_mark_ref text;
ALTER TABLE orders ADD COLUMN requested_quantity numeric(38,18) CHECK(requested_quantity>0);
ALTER TABLE orders ADD CONSTRAINT quantity_sell_only CHECK(requested_quantity IS NULL OR side='SELL');
