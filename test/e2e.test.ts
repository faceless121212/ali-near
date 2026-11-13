import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApi, USDC } from "../src/api.js";
import { createPayingFetch, readSettlement } from "../src/client/paying-fetch.js";
import { MockLedger } from "../src/ledger/mock.js";
import { FirewallError } from "../src/policy.js";
import { encodeHeader, type PaymentRequiredBody } from "../src/near6/types.js";

const ASSET = "usdc.mock.near";
const VAULT = "bot.agents.alice.near";
const API = "api.near";
const OTHER = "other.near";

let ledger: MockLedger;
let server: Server;
let base: string;

beforeEach(async () => {
  ledger = new MockLedger(ASSET);
  ledger.mint(VAULT, USDC(10));
  ledger.createVault(VAULT, { perTxMax: USDC(1), dailyMax: USDC(5), allowlist: [API, OTHER], paused: false });
  server = createApi({ ledger, asset: ASSET, payTo: API }).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
  vi.restoreAllMocks();
  server.close();
});

/** Gets a 402 challenge, pays with the given overrides, and returns the proof header. */
async function payManually(path: string, over: { amount?: bigint; payee?: string; nonce?: string } = {}) {
  const body = (await (await fetch(base + path)).json()) as PaymentRequiredBody;
  const req = body.accepts[0];
  const txHash = await ledger.pay({
    vault: VAULT,
    payee: over.payee ?? req.payTo,
    amount: over.amount ?? BigInt(req.maxAmountRequired),
    memo: over.nonce ?? req.extra.nonce,
  });
  return encodeHeader({ x402Version: 1, scheme: req.scheme, network: req.network, payload: { txHash, payer: VAULT, nonce: req.extra.nonce } });
}

const get = (path: string, proof: string) => fetch(base + path, { headers: { "X-PAYMENT": proof } });

describe("Near6 paywall", () => {
  it("returns 402 with payment requirements when unpaid", async () => {
    const res = await fetch(`${base}/weather`);
    expect(res.status).toBe(402);
    const body = (await res.json()) as PaymentRequiredBody;
    expect(body.accepts[0]).toMatchObject({ scheme: "near6", payTo: API, asset: ASSET, maxAmountRequired: "10000" });
  });

  it("pays and unlocks the resource with createPayingFetch", async () => {
    const fetchPaid = createPayingFetch({ ledger, vault: VAULT, acceptAssets: [ASSET] });
    const res = await fetchPaid(`${base}/weather?city=Kyiv`);
    expect(res.status).toBe(200);
    expect(readSettlement(res)?.success).toBe(true);
    expect(ledger.balanceOf(API)).toBe(USDC(0.01));
  });

  it("rejects an underpayment", async () => {
    const res = await get("/weather", await payManually("/weather", { amount: 9_999n }));
    expect(res.status).toBe(402);
  });

  it("rejects a payment to the wrong payee", async () => {
    const res = await get("/weather", await payManually("/weather", { payee: OTHER }));
    expect(res.status).toBe(402);
  });

  it("rejects a transfer tagged with another nonce", async () => {
    const res = await get("/weather", await payManually("/weather", { nonce: "someone-elses" }));
    expect(res.status).toBe(402);
  });

  it("rejects a replayed proof", async () => {
    const proof = await payManually("/weather");
    expect((await get("/weather", proof)).status).toBe(200);
    const replay = await get("/weather", proof);
    expect(replay.status).toBe(402);
    expect(((await replay.json()) as PaymentRequiredBody).error).toMatch(/used or expired/);
  });

  it("rejects a proof for a different resource", async () => {
    const res = await get("/research", await payManually("/weather"));
    expect(res.status).toBe(402);
  });

  it("rejects an expired challenge", async () => {
    const proof = await payManually("/weather");
    const later = Date.now() + 10 * 60_000;
    vi.spyOn(Date, "now").mockReturnValue(later);
    expect((await get("/weather", proof)).status).toBe(402);
  });

  it("surfaces firewall blocks to the agent and moves no funds", async () => {
    ledger.setPolicy(VAULT, { allowlist: [OTHER] });
    const fetchPaid = createPayingFetch({ ledger, vault: VAULT, acceptAssets: [ASSET] });
    await expect(fetchPaid(`${base}/weather`)).rejects.toBeInstanceOf(FirewallError);
    expect(ledger.balanceOf(VAULT)).toBe(USDC(10));
  });

  it("does not count a failed transfer against the daily budget", async () => {
    const poor = "poor.agents.alice.near";
    ledger.createVault(poor, { perTxMax: USDC(1), dailyMax: USDC(5), allowlist: [API], paused: false });
    const fetchPaid = createPayingFetch({ ledger, vault: poor, acceptAssets: [ASSET] });
    expect((await fetchPaid(`${base}/weather`)).status).toBe(402);
    expect(ledger.spentToday(poor)).toBe(0n);
  });
});
