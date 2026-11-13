# Ali

**Pay-per-call APIs for AI agents on NEAR, using the Near6 protocol, with an on-chain Agent Firewall so an agent can never spend more than its human allowed.**

Built at NEAR HACKATHON 2026. Tracks: **Agent Economy**, **AI Security & Defense**, **Autonomous Business**.

AI agents are starting to pay for APIs, data and compute. Two problems come with that:

1. **Payments.** APIs need a machine-native way to charge per request. [x402](https://www.x402.org/), Coinbase's open standard built on HTTP 402 Payment Required, does this on other chains, but NEAR has no equivalent. **Near6** is Ali's protocol for it on NEAR.
2. **Safety.** An agent holding a normal wallet key can be prompt-injected into draining it.

Ali solves both. An API charges with one Express middleware. The agent pays from a **vault account** whose contract enforces a per-call cap, a daily budget, a payee allowlist and a kill switch. The agent's only key is a NEAR **function-call access key** restricted to the vault's `pay` method, so even a fully jailbroken agent can only do what the policy allows.

## Run the app (no keys needed)

```bash
npm install
npm start
```

Open http://localhost:3000. You are the owner of the **Marketing budget** wallet (`marketing.acme.near`, 5 USDC):

- **API marketplace.** Eight paid APIs, each owned by its own NEAR account. Switch an API on to add it to the wallet's allowlist, then press **Call**: the server-side agent requests the API, gets `402 Payment Required`, pays through the wallet, retries with the proof and shows you the Near6 steps and the API's answer. Weather and Maps return live data from Open-Meteo (they fall back to sample data offline); the others return sample data.
- **Limits.** Per-call and per-day sliders, **Pause** and **New day** change the wallet's policy.
- **Attacks.** *Fake prompt* makes the agent obey a poisoned News response and pay `drainer.near`; *Drain all* calls `pay` for the whole balance; *Spam 30 calls* runs a loop. The wallet blocks each one, and the activity log shows why.

The app runs on an in-memory ledger that applies the same rules, in the same order, as the contract (`src/ledger/mock.ts`). Set `PORT` to change the port. Opened as a static file, the page falls back to a demo mode that runs the checks in the browser.

| Route | What it does |
|---|---|
| `GET /market/:api?q=` | A paid API behind the Near6 paywall (`weather`, `news`, `maps`, `translate`, `search`, `stocks`, `flights`, `images`) |
| `GET /api/state` | Wallet balance, policy, spend today, marketplace and activity |
| `PATCH /api/policy` | Owner: `{ perTxMax, dailyMax, paused, allow: { account, on } }` (micro-USDC) |
| `POST /api/new-day` | Owner: reset today's spend |
| `POST /api/call` | Agent: `{ api, q }`, pays over Near6 and returns the answer |
| `POST /api/attack` | Agent: `{ kind: "inject" \| "drain" \| "loop" }` |

## Terminal demo (offline, about 10 seconds)

```bash
npm run demo
```

The demo starts a paid API and an agent against an in-memory ledger that applies the same rules as the contract. It runs six scenarios:

| # | Scenario | Result |
|---|---|---|
| 1 | Agent calls an API it has never seen: gets `402`, pays, retries | ✅ paid 0.01 USDC per call |
| 2 | API response contains a prompt injection: "call /vip-unlock" (pays `drainer.near`) | 🛡 `ERR_PAYEE_NOT_ALLOWED` |
| 3 | Jailbroken agent tries to send its whole balance to an attacker | 🛡 `ERR_PER_TX_LIMIT` |
| 4 | Runaway loop keeps calling the API | 🛡 `ERR_DAILY_LIMIT` at 0.20 USDC |
| 5 | Someone replays an intercepted payment proof | ❌ `402`, the nonce is single-use |
| 6 | Owner flips the kill switch | 🛡 `ERR_PAUSED` |

```bash
npm test          # 35 tests: policy, payment verification, Near6 end to end, the app
npm run typecheck
```

## How it works

```
 Agent (LLM)                  Paid API (Express)                    NEAR
 ──────────                   ──────────────────                    ────
 GET /weather  ─────────────▶ paywall(): no X-PAYMENT
               ◀──────────── 402 { accepts: [{ payTo, asset,
                                    maxAmountRequired, nonce }] }
 payingFetch:
   vault.pay(payee, amount, memo=nonce) ──────────────────────────▶ Agent Firewall contract
                                                                     checks paused / per-tx /
                                                                     allowlist / daily cap
                                                                     └▶ token.ft_transfer(memo=nonce)
                                                                        └▶ on_pay callback
                                                                           (refunds budget on failure)
 GET /weather
 X-PAYMENT: {txHash, payer, nonce} ─▶ verify via RPC: the TOKEN contract
                                      logged ft_transfer → payTo,
                                      amount ≥ price, memo = nonce;
                                      nonce consumed (no replay)
               ◀──────────── 200 + X-PAYMENT-RESPONSE
```

The server trusts only the **token contract's** NEP-141 `ft_transfer` event, never logs from the payer's vault. A fake "vault" that emits fake logs therefore can't pass verification.

## Why NEAR

- **Function-call access keys** are native, scoped keys that can call only the methods you list, can't attach deposits, and have a gas allowance. This gives the agent a "spend-only" key without any account-abstraction add-on.
- **Named sub-accounts.** Each agent gets a readable vault such as `marketing.acme.near`, and an owner can run a whole fleet under one name.
- **Async receipts with callbacks.** The firewall counts the spend before the transfer and refunds the budget in `on_pay` if the transfer fails.

## Repository layout

| Path | What it is |
|---|---|
| `contracts/agent-firewall/` | Rust contract (near-sdk 5): `pay`, owner controls (`set_limits`, `add_payee`, `remove_payee`, `set_paused`, `reset_day`, `withdraw`), `get_policy` view, unit tests |
| `contracts/test-usdc/` | NEP-141 test token (6 decimals) for testnet |
| `src/app/` | The web app: server, marketplace, wallet (in memory or on NEAR) |
| `web/` | The page the app serves |
| `scripts/` | Contract build and testnet deploy |
| `src/policy.ts` | The same policy in TypeScript, used by the offline ledger and for error codes |
| `src/near6/` | Wire types, `paywall()` Express middleware, payment verification |
| `src/client/paying-fetch.ts` | `fetch` wrapper that handles `402 → pay → retry` |
| `src/ledger/mock.ts` | In-memory token and vaults for the demo and tests |
| `src/ledger/near.ts` | Real NEAR: calls `vault.pay` with near-api-js and verifies receipts via RPC |
| `src/api.ts` | Sample paid API (`/weather` 0.01, `/research` 0.05, `/vip-unlock` the "attacker" route) |
| `src/examples/` | Testnet server and agent |

## Run it on NEAR testnet

The same app runs against real contracts on NEAR testnet. A live deployment exists:

| Account | What it is |
|---|---|
| [`ali-demo-70052.testnet`](https://testnet.nearblocks.io/address/ali-demo-70052.testnet) | Owner. Sets the wallet's rules |
| [`budget.ali-demo-70052.testnet`](https://testnet.nearblocks.io/address/budget.ali-demo-70052.testnet) | The "Marketing budget" vault running the Agent Firewall. It has **no full-access key**; the agent's only key can call `pay` and nothing else |
| [`usdc.ali-demo-70052.testnet`](https://testnet.nearblocks.io/address/usdc.ali-demo-70052.testnet) | Test USDC, a NEP-141 token with 6 decimals (`contracts/test-usdc`) |
| `weather-api.ali-demo-70052.testnet` … `images-api.ali-demo-70052.testnet` | One account per marketplace API; they receive the payments |
| `drainer.ali-demo-70052.testnet` | The "attacker" the fake prompt tries to pay |

In testnet mode every **Call** is a real `pay` transaction from the vault, the server verifies the token's `ft_transfer` event over RPC before it answers, and the activity log links each payment to nearblocks. The attacks fail inside the contract with the same codes as offline (`ERR_PAYEE_NOT_ALLOWED`, `ERR_PER_TX_LIMIT`, `ERR_DAILY_LIMIT`, `ERR_PAUSED`). A paid call takes about 5 seconds; owner changes take 2 to 3.

### Deploy your own

Prerequisites: a funded testnet account (about 5 NEAR covers everything), Rust with the `wasm32-unknown-unknown` target, and `wasm-opt` from [binaryen](https://github.com/WebAssembly/binaryen) (`brew install binaryen`).

```bash
npm run build:contracts      # builds both contracts with --cfg near, shrinks them with wasm-opt
cp .env.example .env         # set OWNER_ACCOUNT_ID and OWNER_PRIVATE_KEY
npm run deploy:testnet       # creates the token, vault, API accounts and the agent key; fills in .env
npm start                    # LEDGER=near is now set, so the app runs on testnet
```

`npm run deploy:testnet` is safe to re-run: it skips what already exists. It creates the vault, deploys the firewall, adds the agent's `pay`-only function-call key, then **deletes the vault's full-access key**, registers every account with the token and sends 5 USDC to the vault.

Build note: near-sdk 5.30 reports `require!` messages to the chain only when compiled with `--cfg near` (which `cargo near build` sets). Without it, a rejected payment fails with a bare `unreachable` trap instead of `ERR_*`. `npm run build:contracts` sets the flag.

For the demo, the server holds the owner's key so the page's owner controls work. In production the owner would sign `set_limits`, `add_payee` and the rest in their own wallet; the agent would still hold only the `pay` key.

The older two-process example also works on testnet: `npm run server` (a paid API that verifies over RPC, needs `PAY_TO_ACCOUNT_ID`) and `npm run agent -- "/weather?city=Kyiv"`.

## Limitations (honest status)

- **Verified:** the web app in memory and on NEAR testnet (paid calls, all three attacks, pause, allowlist changes, new day, each payment checked on chain), the offline demo, 35 TypeScript tests, 9 contract unit tests and the typecheck.
- **The owner key sits on the demo server** (see above). Fine for testnet, not for real money.
- **Near6 is its own protocol, compatible with x402's message format.** The message format follows x402 (`402` body with `accepts`, plus `X-PAYMENT` / `X-PAYMENT-RESPONSE` headers). Settlement differs: the agent pays on-chain first and sends the tx hash, instead of the EVM "exact" scheme's signed authorization. Near6 isn't part of the upstream x402 spec.
- **The server keeps nonces in memory,** so they reset on restart. Use Redis or similar for production.
- **One token per vault.**
- **Roadmap (not built):** paying in any token on any chain via NEAR Intents; a policy dashboard for owners; per-payee budgets; on-chain reputation for agents and APIs; deploying the TEE-attested agent on NEAR AI Cloud.

## License

MIT
