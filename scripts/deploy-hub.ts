// Deploys the Firewall Hub that the app's wallet mode uses, after deploy-testnet.ts.
// Needs OWNER_ACCOUNT_ID, OWNER_PRIVATE_KEY and ASSET_CONTRACT_ID in .env.
//
//   hub.<owner>  one spending budget per NEAR account, plus a test-USDC faucet
//
// Then writes testnet.json, the public config the app reads. It holds no secrets,
// so anyone who clones the repo can use wallet mode against this deployment.
import { readFileSync, writeFileSync } from "node:fs";
import { Account, Connection, InMemorySigner, KeyPair, keyStores, providers, utils } from "near-api-js";
import { loadEnv, required } from "../src/examples/env.js";

loadEnv();
const owner = required("OWNER_ACCOUNT_ID");
const token = required("ASSET_CONTRACT_ID");
const ownerKey = KeyPair.fromString(required("OWNER_PRIVATE_KEY") as `ed25519:${string}`);
const networkId = process.env.NEAR_NETWORK ?? "testnet";
const rpcUrl = process.env.NEAR_RPC_URL ?? "https://test.rpc.fastnear.com";
const provider = new providers.JsonRpcProvider({ url: rpcUrl });

const keyStore = new keyStores.InMemoryKeyStore();
const connection = new Connection(networkId, provider, new InMemorySigner(keyStore), "");
const accountFor = async (id: string) => {
  await keyStore.setKey(networkId, id, ownerKey);
  return new Account(connection, id);
};

const NEAR = (n: string) => BigInt(utils.format.parseNearAmount(n)!);
const TGAS = 1_000_000_000_000n;
const STORAGE_PER_BYTE = 10_000_000_000_000_000_000n;
const hub = `hub.${owner}`;
const wasm = (name: string) =>
  readFileSync(new URL(`../contracts/${name}/target/wasm32-unknown-unknown/release/${name.replace("-", "_")}.wasm`, import.meta.url));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type View = { amount: string; storage_usage: number; code_hash: string };
const view = (id: string) => provider.query({ request_type: "view_account", finality: "final", account_id: id }) as unknown as Promise<View>;

const root = await accountFor(owner);
console.log(`Owner ${owner}`);

// 1. The first token build was unoptimised. Redeploying the slim build frees its storage deposit.
const usdcCode = wasm("test-usdc");
const usdcView = await view(token);
if (usdcView.storage_usage > usdcCode.length + 50_000) {
  const usdc = await accountFor(token);
  await usdc.deployContract(usdcCode);
  await sleep(2000);
  const after = await view(token);
  const keep = BigInt(after.storage_usage) * STORAGE_PER_BYTE + NEAR("0.05");
  const spare = BigInt(after.amount) - keep;
  if (spare > 0n) await usdc.sendMoney(owner, spare);
  console.log(`1. Test USDC redeployed slim; ${utils.format.formatNearAmount(spare.toString(), 2)} NEAR back to the owner`);
}

// 2. The hub
let exists = true;
try {
  await view(hub);
} catch {
  exists = false;
}
if (!exists) {
  await root.createAccount(hub, ownerKey.getPublicKey(), NEAR(process.env.HUB_NEAR ?? "1.75"));
  await sleep(2000);
  console.log(`2. created ${hub}`);
}
if ((await view(hub)).code_hash === "11111111111111111111111111111111") {
  const hubAccount = await accountFor(hub);
  await hubAccount.deployContract(wasm("firewall-hub"));
  await hubAccount.functionCall({ contractId: hub, methodName: "new", args: { admin: owner, token, faucet_amount: "5000000" }, gas: 30n * TGAS });
  console.log("   deployed and initialised (faucet: 5 USDC per budget per day)");
}

// 3. Register the hub with the token and fill the faucet
const registered = await root.viewFunction({ contractId: token, methodName: "storage_balance_of", args: { account_id: hub } });
if (!registered) {
  await root.functionCall({ contractId: token, methodName: "storage_deposit", args: { account_id: hub, registration_only: true }, gas: 30n * TGAS, attachedDeposit: NEAR("0.00125") });
}
const info = await root.viewFunction({ contractId: hub, methodName: "get_info", args: {} });
if (BigInt(info.reserve) < 1_000_000_000n) {
  await root.functionCall({
    contractId: token,
    methodName: "ft_transfer_call",
    args: { receiver_id: hub, amount: "10000000000", msg: "reserve" },
    gas: 100n * TGAS,
    attachedDeposit: 1n,
  });
  console.log("3. 10,000 test USDC added to the faucet reserve");
}

const config = {
  network: networkId,
  rpcUrl,
  hub,
  token,
  marketRoot: process.env.MARKET_ROOT ?? owner,
  explorer: `https://${networkId === "mainnet" ? "" : "testnet."}nearblocks.io`,
};
writeFileSync("testnet.json", JSON.stringify(config, null, 2) + "\n");
console.log(`\nDone. Wrote testnet.json.\nHub: ${config.explorer}/address/${hub}`);
