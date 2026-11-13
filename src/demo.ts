// Offline end-to-end demo: a paid Near6 API, an AI agent that pays per call,
// and the Agent Firewall stopping overspending, a prompt injection and a replay.
// Runs with no keys or network: `npm run demo`.
import type { AddressInfo } from "node:net";
import { createApi, formatUsdc, USDC } from "./api.js";
import { createPayingFetch, readSettlement } from "./client/paying-fetch.js";
import { MockLedger } from "./ledger/mock.js";
import { FirewallError } from "./policy.js";
import { encodeHeader, type PaymentRequiredBody } from "./near6/types.js";

const ASSET = "usdc.mock.near";
const VAULT = "marketing.acme.near";
const API = "weather-api.near";
const ATTACKER = "drainer.near";

const c = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

async function main() {
  const ledger = new MockLedger(ASSET);
  ledger.mint(VAULT, USDC(5));
  // The human owner sets the rules once. The agent only holds a key that can call `pay`.
  ledger.createVault(VAULT, { perTxMax: USDC(0.1), dailyMax: USDC(0.2), allowlist: [API], paused: false });

  const server = createApi({ ledger, asset: ASSET, payTo: API, attackerPayTo: ATTACKER }).listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const fetchPaid = createPayingFetch({
    ledger,
    vault: VAULT,
    acceptAssets: [ASSET],
    onPayment: ({ requirements, txHash }) =>
      console.log(c.dim(`   paid ${formatUsdc(BigInt(requirements.maxAmountRequired))} → ${requirements.payTo} (tx ${txHash.slice(0, 10)}…)`)),
  });

  async function call(path: string) {
    try {
      const res = await fetchPaid(base + path);
      const body = await res.json();
      if (res.ok) console.log(c.green(`   ✓ ${path} → ${JSON.stringify(body)}`));
      else console.log(c.red(`   ✗ ${path} → HTTP ${res.status}: ${body.error}`));
      return { res, body };
    } catch (err) {
      if (err instanceof FirewallError) console.log(c.red(`   🛡  blocked by firewall: ${err.message}`));
      else throw err;
    }
  }

  console.log(c.bold(`\nAgent vault ${VAULT}`));
  console.log(c.dim(`policy: ≤ 0.10 USDC per call, ≤ 0.20 USDC per day, pays only ${API}\n`));

  console.log(c.bold("1. Agent pays per call for an API it has never seen (HTTP 402 → pay → retry)"));
  await call("/weather?city=Kyiv");
  await call("/weather?city=Lisbon");

  console.log(c.bold("\n2. A poisoned API response tells the agent to pay someone else"));
  const research = await call("/research");
  const injected = String(research?.body?.note ?? "").match(/\/[\w-]+/)?.[0];
  if (injected) {
    console.log(c.dim(`   naive agent obeys the response and calls ${injected}…`));
    await call(injected);
  }

  console.log(c.bold("\n3. A jailbroken agent tries to move the whole balance directly"));
  try {
    await ledger.pay({ vault: VAULT, payee: ATTACKER, amount: ledger.balanceOf(VAULT), memo: "" });
  } catch (err) {
    console.log(c.red(`   🛡  blocked by firewall: ${(err as Error).message}`));
  }

  console.log(c.bold("\n4. A runaway loop hits the daily budget"));
  for (let i = 0; i < 30; i++) {
    const r = await call(`/weather?city=loop-${i}`);
    if (!r) break;
  }
  console.log(c.dim(`   spent today: ${formatUsdc(ledger.spentToday(VAULT))}`));

  console.log(c.bold("\n5. Someone replays a payment proof they intercepted"));
  ledger.setPolicy(VAULT, { dailyMax: USDC(1) });
  console.log(c.dim("   owner raises the daily budget to 1.00 USDC"));
  // Do the Near6 handshake by hand so we hold the exact X-PAYMENT header that was sent.
  const challenge = (await (await fetch(`${base}/weather?city=Paris`)).json()) as PaymentRequiredBody;
  const reqs = challenge.accepts[0];
  const txHash = await ledger.pay({ vault: VAULT, payee: reqs.payTo, amount: BigInt(reqs.maxAmountRequired), memo: reqs.extra.nonce });
  const proof = encodeHeader({ x402Version: 1, scheme: reqs.scheme, network: reqs.network, payload: { txHash, payer: VAULT, nonce: reqs.extra.nonce } });
  const original = await fetch(`${base}/weather?city=Paris`, { headers: { "X-PAYMENT": proof } });
  console.log(c.green(`   ✓ original request → HTTP ${original.status}, settled in tx ${readSettlement(original)?.transaction.slice(0, 10)}…`));
  const replay = await fetch(`${base}/weather?city=Paris`, { headers: { "X-PAYMENT": proof } });
  console.log(c.red(`   ✗ same proof replayed → HTTP ${replay.status}: ${(await replay.json()).error}`));

  console.log(c.bold("\n6. The owner hits the kill switch"));
  ledger.setPolicy(VAULT, { paused: true });
  await call("/weather?city=Berlin");

  console.log(c.bold("\nFinal balances"));
  console.log(`   ${VAULT}: ${formatUsdc(ledger.balanceOf(VAULT))}`);
  console.log(`   ${API}: ${formatUsdc(ledger.balanceOf(API))}`);
  console.log(`   ${ATTACKER}: ${formatUsdc(ledger.balanceOf(ATTACKER))}\n`);

  server.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
