// Spending policy for an agent vault. Mirrors the checks in
// contracts/agent-firewall/src/lib.rs so the offline ledger behaves like the chain.

export interface Policy {
  perTxMax: bigint;
  dailyMax: bigint;
  allowlist: string[];
  paused: boolean;
}

export interface SpendState {
  day: number;
  spentToday: bigint;
}

export type FirewallCode =
  | "ERR_PAUSED"
  | "ERR_ZERO"
  | "ERR_PER_TX_LIMIT"
  | "ERR_PAYEE_NOT_ALLOWED"
  | "ERR_MEMO_TOO_LONG"
  | "ERR_DAILY_LIMIT";

export type Decision = { ok: true } | { ok: false; code: FirewallCode; reason: string };

export const MAX_MEMO_LEN = 64;
const MS_PER_DAY = 86_400_000;

export const dayIndex = (nowMs: number) => Math.floor(nowMs / MS_PER_DAY);

export function rollDay(state: SpendState, nowMs: number): SpendState {
  const day = dayIndex(nowMs);
  return day === state.day ? state : { day, spentToday: 0n };
}

export function checkPayment(
  policy: Policy,
  state: SpendState,
  payee: string,
  amount: bigint,
  memo: string,
  nowMs: number,
): Decision {
  if (policy.paused) return deny("ERR_PAUSED", "vault is paused by its owner");
  if (amount <= 0n) return deny("ERR_ZERO", "amount must be positive");
  if (amount > policy.perTxMax)
    return deny("ERR_PER_TX_LIMIT", `amount ${amount} exceeds per-tx max ${policy.perTxMax}`);
  if (!policy.allowlist.includes(payee))
    return deny("ERR_PAYEE_NOT_ALLOWED", `${payee} is not on the allowlist`);
  if (memo.length > MAX_MEMO_LEN) return deny("ERR_MEMO_TOO_LONG", "memo too long");
  const { spentToday } = rollDay(state, nowMs);
  if (spentToday + amount > policy.dailyMax)
    return deny("ERR_DAILY_LIMIT", `would spend ${spentToday + amount} of daily max ${policy.dailyMax}`);
  return { ok: true };
}

function deny(code: FirewallCode, reason: string): Decision {
  return { ok: false, code, reason };
}

export class FirewallError extends Error {
  constructor(
    public code: FirewallCode,
    reason: string,
  ) {
    super(`${code}: ${reason}`);
    this.name = "FirewallError";
  }
}
