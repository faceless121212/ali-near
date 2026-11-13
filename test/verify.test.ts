import { describe, expect, it } from "vitest";
import { parseFtTransfer } from "../src/ledger/near.js";
import type { FtTransferEvent } from "../src/ledger/types.js";
import type { PaymentRequirements } from "../src/protocol/types.js";
import { matchTransfer, verifyPayment } from "../src/protocol/verify.js";
import type { Ledger } from "../src/ledger/types.js";

const req: PaymentRequirements = {
  scheme: "near",
  network: "near-testnet",
  maxAmountRequired: "10000",
  mimeType: "application/json",
  resource: "/weather",
  description: "",
  payTo: "api.testnet",
  asset: "usdc.testnet",
  maxTimeoutSeconds: 60,
  extra: { nonce: "abc" },
};
const good: FtTransferEvent = {
  executor: "usdc.testnet",
  oldOwner: "bot.testnet",
  newOwner: "api.testnet",
  amount: 10000n,
  memo: "abc",
};

describe("matchTransfer", () => {
  it("accepts an exact transfer from the token contract", () => {
    expect(matchTransfer([good], req, "bot.testnet").ok).toBe(true);
  });

  it.each([
    ["underpayment", { amount: 9999n }],
    ["wrong payee", { newOwner: "other.testnet" }],
    ["wrong nonce", { memo: "zzz" }],
    ["log not emitted by the token (fake vault)", { executor: "bot.testnet" }],
    ["wrong asset", { executor: "fake-usdc.testnet" }],
    ["different payer", { oldOwner: "someone.testnet" }],
  ])("rejects %s", (_name, patch) => {
    expect(matchTransfer([{ ...good, ...patch }], req, "bot.testnet").ok).toBe(false);
  });
});

describe("verifyPayment with a shared firewall contract", () => {
  // Firewall Hub: alice's agent signs the tx, but the tokens leave from the hub.
  const hubEvent: FtTransferEvent = { ...good, oldOwner: "hub.testnet" };
  const ledger: Ledger = {
    network: "near-testnet",
    pay: async () => "tx",
    transfersIn: async (_tx, sender) => (sender === "alice.testnet" ? [hubEvent] : []),
  };
  const payment = (from?: string) => ({
    x402Version: 1,
    scheme: "near" as const,
    network: "near-testnet",
    payload: { txHash: "tx", payer: "alice.testnet", nonce: "abc", from },
  });

  it("accepts the transfer when the proof names the hub as `from`", async () => {
    expect((await verifyPayment(ledger, payment("hub.testnet"), req)).ok).toBe(true);
  });

  it("rejects it when `from` doesn't match the token sender", async () => {
    expect((await verifyPayment(ledger, payment(), req)).ok).toBe(false);
    expect((await verifyPayment(ledger, payment("other.testnet"), req)).ok).toBe(false);
  });
});

describe("parseFtTransfer", () => {
  it("parses a NEP-141 ft_transfer event", () => {
    const log =
      'EVENT_JSON:{"standard":"nep141","version":"1.0.0","event":"ft_transfer","data":[{"old_owner_id":"bot.testnet","new_owner_id":"api.testnet","amount":"10000","memo":"abc"}]}';
    expect(parseFtTransfer(log, "usdc.testnet")).toEqual([good]);
  });

  it("ignores other logs and malformed JSON", () => {
    expect(parseFtTransfer("Transfer 1 from a to b", "usdc.testnet")).toEqual([]);
    expect(parseFtTransfer("EVENT_JSON:{oops", "usdc.testnet")).toEqual([]);
    expect(parseFtTransfer('EVENT_JSON:{"standard":"nep171","event":"nft_mint","data":[]}', "x")).toEqual([]);
  });
});
