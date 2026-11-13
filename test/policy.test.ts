import { describe, expect, it } from "vitest";
import { checkPayment, dayIndex, rollDay, type Policy } from "../src/policy.js";

const policy: Policy = { perTxMax: 100n, dailyMax: 250n, allowlist: ["api.near"], paused: false };
const now = Date.UTC(2026, 10, 8, 12);
const today = { day: dayIndex(now), spentToday: 0n };

const code = (d: ReturnType<typeof checkPayment>) => (d.ok ? "OK" : d.code);

describe("checkPayment", () => {
  it("allows a payment within all limits", () => {
    expect(code(checkPayment(policy, today, "api.near", 100n, "n", now))).toBe("OK");
  });

  it.each([
    ["paused", { ...policy, paused: true }, "api.near", 1n, "", "ERR_PAUSED"],
    ["zero", policy, "api.near", 0n, "", "ERR_ZERO"],
    ["over per-tx max", policy, "api.near", 101n, "", "ERR_PER_TX_LIMIT"],
    ["unknown payee", policy, "drainer.near", 1n, "", "ERR_PAYEE_NOT_ALLOWED"],
    ["long memo", policy, "api.near", 1n, "x".repeat(65), "ERR_MEMO_TOO_LONG"],
  ] as const)("blocks %s", (_name, p, payee, amount, memo, expected) => {
    expect(code(checkPayment(p, today, payee, amount, memo, now))).toBe(expected);
  });

  it("enforces the daily cap", () => {
    expect(code(checkPayment(policy, { ...today, spentToday: 200n }, "api.near", 51n, "", now))).toBe("ERR_DAILY_LIMIT");
    expect(code(checkPayment(policy, { ...today, spentToday: 200n }, "api.near", 50n, "", now))).toBe("OK");
  });

  it("resets the budget on a new day", () => {
    const yesterday = { day: today.day - 1, spentToday: 250n };
    expect(rollDay(yesterday, now)).toEqual({ day: today.day, spentToday: 0n });
    expect(code(checkPayment(policy, yesterday, "api.near", 100n, "", now))).toBe("OK");
  });
});
