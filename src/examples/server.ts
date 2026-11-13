// Paid API on NEAR testnet. Verifies payments over RPC; needs no private key.
import { createApi } from "../api.js";
import { NearLedger } from "../ledger/near.js";
import { loadEnv, required } from "./env.js";

loadEnv();
const ledger = new NearLedger({
  networkId: process.env.NEAR_NETWORK ?? "testnet",
  rpcUrl: process.env.NEAR_RPC_URL ?? "https://test.rpc.fastnear.com",
});
const port = Number(process.env.PORT ?? 4021);

createApi({ ledger, asset: required("ASSET_CONTRACT_ID"), payTo: required("PAY_TO_ACCOUNT_ID") }).listen(port, () => {
  console.log(`NEAR API on ${ledger.network} listening at http://localhost:${port}`);
  console.log("try: curl -i http://localhost:%d/weather?city=Kyiv", port);
});
