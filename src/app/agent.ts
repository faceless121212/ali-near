// The demo agent. It does what createPayingFetch does (402 → pay → retry) but
// records every step, so the app can show the whole Near6 handshake.
import type { Ledger } from "../ledger/types.js";
import {
  decodeHeader,
  encodeHeader,
  PROTOCOL_VERSION,
  SCHEME,
  X402_V2,
  type PaymentPayload,
  type PaymentPayloadV2,
  type PaymentRequiredBody,
  type PaymentRequiredV2,
} from "../near6/types.js";
import { FirewallError, type FirewallCode, type Policy } from "../policy.js";

/** The wallet as the agent sees it just before paying. */
export interface Budget {
  policy: Policy;
  spentToday: bigint;
  balance: bigint;
}

export interface Check {
  key: FirewallCode;
  label: string;
  ok: boolean;
  detail: string;
}

export interface Step {
  key: "request" | "quote" | "checks" | "pay" | "verify" | "answer";
  title: string;
  status: "ok" | "no";
  detail: string;
  ms: number;
  data?: unknown;
  checks?: Check[];
  tx?: string;
}

export interface Run {
  ok: boolean;
  /** Fits on a tile: "Paid 0.01 USDC", "Blocked: not allowed". */
  short: string;
  steps: Step[];
  result?: unknown;
  tx?: string;
  code?: FirewallCode;
}

const fmt = (units: bigint) => (Number(units) / 1_000_000).toFixed(2);

/**
 * The checks the firewall contract runs, in its order, against the wallet as it
 * was before paying. The contract has the final word; this is what the app shows.
 */
export function firewallChecks(b: Budget, payee: string, amount: bigint, withBalance: boolean): Check[] {
  const checks: Check[] = [
    { key: "ERR_PAUSED", label: "Wallet is active", ok: !b.policy.paused, detail: b.policy.paused ? "paused by the owner" : "not paused" },
    {
      key: "ERR_PER_TX_LIMIT",
      label: "Under the per-call limit",
      ok: amount <= b.policy.perTxMax,
      detail: `${fmt(amount)} ≤ ${fmt(b.policy.perTxMax)}`,
    },
    {
      key: "ERR_PAYEE_NOT_ALLOWED",
      label: "Payee is allowed",
      ok: b.policy.allowlist.includes(payee),
      detail: b.policy.allowlist.includes(payee) ? `${payee} is on the list` : `${payee} is not on the list`,
    },
    {
      key: "ERR_DAILY_LIMIT",
      label: "Within today's budget",
      ok: b.spentToday + amount <= b.policy.dailyMax,
      detail: `${fmt(b.spentToday)} + ${fmt(amount)} ≤ ${fmt(b.policy.dailyMax)}`,
    },
  ];
  if (withBalance) {
    checks.push({ key: "ERR_BALANCE", label: "Enough money", ok: amount <= b.balance, detail: `${fmt(amount)} ≤ ${fmt(b.balance)}` });
  }
  return checks;
}

export const SHORT: Partial<Record<FirewallCode, string>> = {
  ERR_PAUSED: "wallet paused",
  ERR_PER_TX_LIMIT: "over per-call limit",
  ERR_PAYEE_NOT_ALLOWED: "not allowed",
  ERR_DAILY_LIMIT: "daily limit reached",
  ERR_BALANCE: "not enough money",
  ERR_NO_VAULT: "no budget yet",
};

export interface AgentOptions {
  ledger: Ledger;
  vault: string;
  asset: string;
  budget: Budget;
  /** Hub mode also checks the budget's balance. */
  checksBalance: boolean;
}

