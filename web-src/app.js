// The Ali app (bundled to web/app.js by `npm run build:web`).
//
// Practice: a shared in-memory wallet on the server.
// My NEAR wallet: the visitor's own budget on the Firewall Hub. The visitor signs
// every owner action in their wallet; the server's agent pays with a key the
// visitor added, which can call `pay` on the hub and nothing else.
import "./shims.js";
import { internalActionToNaj, setupWalletSelector } from "@near-wallet-selector/core";
import { setupMeteorWallet } from "@near-wallet-selector/meteor-wallet";
import { setupModal } from "@near-wallet-selector/modal-ui";
import "@near-wallet-selector/modal-ui/styles.css";
import { setupMyNearWallet } from "@near-wallet-selector/my-near-wallet";

const $ = (id) => document.getElementById(id);
const U = 10_000; // 0.01 USDC in micro-USDC
const fmt = (m) => (m / 1_000_000).toFixed(2);
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const GAS = "30000000000000";
const AGENT_ALLOWANCE = "250000000000000000000000"; // 0.25 NEAR of gas for the agent's key

// [id, name, price in cents, allowed in a new budget]
const APIS = [
  ["weather", "Weather", 1, true],
  ["news", "News", 5, true],
  ["maps", "Maps", 2, true],
  ["translate", "Translate", 3, true],
  ["search", "Web search", 4, false],
  ["stocks", "Stock quotes", 2, false],
  ["flights", "Flight prices", 6, false],
  ["images", "Image maker", 8, false],
];
const STEP_TITLES = {
  request: "Agent asks the API",
  quote: "402 Payment Required",
  checks: "Firewall checks the rules",
  pay: "Wallet pays",
  verify: "API checks the payment",
  answer: "Agent gets the answer",
};

let mode = safeGet("ali-mode") === "testnet" ? "testnet" : "practice";
let config = null; // testnet.json from the server, or null
let selector = null;
let modal = null;
let accountId = null;
let state = null;
let busy = false;

// ---------- helpers ----------

function safeGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeSet(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}
const space = () => (mode === "practice" ? "practice" : accountId || "none");
function progress() {
  try { return JSON.parse(safeGet(`ali-progress:${space()}`) || "{}"); } catch { return {}; }
}
function mark(step) {
  safeSet(`ali-progress:${space()}`, JSON.stringify({ ...progress(), [step]: true }));
}

