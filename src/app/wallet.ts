// The owner's side of the practice wallet: read its state and change its policy.
// (In wallet mode the visitor signs these changes in their own NEAR wallet.)
import type { MockLedger } from "../ledger/mock.js";
import type { Policy } from "../policy.js";

export interface WalletView {
  balance: bigint;
  spentToday: bigint;
  policy: Policy;
}

export interface Wallet {
  vault: string;
  view(): Promise<WalletView>;
  setLimits(perTxMax: bigint, dailyMax: bigint): Promise<void>;
  setAllowed(account: string, on: boolean): Promise<void>;
  setPaused(paused: boolean): Promise<void>;
  resetDay(): Promise<void>;
}

export class MockWallet implements Wallet {
  constructor(
    private ledger: MockLedger,
    public vault: string,
  ) {}

  async view() {
    return {
      balance: this.ledger.balanceOf(this.vault),
      spentToday: this.ledger.spentToday(this.vault),
      policy: this.ledger.getPolicy(this.vault),
    };
  }

  async setLimits(perTxMax: bigint, dailyMax: bigint) {
    this.ledger.setPolicy(this.vault, { perTxMax, dailyMax });
  }

  async setAllowed(account: string, on: boolean) {
    const others = this.ledger.getPolicy(this.vault).allowlist.filter((a) => a !== account);
    this.ledger.setPolicy(this.vault, { allowlist: on ? [...others, account] : others });
  }

  async setPaused(paused: boolean) {
    this.ledger.setPolicy(this.vault, { paused });
  }

  async resetDay() {
    this.ledger.resetDay(this.vault);
  }
}