/** One paid API call, step by step. `url` is absolute; `label` is for the request step. */
export async function runCall(opts: AgentOptions, url: string, label: string): Promise<Run> {
  const steps: Step[] = [];
  let t = Date.now();
  const lap = () => {
    const now = Date.now();
    const ms = now - t;
    t = now;
    return ms;
  };

  const first = await fetch(url);
  steps.push({ key: "request", title: "Agent asks the API", status: "ok", detail: `GET ${label}`, ms: lap() });
  if (first.status !== 402) {
    const body = await first.json().catch(() => null);
    steps.push({ key: "answer", title: "API answers", status: first.ok ? "ok" : "no", detail: `HTTP ${first.status}`, ms: 0, data: body });
    return { ok: first.ok, short: first.ok ? "Free answer" : `Failed: HTTP ${first.status}`, steps, result: body };
  }

  // Prefer x402 v2 (PAYMENT-REQUIRED header); fall back to the v1 body.
  const v2Header = first.headers.get("PAYMENT-REQUIRED");
  const v2 = v2Header ? decodeHeader<PaymentRequiredV2>(v2Header) : null;
  const v1 = v2 ? null : ((await first.json()) as PaymentRequiredBody).accepts[0];
  const offer = v2 ? v2.accepts[0] : null;
  const payTo = offer?.payTo ?? v1!.payTo;
  const nonce = offer?.extra.nonce ?? v1!.extra.nonce;
  const amount = BigInt(offer?.amount ?? v1!.maxAmountRequired);
  steps.push({
    key: "quote",
    title: "402 Payment Required",
    status: "ok",
    detail: `${fmt(amount)} USDC to ${payTo}`,
    ms: 0,
    data: offer
      ? { x402Version: X402_V2, scheme: offer.scheme, network: offer.network, payTo, amount: offer.amount, asset: offer.asset, nonce }
      : { x402Version: PROTOCOL_VERSION, scheme: v1!.scheme, network: v1!.network, payTo, amount: v1!.maxAmountRequired, asset: v1!.asset, nonce },
  });

  const paid = await pay(opts, steps, payTo, amount, nonce, lap);
  if (!paid.ok) return paid.run;

  const proofPayload = { txHash: paid.tx, payer: opts.vault, nonce, from: opts.ledger.fundsHolder };
  const headers: Record<string, string> = offer
    ? { "PAYMENT-SIGNATURE": encodeHeader({ x402Version: X402_V2, resource: v2!.resource, accepted: offer, payload: proofPayload } satisfies PaymentPayloadV2) }
    : { "X-PAYMENT": encodeHeader({ x402Version: PROTOCOL_VERSION, scheme: SCHEME, network: v1!.network, payload: proofPayload } satisfies PaymentPayload) };
  const second = await fetch(url, { headers });
  const body = await second.json().catch(() => null);
  if (!second.ok) {
    steps.push({ key: "verify", title: "API checks the payment", status: "no", detail: `HTTP ${second.status}: ${body?.error ?? "rejected"}`, ms: lap() });
    return { ok: false, short: `Failed: HTTP ${second.status}`, steps, tx: paid.tx };
  }
  steps.push({ key: "verify", title: "API checks the payment", status: "ok", detail: "Found the token transfer with this nonce", ms: lap(), tx: paid.tx });
  steps.push({ key: "answer", title: "Agent gets the answer", status: "ok", detail: "HTTP 200", ms: 0, data: body });
  return { ok: true, short: `Paid ${fmt(amount)} USDC`, steps, result: body, tx: paid.tx };
}

/** A jailbroken agent skipping the API and calling `pay` straight away. */
export async function runDirectPay(opts: AgentOptions, payee: string, amount: bigint): Promise<Run> {
  const steps: Step[] = [
    { key: "request", title: "Agent calls pay() directly", status: "ok", detail: `${fmt(amount)} USDC to ${payee}`, ms: 0 },
  ];
  let t = Date.now();
  const paid = await pay(opts, steps, payee, amount, "", () => {
    const ms = Date.now() - t;
    t = Date.now();
    return ms;
  });
  return paid.ok ? { ok: true, short: "The wallet paid it", steps, tx: paid.tx } : paid.run;
}

type Paid = { ok: true; tx: string } | { ok: false; run: Run };

async function pay(opts: AgentOptions, steps: Step[], payee: string, amount: bigint, memo: string, lap: () => number): Promise<Paid> {
  const checks = firewallChecks(opts.budget, payee, amount, opts.checksBalance);
  try {
    const tx = await opts.ledger.pay({ vault: opts.vault, payee, amount, memo });
    steps.push({ key: "checks", title: "Firewall checks the rules", status: "ok", detail: "All checks passed", ms: 0, checks });
    steps.push({ key: "pay", title: "Wallet pays", status: "ok", detail: `${fmt(amount)} USDC → ${payee}`, ms: lap(), tx });
    return { ok: true, tx };
  } catch (err) {
    if (!(err instanceof FirewallError)) {
      // Not a rule: the network or the agent's key failed (e.g. its gas allowance ran out).
      const message = ((err as Error).message ?? String(err)).split("\n")[0].slice(0, 160);
      steps.push({ key: "checks", title: "Firewall checks the rules", status: "ok", detail: "Preview passed", ms: 0, checks });
      steps.push({ key: "pay", title: "Wallet pays", status: "no", detail: message, ms: lap() });
      return { ok: false, run: { ok: false, short: "Payment failed", steps } };
    }
    // The contract's answer wins: mark the check it failed on, even if our preview disagreed.
    const marked = checks.map((c) => (c.key === err.code ? { ...c, ok: false } : c));
    const failed = marked.find((c) => c.key === err.code);
    steps.push({
      key: "checks",
      title: "Firewall checks the rules",
      status: "no",
      detail: `Refused: ${err.code}${failed ? `, failed check "${failed.label}"` : ""}`,
      ms: lap(),
      checks: failed ? marked : [...marked, { key: err.code, label: "Budget exists", ok: false, detail: err.code }],
    });
    return { ok: false, run: { ok: false, short: `Blocked: ${SHORT[err.code] ?? err.code}`, steps, code: err.code } };
  }
}
