// The owner's side of the agent vault: read its state and change its policy.
// MockWallet drives the in-memory ledger; NearWallet calls the Agent Firewall
// contract on NEAR with the owner's key.
import { Account, Connection, InMemorySigner, KeyPair, keyStores, providers } from "near-api-js";
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
  /** Link to a transaction in a block explorer, when there is one. */
  explorer?(tx: string): string;
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

interface PolicyJson {
  per_tx_max: string;
  daily_max: string;
  allowlist: string[];
  paused: boolean;
  spent_today: string;
}

const GAS = 30_000_000_000_000n;

export class NearWallet implements Wallet {
  private owner: Promise<Account>;

  constructor(
    private config: { networkId: string; rpcUrl: string; ownerId: string; ownerKey: string; token: string },
    public vault: string,
  ) {
    const provider = new providers.JsonRpcProvider({ url: config.rpcUrl });
    const keyStore = new keyStores.InMemoryKeyStore();
    const connection = new Connection(config.networkId, provider, new InMemorySigner(keyStore), "");
    this.owner = keyStore
      .setKey(config.networkId, config.ownerId, KeyPair.fromString(config.ownerKey as `ed25519:${string}`))
      .then(() => new Account(connection, config.ownerId));
  }

  async view() {
    const owner = await this.owner;
    const [p, balance] = await Promise.all([
      owner.viewFunction({ contractId: this.vault, methodName: "get_policy", args: {} }) as Promise<PolicyJson>,
      owner.viewFunction({ contractId: this.config.token, methodName: "ft_balance_of", args: { account_id: this.vault } }),
    ]);
    return {
      balance: BigInt(balance),
      spentToday: BigInt(p.spent_today),
      policy: { perTxMax: BigInt(p.per_tx_max), dailyMax: BigInt(p.daily_max), allowlist: p.allowlist, paused: p.paused },
    };
  }

  setLimits(perTxMax: bigint, dailyMax: bigint) {
    return this.call("set_limits", { per_tx_max: perTxMax.toString(), daily_max: dailyMax.toString() });
  }

  setAllowed(account: string, on: boolean) {
    return this.call(on ? "add_payee" : "remove_payee", { payee: account });
  }

  setPaused(paused: boolean) {
    return this.call("set_paused", { paused });
  }

  resetDay() {
    return this.call("reset_day", {});
  }

  explorer(tx: string) {
    return `https://${this.config.networkId === "mainnet" ? "" : "testnet."}nearblocks.io/txns/${tx}`;
  }

  private async call(methodName: string, args: object) {
    const owner = await this.owner;
    await owner.functionCall({ contractId: this.vault, methodName, args, gas: GAS });
    // RPC nodes behind a load balancer can lag a block; wait so the next view sees the change.
    await new Promise((r) => setTimeout(r, 1200));
  }
}
