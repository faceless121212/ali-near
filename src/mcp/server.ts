// Ali as an MCP server: any MCP client (Claude Desktop, Claude Code, Cursor…)
// becomes an agent with a budget. It can look at its budget, call paid APIs and
// follow paid links, and every payment goes through the firewall. The agent never
// holds a key: it talks to a running Ali app, which pays with the budget's
// pay-only key, so a jailbroken model still can't break the owner's rules.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export interface AliMcpOptions {
  /** The running Ali app, e.g. http://localhost:3000 */
  appUrl: string;
  /** "practice" | "demo:<account>" | "testnet:<account>" */
  wallet: string;
}

interface Budget {
  balance: number;
  spentToday: number;
  policy: { perTxMax: number; dailyMax: number; allowlist: string[]; paused: boolean };
}
interface State {
  vault: string;
  network: string;
  budget: Budget | null;
  apis: { id: string; name: string; account: string; price: number; description: string }[];
}
interface Run {
  ok: boolean;
  short: string;
  code?: string;
  tx?: string;
  result?: unknown;
  steps: { key: string; detail: string; status: string }[];
}

const usdc = (micro: number) => `${(micro / 1_000_000).toFixed(2)} USDC`;

export function walletPath(wallet: string): string {
  if (wallet === "practice") return "/api/practice";
  const [kind, account] = wallet.split(":");
  if ((kind === "demo" || kind === "testnet") && account) return `/api/${kind}/${encodeURIComponent(account)}`;
  throw new Error(`ALI_WALLET must be "practice", "demo:<account>" or "testnet:<account>", got "${wallet}"`);
}

export function createAliMcp({ appUrl, wallet }: AliMcpOptions) {
  const base = appUrl.replace(/\/$/, "") + walletPath(wallet);
  const server = new McpServer({ name: "ali", version: "0.1.0" });

  async function api<T>(method: "GET" | "POST", path: string, body?: object): Promise<T> {
    const res = await fetch(base + path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body && JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
    return json as T;
  }

  const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], isError });

  /** Turns a run into what the model needs: the answer, or why the firewall refused. */
  function report(run: Run): ReturnType<typeof text> {
    if (run.ok) {
      const paid = run.steps.find((s) => s.key === "pay")?.detail;
      return text(`${run.short}${paid ? ` (${paid})` : ""}${run.tx ? `, tx ${run.tx}` : ""}.\n\nAnswer:\n${JSON.stringify(run.result, null, 2)}`);
    }
    if (run.code) {
      const why = run.steps.find((s) => s.key === "checks")?.detail ?? run.code;
      return text(`${run.short}. ${why}. The firewall refused the payment and no money moved. Only the budget's owner can change the rules.`, true);
    }
    return text(`${run.short}: ${run.steps.at(-1)?.detail ?? "failed"}`, true);
  }

  server.registerTool(
    "budget",
    {
      title: "Show my budget",
      description: "Show the agent's spending budget: balance, per-call and daily limits, spent today, allowed APIs, and whether the owner paused it.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const s = await api<State>("GET", "/state");
      const b = s.budget;
      if (!b) return text(`${s.vault} has no budget yet. The owner must create one in the Ali app.`, true);
      return text(
        [
          `Budget ${s.vault} on ${s.network}`,
          `Balance: ${usdc(b.balance)}`,
          `Per call: up to ${usdc(b.policy.perTxMax)}`,
          `Today: ${usdc(b.spentToday)} spent of ${usdc(b.policy.dailyMax)}`,
          `Status: ${b.policy.paused ? "PAUSED by the owner, every payment is refused" : "active"}`,
          `Allowed payees: ${b.policy.allowlist.join(", ") || "none"}`,
        ].join("\n"),
      );
    },
  );

  server.registerTool(
    "list_apis",
    {
      title: "List paid APIs",
      description: "List the APIs in the marketplace with their price per call and whether this budget may pay them.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const s = await api<State>("GET", "/state");
      const allowed = new Set(s.budget?.policy.allowlist ?? []);
      return text(
        s.apis
          .map((a) => `- ${a.id}: ${a.name}, ${usdc(a.price)} per call, ${allowed.has(a.account) ? "allowed" : "NOT allowed"}. ${a.description}`)
          .join("\n"),
      );
    },
  );

  server.registerTool(
    "call_api",
    {
      title: "Call a paid API",
      description:
        "Call one marketplace API. It answers HTTP 402 with a price; the agent pays from its budget through the firewall, then gets the answer. If the firewall refuses, you get the reason and nothing is paid.",
      inputSchema: {
        api: z.string().describe("API id from list_apis, e.g. weather, news, maps, translate"),
        query: z.string().max(80).optional().describe("What to ask, e.g. a city for weather or a topic for news"),
      },
    },
    async ({ api: id, query }) => report(await api<Run>("POST", "/call", { api: id, q: query })),
  );

  server.registerTool(
    "fetch_paid",
    {
      title: "Open a paid marketplace link",
      description: "Open a marketplace path such as /market/news?q=NEAR, paying for it if it asks for payment. Payments still go through the firewall.",
      inputSchema: { path: z.string().max(240).describe("A path starting with /market/") },
    },
    async ({ path }) => report(await api<Run>("POST", "/fetch", { path })),
  );

  return server;
}
