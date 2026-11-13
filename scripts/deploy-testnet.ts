// One-time testnet setup. Needs OWNER_ACCOUNT_ID and OWNER_PRIVATE_KEY in .env
// (a funded testnet account) and the two contracts built (npm run build:contracts).
//
// Creates under the owner account:
//   usdc.<owner>       Test USDC (NEP-141, 6 decimals)
//   budget.<owner>     the agent's vault ("Marketing budget"), running the Agent Firewall
//   <api>-api.<owner>  one account per marketplace API, plus drainer.<owner>
// then gives the agent a key that can only call `pay`, funds the vault with
// 5 USDC and writes the resulting settings to .env.
import { readFileSync, writeFileSync } from "node:fs";
import { Account, Connection, InMemorySigner, KeyPair, keyStores, providers, utils } from "near-api-js";
import { loadEnv, required } from "../src/examples/env.js";
import { buildMarket } from "../src/app/market.js";

loadEnv();
const owner = required("OWNER_ACCOUNT_ID");
const ownerKey = KeyPair.fromString(required("OWNER_PRIVATE_KEY") as `ed25519:${string}`);
const networkId = process.env.NEAR_NETWORK ?? "testnet";
const provider = new providers.JsonRpcProvider({ url: process.env.NEAR_RPC_URL ?? "https://test.rpc.fastnear.com" });

const keyStore = new keyStores.InMemoryKeyStore();
const connection = new Connection(networkId, provider, new InMemorySigner(keyStore), "");
const accountFor = async (id: string) => {
  await keyStore.setKey(networkId, id, ownerKey);
  return new Account(connection, id);
};

const NEAR = (n: string) => BigInt(utils.format.parseNearAmount(n)!);
const TGAS = 1_000_000_000_000n;
const USDC = (n: number) => String(Math.round(n * 1_000_000));

const token = `usdc.${owner}`;
const vault = `budget.${owner}`;
const { apis, attacker } = buildMarket(owner);
const wasm = (name: string) => readFileSync(new URL(`../contracts/${name}/target/wasm32-unknown-unknown/release/${name.replace("-", "_")}.wasm`, import.meta.url));

const root = await accountFor(owner);

async function create(id: string, amount: string) {
  try {
    await provider.query({ request_type: "view_account", finality: "final", account_id: id });
    console.log(`  exists  ${id}`);
  } catch {
    await root.createAccount(id, ownerKey.getPublicKey(), NEAR(amount));
    console.log(`  created ${id}`);
    await new Promise((r) => setTimeout(r, 2000)); // let every RPC node see the new account
  }
  return accountFor(id);
}

async function hasCode(id: string) {
  const view = (await provider.query({ request_type: "view_account", finality: "final", account_id: id })) as unknown as { code_hash: string };
  return view.code_hash !== "11111111111111111111111111111111";
}

console.log(`Owner ${owner}`);
console.log("1. Test USDC");
const usdc = await create(token, "3.2");
if (!(await hasCode(token))) {
  await usdc.deployContract(wasm("test-usdc"));
  await usdc.functionCall({ contractId: token, methodName: "new", args: { owner, total_supply: USDC(1_000_000) }, gas: 50n * TGAS });
  console.log("  deployed, 1,000,000 USDC minted to the owner");
}

console.log("2. Marketplace accounts");
for (const id of [...apis.map((a) => a.account), attacker]) await create(id, "0.02");

console.log("3. Vault with the Agent Firewall");
const vaultAccount = await create(vault, "2");
let agentKey = process.env.AGENT_PRIVATE_KEY;
if (!(await hasCode(vault))) {
  await vaultAccount.deployContract(wasm("agent-firewall"));
  await vaultAccount.functionCall({
    contractId: vault,
    methodName: "new",
    args: {
      owner,
      token,
      per_tx_max: USDC(0.1),
      daily_max: USDC(0.2),
      allowlist: apis.filter((a) => a.allowed).map((a) => a.account),
    },
    gas: 50n * TGAS,
  });
  console.log("  deployed and initialised");
  // The agent's only key: it can call `pay` on the vault and nothing else.
  const agent = KeyPair.fromRandom("ed25519");
  await vaultAccount.addKey(agent.getPublicKey(), vault, ["pay"], NEAR("0.5"));
  agentKey = agent.toString();
  // Leave the vault with no full-access key, so only the contract's rules can move its funds.
  await vaultAccount.deleteKey(ownerKey.getPublicKey());
  console.log("  agent key added (pay only); owner full-access key removed from the vault");
}

console.log("4. Token storage and funding");
for (const id of [vault, ...apis.map((a) => a.account), attacker]) {
  const registered = await root.viewFunction({ contractId: token, methodName: "storage_balance_of", args: { account_id: id } });
  if (!registered) {
    await root.functionCall({ contractId: token, methodName: "storage_deposit", args: { account_id: id, registration_only: true }, gas: 30n * TGAS, attachedDeposit: NEAR("0.00125") });
  }
}
const balance = BigInt(await root.viewFunction({ contractId: token, methodName: "ft_balance_of", args: { account_id: vault } }));
if (balance < BigInt(USDC(1))) {
  await root.functionCall({ contractId: token, methodName: "ft_transfer", args: { receiver_id: vault, amount: USDC(5), memo: "fund vault" }, gas: 30n * TGAS, attachedDeposit: 1n });
  console.log("  sent 5 USDC to the vault");
}

const settings: Record<string, string> = {
  LEDGER: "near",
  NEAR_NETWORK: networkId,
  VAULT_ACCOUNT_ID: vault,
  ASSET_CONTRACT_ID: token,
  MARKET_ROOT: owner,
};
if (agentKey) settings.AGENT_PRIVATE_KEY = agentKey;
let env = readFileSync(".env", "utf8");
for (const [k, v] of Object.entries(settings)) {
  const line = `${k}=${v}`;
  env = new RegExp(`^${k}=.*$`, "m").test(env) ? env.replace(new RegExp(`^${k}=.*$`, "m"), line) : `${env.trimEnd()}\n${line}\n`;
}
writeFileSync(".env", env);
console.log(`\nDone. .env updated. Run: npm start\nVault: https://testnet.nearblocks.io/address/${vault}`);
