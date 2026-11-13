// The Vercel function: the whole app as one handler. scripts/build-vercel.mjs
// bundles it into .vercel/output (Build Output API); the pages in web/ are served
// as static files, everything else (/api, /market, /testnet/market) comes here.
// State (practice and demo budgets, 402 nonces) lives in this instance's memory.
import { join } from "node:path";
import { buildAliApp } from "./build.js";

// Static pages are served by Vercel; this is only a fallback for the function itself.
const { app, testnet, testnetOff } = buildAliApp({ serverless: true, webDir: join(process.cwd(), "web") });
console.log(testnet ? `Ali: wallet mode on, hub ${testnet.hub}` : `Ali: real testnet wallet off (${testnetOff})`);

export default app;
