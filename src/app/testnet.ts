// Wallet mode: each visitor's own budget on the Firewall Hub (contracts/firewall-hub).
// The visitor signs the rules in their NEAR wallet. The server only holds the
// agent's keys: function-call keys the visitor adds to their own account, which
// can call `pay` on the hub and nothing else.
import { createHmac, createPrivateKey, createPublicKey } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { KeyPair, providers, utils } from "near-api-js";
import { NearLedger } from "../ledger/near.js";
import type { Budget } from "./agent.js";

export interface TestnetConfig {
  network: string;
  rpcUrl: string;
  hub: string;
  token: string;
  marketRoot: string;
  explorer: string;
}

/** testnet.json is written by scripts/deploy-hub.ts and holds no secrets. */
export function loadTestnetConfig(path = "testnet.json"): TestnetConfig | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as TestnetConfig;
}

interface VaultJson {
  per_tx_max: string;
  daily_max: string;
  allowlist: string[];
  paused: boolean;
  spent_today: string;
  balance: string;
  faucet_ready: boolean;
}

export interface HubBudget extends Budget {
  faucetReady: boolean;
}

export class Hub {
  readonly provider: providers.JsonRpcProvider;
  private ledgers = new Map<string, NearLedger>();

  constructor(
    readonly config: TestnetConfig,
    readonly keys: AgentKeys,
  ) {
    this.provider = new providers.JsonRpcProvider({ url: config.rpcUrl });
  }

  async budget(account: string): Promise<HubBudget | null> {
    const v = await this.view<VaultJson | null>("get_vault", { account_id: account });
    if (!v) return null;
    return {
      policy: { perTxMax: BigInt(v.per_tx_max), dailyMax: BigInt(v.daily_max), allowlist: v.allowlist, paused: v.paused },
      spentToday: BigInt(v.spent_today),
      balance: BigInt(v.balance),
      faucetReady: v.faucet_ready,
    };
  }

  /** Whether the agent's key is on the account yet, and still limited to `pay` on the hub. */
  async agentKeyAdded(account: string): Promise<boolean> {
    const publicKey = this.keys.publicKey(account);
    if (!publicKey) return false;
    try {
      const key = (await this.provider.query({
        request_type: "view_access_key",
        finality: "optimistic",
        account_id: account,
        public_key: publicKey,
      })) as unknown as { permission: { FunctionCall?: { receiver_id: string; method_names: string[] } } };
      const fc = key.permission.FunctionCall;
      return fc?.receiver_id === this.config.hub && fc.method_names.length === 1 && fc.method_names[0] === "pay";
    } catch {
      return false;
    }
  }

  /** The agent for one account: signs `pay` on the hub with that account's agent key. */
  ledger(account: string): NearLedger {
    let ledger = this.ledgers.get(account);
    if (!ledger) {
      const privateKey = this.keys.secret(account);
      if (!privateKey) throw new Error(`no agent key for ${account}`);
      ledger = new NearLedger({
        networkId: this.config.network,
        rpcUrl: this.config.rpcUrl,
        agent: { vault: account, privateKey },
        contract: this.config.hub,
      });
      this.ledgers.set(account, ledger);
    }
    return ledger;
  }

  /** Verifies payments only; used by the paywalled marketplace. */
  verifier() {
    return new NearLedger({ networkId: this.config.network, rpcUrl: this.config.rpcUrl });
  }

  private async view<T>(method: string, args: object): Promise<T> {
    const res = (await this.provider.query({
      request_type: "call_function",
      finality: "optimistic",
      account_id: this.config.hub,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    })) as unknown as { result: number[] };
    return JSON.parse(Buffer.from(res.result).toString("utf8")) as T;
  }
}

/** Agent keys per NEAR account, kept in a local JSON file (gitignored). */
/**
 * The agent's key pair for each visitor account.
 *
 * With AGENT_KEY_SECRET set, keys are derived from it (HMAC-SHA256 of the account id
 * as the ed25519 seed): nothing is stored, every server instance computes the same
 * key, and it works on serverless hosts with a read-only disk (Vercel). Without it,
 * keys are random and kept in data/agent-keys.json (mode 0600).
 */
export class AgentKeys {
  private keys: Record<string, string>;

  constructor(
    private path = "data/agent-keys.json",
    private secretKey = process.env.AGENT_KEY_SECRET,
  ) {
    this.keys = !secretKey && existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  }

  /** Returns the account's agent public key, creating the key pair on first use. */
  ensure(account: string): string {
    if (this.secretKey) return this.publicKey(account)!;
    if (!this.keys[account]) {
      this.keys[account] = KeyPair.fromRandom("ed25519").toString();
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(this.path, JSON.stringify(this.keys, null, 2), { mode: 0o600 });
    }
    return this.publicKey(account)!;
  }

  publicKey(account: string) {
    const secret = this.secret(account);
    return secret ? KeyPair.fromString(secret as `ed25519:${string}`).getPublicKey().toString() : undefined;
  }

  secret(account: string): string | undefined {
    return this.secretKey ? deriveKey(this.secretKey, account) : this.keys[account];
  }
}

/** ed25519 key pair from a 32-byte seed, in near-api-js's "ed25519:<base58 seed+public>" form. */
export function deriveKey(secret: string, account: string): string {
  const seed = createHmac("sha256", secret).update(`ali-agent-key:${account}`).digest();
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  const jwk = createPublicKey(createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" })).export({ format: "jwk" });
  const pub = Buffer.from(jwk.x!, "base64url");
  return `ed25519:${utils.serialize.base_encode(Buffer.concat([seed, pub]))}`;
}
