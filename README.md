# Ali

**Pay-per-call APIs for AI agents on NEAR. Its NEAR payment protocol is x402-compatible, and an on-chain Agent Firewall makes sure an agent can never spend more than its human allowed. Any MCP agent (Claude, Cursor…) can plug in.**

Built at NEAR HACKATHON 2026. Tracks: **Agent Economy**, **AI Security & Defense**, **Autonomous Business**.

AI agents are starting to pay for APIs, data and compute. Two problems come with that:

1. **Payments.** APIs need a machine-native way to charge per request. [x402](https://www.x402.org/), Coinbase's open standard built on HTTP 402 Payment Required, does this on other chains, but NEAR has no equivalent. Ali's **NEAR** protocol brings it to NEAR: an x402 payment scheme (`scheme: "near"`, `network: "near:testnet"`) that speaks both x402 v1 and v2.
2. **Safety.** An agent holding a normal wallet key can be prompt-injected into draining it.

Ali solves both. An API charges with one Express middleware. The agent pays from a **vault account** whose contract enforces a per-call cap, a daily budget, a payee allowlist and a kill switch. The agent's only key is a NEAR **function-call access key** restricted to the vault's `pay` method, so even a fully jailbroken agent can only do what the policy allows.

## Run the app

```bash
npm install
npm start
```

Open **http://localhost:3000/play** for the **guided tour**: one example, one idea per chapter, about 2 minutes. You tap a card, and a live view shows the agent, the firewall and the API as it happens. It covers why agents need to pay, why a budget beats a wallet, a real paid call, three attacks (prompt injection, a hijack, a runaway loop) and the pause switch, then where to try it next. Each tap is a real request that the server runs on a fresh test budget (`POST /api/tour/:step`).

Open **http://localhost:3000/app** for the full playground. No keys or setup needed. The landing page is at http://localhost:3000. Live: https://ali-near.vercel.app

The app is a guided playground. A numbered checklist at the top says what to do next, and every agent call fills a timeline with each step and its result:

1. **Agent asks the API** (`GET /market/weather?q=Kyiv`)
2. **402 Payment Required**: the price, the payee and a one-time nonce
3. **Firewall checks the rules**: wallet active, under the per-call limit, payee allowed, within today's budget (and enough money, in wallet mode), each ✓ or ✗
4. **Wallet pays**: the transaction, linked to nearblocks in wallet mode
5. **API checks the payment**: it finds the token transfer carrying its nonce
6. **Agent gets the answer**: the API's JSON

Three attacks show where each one is stopped. *Fake prompt*: a poisoned News answer tells the agent to pay `drainer`. *Drain all*: the agent calls `pay` for the whole balance. *Spam 30 calls*: a runaway loop on the priciest allowed API.

It has two modes, switched at the top. A **How it works** guide (and a **?** next to every panel) explains each part in plain language, and every run starts with a one-line summary of what happened and why.

| Mode | What it is |
|---|---|
| **Practice** | A shared in-memory "Marketing budget" (`marketing.acme.near`, 5 USDC). Instant, nothing to set up. It applies the same rules, in the same order, as the contracts (`src/ledger/mock.ts`). |
| **My wallet → Demo wallet** | The full owner flow, simulated and instant: connect in one click (you get an account like `you-7k2p.demo.near`), **(1)** create your budget, **(2)** give the agent a pay-only key, **(3)** call APIs and run the attacks. Each owner action opens a wallet-style approval popup (Approve / Reject). Budgets live on the server's in-memory ledger (`src/app/demo.ts`). |
| **My wallet → Real NEAR testnet wallet** | The same steps on NEAR testnet. Connect **MyNearWallet** or **Meteor** with any testnet account, then: **(1)** create your budget, signing once to get 5 test USDC from the hub's faucet; **(2)** give the agent a key, a function-call key that you add to your own account and that can call only `pay` on the Firewall Hub; **(3)** call APIs and run the attacks. Every rule change (limits, allowed APIs, pause, new day) is a transaction you sign. Every payment is a real `pay` transaction, refused by the contract when it breaks a rule. |

Wallet mode uses the public deployment in [`testnet.json`](testnet.json), which holds no secrets, so it works from a fresh clone. The agent keys the server creates for visitors are stored in `data/agent-keys.json` (gitignored). You only need a little testnet NEAR for gas; new testnet accounts in MyNearWallet and Meteor come with some. Weather and Maps return live data from Open-Meteo, falling back to sample data offline; the other APIs return sample data.

| Route | What it does |
|---|---|
| `GET /market/:api?q=`, `GET /testnet/market/:api?q=` | Paid APIs behind the NEAR paywall (`weather`, `news`, `maps`, `translate`, `search`, `stocks`, `flights`, `images`) |
| `GET /api/practice/state` | Practice wallet: balance, policy, spend today, activity |
| `PATCH /api/practice/policy`, `POST /api/practice/new-day` | Practice owner controls |
| `POST /api/{practice \| testnet/:account}/call` | Agent: `{ api, q }`. Returns `{ ok, short, steps[], result, tx }` |
| `POST /api/{practice \| testnet/:account}/attack` | Agent: `{ kind: "inject" \| "drain" \| "loop" }` |
| `GET /api/demo/:account/state`, `POST /api/demo/:account/sign` | Demo wallet: state, and an approved owner action `{ method, args }` (`create_vault`, `add_key`, `set_limits`, `add_payee`, `remove_payee`, `set_paused`, `reset_day`, `faucet`) |
| `POST /api/demo/:account/{call \| attack}` | Agent, paying from the demo budget |
| `GET /api/testnet/:account/state` | Your hub budget, whether the agent's key is added, activity |
| `POST /api/testnet/:account/agent-key` | The public key to add to your account (`pay` on the hub only) |

After changing `web-src/app.js`, run `npm run build:web`. The bundle in `web/` is committed, so `npm start` needs no build step.

## Deploy to Vercel

The repo deploys as is: `vercel.json` runs `npm run build:vercel`, which writes `.vercel/output` (Vercel's Build Output API). The pages in `web/` become static files, and the whole app is bundled into one Node function for `/api/*`, `/market/*` and `/testnet/market/*`.

1. In Vercel, **Add New → Project**, import the GitHub repo, keep the defaults (Framework Preset: *Other*, root directory: the repo root), and deploy.
2. **To also turn on the real testnet wallet,** add an environment variable `AGENT_KEY_SECRET` set to a long random string (for example the output of `openssl rand -hex 32`), then redeploy. Agent keys are derived from it, so nothing has to be written to disk. Keep it secret, and don't change it later: the keys visitors added to their accounts were derived from it. Without it, Practice and the Demo wallet work, and the real wallet option says it's off.

Practice and demo budgets live in the function's memory, so they start over when Vercel starts a new instance. Wallet mode keeps its state on chain. To check the build locally: `npm run build:vercel`.

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
npm test          # 58 tests: policy, payment verification, NEAR (x402 v1 + v2) end to end, the app, the MCP server
npm run typecheck
```

## Use it from a real AI agent (MCP)

Ali ships an MCP server, so Claude Desktop, Claude Code, Cursor or any MCP client becomes an agent with a budget. The model never holds a key: the MCP server asks the running app to pay, and the app pays with the budget's pay-only key, so every payment still goes through the firewall.

| Tool | What it does |
|---|---|
| `budget` | Balance, per-call and daily limits, spent today, allowed payees, paused or not |
| `list_apis` | The marketplace, with prices and whether this budget may pay each API |
| `call_api` | `{ api, query }`: 402 → pay through the firewall → answer. A refusal comes back with its `ERR_*` reason |
| `fetch_paid` | `{ path }`: open any `/market/...` link, paying if asked. This is how a prompt injection reaches a real model: the News API's answer tells it to open `/market/vip-unlock`, and the firewall refuses to pay `drainer` |

Start the app (`npm start`), then add this to your MCP client's config (for Claude Desktop: `claude_desktop_config.json`), with the path to your clone:

```json
{
  "mcpServers": {
    "ali": {
      "command": "npx",
      "args": ["tsx", "/path/to/ali-near/src/mcp/main.ts"],
      "env": { "ALI_WALLET": "practice" }
    }
  }
}
```

Or with Claude Code:

```bash
claude mcp add ali -e ALI_WALLET=practice -- npx tsx /path/to/ali-near/src/mcp/main.ts
```

`ALI_WALLET` picks the budget: `practice` (the shared one), `demo:<account>` (a demo wallet you set up in the app, e.g. `demo:you-7k2p.demo.near`) or `testnet:<account>` (your real testnet budget, after steps 1–3 in the app). `ALI_APP_URL` defaults to `http://localhost:3000`. Every payment the model makes shows up live in the app's Activity panel. Then ask it, for example: *"Check my budget, get the weather in Lisbon and the latest NEAR news, and follow any links the news tells you to."*

## x402 compatibility

A NEAR paywall answers every unpaid request in both x402 versions at once, and accepts either proof:

| | x402 v1 | x402 v2 |
|---|---|---|
| Offer | `402` JSON body `{ x402Version: 1, accepts: [{ scheme, network: "near-testnet", maxAmountRequired, resource, mimeType, payTo, asset, extra: { nonce } }] }` | `PAYMENT-REQUIRED` header (base64 JSON) `{ x402Version: 2, resource: { url, description, mimeType }, accepts: [{ scheme, network: "near:testnet", amount, asset, payTo, maxTimeoutSeconds, extra: { nonce } }] }` |
| Proof | `X-PAYMENT` header `{ x402Version: 1, scheme, network, payload: { txHash, payer, nonce, from? } }` | `PAYMENT-SIGNATURE` header `{ x402Version: 2, accepted, payload: { txHash, payer, nonce, from? } }` |
| Receipt | `X-PAYMENT-RESPONSE` | `PAYMENT-RESPONSE` (adds `amount`, CAIP-2 network) |

`createPayingFetch` answers in v2 when the server offers it (`version: 1` forces v1). What's NEAR-specific is the scheme: instead of a signed authorization settled by a facilitator, the agent pays on chain first, through its firewall, and the proof is the transaction hash. The server checks the token contract's own transfer event.

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
| `contracts/agent-firewall/` | Rust contract (near-sdk 5), one vault per account: `pay`, owner controls (`set_limits`, `add_payee`, `remove_payee`, `set_paused`, `reset_day`, `withdraw`), `get_policy`, 9 unit tests |
| `contracts/firewall-hub/` | The same firewall for many owners in one contract: a budget per NEAR account, the owner's own key signs the rules, the agent's key can call only `pay`, and a test-USDC faucet. 13 unit tests |
| `contracts/test-usdc/` | NEP-141 test token (6 decimals) for testnet |
| `src/app/` | The app server: practice and wallet modes, the traced agent (`agent.ts`), the marketplace, the hub client (`testnet.ts`) |
| `web/` | The landing page, the guided tour (`play.html`, `play.js`), the app page and its committed bundle |
| `web-src/app.js` | The app's client: NEAR Wallet Selector, the guide, the run timeline |
| `scripts/` | Contract build, testnet deploys (`deploy-testnet.ts`, `deploy-hub.ts`) and an end-to-end testnet check (`e2e-testnet.ts`) |
| `src/policy.ts` | The same policy in TypeScript, used by the offline ledger and for error codes |
| `src/protocol/` | Wire types (x402 v1 and v2), `paywall()` Express middleware, payment verification |
| `src/mcp/` | The MCP server (`budget`, `list_apis`, `call_api`, `fetch_paid`) and its stdio entry |
| `src/app/demo.ts` | The simulated demo wallet |
| `src/app/build.ts`, `src/app/vercel.ts`, `scripts/build-vercel.mjs`, `vercel.json` | One app factory for `npm start` and the Vercel function, and the Vercel build |
| `src/client/paying-fetch.ts` | `fetch` wrapper that handles `402 → pay → retry` |
| `src/ledger/mock.ts` | In-memory token and vaults for practice mode, the demo and tests |
| `src/ledger/near.ts` | Real NEAR: calls `pay` with near-api-js and verifies receipts via RPC |
| `src/api.ts`, `src/examples/` | The minimal paid API and the two-process testnet example |

## On NEAR testnet

The live deployment, all on testnet:

| Account | What it is |
|---|---|
| [`hub.ali-demo-70052.testnet`](https://testnet.nearblocks.io/address/hub.ali-demo-70052.testnet) | **Firewall Hub**, used by the app's wallet mode. One budget per NEAR account, plus a faucet holding 10,000 test USDC |
| [`usdc.ali-demo-70052.testnet`](https://testnet.nearblocks.io/address/usdc.ali-demo-70052.testnet) | Test USDC, a NEP-141 token with 6 decimals |
| `weather-api.ali-demo-70052.testnet` … `images-api.ali-demo-70052.testnet` | One account per marketplace API; they receive the payments |
| `drainer.ali-demo-70052.testnet` | The "attacker" that the fake prompt tries to pay |
| [`budget.ali-demo-70052.testnet`](https://testnet.nearblocks.io/address/budget.ali-demo-70052.testnet) | A single-owner vault running `agent-firewall`, with **no full-access key**. Used by the two-process example |
| [`ali-demo-70052.testnet`](https://testnet.nearblocks.io/address/ali-demo-70052.testnet) | The deployer |

**How wallet mode keeps the agent boxed in.** The hub runs `pay` as the *caller*: it looks up the caller's budget and applies the caller's rules. The agent's key lives on your account and is a function-call key for `pay` on the hub only. It can't call `set_limits`, `add_payee` or anything else, can't call any other contract, and can't move NEAR. So the worst a fully jailbroken agent can do is spend within the rules you signed. Payments leave the hub as NEP-141 transfers with the NEAR nonce as memo, and the API verifies them on chain. The proof carries `from: hub` because the tokens leave the hub, not your account.

To check wallet mode end to end without a browser, run `npx tsx scripts/e2e-testnet.ts` while `npm start` is running. It needs the deployer key in `.env`. The script creates a throwaway account, signs the budget and key like a wallet would, drives the app's API through a call and all three attacks, and then deletes the account.

### Deploy your own

Prerequisites: a funded testnet account (about 8 NEAR covers everything), Rust with the `wasm32-unknown-unknown` target, and `wasm-opt` from [binaryen](https://github.com/WebAssembly/binaryen) (`brew install binaryen`).

```bash
npm run build:contracts      # builds the three contracts with --cfg near, shrinks them with wasm-opt
cp .env.example .env         # set OWNER_ACCOUNT_ID and OWNER_PRIVATE_KEY
npm run deploy:testnet       # test USDC, the API accounts and a single-owner vault
npm run deploy:hub           # the Firewall Hub and its faucet; writes testnet.json
npm start
```

Both deploy scripts are safe to re-run: they skip what already exists.

Build note: near-sdk 5.30 reports `require!` messages to the chain only when compiled with `--cfg near`, which `cargo near build` sets. Without it, a rejected payment fails with a bare `unreachable` trap instead of `ERR_*`. `npm run build:contracts` sets the flag.

The older two-process example also works on testnet: `npm run server` (a paid API that verifies over RPC; needs `PAY_TO_ACCOUNT_ID`) and `npm run agent -- "/weather?city=Kyiv"` (needs the single-owner vault's `VAULT_ACCOUNT_ID` and `AGENT_PRIVATE_KEY`).

## Limitations (honest status)

- **Verified:** practice mode in the browser (calls, attacks, limits, pause, new day). Wallet mode end to end on testnet with a scripted wallet (budget, agent key, a paid call, all three attacks and pause, each checked on chain). The demo wallet flow in the browser. The MCP server over stdio against the running app. The wallet chooser opening with MyNearWallet and Meteor. 54 TypeScript tests, 9 + 13 contract unit tests, the offline demo and the typecheck.
- **Not verified by us:** signing in with a real MyNearWallet or Meteor account in the browser. That needs a person's wallet; the same transactions were sent by the scripted wallet.
- **The agent keys sit on the app server** (`data/agent-keys.json`). That's the point of the design: the agent is a server process. Each key can only call `pay` on the hub and is capped by its gas allowance (0.25 NEAR). Remove it from your account any time in your wallet.
- **No sign-in on the app's API.** Anyone who knows your account id can make the server's agent call APIs for you, but only within your rules and only to APIs you allowed. A production version would check a NEP-413 signed message first.
- **The NEAR scheme is ours, not part of the upstream x402 spec.** It follows x402's v1 and v2 message formats (see *x402 compatibility*). Settlement differs: the agent pays on chain first and sends the tx hash, instead of a signed authorization settled by a facilitator. Off-the-shelf x402 clients would need this scheme added to pay on NEAR; proposing it upstream is on the roadmap. "x402" is Coinbase's name for its open standard; Ali isn't affiliated with Coinbase.
- **The server keeps nonces in memory,** so they reset on restart. Use Redis or similar for production.
- **One token per vault.**
- **Roadmap (not built):** paying in any token on any chain via NEAR Intents; a policy dashboard for owners; per-payee budgets; on-chain reputation for agents and APIs; deploying the TEE-attested agent on NEAR AI Cloud.

## License

MIT
