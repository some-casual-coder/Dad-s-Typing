export type ErrorCode =
  | "not_found" | "forbidden" | "stale" | "invalid" | "conflict" | "idempotency_mismatch" | "not_payable";

const STATUS: Record<ErrorCode, number> = {
  not_found: 404, forbidden: 403, stale: 409, invalid: 422, conflict: 409, idempotency_mismatch: 422, not_payable: 409,
};

export class DomainError extends Error {
  readonly status: number;
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
    this.status = STATUS[code];
  }
}
