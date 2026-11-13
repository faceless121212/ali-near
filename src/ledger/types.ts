// A NEP-141 `ft_transfer` event as emitted (EVENT_JSON) by the token contract.
export interface FtTransferEvent {
  executor: string; // account that emitted the log; must be the token contract
  oldOwner: string;
  newOwner: string;
  amount: bigint;
  memo?: string;
}

export interface Ledger {
  network: string;
  /** Calls `pay` on the agent's firewall vault. Throws FirewallError if the policy blocks it. */
  pay(args: { vault: string; payee: string; amount: bigint; memo: string }): Promise<string>;
  /** Successful ft_transfer events produced by a transaction. */
  transfersIn(txHash: string, sender: string): Promise<FtTransferEvent[]>;
}
