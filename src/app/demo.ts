// Demo wallet: the same five steps as a real NEAR wallet (connect, create a
// budget, give the agent a key, call, attack), simulated on the in-memory ledger.
// Nothing leaves the server and nothing needs a browser wallet, so it is instant.
import { createHash } from "node:crypto";
import { USDC } from "../api.js";
import type { MockLedger } from "../ledger/mock.js";
import { dayIndex, FirewallError, type Policy } from "../policy.js";

export const DEMO_HUB = "hub.demo.near";
const FAUCET = USDC(5);
const MAX_ACCOUNTS = 2000;
const MAX_PAYEES = 16;

interface Account {
  hasBudget: boolean;
  keyAdded: boolean;
  faucetDay: number;
}

export interface DemoView {
  budget: { balance: bigint; spentToday: bigint; policy: Policy; faucetReady: boolean } | null;
  keyAdded: boolean;
}

export class DemoWallets {
  private accounts = new Map<string, Account>();
  private seq = 0;

  constructor(
    private ledger: MockLedger,
    private payees: string[],
    private now: () => number = Date.now,
  ) {}

  view(id: string): DemoView {
    const a = this.accounts.get(id);
    if (!a?.hasBudget) return { budget: null, keyAdded: Boolean(a?.keyAdded) };
    return {
      budget: {
        balance: this.ledger.balanceOf(id),
        spentToday: this.ledger.spentToday(id),
        policy: this.ledger.getPolicy(id),
        faucetReady: a.faucetDay !== dayIndex(this.now()),
      },
      keyAdded: a.keyAdded,
    };
  }

  /** Runs one owner transaction as if it had been signed in a wallet. Returns a fake tx hash. */
  sign(id: string, method: string, args: Record<string, unknown>): string {
    const a = this.account(id);
    switch (method) {
      case "create_vault": {
        if (a.hasBudget) throw demoError("ERR_VAULT_EXISTS", "you already have a budget");
        const allowlist = list(args.allowlist).filter((p) => this.payees.includes(p)).slice(0, MAX_PAYEES);
        this.ledger.createVault(id, {
          perTxMax: amount(args.per_tx_max, USDC(0.1)),
          dailyMax: amount(args.daily_max, USDC(0.2)),
          allowlist,
          paused: false,
        });
        this.ledger.mint(id, FAUCET);
        a.hasBudget = true;
        a.faucetDay = dayIndex(this.now());
        break;
      }
      case "add_key":
        a.keyAdded = true;
        break;
      case "delete_key":
        a.keyAdded = false;
        break;
      case "faucet": {
        this.needBudget(a);
        if (a.faucetDay === dayIndex(this.now())) throw demoError("ERR_FAUCET_USED_TODAY", "the faucet gives 5 USDC once a day");
        this.ledger.mint(id, FAUCET);
        a.faucetDay = dayIndex(this.now());
        break;
      }
      case "set_limits":
        this.needBudget(a);
        this.ledger.setPolicy(id, { perTxMax: amount(args.per_tx_max, USDC(0.1)), dailyMax: amount(args.daily_max, USDC(0.2)) });
        break;
      case "add_payee":
      case "remove_payee": {
        this.needBudget(a);
        const payee = String(args.payee ?? "");
        if (!this.payees.includes(payee)) throw demoError("ERR_BAD_PAYEE", "unknown API");
        const others = this.ledger.getPolicy(id).allowlist.filter((p) => p !== payee);
        this.ledger.setPolicy(id, { allowlist: method === "add_payee" ? [...others, payee] : others });
        break;
      }
      case "set_paused":
        this.needBudget(a);
        this.ledger.setPolicy(id, { paused: Boolean(args.paused) });
        break;
      case "reset_day":
        this.needBudget(a);
        this.ledger.resetDay(id);
        break;
      default:
        throw demoError("ERR_BAD_METHOD", `unknown method ${method}`);
    }
    return createHash("sha256").update(`demo-${id}-${++this.seq}`).digest("base64url").slice(0, 44);
  }

  /** Removes a throwaway account (used by the guided tour after each step). */
  forget(id: string) {
    this.accounts.delete(id);
    this.ledger.dropVault(id);
  }

  private account(id: string): Account {
    let a = this.accounts.get(id);
    if (!a) {
      if (this.accounts.size >= MAX_ACCOUNTS) throw Object.assign(new Error("too many demo wallets on this server; restart it"), { status: 503 });
      a = { hasBudget: false, keyAdded: false, faucetDay: -1 };
      this.accounts.set(id, a);
    }
    return a;
  }

  private needBudget(a: Account) {
    if (!a.hasBudget) throw new FirewallError("ERR_NO_VAULT", "create your budget first");
  }
}

function demoError(code: string, reason: string) {
  return Object.assign(new Error(`${code}: ${reason}`), { status: 409 });
}

function list(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

/** micro-USDC from the client, clamped to 0.01 .. 5 USDC. */
function amount(value: unknown, fallback: bigint): bigint {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return BigInt(Math.max(10_000, Math.min(5_000_000, Math.round(n))));
}
