import { ApiFault } from "./errors.js";

export function idempotencyKey(value: unknown): string {
  if (typeof value !== "string" || value.length < 8 || value.length > 128) {
    throw new ApiFault(400, "idempotency_key_required", "Idempotency-Key must be 8-128 characters");
  }
  return value;
}

export function sequenceCursor(value: unknown): number {
  const raw = value ?? "0";
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) {
    throw new ApiFault(400, "invalid_cursor", "after must be a nonnegative integer");
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new ApiFault(400, "invalid_cursor", "after must be a nonnegative integer");
  }
  return parsed;
}
