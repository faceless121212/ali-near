// Starts the Ali app: `npm start`, then open http://localhost:3000/app.
// Practice and the demo wallet always work. The real testnet wallet turns on when
// testnet.json exists (it is committed, so a fresh clone can use the public deployment).
import { buildAliApp } from "./build.js";

const port = Number(process.env.PORT ?? 3000);
const { app, testnet, testnetOff } = buildAliApp();

app.listen(port, () => {
  console.log(`Ali is running at http://localhost:${port}/app`);
  console.log(testnet ? `Wallet mode: NEAR ${testnet.network}, hub ${testnet.hub}` : `Real testnet wallet is off (${testnetOff})`);
});
