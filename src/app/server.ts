// The Ali web app: serves the UI, the paid API marketplace, the owner's wallet
// controls and an agent that buys from the marketplace over real Near6 (HTTP 402).
import { fileURLToPath } from "node:url";
import express, { type Request } from "express";
import { USDC } from "../api.js";
import { createPayingFetch, readSettlement } from "../client/paying-fetch.js";
import type { Ledger } from "../ledger/types.js";
import { FirewallError, type FirewallCode } from "../policy.js";
import { createMarket, type Market } from "./market.js";
import type { Wallet } from "./wallet.js";

export interface AppOptions {
  /** The agent's side: pays through the vault and verifies payments. */
  ledger: Ledger;
  /** The owner's side: reads and changes the vault's policy. */
  wallet: Wallet;
  market: Market;
  asset: string;
  /** Folder with index.html and assets. Defaults to ../../web. */
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

/** What the agent saw: `short` fits on a tile, `steps` is the Near6 handshake. */
interface Outcome {
  ok: boolean;
  short: string;
  result?: unknown;
  steps: string[];
}

const LIMITS = { perTxMax: USDC(1), dailyMax: USDC(5) };
const fmt = (units: bigint) => (Number(units) / 1_000_000).toFixed(2);

export function createApp({ ledger, wallet, market, asset, webDir }: AppOptions) {
  const { vault } = wallet;
  const app = express();
  app.use(express.json());
  app.use("/market", createMarket({ ledger, asset, market }));

  // One wallet action at a time: on NEAR, parallel transactions from one key collide on nonces.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work);
    queue = run.catch(() => {});
    return run;
  };

  const activity: Activity[] = [];
  let seq = 0;
  function log(entry: Omit<Activity, "id" | "at">) {
    activity.unshift({ id: ++seq, at: Date.now(), ...entry });
    activity.length = Math.min(activity.length, 50);
  }

  async function state() {
    const { balance, spentToday, policy } = await wallet.view();
    return {
      network: ledger.network,
      asset,
      vault,
      explorer: wallet.explorer?.("") ?? null,
      balance: Number(balance),
      spentToday: Number(spentToday),
      policy: {
        perTxMax: Number(policy.perTxMax),
        dailyMax: Number(policy.dailyMax),
        allowlist: policy.allowlist,
        paused: policy.paused,
      },
      apis: market.apis.map((a) => ({
        id: a.id,
        name: a.name,
        account: a.account,
        price: Number(a.price),
        description: a.description,
        defaultQuery: a.defaultQuery,
      })),
      activity,
    };
  }

  // The agent: a fetch that answers 402s by paying through the firewall vault.
  const agentFetch = (req: Request, steps: string[]) => {
    const base = `http://127.0.0.1:${req.socket.localPort}`;
    const fetchPaid = createPayingFetch({
      ledger,
      vault,
      acceptAssets: [asset],
      onPayment: ({ requirements, txHash }) => {
        steps.push(`402: pay ${fmt(BigInt(requirements.maxAmountRequired))} USDC to ${requirements.payTo}`);
        steps.push(`Paid through the wallet, tx ${txHash.slice(0, 10)}…`);
      },
    });
    return (path: string) => fetchPaid(base + path);
  };

  async function callApi(req: Request, apiId: string, q: string | undefined, label: string): Promise<Outcome> {
    const api = market.apis.find((a) => a.id === apiId);
    if (!api) return { ok: false, short: "Unknown API", steps: [] };
    const steps: string[] = [];
    const path = `/market/${api.id}?q=${encodeURIComponent(q || api.defaultQuery)}`;
    try {
      const res = await agentFetch(req, steps)(path);
      const body = await res.json();
      if (!res.ok) {
        log({ kind: "no", tag: "Failed", text: label, why: `HTTP ${res.status}: ${body.error}` });
        return { ok: false, short: `Failed: HTTP ${res.status}`, steps };
      }
      const tx = readSettlement(res)?.transaction;
      steps.push("Proof verified, 200 OK");
      log({ kind: "ok", tag: "Paid", text: label, why: `${fmt(api.price)} USDC → ${api.account}`, tx });
      return { ok: true, short: `Paid ${fmt(api.price)} USDC`, result: body, steps };
    } catch (err) {
      return blocked(err, label, steps);
    }
  }

  function blocked(err: unknown, label: string, steps: string[]): Outcome {
    if (!(err instanceof FirewallError)) throw err;
    const [short, why] = explain(err.code);
    steps.push(`Wallet refused: ${err.code}`);
    log({ kind: "no", tag: "Blocked", text: label, why });
    return { ok: false, short: `Blocked: ${short}`, steps };
  }

  // Wraps a handler: runs it in the queue, then answers with its result plus the fresh state.
  const action =
    (work: (req: Request) => Promise<object | void>) =>
    async (req: Request, res: express.Response, next: express.NextFunction) => {
      try {
        res.json(await serial(async () => ({ ...(await work(req)), state: await state() })));
      } catch (err) {
        next(err);
      }
    };

