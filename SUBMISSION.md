# Ali: submission text

Copy-paste material for the NEAR HACKATHON 2026 form. Repo: https://github.com/faceless121212/ali-near

## Name

Ali

## One-liner

Let your AI agent spend. Never let it drain. x402-compatible pay-per-call for AI agents on NEAR, with an on-chain firewall that enforces the owner's rules.

## Tracks

Agent Economy · AI Security & Defense · Autonomous Business

## Problem

AI agents are starting to pay for APIs, data and compute, usually a cent or two per call. Two things are missing on NEAR:

1. **A way for APIs to charge machines per request.** x402, the open standard built on HTTP 402, does this on other chains. NEAR has no equivalent.
2. **A safe way to give an agent money.** An agent holding a normal wallet key can be prompt-injected, hijacked, or stuck in a loop, and drain everything.

## Solution

- **Near6: an x402 payment scheme for NEAR.** One Express middleware turns any API into a paid one. It answers in x402 v1 and v2 (`network: "near:testnet"`). The agent pays with a NEP-141 transfer carrying a one-time nonce, and the API checks the token contract's own transfer event on chain.
- **Agent Firewall: Rust contracts on NEAR.** Every payment passes owner-set rules before any token moves: a per-call cap, a daily budget, an allowlist of payees, and a pause switch. The agent's only key is a NEAR **function-call access key** that can call `pay` and nothing else, so even a fully jailbroken agent can only spend within the rules.
- **Firewall Hub on testnet.** Any NEAR account gets its own budget in one shared contract: sign once, get 5 test USDC, add a pay-only key for the agent.
- **MCP server.** Claude, Cursor or any MCP client becomes an agent with a budget (`budget`, `list_apis`, `call_api`, `fetch_paid`). The model never holds a key, and when a prompt injection tells it to pay an attacker, the firewall refuses.
- **The app.** A guided playground that shows every step of each call (request → 402 → firewall checks → pay → verify → answer) and lets you attack it. It has three wallets: *Practice* (instant), *Demo wallet* (the full owner flow, simulated, one click), and a *real NEAR testnet wallet* (MyNearWallet / Meteor).

## Why NEAR

- **Function-call access keys** are native "spend-only" keys: scoped to one contract and method, no deposits, with a gas allowance. No account-abstraction add-on needed.
- **Named accounts** (`marketing.acme.near`) make budgets and payees readable.
- **Async receipts with callbacks:** the firewall counts the spend, and refunds the budget if the token transfer fails.

## What's built and verified

- 3 Rust contracts: `agent-firewall` (single-owner vault, 9 tests), `firewall-hub` (multi-owner budgets + faucet, 13 tests), `test-usdc` (NEP-141), all deployed on testnet (`hub.ali-demo-70052.testnet`).
- TypeScript: Near6 paywall and verifier (x402 v1 + v2), paying fetch, the app, the MCP server. 54 tests.
- End-to-end on NEAR testnet (`scripts/e2e-testnet.ts`), each step a real transaction:
  - A paid call went through over x402 v2.
  - Prompt injection was refused with `ERR_PAYEE_NOT_ALLOWED`.
  - Draining the balance was refused with `ERR_PER_TX_LIMIT`.
  - A runaway loop stopped after 3 calls with `ERR_DAILY_LIMIT`.
  - A call on the paused wallet was refused with `ERR_PAUSED`.
- Not verified by us: signing in with a real MyNearWallet or Meteor account in the browser. The same transactions were sent by a scripted wallet.

## How to try it (2 minutes)

```bash
git clone https://github.com/faceless121212/ali-near && cd ali-near
npm install && npm start
```

Open http://localhost:3000/app:

1. **Practice:** press **Call** on Weather and watch the 6 steps, then press the three red attack cards.
2. **My wallet → Connect → Demo wallet:** approve *Create budget* and *Add key* in the popup, then call and attack.
3. **Optional, real chain:** **My wallet → Real NEAR testnet wallet**.

The **How it works** button explains every part in plain language.

To use it from Claude Desktop or Claude Code, see "Use it from a real AI agent (MCP)" in the README.

## What's next

Propose the Near6 scheme to the x402 spec. Pay in any token through NEAR Intents. Per-payee budgets. Signed (NEP-413) access to the app's API. Run the agent in a TEE on NEAR AI Cloud.
