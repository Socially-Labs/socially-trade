CREATE INDEX IF NOT EXISTS vault_operations_user_history_idx
  ON vault_operations(user_id,created_at DESC,id DESC);