  app.get("/api/state", async (_req, res, next) => {
    try {
      res.json(await state());
    } catch (err) {
      next(err);
    }
  });

  // Owner controls. On chain only the owner's key can call these.
  app.patch(
    "/api/policy",
    action(async (req) => {
      const { perTxMax, dailyMax, paused, allow } = req.body ?? {};
      const { policy } = await wallet.view();
      if (perTxMax !== undefined || dailyMax !== undefined) {
        await wallet.setLimits(
          perTxMax === undefined ? policy.perTxMax : units(perTxMax, LIMITS.perTxMax),
          dailyMax === undefined ? policy.dailyMax : units(dailyMax, LIMITS.dailyMax),
        );
      }
      if (typeof paused === "boolean" && paused !== policy.paused) {
        await wallet.setPaused(paused);
        log({ kind: paused ? "no" : "ok", tag: "Setting", text: paused ? "Wallet paused" : "Wallet resumed", why: "Only the owner can do this" });
      }
      if (allow && typeof allow.account === "string" && market.apis.some((a) => a.account === allow.account)) {
        await wallet.setAllowed(allow.account, Boolean(allow.on));
        log({ kind: allow.on ? "ok" : "no", tag: "Setting", text: `${allow.on ? "Allowed" : "Removed"} ${allow.account}`, why: "Only the owner can change this" });
      }
    }),
  );

  app.post(
    "/api/new-day",
    action(async () => {
      await wallet.resetDay();
      log({ kind: "ok", tag: "New day", text: "Daily spend reset", why: "0.00 spent today" });
    }),
  );

  app.post(
    "/api/call",
    action((req) => {
      const api = market.apis.find((a) => a.id === req.body?.api);
      return callApi(req, String(req.body?.api), req.body?.q, `${api?.name ?? "Unknown"} API`);
    }),
  );

  app.post("/api/attack", action((req) => attack(req, String(req.body?.kind))));

  async function attack(req: Request, kind: string): Promise<Outcome> {
    if (kind === "inject") {
      // The agent obeys the poisoned News response and calls the attacker's endpoint.
      const steps = ["Agent follows a fake prompt to /market/vip-unlock"];
      const label = `Fake prompt: "pay ${market.attacker}"`;
      try {
        const res = await agentFetch(req, steps)("/market/vip-unlock");
        log({ kind: "no", tag: "Paid", text: label, why: `0.09 USDC → ${market.attacker}` });
        return { ok: true, short: "The attacker got paid", result: await res.json(), steps };
      } catch (err) {
        return blocked(err, label, steps);
      }
    }
    if (kind === "drain") {
      // A jailbroken agent skips the API and calls the vault's `pay` directly.
      const steps = ["Agent calls pay() for the whole balance"];
      const label = "Send the whole balance";
      try {
        const { balance: amount } = await wallet.view();
        await ledger.pay({ vault, payee: market.attacker, amount, memo: "" });
        log({ kind: "no", tag: "Paid", text: label, why: `${fmt(amount)} USDC → ${market.attacker}` });
        return { ok: true, short: "The wallet was drained", steps };
      } catch (err) {
        return blocked(err, label, steps);
      }
    }
    if (kind === "loop") {
      // The priciest allowed API, so the daily budget runs out in a few calls.
      const { policy } = await wallet.view();
      const api = market.apis
        .filter((a) => policy.allowlist.includes(a.account))
        .sort((a, b) => Number(b.price - a.price))[0];
      if (!api) {
        log({ kind: "no", tag: "Stopped", text: "Spam 30 calls", why: "No API is allowed" });
        return { ok: false, short: "No API is allowed", steps: [] };
      }
      let n = 0;
      for (let i = 0; i < 30; i++) {
        const r = await callApi(req, api.id, undefined, `${api.name} call ${i + 1}`);
        if (!r.ok) break;
        n++;
      }
      const ok = n === 30;
      log({ kind: ok ? "ok" : "no", tag: ok ? "Done" : "Stopped", text: "Spam 30 calls", why: `${n} of 30 calls went through` });
      return { ok, short: ok ? "All 30 calls went through" : `Stopped after ${n} of 30 calls`, steps: [] };
    }
    return { ok: false, short: "Unknown attack", steps: [] };
  }

  app.use(express.static(webDir ?? fileURLToPath(new URL("../../web", import.meta.url))));
  return app;
}

/** Parses a micro-USDC amount from the client and clamps it to a sane range. */
function units(value: unknown, max: bigint) {
  return BigInt(Math.max(10_000, Math.min(Number(max), Math.round(Number(value) || 0))));
}

function explain(code: FirewallCode): [string, string] {
  switch (code) {
    case "ERR_PAUSED": return ["wallet paused", "The wallet is paused"];
    case "ERR_PER_TX_LIMIT": return ["over per-call limit", "The amount is over the per-call limit"];
    case "ERR_PAYEE_NOT_ALLOWED": return ["not allowed", "That account isn't on the allowed list"];
    case "ERR_DAILY_LIMIT": return ["daily limit reached", "It would pass the daily limit"];
    default: return ["refused", code];
  }
}
