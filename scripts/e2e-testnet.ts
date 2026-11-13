// End-to-end check of wallet mode on NEAR testnet, without a browser.
// Plays the visitor's wallet with a fresh sub-account of the owner, then drives
// a running app (npm start) the way the page does.
// Usage: npm start (in another terminal), then: npx tsx scripts/e2e-testnet.ts
import { Account, Connection, InMemorySigner, KeyPair, keyStores, providers, utils } from "near-api-js";
import { loadEnv, required } from "../src/examples/env.js";
import { buildMarket } from "../src/app/market.js";
import { loadTestnetConfig } from "../src/app/testnet.js";

loadEnv();
const config = loadTestnetConfig();
if (!config) throw new Error("no testnet.json; run npm run deploy:hub");
const app = process.env.APP_URL ?? "http://localhost:3000";
const owner = required("OWNER_ACCOUNT_ID");
const ownerKey = KeyPair.fromString(required("OWNER_PRIVATE_KEY") as `ed25519:${string}`);
const provider = new providers.JsonRpcProvider({ url: config.rpcUrl });
const keyStore = new keyStores.InMemoryKeyStore();
const connection = new Connection(config.network, provider, new InMemorySigner(keyStore), "");
const TGAS = 1_000_000_000_000n;
const NEAR = (n: string) => BigInt(utils.format.parseNearAmount(n)!);

await keyStore.setKey(config.network, owner, ownerKey);
const visitorId = `tester-${Date.now().toString(36)}.${owner}`;
const visitorKey = KeyPair.fromRandom("ed25519");
await new Account(connection, owner).createAccount(visitorId, visitorKey.getPublicKey(), NEAR("0.3"));
await keyStore.setKey(config.network, visitorId, visitorKey);
await new Promise((r) => setTimeout(r, 2000));
const visitor = new Account(connection, visitorId);
console.log(`visitor ${visitorId}`);

const { apis } = buildMarket(config.marketRoot);
// 1. "Create your budget" (signed in the wallet)
await visitor.functionCall({
  contractId: config.hub,
  methodName: "create_vault",
  args: { per_tx_max: "100000", daily_max: "200000", allowlist: apis.filter((a) => a.allowed).map((a) => a.account) },
  gas: 30n * TGAS,
});
// 2. "Give the agent a pay-only key" (signed in the wallet)
const { publicKey } = await (await fetch(`${app}/api/testnet/${visitorId}/agent-key`, { method: "POST" })).json();
await visitor.addKey(publicKey, config.hub, ["pay"], NEAR("0.25"));
await new Promise((r) => setTimeout(r, 1500));

const post = async (path: string, body: object) => {
  const res = await fetch(`${app}/api/testnet/${visitorId}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return res.json();
};
const show = (name: string, r: any) =>
  console.log(
    `${name.padEnd(8)} ${r.ok ? "ok " : "no "} ${r.short}  [${r.steps.map((s: any) => `${s.key}:${s.status}`).join(" ")}]` +
      `  balance ${(r.state.budget.balance / 1e6).toFixed(2)}${r.tx ? `  tx ${r.tx}` : ""}`,
  );

const state = await (await fetch(`${app}/api/testnet/${visitorId}/state`)).json();
console.log(`budget ${(state.budget.balance / 1e6).toFixed(2)} USDC, agent key added: ${state.agentKey.added}`);
show("call", await post("/call", { api: "weather", q: "Lisbon" }));
show("inject", await post("/attack", { kind: "inject" }));
show("drain", await post("/attack", { kind: "drain" }));
show("loop", await post("/attack", { kind: "loop" }));
// The owner pauses in the wallet; the agent is refused.
await visitor.functionCall({ contractId: config.hub, methodName: "set_paused", args: { paused: true }, gas: 30n * TGAS });
await new Promise((r) => setTimeout(r, 1500));
show("paused", await post("/call", { api: "weather" }));

// Clean up: delete the test account and return its NEAR to the owner.
await visitor.deleteAccount(owner);
console.log(`deleted ${visitorId}`);
