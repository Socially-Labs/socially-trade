ALTER TABLE messages
  ADD COLUMN kind text NOT NULL DEFAULT 'CHAT' CHECK (kind IN ('CHAT', 'TRADE_NOTE')),
  ADD COLUMN moderation_status text NOT NULL DEFAULT 'VISIBLE'
    CHECK (moderation_status IN ('VISIBLE', 'HIDDEN')),
  ADD COLUMN corrects_message_id uuid REFERENCES messages(id),
  ADD COLUMN event_sequence bigint,
  ADD CONSTRAINT messages_kind_link_check CHECK (
    (kind = 'CHAT' AND linked_order_id IS NULL AND corrects_message_id IS NULL)
    OR (kind = 'TRADE_NOTE' AND linked_order_id IS NOT NULL)
  ),
  ADD CONSTRAINT messages_fund_sequence_unique UNIQUE (fund_id, event_sequence);

CREATE INDEX messages_fund_cursor_idx ON messages(fund_id, event_sequence)
  WHERE moderation_status = 'VISIBLE';
