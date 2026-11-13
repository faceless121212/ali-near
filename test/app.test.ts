import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { USDC } from "../src/api.js";
import { createApp } from "../src/app/server.js";
import { buildMarket } from "../src/app/market.js";
import { MockWallet } from "../src/app/wallet.js";
import { MockLedger } from "../src/ledger/mock.js";

const ASSET = "usdc.mock.near";
const VAULT = "marketing.acme.near";

let ledger: MockLedger;
let server: Server;
let base: string;

beforeEach(async () => {
  const market = buildMarket();
  ledger = new MockLedger(ASSET);
  ledger.mint(VAULT, USDC(5));
  ledger.createVault(VAULT, {
    perTxMax: USDC(0.1),
    dailyMax: USDC(0.2),
    allowlist: market.apis.filter((a) => a.allowed).map((a) => a.account),
    paused: false,
  });
  server = createApp({ ledger, wallet: new MockWallet(ledger, VAULT), market, asset: ASSET }).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
  server.close();
});

const post = (path: string, body: unknown, method = "POST") =>
  fetch(base + path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());

describe("Ali app", () => {
  it("serves the web page", async () => {
    const res = await fetch(base + "/");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Marketing budget");
  });

  it("marketplace APIs answer 402 without payment", async () => {
    const res = await fetch(base + "/market/translate?q=hello");
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.accepts[0]).toMatchObject({ scheme: "near6", payTo: "translate-api.near", maxAmountRequired: "30000" });
  });

  it("the agent pays over Near6 and gets the data", async () => {
    const r = await post("/api/call", { api: "translate", q: "hello agent" });
    expect(r.ok).toBe(true);
    expect(r.result).toMatchObject({ translation: "hola agente" });
    expect(r.steps.some((s: string) => s.startsWith("402"))).toBe(true);
    expect(r.state.balance).toBe(5_000_000 - 30_000);
    expect(ledger.balanceOf("translate-api.near")).toBe(USDC(0.03));
  });

  it("blocks APIs the owner has not allowed", async () => {
    const r = await post("/api/call", { api: "search" });
    expect(r).toMatchObject({ ok: false, short: "Blocked: not allowed" });
    expect(ledger.balanceOf("search-api.near")).toBe(0n);
  });

  it("owner can allow an API, then the agent can pay it", async () => {
    await post("/api/policy", { allow: { account: "search-api.near", on: true } }, "PATCH");
    expect((await post("/api/call", { api: "search" })).ok).toBe(true);
  });

  it("stops the three attacks", async () => {
    expect(await post("/api/attack", { kind: "inject" })).toMatchObject({ ok: false, short: "Blocked: not allowed" });
    expect(await post("/api/attack", { kind: "drain" })).toMatchObject({ ok: false, short: "Blocked: over per-call limit" });
    const loop = await post("/api/attack", { kind: "loop" });
    // The loop uses the priciest allowed API, News at 0.05, so the 0.20 budget allows 4 calls.
    expect(loop).toMatchObject({ ok: false, short: "Stopped after 4 of 30 calls" });
    expect(loop.state.spentToday).toBe(200_000);
    expect(ledger.balanceOf("drainer.near")).toBe(0n);
  });

  it("pause and new day are owner controls", async () => {
    await post("/api/policy", { paused: true }, "PATCH");
    expect(await post("/api/call", { api: "translate" })).toMatchObject({ ok: false, short: "Blocked: wallet paused" });
    await post("/api/policy", { paused: false }, "PATCH");
    await post("/api/attack", { kind: "loop" });
    const { state } = await post("/api/new-day", {});
    expect(state.spentToday).toBe(0);
  });

  it("clamps limits sent by the client", async () => {
    const { state } = await post("/api/policy", { perTxMax: 10 ** 12, dailyMax: -5 }, "PATCH");
    expect(state.policy).toMatchObject({ perTxMax: 1_000_000, dailyMax: 10_000 });
  });
});
