// Agent on NEAR testnet: calls the paid API and pays through its firewall vault.
// Usage: npm run agent -- /weather?city=Kyiv
import { createPayingFetch, readSettlement } from "../client/paying-fetch.js";
import { NearLedger } from "../ledger/near.js";
import { FirewallError } from "../policy.js";
import { loadEnv, required } from "./env.js";

loadEnv();
const vault = required("VAULT_ACCOUNT_ID");
const ledger = new NearLedger({
  networkId: process.env.NEAR_NETWORK ?? "testnet",
  rpcUrl: process.env.NEAR_RPC_URL ?? "https://test.rpc.fastnear.com",
  agent: { vault, privateKey: required("AGENT_PRIVATE_KEY") },
});
const base = process.env.API_URL ?? `http://localhost:${process.env.PORT ?? 4021}`;
const path = process.argv[2] ?? "/weather?city=Kyiv";

const fetchPaid = createPayingFetch({
  ledger,
  vault,
  acceptAssets: [required("ASSET_CONTRACT_ID")],
  onPayment: ({ requirements, txHash }) =>
    console.log(`paid ${requirements.maxAmountRequired} of ${requirements.asset} to ${requirements.payTo}: tx ${txHash}`),
});

try {
  const res = await fetchPaid(base + path);
  console.log(res.status, await res.json());
  const settlement = readSettlement(res);
  if (settlement) console.log(`explorer: https://testnet.nearblocks.io/txns/${settlement.transaction}`);
} catch (err) {
  if (err instanceof FirewallError) {
    console.error(`blocked by Agent Firewall: ${err.code}`);
    process.exit(2);
  }
  throw err;
}
