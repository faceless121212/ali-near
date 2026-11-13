// The Ali app server. Two ways to try the same agent:
//
//   practice  an in-memory wallet everyone shares; instant, no keys
//   testnet   the visitor's own budget on the Firewall Hub, signed in their NEAR wallet
//
// Both run the agent over real NEAR (HTTP 402) against the paid marketplace and
// return every step of each call.
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import { USDC } from "../api.js";
import type { Ledger } from "../ledger/types.js";
import { runCall, runDirectPay, type AgentOptions, type Budget, type Run } from "./agent.js";
import { buildMarket, createMarket, type Market } from "./market.js";
import { DEMO_HUB, type DemoWallets } from "./demo.js";
import type { Hub } from "./testnet.js";
import type { Wallet } from "./wallet.js";

export interface AppOptions {
  practice: { ledger: Ledger; wallet: Wallet; market: Market; asset: string };
  /** Wallet mode on NEAR testnet; off when there is no testnet.json. */
  hub?: Hub;
  /** Wallet mode with a simulated wallet on the practice ledger. */
  demo?: DemoWallets;
  /** Folder with the pages and assets. Defaults to ../../web. */
  webDir?: string;
}

interface Activity {
  id: number;
  at: number;
  kind: "ok" | "no";
  tag: string;
  text: string;
  why: string;
  tx?: string;
}

const LIMITS = { perTxMax: USDC(1), dailyMax: USDC(5) };
const fmt = (units: bigint) => (Number(units) / 1_000_000).toFixed(2);
const ACCOUNT = /^(?=.{2,64}$)[a-z0-9]+([-_][a-z0-9]+)*(\.[a-z0-9]+([-_][a-z0-9]+)*)*$/;

