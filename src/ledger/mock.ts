import { createHash } from "node:crypto";
import { checkPayment, FirewallError, rollDay, type Policy, type SpendState } from "../policy.js";
import type { FtTransferEvent, Ledger } from "./types.js";

interface Vault {
  policy: Policy;
  state: SpendState;
}

interface Tx {
  sender: string;
  events: FtTransferEvent[];
}

/**
 * In-memory stand-in for NEAR: one NEP-141 token plus firewall vaults running
 * the same policy as the on-chain contract. Lets the demo and tests run offline.
 */
export class MockLedger implements Ledger {
  network = "near-mock";
  private balances = new Map<string, bigint>();
  private vaults = new Map<string, Vault>();
  private txs = new Map<string, Tx>();
  private seq = 0;

  constructor(
    public asset: string,
    private now: () => number = Date.now,
  ) {}

  mint(account: string, amount: bigint) {
    this.balances.set(account, this.balanceOf(account) + amount);
  }

  /** Forgets a vault and its balance (the guided tour's throwaway budgets). */
  dropVault(vault: string) {
    this.vaults.delete(vault);
    this.balances.delete(vault);
  }

  balanceOf(account: string) {
    return this.balances.get(account) ?? 0n;
  }

  createVault(vault: string, policy: Policy) {
    this.vaults.set(vault, { policy, state: { day: 0, spentToday: 0n } });
  }

  /** Owner-only actions on chain; here the demo calls them directly. */
  setPolicy(vault: string, patch: Partial<Policy>) {
    const v = this.mustVault(vault);
    v.policy = { ...v.policy, ...patch };
  }

  getPolicy(vault: string): Policy {
    return { ...this.mustVault(vault).policy };
  }

  /** Starts a new spending day, as if the clock had passed midnight. */
  resetDay(vault: string) {
    const v = this.mustVault(vault);
    v.state = { day: v.state.day, spentToday: 0n };
  }

  spentToday(vault: string) {
    const v = this.mustVault(vault);
    return rollDay(v.state, this.now()).spentToday;
  }

  async pay({ vault, payee, amount, memo }: { vault: string; payee: string; amount: bigint; memo: string }) {
    const v = this.mustVault(vault);
    const decision = checkPayment(v.policy, v.state, payee, amount, memo, this.now());
    if (!decision.ok) throw new FirewallError(decision.code, decision.reason);

    const hash = this.nextHash();
    const events: FtTransferEvent[] = [];
    // Like the contract: count the spend, and only keep it if the token transfer succeeds.
    if (this.balanceOf(vault) >= amount) {
      const state = rollDay(v.state, this.now());
      v.state = { ...state, spentToday: state.spentToday + amount };
      this.balances.set(vault, this.balanceOf(vault) - amount);
      this.mint(payee, amount);
      events.push({ executor: this.asset, oldOwner: vault, newOwner: payee, amount, memo });
    }
    this.txs.set(hash, { sender: vault, events });
    return hash;
  }

  async transfersIn(txHash: string, sender: string) {
    const tx = this.txs.get(txHash);
    if (!tx || tx.sender !== sender) return [];
    return tx.events;
  }

  private mustVault(vault: string) {
    const v = this.vaults.get(vault);
    if (!v) throw new Error(`no vault ${vault}`);
    return v;
  }

  private nextHash() {
    return createHash("sha256").update(`tx-${++this.seq}`).digest("base64url").slice(0, 44);
  }
}