async function server(method, path, body) {
  const res = await fetch(path, { method, headers: { "Content-Type": "application/json" }, body: body && JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

let toastTimer;
function toast(text, bad = false) {
  const el = $("toast");
  el.textContent = text;
  el.className = `toast${bad ? " no" : ""}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4000);
}

const base = () => (mode === "practice" ? "/api/practice" : `/api/testnet/${accountId}`);
const marketRoot = () => (mode === "practice" ? "near" : config.marketRoot);
const accountOf = (id) => `${id}-api.${marketRoot()}`;
const txLink = (tx) =>
  state?.explorer ? `<a href="${esc(state.explorer + tx)}" target="_blank" rel="noopener">tx ${esc(tx.slice(0, 8))}…</a>` : `tx ${esc(tx.slice(0, 8))}…`;

// ---------- wallet ----------

async function setupWallet() {
  selector = await setupWalletSelector({
    network: {
      networkId: config.network,
      nodeUrl: config.rpcUrl,
      helperUrl: "",
      explorerUrl: config.explorer,
      indexerUrl: "",
    },
    modules: [setupMyNearWallet(), setupMeteorWallet()],
    // Lets the wallet sign the owner's no-deposit calls to the hub without a popup each time.
    createAccessKeyFor: config.hub,
  });
  modal = setupModal(selector, { contractId: config.hub });
  const pick = (s) => s.accounts.find((a) => a.active)?.accountId ?? null;
  accountId = pick(selector.store.getState());
  selector.store.observable.subscribe((s) => {
    const next = pick(s);
    if (next !== accountId) {
      accountId = next;
      if (mode === "testnet") refresh();
    }
  });
}

/** Signs one transaction in the visitor's wallet. Browser wallets may leave the page and come back. */
async function sign(receiverId, action, label) {
  sessionStorage.setItem("ali-pending", label);
  const wallet = await selector.wallet();
  const outcome = await wallet.signAndSendTransaction({ receiverId, actions: [internalActionToNaj(action)] });
  sessionStorage.removeItem("ali-pending");
  if (outcome?.status && typeof outcome.status === "object" && "Failure" in outcome.status) {
    const reason = JSON.stringify(outcome.status.Failure).match(/ERR_[A-Z_]+/)?.[0] ?? "transaction failed";
    throw new Error(reason);
  }
  const tx = outcome?.transaction?.hash;
  const res = await server("POST", `${base()}/note`, { text: label, tx });
  state = res.state;
  return tx;
}

const callHub = (methodName, args, label) =>
  sign(config.hub, { type: "FunctionCall", params: { methodName, args, gas: GAS, deposit: "0" } }, label);

/** After a redirect wallet (MyNearWallet) sends the visitor back. */
async function handleReturn() {
  const url = new URL(location.href);
  const hashes = url.searchParams.get("transactionHashes");
  const error = url.searchParams.get("errorCode");
  if (!hashes && !error) return;
  const label = sessionStorage.getItem("ali-pending") || "Transaction";
  sessionStorage.removeItem("ali-pending");
  for (const p of ["transactionHashes", "errorCode", "errorMessage", "account_id", "public_key", "all_keys"]) url.searchParams.delete(p);
  history.replaceState(null, "", url.pathname + url.search + url.hash);
  if (error) return toast(`${label}: cancelled in the wallet`, true);
  if (accountId) await server("POST", `/api/testnet/${accountId}/note`, { text: label, tx: hashes.split(",")[0] }).catch(() => {});
  toast(`${label}: signed ✓`);
}

// ---------- data ----------

async function refresh() {
  try {
    if (mode === "practice") state = await server("GET", "/api/practice/state");
    else state = accountId ? await server("GET", `/api/testnet/${accountId}/state`) : null;
  } catch (err) {
    toast(err.message, true);
  }
  render();
}

function setMode(next) {
  mode = next;
  safeSet("ali-mode", mode);
  $("mode-practice").setAttribute("aria-pressed", String(mode === "practice"));
  $("mode-testnet").setAttribute("aria-pressed", String(mode === "testnet"));
  $("banner").hidden = !(mode === "testnet" && !config);
  $("banner").textContent = "Wallet mode isn't set up on this server: testnet.json is missing. Practice mode works as usual.";
  buildMarket();
  clearRun();
  refresh();
}

// ---------- rendering ----------

function budget() {
  return state?.budget ?? null;
}

function guideSteps() {
  const p = progress();
  if (mode === "practice") {
    return [
      { t: "Set the rules", d: "Drag Per call and Per day. Only the owner can change them.", done: p.limits },
      { t: "Choose allowed APIs", d: "Switch an API on or off in the marketplace.", done: p.allow },
      { t: "Let the agent call one", d: "Press Call and watch every step on the right.", done: p.call },
      { t: "Try to break it", d: "Run an attack. The wallet should stop it.", done: p.attack },
    ];
  }
  const connected = Boolean(accountId);
  const hasBudget = Boolean(budget());
  const hasKey = Boolean(state?.agentKey?.added);
  return [
    { t: "Connect your NEAR wallet", d: "Testnet only. No real money.", done: connected, action: connected ? null : ["Connect", connect] },
    { t: "Create your budget", d: "Sign once. You get 5 test USDC to spend.", done: hasBudget, locked: !connected, action: ["Create budget", createBudget] },
    { t: "Give the agent a key", d: "It can only call pay, and only within your rules.", done: hasKey, locked: !hasBudget, action: ["Add key", addAgentKey] },
    { t: "Let the agent call an API", d: "Press Call. It pays on NEAR and shows each step.", done: p.call, locked: !hasKey },
    { t: "Try to break it", d: "Each attack is a real transaction the contract refuses.", done: p.attack, locked: !hasKey },
  ];
}

function renderGuide() {
  const steps = guideSteps();
  const now = steps.findIndex((s) => !s.done && !s.locked);
  const el = $("guide");
  el.style.setProperty("--n", steps.length);
  el.innerHTML = steps
    .map((s, i) => {
      const cls = s.done ? "done" : i === now ? "now" : s.locked ? "locked" : "";
      const btn = s.action && !s.done && !s.locked ? `<button class="btn ${i === now ? "btn-pink" : "btn-line"} act" type="button" data-step="${i}">${esc(s.action[0])}</button>` : "";
      return `<li class="g ${cls}"><span class="n"><span>${i + 1}</span></span><strong>${esc(s.t)}</strong><p>${esc(s.d)}</p>${btn}</li>`;
    })
    .join("");
  el.querySelectorAll("[data-step]").forEach((b) =>
    b.addEventListener("click", () => withBusy(b, steps[+b.dataset.step].action[1])),
  );
}

function renderVault() {
  const b = budget();
  const ready = Boolean(b);
  $("vault-body").hidden = !ready;
  $("vault-empty").hidden = ready;
  $("vault-acct").textContent = mode === "practice" ? state?.vault ?? "" : accountId ?? "not connected";
  if (!ready) {
    $("vault-empty-text").textContent = !accountId
      ? "Connect your NEAR wallet to open your own budget."
      : "You don't have a budget yet. Create it in step 2 above.";
    $("pill").textContent = "Not set up";
    $("pill").classList.add("off");
    return;
  }
  const dragging = document.activeElement?.type === "range";
  if (!dragging) {
    $("per-tx").value = Math.round(b.policy.perTxMax / U);
    $("daily").value = Math.round(b.policy.dailyMax / U);
  }
  syncSliders();
  $("balance").textContent = fmt(b.balance);
  $("pill").textContent = b.policy.paused ? "Paused" : "Active";
  $("pill").classList.toggle("off", b.policy.paused);
  $("kill").textContent = b.policy.paused ? "Resume" : "Pause";
  $("faucet").hidden = !(mode === "testnet" && b.faucetReady);
  $("vault-note").innerHTML =
    mode === "practice"
      ? "Practice wallet on an in-memory ledger, shared by everyone on this server."
      : state.agentKey?.added
        ? `Your budget lives in <span class="mono">${esc(state.hub)}</span>. The agent's key can only call <span class="mono">pay</span>.`
        : "The agent has no key yet, so it can't pay. Do step 3.";
}

function syncSliders() {
  const b = budget();
  if (!b) return;
  const perTx = +$("per-tx").value * U;
  const daily = +$("daily").value * U;
  $("per-tx-out").textContent = fmt(perTx);
  $("spent-out").textContent = `${fmt(b.spentToday)} spent of ${fmt(daily)}`;
  $("spent-out").classList.toggle("full", b.spentToday >= daily);
  const pct = Math.min(100, (b.spentToday / daily) * 100);
  $("meter").firstElementChild.style.width = pct + "%";
  $("meter").classList.toggle("full", pct >= 100);
}

function buildMarket() {
  $("market").innerHTML = APIS.map(
    ([id, name, cents, on]) => `
    <div class="api${on ? "" : " is-off"}" data-api="${id}">
      <img class="api-mark" src="/assets/v4/api-${id}.jpg" alt="" width="44" height="44">
      <div style="min-width:0"><div class="api-name">${name}</div><div class="api-price">${(cents / 100).toFixed(2)} / call</div></div>
      <button class="switch" type="button" role="switch" aria-checked="${on}" aria-label="Allow ${name}" data-api="${id}"></button>
      <button class="call" type="button" data-api="${id}" data-name="${name}">Call</button>
      <div class="api-state" aria-live="polite"></div>
    </div>`,
  ).join("");
}

function renderMarket() {
  const b = budget();
  const canAct = mode === "practice" || (b && state?.agentKey?.added);
  document.querySelectorAll("#market .api").forEach((tile) => {
    const id = tile.dataset.api;
    const on = b ? b.policy.allowlist.includes(accountOf(id)) : APIS.find((a) => a[0] === id)[3];
    tile.querySelector(".switch").setAttribute("aria-checked", String(on));
    tile.classList.toggle("is-off", !on);
    tile.querySelector(".switch").disabled = busy || !b;
    tile.querySelector(".call").disabled = busy || !canAct;
  });
  document.querySelectorAll(".attack").forEach((a) => (a.disabled = busy || !canAct));
  ["kill", "reset", "faucet", "per-tx", "daily"].forEach((id) => ($(id).disabled = busy));
}

function renderLog() {
  const items = state?.activity ?? [];
  $("log").innerHTML = items.length
    ? items
        .map((a) => {
          const tx = a.tx ? ` · ${txLink(a.tx)}` : "";
          return `<li><span class="tag ${a.kind}">${esc(a.tag)}</span><span>${esc(a.text)}<span class="why">${esc(a.why)}${tx}</span></span></li>`;
        })
        .join("")
    : `<li><span class="tag ok">Ready</span><span>Every payment and setting shows up here.</span></li>`;
  $("net").textContent = mode === "practice" ? "in-memory ledger" : state ? `NEAR ${config.network}` : "";
}

function renderHeader() {
  const wallet = mode === "testnet" && config;
  $("connect").hidden = !wallet || Boolean(accountId);
  $("disconnect").hidden = !wallet || !accountId;
  $("who").textContent = wallet && accountId ? accountId : "";
}

function render() {
  renderHeader();
  renderGuide();
  renderVault();
  renderMarket();
  renderLog();
}

// ---------- the run panel ----------

function clearRun() {
  $("run-title").textContent = "Agent run";
  $("run-result").textContent = "Waiting";
  $("run-result").className = "result";
  $("runs").hidden = true;
  $("steps").innerHTML = `<li class="run-empty">Press <b>Call</b> on an API. Every step the agent takes shows up here.</li>`;
}

let pendingTimer;
function showPending(title, keys) {
  // When the run panel sits below the controls (narrow screens), bring it into view.
  if (innerWidth <= 1240) $("run-title").closest(".panel").scrollIntoView({ behavior: "smooth", block: "start" });
  $("run-title").textContent = title;
  $("run-result").textContent = mode === "practice" ? "Running…" : "Running on NEAR…";
  $("run-result").className = "result busy";
  $("runs").hidden = true;
  let live = 0;
  const draw = () => {
    $("steps").innerHTML = keys
      .map((k, i) => `<li class="step ${i === live ? "live" : "wait"}"><span class="dot">${i + 1}</span><div><div class="st"><strong>${STEP_TITLES[k]}</strong></div></div></li>`)
      .join("");
  };
  draw();
  clearInterval(pendingTimer);
  pendingTimer = setInterval(() => {
    if (live < keys.length - 2) {
      live++;
      draw();
    }
  }, mode === "practice" ? 250 : 1200);
}

function renderRun(title, run) {
  clearInterval(pendingTimer);
  $("run-title").textContent = title;
  $("run-result").textContent = run.short;
  $("run-result").className = `result ${run.ok ? "ok" : "no"}`;
  $("runs").hidden = !run.runs?.length;
  if (run.runs?.length) {
    $("runs").innerHTML = run.runs.map((r) => `<span class="${r.ok ? "" : "no"}" title="${esc(r.short)}">${r.n} ${r.ok ? "✓" : "✗"}</span>`).join("");
  }
  if (!run.steps?.length) {
    $("steps").innerHTML = `<li class="run-empty">${esc(run.short)}</li>`;
    return;
  }
  $("steps").innerHTML = run.steps
    .map((s, i) => {
      const mark = s.status === "ok" ? "✓" : "✗";
      const time = s.ms ? `<time>${s.ms < 1000 ? `${s.ms} ms` : `${(s.ms / 1000).toFixed(1)} s`}</time>` : "";
      const tx = s.tx ? ` · ${txLink(s.tx)}` : "";
      const checks = s.checks
        ? `<ul class="checks">${s.checks
            .map((c) => `<li class="${c.ok ? "ok" : "no"}"><b>${c.ok ? "✓" : "✗"}</b><span>${esc(c.label)}</span><em>${esc(c.detail)}</em></li>`)
            .join("")}</ul>`
        : "";
      return `<li class="step ${s.status}"><span class="dot" aria-label="${s.status === "ok" ? "passed" : "failed"}">${mark}</span><div>
        <div class="st"><strong>${i + 1}. ${esc(s.title)}</strong>${time}</div>
        <div class="sd">${esc(s.detail)}${tx}</div>${checks}${data(s)}</div></li>`;
    })
    .join("");
}

function data(step) {
  if (step.data === undefined || step.data === null) return "";
  if (step.key === "answer" && step.data.svg) {
    const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(step.data.svg)}`;
    return `<img src="${src}" alt="Generated image" width="96" height="96" style="margin-top:6px;border-radius:12px">`;
  }
  return `<pre class="json">${esc(JSON.stringify(step.data, null, 2))}</pre>`;
}

function flash(tile, run) {
  const label = tile.querySelector(".api-state");
  label.textContent = run.short;
  label.className = `api-state ${run.ok ? "ok" : "no"}`;
  tile.classList.remove("flash-ok", "flash-no");
  tile.classList.add(run.ok ? "flash-ok" : "flash-no");
  setTimeout(() => {
    tile.classList.remove("flash-ok", "flash-no");
    label.textContent = "";
    label.className = "api-state";
  }, 2600);
}

// ---------- actions ----------

async function withBusy(btn, work) {
  if (busy) return;
  busy = true;
  if (btn) btn.disabled = true;
  renderMarket();
  try {
    await work();
  } catch (err) {
    toast(err.message || String(err), true);
  } finally {
    busy = false;
    if (btn) btn.disabled = false;
    render();
  }
}

function connect() {
  modal.show();
}

async function createBudget() {
  const allowlist = APIS.filter((a) => a[3]).map((a) => accountOf(a[0]));
  await callHub("create_vault", { per_tx_max: String(10 * U), daily_max: String(20 * U), allowlist }, "Created your budget (+5 test USDC)");
  await refresh();
  toast("Budget created. 5 test USDC added.");
}

async function addAgentKey() {
  const { publicKey } = await server("POST", `/api/testnet/${accountId}/agent-key`);
  await sign(
    accountId,
    { type: "AddKey", params: { publicKey, accessKey: { permission: { receiverId: config.hub, allowance: AGENT_ALLOWANCE, methodNames: ["pay"] } } } },
    "Gave the agent a pay-only key",
  );
  // The key needs a moment to show up on every RPC node.
  for (let i = 0; i < 8; i++) {
    await refresh();
    if (state?.agentKey?.added) return toast("The agent has its key. It can only call pay.");
    await new Promise((r) => setTimeout(r, 1500));
  }
}

async function ownerAction(practiceCall, hubCall) {
  if (mode === "practice") {
    const res = await practiceCall();
    state = res.state;
  } else {
    await hubCall();
    await new Promise((r) => setTimeout(r, 800));
    await refresh();
  }
}

async function call(tile) {
  const btn = tile.querySelector(".call");
  const name = btn.dataset.name;
  showPending(`${name} API`, ["request", "quote", "checks", "pay", "verify", "answer"]);
  const run = await server("POST", `${base()}/call`, { api: btn.dataset.api }).catch((err) => ({ ok: false, short: err.message, steps: [] }));
  if (run.state) state = run.state;
  renderRun(`${name} API`, run);
  flash(tile, run);
  if (run.ok) mark("call");
}

async function attack(btn) {
  const kind = btn.dataset.act;
  const title = btn.querySelector("strong").textContent;
  showPending(title, kind === "drain" ? ["request", "checks", "pay"] : ["request", "quote", "checks", "pay", "verify", "answer"]);
  const run = await server("POST", `${base()}/attack`, { kind }).catch((err) => ({ ok: false, short: err.message, steps: [] }));
  if (run.state) state = run.state;
  renderRun(title, run);
  mark("attack");
}

// ---------- wiring ----------

$("mode-practice").addEventListener("click", () => setMode("practice"));
$("mode-testnet").addEventListener("click", () => setMode("testnet"));
$("connect").addEventListener("click", connect);
$("disconnect").addEventListener("click", async () => {
  const wallet = await selector.wallet();
  await wallet.signOut();
});

$("market").addEventListener("click", (e) => {
  const sw = e.target.closest(".switch");
  const callBtn = e.target.closest(".call");
  if (sw) {
    const on = sw.getAttribute("aria-checked") !== "true";
    const account = accountOf(sw.dataset.api);
    withBusy(sw, async () => {
      await ownerAction(
        () => server("PATCH", "/api/practice/policy", { allow: { account, on } }),
        () => callHub(on ? "add_payee" : "remove_payee", { payee: account }, `${on ? "Allowed" : "Removed"} ${account}`),
      );
      mark("allow");
    });
  } else if (callBtn) {
    withBusy(callBtn, () => call(callBtn.closest(".api")));
  }
});

document.querySelectorAll(".attack").forEach((b) => b.addEventListener("click", () => withBusy(b, () => attack(b))));

["per-tx", "daily"].forEach((id) => {
  $(id).addEventListener("input", syncSliders);
  $(id).addEventListener("change", () =>
    withBusy(null, async () => {
      const perTxMax = +$("per-tx").value * U;
      const dailyMax = +$("daily").value * U;
      await ownerAction(
        () => server("PATCH", "/api/practice/policy", { perTxMax, dailyMax }),
        () => callHub("set_limits", { per_tx_max: String(perTxMax), daily_max: String(dailyMax) }, `Limits: ${fmt(perTxMax)} per call, ${fmt(dailyMax)} per day`),
      );
      mark("limits");
    }),
  );
});

$("kill").addEventListener("click", () =>
  withBusy($("kill"), () => {
    const paused = !budget().policy.paused;
    return ownerAction(
      () => server("PATCH", "/api/practice/policy", { paused }),
      () => callHub("set_paused", { paused }, paused ? "Paused the wallet" : "Resumed the wallet"),
    );
  }),
);
$("reset").addEventListener("click", () =>
  withBusy($("reset"), () =>
    ownerAction(
      () => server("POST", "/api/practice/new-day"),
      () => callHub("reset_day", {}, "Started a new day"),
    ),
  ),
);
$("faucet").addEventListener("click", () =>
  withBusy($("faucet"), async () => {
    await callHub("faucet", {}, "Took 5 test USDC from the faucet");
    await refresh();
  }),
);

// ---------- start ----------

(async () => {
  config = (await server("GET", "/api/config").catch(() => ({ testnet: null }))).testnet;
  if (config) {
    try {
      await setupWallet();
      await handleReturn();
    } catch (err) {
      console.error(err);
      toast("Couldn't load the NEAR wallet selector", true);
    }
  }
  setMode(mode);
})();
