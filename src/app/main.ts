// Starts the Ali app: `npm start`, then open http://localhost:3000/app.
// Practice mode always works. Wallet mode turns on when testnet.json exists
// (it is committed, so a fresh clone can use the public testnet deployment).
import { USDC } from "../api.js";
import { MockLedger } from "../ledger/mock.js";
import { DemoWallets } from "./demo.js";
import { buildMarket } from "./market.js";
import { createApp } from "./server.js";
import { AgentKeys, Hub, loadTestnetConfig } from "./testnet.js";
import { MockWallet } from "./wallet.js";

const port = Number(process.env.PORT ?? 3000);

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

const config = loadTestnetConfig();
const hub = config ? new Hub(config, new AgentKeys()) : undefined;

const demo = new DemoWallets(ledger, market.apis.map((a) => a.account));

createApp({ practice: { ledger, wallet: new MockWallet(ledger, vault), market, asset }, hub, demo }).listen(port, () => {
  console.log(`Ali is running at http://localhost:${port}/app`);
  console.log(hub ? `Wallet mode: NEAR ${config!.network}, hub ${config!.hub}` : "Wallet mode is off (no testnet.json)");
});
