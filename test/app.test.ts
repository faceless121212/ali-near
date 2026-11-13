import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { USDC } from "../src/api.js";
import { DemoWallets } from "../src/app/demo.js";
import { buildMarket } from "../src/app/market.js";
import { createApp } from "../src/app/server.js";
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
  const demo = new DemoWallets(ledger, market.apis.map((a) => a.account));
  server = createApp({ practice: { ledger, wallet: new MockWallet(ledger, VAULT), market, asset: ASSET }, demo }).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
  server.close();
});

const send = (path: string, body: unknown, method = "POST") =>
  fetch(base + path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
const keys = (r: { steps: { key: string }[] }) => r.steps.map((s) => s.key);

describe("Ali app", () => {
  it("serves the landing page and the app", async () => {
    expect(await (await fetch(base + "/")).text()).toContain("Ali");
    const app = await fetch(base + "/app");
    expect(app.status).toBe(200);
    expect(await app.text()).toContain("Marketing budget");
  });

  it("reports wallet mode as off without testnet.json", async () => {
    expect(await (await fetch(base + "/api/config")).json()).toEqual({ testnet: null, demo: true });
  });

  it("marketplace APIs answer 402 without payment", async () => {
    const res = await fetch(base + "/market/translate?q=hello");
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.accepts[0]).toMatchObject({ scheme: "near", payTo: "translate-api.near", maxAmountRequired: "30000" });
  });

  it("a paid call shows every NEAR step and the answer", async () => {
    const r = await send("/api/practice/call", { api: "translate", q: "hello agent" });
    expect(r.ok).toBe(true);
    expect(keys(r)).toEqual(["request", "quote", "checks", "pay", "verify", "answer"]);
    expect(r.steps[1].data).toMatchObject({ payTo: "translate-api.near", amount: "30000" });
    expect(r.steps[2].checks.every((c: { ok: boolean }) => c.ok)).toBe(true);
    expect(r.result).toMatchObject({ translation: "hola agente" });
    expect(r.state.budget.balance).toBe(5_000_000 - 30_000);
    expect(ledger.balanceOf("translate-api.near")).toBe(USDC(0.03));
  });

  it("stops at the firewall for APIs the owner has not allowed", async () => {
    const r = await send("/api/practice/call", { api: "search" });
    expect(r).toMatchObject({ ok: false, short: "Blocked: not allowed", code: "ERR_PAYEE_NOT_ALLOWED" });
    expect(keys(r)).toEqual(["request", "quote", "checks"]);
    const failed = r.steps[2].checks.filter((c: { ok: boolean }) => !c.ok);
    expect(failed.map((c: { key: string }) => c.key)).toEqual(["ERR_PAYEE_NOT_ALLOWED"]);
    expect(ledger.balanceOf("search-api.near")).toBe(0n);
  });

  it("owner can allow an API, then the agent can pay it", async () => {
    await send("/api/practice/policy", { allow: { account: "search-api.near", on: true } }, "PATCH");
    expect((await send("/api/practice/call", { api: "search" })).ok).toBe(true);
  });

  it("stops the three attacks", async () => {
    expect(await send("/api/practice/attack", { kind: "inject" })).toMatchObject({ ok: false, short: "Blocked: not allowed" });
    const drain = await send("/api/practice/attack", { kind: "drain" });
    expect(drain).toMatchObject({ ok: false, short: "Blocked: over per-call limit" });
    expect(keys(drain)).toEqual(["request", "checks"]);
    // The loop uses the priciest allowed API, News at 0.05, so the 0.20 budget allows 4 calls.
    const loop = await send("/api/practice/attack", { kind: "loop" });
    expect(loop).toMatchObject({ ok: false, short: "Stopped after 4 of 30 calls" });
    expect(loop.runs).toHaveLength(5);
    expect(loop.state.budget.spentToday).toBe(200_000);
    expect(ledger.balanceOf("drainer.near")).toBe(0n);
  });

  it("pause and new day are owner controls", async () => {
    await send("/api/practice/policy", { paused: true }, "PATCH");
    expect(await send("/api/practice/call", { api: "translate" })).toMatchObject({ ok: false, short: "Blocked: wallet paused" });
    await send("/api/practice/policy", { paused: false }, "PATCH");
    await send("/api/practice/attack", { kind: "loop" });
    const { state } = await send("/api/practice/new-day", {});
    expect(state.budget.spentToday).toBe(0);
  });

  it("clamps limits sent by the client", async () => {
    const { state } = await send("/api/practice/policy", { perTxMax: 10 ** 12, dailyMax: -5 }, "PATCH");
    expect(state.budget.policy).toMatchObject({ perTxMax: 1_000_000, dailyMax: 10_000 });
  });

  it("rejects unknown APIs with a JSON error", async () => {
    const res = await fetch(base + "/api/practice/call", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "unknown API" });
  });

  it("demo wallet walks the five steps: connect, budget, key, call, attack", async () => {
    const id = "you-test.demo.near";
    const allowlist = ["weather-api.near", "news-api.near"];
    let st = await (await fetch(`${base}/api/demo/${id}/state`)).json();
    expect(st.budget).toBeNull();
    // No budget, no key: the agent can't pay.
    expect((await fetch(`${base}/api/demo/${id}/call`, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"api":"weather"}' })).status).toBe(409);

    st = (await send(`/api/demo/${id}/sign`, { method: "create_vault", args: { per_tx_max: "100000", daily_max: "200000", allowlist }, label: "Created" })).state;
    expect(st.budget.balance).toBe(5_000_000);
    expect(st.budget.faucetReady).toBe(false);
    expect((await fetch(`${base}/api/demo/${id}/call`, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"api":"weather"}' })).status).toBe(409);

    st = (await send(`/api/demo/${id}/sign`, { method: "add_key" })).state;
    expect(st.agentKey.added).toBe(true);

    const paid = await send(`/api/demo/${id}/call`, { api: "weather" });
    expect(paid.ok).toBe(true);
    expect(keys(paid)).toEqual(["request", "quote", "checks", "pay", "verify", "answer"]);
    expect(paid.state.budget.balance).toBe(4_990_000);

    const drain = await send(`/api/demo/${id}/attack`, { kind: "drain" });
    expect(drain.code).toBe("ERR_PER_TX_LIMIT");
    const inject = await send(`/api/demo/${id}/attack`, { kind: "inject" });
    expect(inject.code).toBe("ERR_PAYEE_NOT_ALLOWED");

    await send(`/api/demo/${id}/sign`, { method: "set_paused", args: { paused: true } });
    expect((await send(`/api/demo/${id}/call`, { api: "weather" })).code).toBe("ERR_PAUSED");
    // The shared practice wallet is untouched.
    expect((await (await fetch(base + "/api/practice/state")).json()).budget.balance).toBe(5_000_000);
    expect((await send(`/api/demo/${id}/sign`, { method: "create_vault", args: {} })).error).toMatch(/ERR_VAULT_EXISTS/);
  });

  it("guided tour: each step runs on its own fresh budget and leaves nothing behind", async () => {
    const pay = await send("/api/tour/pay", { q: "Lisbon" });
    expect(pay.ok).toBe(true);
    expect(keys(pay)).toEqual(["request", "quote", "checks", "pay", "verify", "answer"]);
    expect(pay.budget.balance).toBe(4_990_000);
    expect((await send("/api/tour/inject", {})).code).toBe("ERR_PAYEE_NOT_ALLOWED");
    expect((await send("/api/tour/drain", {})).code).toBe("ERR_PER_TX_LIMIT");
    const loop = await send("/api/tour/loop", {});
    expect(loop.short).toBe("Stopped after 4 of 30 calls");
    expect(loop.runs).toHaveLength(5);
    const after = await send("/api/tour/loop", { paidBefore: true });
    expect(after.short).toBe("Stopped after 3 of 30 calls");
    expect(after.budget.balance).toBe(4_840_000);
    expect((await send("/api/tour/pause", {})).code).toBe("ERR_PAUSED");
    const drain = await send("/api/tour/drain", { paidBefore: true });
    expect(drain.code).toBe("ERR_PER_TX_LIMIT");
    expect(drain.steps[0].detail).toBe("4.99 USDC to drainer.near");
    expect(drain.budget.balance).toBe(4_990_000);
    expect((await fetch(base + "/api/tour/nope", { method: "POST" })).status).toBe(400);
    // The shared practice budget is untouched.
    expect((await (await fetch(base + "/api/practice/state")).json()).budget.balance).toBe(5_000_000);
  });
});
