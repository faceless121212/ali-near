// Starts the Ali web app: `npm start`, then open the URL.
// With LEDGER=near in .env (see scripts/deploy-testnet.ts) it runs on NEAR testnet;
// otherwise on an in-memory ledger that needs no keys.
import { USDC } from "../api.js";
import { loadEnv, required } from "../examples/env.js";
import { MockLedger } from "../ledger/mock.js";
import { NearLedger } from "../ledger/near.js";
import { buildMarket } from "./market.js";
import { createApp, type AppOptions } from "./server.js";
import { MockWallet, NearWallet } from "./wallet.js";

loadEnv();
const port = Number(process.env.PORT ?? 3000);

function onChain(): AppOptions {
  const networkId = process.env.NEAR_NETWORK ?? "testnet";
  const rpcUrl = process.env.NEAR_RPC_URL ?? (networkId === "mainnet" ? "https://rpc.mainnet.fastnear.com" : "https://test.rpc.fastnear.com");
  const vault = required("VAULT_ACCOUNT_ID");
  const asset = required("ASSET_CONTRACT_ID");
  return {
    ledger: new NearLedger({ networkId, rpcUrl, agent: { vault, privateKey: required("AGENT_PRIVATE_KEY") } }),
    wallet: new NearWallet(
      { networkId, rpcUrl, ownerId: required("OWNER_ACCOUNT_ID"), ownerKey: required("OWNER_PRIVATE_KEY"), token: asset },
      vault,
    ),
    market: buildMarket(required("MARKET_ROOT")),
    asset,
  };
}

function inMemory(): AppOptions {
  const asset = "usdc.mock.near";
  const vault = "marketing.acme.near";
  const market = buildMarket();
  const ledger = new MockLedger(asset);
  ledger.mint(vault, USDC(5));
  ledger.createVault(vault, {
    perTxMax: USDC(0.1),
    dailyMax: USDC(0.2),
    allowlist: market.apis.filter((a) => a.allowed).map((a) => a.account),
    paused: false,
  });
  return { ledger, wallet: new MockWallet(ledger, vault), market, asset };
}

const options = process.env.LEDGER === "near" ? onChain() : inMemory();
createApp(options).listen(port, () => {
  console.log(`Ali is running at http://localhost:${port} (${options.ledger.network}, vault ${options.wallet.vault})`);
});
