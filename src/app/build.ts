// Builds the whole Ali app: the practice wallet, the demo wallets and, when
// testnet.json exists, wallet mode on NEAR testnet. Used by `npm start` (main.ts)
// and by the Vercel function (vercel.ts).
import { USDC } from "../api.js";
import { MockLedger } from "../ledger/mock.js";
import { DemoWallets } from "./demo.js";
import { buildMarket } from "./market.js";
import { createApp } from "./server.js";
import { AgentKeys, Hub, loadTestnetConfig, type TestnetConfig } from "./testnet.js";
import { MockWallet } from "./wallet.js";

export interface Built {
  app: ReturnType<typeof createApp>;
  testnet?: TestnetConfig;
  /** Why wallet mode is off, if it is. */
  testnetOff?: string;
}

export function buildAliApp(opts: { testnetJson?: string; webDir?: string; serverless?: boolean } = {}): Built {
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
  const demo = new DemoWallets(ledger, market.apis.map((a) => a.account));

  const config = loadTestnetConfig(opts.testnetJson);
  let testnetOff: string | undefined;
  if (!config) testnetOff = "no testnet.json";
  // A serverless disk is read-only and per instance, so agent keys must be derived from a secret.
  else if (opts.serverless && !process.env.AGENT_KEY_SECRET) testnetOff = "set AGENT_KEY_SECRET to turn on the real testnet wallet";
  const hub = config && !testnetOff ? new Hub(config, new AgentKeys()) : undefined;

  const app = createApp({ practice: { ledger, wallet: new MockWallet(ledger, vault), market, asset }, hub, demo, webDir: opts.webDir });
  return { app, testnet: hub ? config : undefined, testnetOff };
}
