-- A deposit claim expires only after the chain passes this block height (finalized). It is set
-- the first time the signature is missing on chain: the processed tip then, plus the blockhash
-- lifetime and a margin. No transaction that the cluster had not seen by then can land later.
ALTER TABLE token_deposits ADD COLUMN expiry_block_height bigint;
