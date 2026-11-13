import { Account, Connection, InMemorySigner, KeyPair, keyStores, providers } from "near-api-js";
import { FirewallError, type FirewallCode } from "../policy.js";
import type { FtTransferEvent, Ledger } from "./types.js";

const PAY_GAS = 100_000_000_000_000n; // 100 Tgas: pay + ft_transfer + callback

export interface NearLedgerConfig {
  networkId: string; // "testnet" | "mainnet"
  rpcUrl: string;
  /** Only needed to pay. A server that only verifies can omit it. */
  agent?: { vault: string; privateKey: string };
}

/** Talks to a real NEAR network: pays through the firewall contract, and verifies via RPC. */
export class NearLedger implements Ledger {
  network: string;
  private provider: providers.JsonRpcProvider;
  private account?: Promise<Account>;

  constructor(private config: NearLedgerConfig) {
    this.network = `near-${config.networkId}`;
    this.provider = new providers.JsonRpcProvider({ url: config.rpcUrl });
    if (config.agent) this.account = this.connect(config.agent);
  }

  async pay({ vault, payee, amount, memo }: { vault: string; payee: string; amount: bigint; memo: string }) {
    if (!this.account) throw new Error("NearLedger was created without an agent key");
    const account = await this.account;
    try {
      const outcome = await account.functionCall({
        contractId: vault,
        methodName: "pay",
        args: { payee, amount: amount.toString(), memo },
        gas: PAY_GAS,
        attachedDeposit: 0n, // function-call keys can't attach deposits; the vault pays the 1 yocto
      });
      return outcome.transaction.hash as string;
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      const code = message.match(/ERR_[A-Z_]+/)?.[0];
      if (code) throw new FirewallError(code as FirewallCode, message);
      throw err;
    }
  }

  async transfersIn(txHash: string, sender: string) {
    const outcome = await this.provider.txStatus(txHash, sender, "FINAL");
    const events: FtTransferEvent[] = [];
    for (const receipt of outcome.receipts_outcome) {
      const status = receipt.outcome.status as Record<string, unknown>;
      if ("Failure" in status) continue;
      for (const log of receipt.outcome.logs) {
        events.push(...parseFtTransfer(log, receipt.outcome.executor_id));
      }
    }
    return events;
  }

  private async connect({ vault, privateKey }: { vault: string; privateKey: string }) {
    const keyStore = new keyStores.InMemoryKeyStore();
    await keyStore.setKey(this.config.networkId, vault, KeyPair.fromString(privateKey as `ed25519:${string}`));
    const connection = new Connection(this.config.networkId, this.provider, new InMemorySigner(keyStore), "");
    return new Account(connection, vault);
  }
}

/** Parses a NEP-297 `EVENT_JSON:` log carrying a NEP-141 ft_transfer event. */
export function parseFtTransfer(log: string, executor: string): FtTransferEvent[] {
  if (!log.startsWith("EVENT_JSON:")) return [];
  try {
    const event = JSON.parse(log.slice("EVENT_JSON:".length));
    if (event.standard !== "nep141" || event.event !== "ft_transfer" || !Array.isArray(event.data)) return [];
    return event.data.map((d: { old_owner_id: string; new_owner_id: string; amount: string; memo?: string }) => ({
      executor,
      oldOwner: d.old_owner_id,
      newOwner: d.new_owner_id,
      amount: BigInt(d.amount),
      memo: d.memo,
    }));
  } catch {
    return [];
  }
}