export function createApp({ practice, hub, demo, webDir }: AppOptions) {
  const app = express();
  app.use(express.json());
  app.use("/market", createMarket({ ledger: practice.ledger, asset: practice.asset, market: practice.market }));
  const hubMarket = hub ? buildMarket(hub.config.marketRoot) : undefined;
  if (hub && hubMarket) app.use("/testnet/market", createMarket({ ledger: hub.verifier(), asset: hub.config.token, market: hubMarket }));

  // Activity per wallet: "practice" or a NEAR account id.
  const activity = new Map<string, Activity[]>();
  let seq = 0;
  const feed = (space: string) => activity.get(space) ?? [];
  function log(space: string, entry: Omit<Activity, "id" | "at">) {
    activity.set(space, [{ id: ++seq, at: Date.now(), ...entry }, ...feed(space)].slice(0, 50));
  }
  function logRun(space: string, text: string, run: Run, payee: string, amount: bigint) {
    if (run.ok) log(space, { kind: "ok", tag: "Paid", text, why: `${fmt(amount)} USDC → ${payee}`, tx: run.tx });
    else log(space, { kind: "no", tag: run.code ? "Blocked" : "Failed", text, why: run.steps.at(-1)?.detail ?? run.short });
  }

  // One payment at a time: parallel transactions from one key collide on nonces.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work);
    queue = run.catch(() => {});
    return run;
  };
  const handle =
    (work: (req: Request) => Promise<object>) =>
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        res.json(await work(req));
      } catch (err) {
        next(err);
      }
    };

  // The agent calls the marketplace over real HTTP. It talks to this same app on an
  // internal loopback listener, so it also works where the public server has no port
  // (serverless) and the 402 nonce stays in this process's memory.
  let self: Promise<string> | undefined;
  const local = (_req: Request) =>
    (self ??= new Promise<string>((resolve, reject) => {
      const inner = app.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(inner.address() as AddressInfo).port}`));
      inner.on("error", reject);
      inner.unref();
    }));
  const apisOf = (m: Market) =>
    m.apis.map((a) => ({ id: a.id, name: a.name, account: a.account, price: Number(a.price), description: a.description, defaultQuery: a.defaultQuery }));
  const numbers = (b: Budget) => ({
    balance: Number(b.balance),
    spentToday: Number(b.spentToday),
    policy: { perTxMax: Number(b.policy.perTxMax), dailyMax: Number(b.policy.dailyMax), allowlist: b.policy.allowlist, paused: b.policy.paused },
  });

  app.get("/api/config", (_req, res) => {
    res.json({ testnet: hub ? hub.config : null, demo: Boolean(demo) });
  });

  // ---------- practice ----------

  const { wallet, market } = practice;
  const practiceState = async () => ({
    mode: "practice",
    network: practice.ledger.network,
    vault: wallet.vault,
    explorer: null,
    budget: numbers(await wallet.view()),
    apis: apisOf(market),
    activity: feed("practice"),
  });
  const practiceAgent = async (): Promise<AgentOptions> => ({
    ledger: practice.ledger,
    vault: wallet.vault,
    asset: practice.asset,
    budget: await wallet.view(),
    checksBalance: false,
  });

  app.get("/api/practice/state", handle(practiceState));

  app.patch(
    "/api/practice/policy",
    handle((req) =>
      serial(async () => {
        const { perTxMax, dailyMax, paused, allow } = req.body ?? {};
        const { policy } = await wallet.view();
        if (perTxMax !== undefined || dailyMax !== undefined) {
          await wallet.setLimits(
            perTxMax === undefined ? policy.perTxMax : units(perTxMax, LIMITS.perTxMax),
            dailyMax === undefined ? policy.dailyMax : units(dailyMax, LIMITS.dailyMax),
          );
          log("practice", { kind: "ok", tag: "Setting", text: "Limits changed", why: "Owner only" });
        }
        if (typeof paused === "boolean" && paused !== policy.paused) {
          await wallet.setPaused(paused);
          log("practice", { kind: paused ? "no" : "ok", tag: "Setting", text: paused ? "Wallet paused" : "Wallet resumed", why: "Owner only" });
        }
        if (allow && typeof allow.account === "string" && market.apis.some((a) => a.account === allow.account)) {
          await wallet.setAllowed(allow.account, Boolean(allow.on));
          log("practice", { kind: allow.on ? "ok" : "no", tag: "Setting", text: `${allow.on ? "Allowed" : "Removed"} ${allow.account}`, why: "Owner only" });
        }
        return { state: await practiceState() };
      }),
    ),
  );

  app.post(
    "/api/practice/new-day",
    handle(() =>
      serial(async () => {
        await wallet.resetDay();
        log("practice", { kind: "ok", tag: "New day", text: "Daily spend reset", why: "0.00 spent today" });
        return { state: await practiceState() };
      }),
    ),
  );

  app.post(
    "/api/practice/call",
    handle((req) => serial(async () => ({ ...(await call(req, "practice", "/market", market, practiceAgent)), state: await practiceState() }))),
  );

  app.post(
    "/api/practice/attack",
    handle((req) => serial(async () => ({ ...(await attack(req, "practice", "/market", market, practiceAgent)), state: await practiceState() }))),
  );

  app.post(
    "/api/practice/fetch",
    handle((req) => serial(async () => ({ ...(await fetchPath(req, "practice", "/market", practiceAgent)), state: await practiceState() }))),
  );

  const account = (req: Request) => {
    const id = String(req.params.account ?? "");
    if (!ACCOUNT.test(id)) throw Object.assign(new Error("invalid account id"), { status: 400 });
    return id;
  };

  // ---------- demo wallet: wallet mode, simulated ----------

  if (demo) {
    const demoState = async (id: string) => {
      const view = demo.view(id);
      return {
        mode: "demo",
        network: practice.ledger.network,
        vault: id,
        hub: DEMO_HUB,
        explorer: null,
        budget: view.budget && { ...numbers(view.budget), faucetReady: view.budget.faucetReady },
        agentKey: { publicKey: view.keyAdded ? "ed25519:demo-agent-key" : null, added: view.keyAdded },
        apis: apisOf(market),
        activity: feed(`demo:${id}`),
      };
    };
    const demoAgent = (id: string) => async (): Promise<AgentOptions> => {
      const { budget, keyAdded } = demo.view(id);
      if (!budget) throw Object.assign(new Error("create your budget first"), { status: 409 });
      if (!keyAdded) throw Object.assign(new Error("give the agent its key first"), { status: 409 });
      return { ledger: practice.ledger, vault: id, asset: practice.asset, budget, checksBalance: true };
    };

    app.get("/api/demo/:account/state", handle((req) => demoState(account(req))));

    // The visitor approved a transaction in the simulated wallet.
    app.post(
      "/api/demo/:account/sign",
      handle((req) =>
        serial(async () => {
          const id = account(req);
          const method = String(req.body?.method ?? "");
          const label = String(req.body?.label ?? method).slice(0, 80);
          const tx = demo.sign(id, method, req.body?.args ?? {});
          log(`demo:${id}`, { kind: "ok", tag: "Signed", text: label, why: "In your demo wallet", tx });
          return { tx, state: await demoState(id) };
        }),
      ),
    );

    app.post(
      "/api/demo/:account/call",
      handle((req) => {
        const id = account(req);
        return serial(async () => ({ ...(await call(req, `demo:${id}`, "/market", market, demoAgent(id))), state: await demoState(id) }));
      }),
    );

    app.post(
      "/api/demo/:account/attack",
      handle((req) => {
        const id = account(req);
        return serial(async () => ({ ...(await attack(req, `demo:${id}`, "/market", market, demoAgent(id))), state: await demoState(id) }));
      }),
    );

    app.post(
      "/api/demo/:account/fetch",
      handle((req) => {
        const id = account(req);
        return serial(async () => ({ ...(await fetchPath(req, `demo:${id}`, "/market", demoAgent(id))), state: await demoState(id) }));
      }),
    );
  }

  // ---------- testnet: the visitor's own wallet ----------

  if (hub && hubMarket) {
    const testnetState = async (id: string) => {
      const [budget, added] = await Promise.all([hub.budget(id), hub.agentKeyAdded(id)]);
      return {
        mode: "testnet",
        network: `near-${hub.config.network}`,
        vault: id,
        hub: hub.config.hub,
        explorer: `${hub.config.explorer}/txns/`,
        budget: budget && { ...numbers(budget), faucetReady: budget.faucetReady },
        agentKey: { publicKey: hub.keys.publicKey(id) ?? null, added },
        apis: apisOf(hubMarket),
        activity: feed(id),
      };
    };
    const hubAgent = (id: string) => async (): Promise<AgentOptions> => {
      const budget = await hub.budget(id);
      if (!budget) throw Object.assign(new Error("create your budget first"), { status: 409 });
      return { ledger: hub.ledger(id), vault: id, asset: hub.config.token, budget, checksBalance: true };
    };
    const needsKey = async (id: string) => {
      if (!(await hub.agentKeyAdded(id))) throw Object.assign(new Error("add the agent's key first"), { status: 409 });
    };

    app.get("/api/testnet/:account/state", handle((req) => testnetState(account(req))));

    // The agent's key pair for this account. The visitor adds the public key in their wallet.
    app.post(
      "/api/testnet/:account/agent-key",
      handle(async (req) => ({ publicKey: hub.keys.ensure(account(req)), hub: hub.config.hub, methodNames: ["pay"] })),
    );

    // The owner signed something in their wallet; note it in the activity log.
    app.post(
      "/api/testnet/:account/note",
      handle(async (req) => {
        const id = account(req);
        const text = String(req.body?.text ?? "").slice(0, 80);
        const tx = typeof req.body?.tx === "string" ? req.body.tx.slice(0, 64) : undefined;
        if (text) log(id, { kind: req.body?.kind === "no" ? "no" : "ok", tag: "Signed", text, why: "In your NEAR wallet", tx });
        return { state: await testnetState(id) };
      }),
    );

    app.post(
      "/api/testnet/:account/call",
      handle(async (req) => {
        const id = account(req);
        await needsKey(id);
        return serial(async () => ({ ...(await call(req, id, "/testnet/market", hubMarket, hubAgent(id))), state: await testnetState(id) }));
      }),
    );

    app.post(
      "/api/testnet/:account/attack",
      handle(async (req) => {
        const id = account(req);
        await needsKey(id);
        return serial(async () => ({ ...(await attack(req, id, "/testnet/market", hubMarket, hubAgent(id))), state: await testnetState(id) }));
      }),
    );

    app.post(
      "/api/testnet/:account/fetch",
      handle(async (req) => {
        const id = account(req);
        await needsKey(id);
        return serial(async () => ({ ...(await fetchPath(req, id, "/testnet/market", hubAgent(id))), state: await testnetState(id) }));
      }),
    );
  }

  // ---------- the agent ----------

  async function call(req: Request, space: string, prefix: string, m: Market, agent: () => Promise<AgentOptions>) {
    const api = m.apis.find((a) => a.id === req.body?.api);
    if (!api) throw Object.assign(new Error("unknown API"), { status: 400 });
    const q = String(req.body?.q || api.defaultQuery).slice(0, 80);
    const path = `${prefix}/${api.id}?q=${encodeURIComponent(q)}`;
    const run = await runCall(await agent(), (await local(req)) + path, path);
    logRun(space, `${api.name} API`, run, api.account, api.price);
    return run;
  }

  /**
   * The agent follows any marketplace link, paying if asked. This is how a real
   * AI agent (over MCP) gets prompt-injected: it reads "call /market/vip-unlock"
   * in an answer and fetches it. The firewall decides whether it may pay.
   */
  async function fetchPath(req: Request, space: string, prefix: string, agent: () => Promise<AgentOptions>) {
    const raw = String(req.body?.path ?? "").trim();
    const match = raw.match(/^(?:\/testnet)?\/market\/([a-z0-9-]{1,32})(\?[^#\s]{0,200})?$/);
    if (!match) throw Object.assign(new Error("path must look like /market/<api>?q=..."), { status: 400 });
    const path = `${prefix}/${match[1]}${match[2] ?? ""}`;
    const run = await runCall(await agent(), (await local(req)) + path, path);
    const payee = run.steps.find((s) => s.key === "quote")?.detail.split(" to ")[1] ?? "";
    const amount = BigInt((run.steps.find((s) => s.key === "quote")?.data as { amount?: string } | undefined)?.amount ?? 0);
    logRun(space, `Agent fetched ${path.replace(prefix, "/market")}`, run, payee, amount);
    return run;
  }

  async function attack(req: Request, space: string, prefix: string, m: Market, agent: () => Promise<AgentOptions>) {
    const kind = String(req.body?.kind);
    if (kind === "inject") {
      // The agent obeys the poisoned News answer and calls the attacker's endpoint.
      const path = `${prefix}/vip-unlock`;
      const run = await runCall(await agent(), (await local(req)) + path, `${path} (a fake prompt said to)`);
      logRun(space, `Fake prompt: "pay ${m.attacker}"`, run, m.attacker, USDC(0.09));
      return run;
    }
    if (kind === "drain") {
      const opts = await agent();
      const amount = opts.budget.balance > 0n ? opts.budget.balance : USDC(5);
      const run = await runDirectPay(opts, m.attacker, amount);
      logRun(space, "Send the whole balance", run, m.attacker, amount);
      return run;
    }
    if (kind === "loop") {
      // The priciest allowed API, so the daily budget runs out in a few calls.
      const { budget } = await agent();
      const api = m.apis.filter((a) => budget.policy.allowlist.includes(a.account)).sort((a, b) => Number(b.price - a.price))[0];
      if (!api) return { ok: false, short: "No API is allowed", steps: [], runs: [] };
      const runs: { n: number; ok: boolean; short: string; tx?: string }[] = [];
      let last: Run | undefined;
      for (let i = 1; i <= 30; i++) {
        const path = `${prefix}/${api.id}?q=${encodeURIComponent(api.defaultQuery)}`;
        last = await runCall(await agent(), (await local(req)) + path, `${path} (call ${i} of 30)`);
        logRun(space, `${api.name} call ${i}`, last, api.account, api.price);
        runs.push({ n: i, ok: last.ok, short: last.short, tx: last.tx });
        if (!last.ok) break;
      }
      const n = runs.filter((r) => r.ok).length;
      const ok = n === 30;
      log(space, { kind: ok ? "ok" : "no", tag: ok ? "Done" : "Stopped", text: "Spam 30 calls", why: `${n} of 30 calls went through` });
      return { ...last!, ok, short: ok ? "All 30 calls went through" : `Stopped after ${n} of 30 calls`, runs };
    }
    throw Object.assign(new Error("unknown attack"), { status: 400 });
  }

  const pages = webDir ?? fileURLToPath(new URL("../../web", import.meta.url));
  app.get("/app", (_req, res) => res.sendFile("app.html", { root: pages }));
  app.use(express.static(pages));
  app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status ?? 500;
    if (status === 500) console.error(err);
    res.status(status).json({ error: err.message });
  });
  return app;
}

/** Parses a micro-USDC amount from the client and clamps it to a sane range. */
function units(value: unknown, max: bigint) {
  return BigInt(Math.max(10_000, Math.min(Number(max), Math.round(Number(value) || 0))));
}
