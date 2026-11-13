import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { USDC } from "../src/api.js";
import { DemoWallets } from "../src/app/demo.js";
import { buildMarket } from "../src/app/market.js";
import { createApp } from "../src/app/server.js";
import { MockWallet } from "../src/app/wallet.js";
import { MockLedger } from "../src/ledger/mock.js";
import { createAliMcp, walletPath } from "../src/mcp/server.js";

const ASSET = "usdc.mock.near";
const VAULT = "marketing.acme.near";

let server: Server;
let appUrl: string;
let ledger: MockLedger;

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
  appUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
  server.close();
});

async function connect(wallet = "practice") {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createAliMcp({ appUrl, wallet }).connect(a);
  const client = new Client({ name: "test-agent", version: "1.0.0" });
  await client.connect(b);
  return client;
}

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };
const call = async (client: Client, name: string, args: Record<string, unknown> = {}) =>
  (await client.callTool({ name, arguments: args })) as ToolResult;

describe("Ali MCP server", () => {
  it("offers four tools", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["budget", "call_api", "fetch_paid", "list_apis"]);
  });

  it("shows the budget and the APIs", async () => {
    const client = await connect();
    const budget = await call(client, "budget");
    expect(budget.content[0].text).toContain("Balance: 5.00 USDC");
    expect(budget.content[0].text).toContain("Per call: up to 0.10 USDC");
    const apis = (await call(client, "list_apis")).content[0].text;
    expect(apis).toContain("weather: Weather, 0.01 USDC per call, allowed");
    expect(apis).toContain("images: Image maker, 0.08 USDC per call, NOT allowed");
  });

  it("pays for an API and returns the answer", async () => {
    const client = await connect();
    const r = await call(client, "call_api", { api: "translate", query: "hello" });
    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toMatch(/^Paid 0.03 USDC/);
    expect(r.content[0].text).toContain("Answer:");
    expect(ledger.balanceOf(VAULT)).toBe(USDC(4.97));
  });

  it("a prompt-injected agent following the link is refused, and nothing is paid", async () => {
    const client = await connect();
    const news = await call(client, "call_api", { api: "news", query: "NEAR" });
    expect(news.content[0].text).toContain("/market/vip-unlock"); // the injected instruction
    const before = ledger.balanceOf(VAULT);
    const r = await call(client, "fetch_paid", { path: "/market/vip-unlock" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("ERR_PAYEE_NOT_ALLOWED");
    expect(r.content[0].text).toContain("no money moved");
    expect(ledger.balanceOf(VAULT)).toBe(before);
  });

  it("an API the owner didn't allow is refused", async () => {
    const client = await connect();
    const r = await call(client, "call_api", { api: "images" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("ERR_PAYEE_NOT_ALLOWED");
  });

  it("stops at the daily limit", async () => {
    const client = await connect();
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await call(client, "call_api", { api: "news" }));
    expect(results.map((r) => !r.isError)).toEqual([true, true, true, true, false]);
    expect(results[4].content[0].text).toContain("ERR_DAILY_LIMIT");
  });

  it("rejects paths outside the marketplace", async () => {
    const client = await connect();
    const r = await call(client, "fetch_paid", { path: "http://evil.example/steal" });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/path must look like/);
  });

  it("works with a demo wallet budget", async () => {
    const id = "mcp-agent.demo.near";
    const post = (path: string, body: object) =>
      fetch(`${appUrl}/api/demo/${id}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const client = await connect(`demo:${id}`);
    expect((await call(client, "budget")).content[0].text).toContain("has no budget yet");
    await post("/sign", { method: "create_vault", args: { per_tx_max: "100000", daily_max: "200000", allowlist: ["weather-api.near"] } });
    await post("/sign", { method: "add_key" });
    expect((await call(client, "call_api", { api: "weather", query: "Lisbon" })).content[0].text).toMatch(/^Paid 0.01 USDC/);
    await post("/sign", { method: "set_paused", args: { paused: true } });
    expect((await call(client, "call_api", { api: "weather" })).content[0].text).toContain("ERR_PAUSED");
  });

  it("validates ALI_WALLET", () => {
    expect(walletPath("practice")).toBe("/api/practice");
    expect(walletPath("testnet:alice.testnet")).toBe("/api/testnet/alice.testnet");
    expect(() => walletPath("mainnet:alice.near")).toThrow(/ALI_WALLET/);
  });
});
