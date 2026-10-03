CREATE INDEX orders_fund_history ON orders(fund_id, submitted_at DESC, id DESC);
CREATE INDEX orders_captain_history ON orders(captain_id, submitted_at DESC, id DESC);
CREATE INDEX crew_event_history ON fund_events((payload->>'userId'), recorded_at DESC, id DESC)
  WHERE type IN ('crew_joined','crew_left');
CREATE INDEX settlement_event_history ON fund_events(recorded_at DESC, id DESC)
  WHERE type='trial_completed';
