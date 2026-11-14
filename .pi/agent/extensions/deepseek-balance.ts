/**
 * DeepSeek Balance extension
 *
 * When the currently selected model is a DeepSeek model (the provider id or
 * model id contains "deepseek"), queries the account balance and shows it in
 * gray in the footer status bar:
 *
 *     Deepseek balance: $18.81 · ¥235.27
 *
 * Two backends are supported:
 *
 * - Native DeepSeek (`api.deepseek.com`): `GET <baseUrl>/user/balance`,
 *   authenticated with the provider API key.
 * - Fairouter (`api.fairouter.com`), used when the DeepSeek provider is
 *   remapped to it via `models.json`: `GET /me/wallet`. Fairouter has no
 *   API-key balance endpoint, so this logs in through `POST /auth/login`
 *   using `FAIROUTER_EMAIL` + (`FAIROUTER_PASS` or `FAIROUTER_PASSWORD`), or
 *   reuses a raw session cookie from `FAIROUTER_SESSION`, and sends it as
 *   `Cookie: session=…`.
 *
 *   The effective base URL is read from the *model* (`model.baseUrl`), because
 *   a `models.json` provider-level `baseUrl` is applied to composed models,
 *   not to `getProviderAuth().auth.baseUrl`. Falling back to the auth result
 *   only helps per-credential endpoints (e.g. OAuth); otherwise the native
 *   DeepSeek default is used.
 *
 * - Checks the model on session start and whenever it changes (/model, Ctrl+P,
 *   session restore).
 * - Clears the status when switching away from DeepSeek models.
 * - Use `/deepseek-balance` to force a manual refresh, and
 *   `/deepseek-balance show` (or `--show`) to render per-day spend.
 * - Results are cached for 5 minutes; concurrent fetches are coalesced.
 *
 * Per-day usage from the API: DeepSeek's public REST API exposes only
 * `GET /user/balance`, a point-in-time snapshot per currency. It documents no
 * per-day usage or consumption-history endpoint, so there is nothing to fetch
 * and no speculative request is made. Per-day spend is therefore derived from
 * locally recorded snapshots:
 *
 *     date,currency,start_balance,last_seen_at
 *
 * One row per (local date, currency), stored at
 * `~/.pi/state/deepseek-balance/usage.csv` (`PI_DEEPSEEK_BALANCE_CSV`
 * overrides the path). The first successful fetch of a local date records
 * `start_balance`; later fetches that day only refresh `last_seen_at`. Fetch
 * failures, a missing key, and an unavailable account write nothing, so an
 * existing CSV is never truncated.
 *
 * Spend for a day is `start_balance(day) - start_balance(next recorded day)`,
 * which attributes a multi-day sampling gap to the earlier recorded day.
 * Calendar days inside the span with no row render as `no sample`, never as
 * `$0.00`; the final recorded day renders as `in progress` until a closing
 * balance exists.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_ID = "deepseek-balance";
const CACHE_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

const USAGE_HEADER = "date,currency,start_balance,last_seen_at";
const DEFAULT_USAGE_CSV = join(homedir(), ".pi", "state", "deepseek-balance", "usage.csv");
/** Currency the spend table prefers; anything else is a fallback. */
const SPEND_CURRENCY = "USD";

interface BalanceInfo {
  currency: string;
  total_balance: string;
  granted_balance: string;
  topped_up_balance: string;
}

interface BalanceResponse {
  is_available: boolean;
  balance_infos?: BalanceInfo[];
}

interface CachedResult {
  at: number;
  text: string;
}

interface FairouterWallet {
  balance?: number | string;
  total_spent?: number | string;
  currency?: string;
}

interface FairouterSession {
  cookie: string;
  /** Epoch ms after which the cookie should be discarded. */
  expiresAt: number;
}

/** Minimal model shape the extension needs (subset of pi's `Model`). */
interface ModelLike {
  provider?: string;
  id?: string;
  name?: string;
  baseUrl?: string;
}

let cache: CachedResult | undefined;
let inFlight: Promise<void> | undefined;
let fairouterSession: FairouterSession | undefined;
/** Latest fetched balances, used to close the current day's spend row. */
let lastBalances: Map<string, number> | undefined;

/** One stored sample: the first balance seen for a local date + currency. */
interface UsageRow {
  /** Local calendar date, `YYYY-MM-DD`. */
  date: string;
  /** Upper-case currency code, e.g. `USD`. */
  currency: string;
  /** Balance observed first on that date. */
  startBalance: number;
  /** ISO timestamp of the most recent observation. */
  lastSeenAt: string;
}

/** One rendered table row. */
interface SpendDay {
  date: string;
  /** Omitted for a day with no sample. */
  startBalance?: number;
  /** Omitted when the day has no sample or no closing balance yet. */
  spend?: number;
  /** Shown in the spend column instead of an amount. */
  note?: "no sample" | "in progress";
}

interface SpendTable {
  currency: string;
  days: SpendDay[];
  /** Sum of every known daily spend. */
  total: number;
  /** Number of days whose spend is known. */
  samples: number;
}

/** Result of the Fairouter path: footer text plus the snapshot to persist. */
interface FairouterResult {
  text: string;
  infos: BalanceInfo[];
}

function isFairouter(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.includes("fairouter");
  } catch {
    return false;
  }
}

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

/** Read the `session` value from a `set-cookie` response (Node 20+). */
function extractSessionCookie(res: Response): string | undefined {
  const headers = res.headers as Headers & { getSetCookie?: () => string[] };
  const raw = headers.getSetCookie?.() ?? [];
  const lines = raw.length > 0 ? raw : [res.headers.get("set-cookie") ?? ""];
  for (const line of lines) {
    const match = /(?:^|[,;]\s*)session=([^;,\s]+)/.exec(line);
    if (match) return match[1];
  }
  return undefined;
}

/** Decode a JWT's `exp` (seconds) so we can refresh slightly before it lapses. */
function jwtExpiresAt(cookie: string): number | undefined {
  const payload = cookie.split(".")[1];
  if (!payload) return undefined;
  try {
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: number };
    return typeof json.exp === "number" ? json.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve a fairouter session cookie: an explicitly supplied
 * `FAIROUTER_SESSION`, a still-valid cached login, or a fresh
 * `FAIROUTER_EMAIL` + (`FAIROUTER_PASS` or `FAIROUTER_PASSWORD`) login.
 */
async function getFairouterSession(origin: string, signal: AbortSignal): Promise<string> {
  const explicit = env("FAIROUTER_SESSION");
  if (explicit) return explicit;

  const now = Date.now();
  if (fairouterSession && now < fairouterSession.expiresAt - 60_000) {
    return fairouterSession.cookie;
  }

  const email = env("FAIROUTER_EMAIL");
  const password = env("FAIROUTER_PASS") ?? env("FAIROUTER_PASSWORD");
  if (!email || !password) {
    throw new Error(
      "fairouter needs FAIROUTER_EMAIL + FAIROUTER_PASS (or FAIROUTER_PASSWORD, or FAIROUTER_SESSION)",
    );
  }

  const res = await fetch(`${origin}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
    signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`fairouter login failed: HTTP ${res.status}${body ? `: ${body.slice(0, 160)}` : ""}`);
  }

  const cookie = extractSessionCookie(res);
  if (!cookie) throw new Error("fairouter login returned no session cookie");

  fairouterSession = {
    cookie,
    expiresAt: jwtExpiresAt(cookie) ?? now + 12 * 60 * 60 * 1000,
  };
  return cookie;
}

/** Balance symbol for a currency; falls back to "<CUR> " for anything else. */
function currencySymbol(currency: string): string {
  if (currency === "USD") return "$";
  if (currency === "CNY") return "¥";
  return `${currency} `;
}

async function fetchFairouterBalance(baseUrl: string, signal: AbortSignal): Promise<FairouterResult> {
  const origin = new URL(baseUrl).origin;

  const attempt = async (): Promise<Response> => {
    const cookie = await getFairouterSession(origin, signal);
    return fetch(`${origin}/me/wallet`, {
      headers: { Cookie: `session=${cookie}` },
      signal,
    });
  };

  let res = await attempt();
  if (res.status === 401) {
    // Session lapsed despite our TTL: drop it and log in once more.
    fairouterSession = undefined;
    if (!env("FAIROUTER_SESSION")) res = await attempt();
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}${body ? `: ${body.slice(0, 160)}` : ""}`);
  }

  const wallet = (await res.json()) as FairouterWallet;
  const balance = Number.parseFloat(String(wallet.balance));
  if (!Number.isFinite(balance) || balance <= 0) {
    return { text: "Deepseek balance: n/a", infos: [] };
  }
  const currency = (wallet.currency ?? "USD").trim().toUpperCase() || "USD";
  const symbol = currencySymbol(currency);
  const spent = Number.parseFloat(String(wallet.total_spent));
  const text =
    Number.isFinite(spent) && spent > 0
      ? `Deepseek balance: ${symbol}${balance.toFixed(2)} · spent ${symbol}${spent.toFixed(2)}`
      : `Deepseek balance: ${symbol}${balance.toFixed(2)}`;
  return { text, infos: [balanceInfo(currency, balance)] };
}

/** CSV path, overridable for tests and alternate profiles. */
function usageCsvPath(): string {
  return env("PI_DEEPSEEK_BALANCE_CSV") ?? DEFAULT_USAGE_CSV;
}

/** Local calendar date of `at` as `YYYY-MM-DD` (never UTC-shifted). */
function localDateKey(at: Date = new Date()): string {
  const month = `${at.getMonth() + 1}`.padStart(2, "0");
  const day = `${at.getDate()}`.padStart(2, "0");
  return `${at.getFullYear()}-${month}-${day}`;
}

/** Parse `YYYY-MM-DD` as a local date (avoids `new Date(str)`'s UTC parsing). */
function parseLocalDate(date: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return undefined;
  const parsed = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date.getTime());
  next.setDate(next.getDate() + days);
  return next;
}

/** Every local calendar date from `from` to `to`, inclusive. */
function dayKeysBetween(from: string, to: string): string[] {
  const start = parseLocalDate(from);
  const end = parseLocalDate(to);
  if (!start || !end) return [];
  const keys: string[] = [];
  for (let cursor = start; cursor.getTime() <= end.getTime(); cursor = addDays(cursor, 1)) {
    keys.push(localDateKey(cursor));
  }
  return keys;
}

/**
 * Parse the usage CSV. Blank lines, `#` comments, the header, and malformed
 * rows are skipped, so one damaged line cannot hide the rest of the history.
 */
function parseUsageCsv(text: string): UsageRow[] {
  const rows: UsageRow[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const cells = line.split(",").map((cell) => cell.trim());
    if (cells.length < 3) continue;
    const [date, currency, balance, seenAt] = cells;
    if (!parseLocalDate(date) || !currency) continue;
    const startBalance = Number.parseFloat(balance);
    if (!Number.isFinite(startBalance)) continue;
    rows.push({ date, currency: currency.toUpperCase(), startBalance, lastSeenAt: seenAt ?? "" });
  }
  return rows;
}

function serializeUsageCsv(rows: UsageRow[]): string {
  const sorted = [...rows].sort((a, b) =>
    a.date === b.date ? a.currency.localeCompare(b.currency) : a.date.localeCompare(b.date),
  );
  const lines = sorted.map((row) =>
    [row.date, row.currency, row.startBalance.toFixed(4), row.lastSeenAt].join(","),
  );
  return `${[USAGE_HEADER, ...lines].join("\n")}\n`;
}

/** Read stored samples; a missing or unreadable CSV is simply empty history. */
function readUsage(): UsageRow[] {
  try {
    return parseUsageCsv(readFileSync(usageCsvPath(), "utf8"));
  } catch {
    return [];
  }
}

/** Write all rows via a temp file + rename, so a crash can never truncate history. */
function writeUsage(rows: UsageRow[]): void {
  const path = usageCsvPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, serializeUsageCsv(rows), { mode: 0o600 });
  renameSync(tmp, path);
}

/** Build a `BalanceInfo` from a numeric balance (Fairouter has no raw JSON shape). */
function balanceInfo(currency: string, amount: number): BalanceInfo {
  return {
    currency,
    total_balance: String(amount),
    granted_balance: "0",
    topped_up_balance: "0",
  };
}

/**
 * Persist a successful snapshot: the first balance of a local date becomes
 * `start_balance`, later fetches that day only refresh `last_seen_at`.
 */
function recordUsage(infos: BalanceInfo[], at: Date = new Date()): void {
  const date = localDateKey(at);
  const seenAt = at.toISOString();
  const rows = readUsage();
  let changed = false;

  for (const info of infos) {
    const amount = Number.parseFloat(info.total_balance);
    const currency = (info.currency ?? "").trim().toUpperCase();
    if (!currency || !Number.isFinite(amount)) continue;
    const existing = rows.find((row) => row.date === date && row.currency === currency);
    if (existing) {
      existing.lastSeenAt = seenAt; // start_balance stays: it is the day's opening value
    } else {
      rows.push({ date, currency, startBalance: amount, lastSeenAt: seenAt });
    }
    changed = true;
  }

  if (changed) writeUsage(rows);
}

/** Best-effort persistence: CSV or IO trouble must never break the status line. */
function persistSnapshot(infos: BalanceInfo[]): void {
  try {
    recordUsage(infos);
  } catch {
    // ignored by design: recorded history is auxiliary to the footer status
  }
}

/** Remember the snapshot that closes the current day's spend row. */
function rememberBalances(infos: BalanceInfo[]): void {
  const balances = new Map<string, number>();
  for (const info of infos) {
    const amount = Number.parseFloat(info.total_balance);
    const currency = (info.currency ?? "").trim().toUpperCase();
    if (currency && Number.isFinite(amount)) balances.set(currency, amount);
  }
  lastBalances = balances;
}

function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Per-day spend for one currency.
 *
 * `spend(day) = start_balance(day) - start_balance(next recorded day)`, so a
 * gap in sampling is attributed to the earlier recorded day instead of being
 * lost. The final recorded day closes against `closingBalance` when the caller
 * has a live value, and is `in progress` otherwise. Calendar days inside the
 * span with no row are `no sample`.
 */
function computeSpend(
  rows: UsageRow[],
  currency: string,
  closingBalance?: number,
  today: string = localDateKey(),
): SpendTable {
  const samples = rows
    .filter((row) => row.currency === currency)
    .sort((a, b) => a.date.localeCompare(b.date));
  if (samples.length === 0) return { currency, days: [], total: 0, samples: 0 };

  const indexByDate = new Map(samples.map((row, index) => [row.date, index]));
  const lastSample = samples[samples.length - 1].date;
  const lastDate = today > lastSample ? today : lastSample;

  const days: SpendDay[] = [];
  let total = 0;
  let known = 0;

  for (const date of dayKeysBetween(samples[0].date, lastDate)) {
    const index = indexByDate.get(date);
    if (index === undefined) {
      days.push({ date, note: "no sample" });
      continue;
    }
    const sample = samples[index];
    const next = samples[index + 1];
    const closing = next ? next.startBalance : closingBalance;
    if (closing === undefined || !Number.isFinite(closing)) {
      days.push({ date, startBalance: sample.startBalance, note: "in progress" });
      continue;
    }
    const spend = roundCents(sample.startBalance - closing);
    total += spend;
    known += 1;
    days.push({ date, startBalance: sample.startBalance, spend });
  }

  return { currency, days, total: roundCents(total), samples: known };
}

/** USD is the table currency; anything else is a documented fallback. */
function pickSpendCurrency(rows: UsageRow[]): string | undefined {
  const currencies = new Set(rows.map((row) => row.currency));
  if (currencies.has(SPEND_CURRENCY)) return SPEND_CURRENCY;
  return [...currencies].sort()[0];
}

function formatMoney(value: number): string {
  return `${value < 0 ? "-" : ""}$${Math.abs(value).toFixed(2)}`;
}

/** Render the per-day spend table shown by `/deepseek-balance show`. */
function renderSpendTable(table: SpendTable, path: string = usageCsvPath()): string {
  const title = `DeepSeek daily spend (${table.currency})`;
  if (table.days.length === 0) {
    return [
      title,
      "No samples yet: a row is written on the first successful balance check.",
      `csv: ${path}`,
    ].join("\n");
  }

  // The opening balance is kept in the model (it is what spend is derived
  // from) but is deliberately not rendered as a column.
  const spendCells = table.days.map((day) =>
    day.spend === undefined ? (day.note ?? "-") : formatMoney(day.spend),
  );
  const columnWidth = (cells: string[], header: string): number =>
    Math.max(header.length, ...cells.map((cell) => cell.length));
  const spendWidth = columnWidth(spendCells, "Spend");

  const lines = [
    title,
    `${"Date".padEnd(10)}  ${"Spend".padStart(spendWidth)}`,
    ...table.days.map(
      (day, index) => `${day.date.padEnd(10)}  ${spendCells[index].padStart(spendWidth)}`,
    ),
  ];
  if (table.samples > 0) {
    lines.push(`${"Total".padEnd(10)}  ${formatMoney(table.total).padStart(spendWidth)}`);
  }
  lines.push(
    "",
    "spend = start of day - start of next recorded day; no sample = no balance recorded",
    `csv: ${path}`,
  );
  return lines.join("\n");
}

export default function (pi: ExtensionAPI) {
  function isDeepSeekModel(model?: ModelLike): boolean {
    if (!model) return false;
    const id = model.id?.toLowerCase() ?? "";
    const provider = model.provider?.toLowerCase() ?? "";
    const name = model.name?.toLowerCase() ?? "";
    return id.includes("deepseek") || provider.includes("deepseek") || name.includes("deepseek");
  }

  /**
   * "Deepseek balance: $18.81 · ¥235.27"
   *
   * /user/balance returns one entry per currency and exposes no flag for which
   * currency DeepSeek is currently billing, so every positive balance is shown;
   * zero and negative entries are hidden. Symbol per currency: "$" (USD),
   * "¥" (CNY), else "<CUR> 12.34".
   */
  function formatBalance(data: BalanceResponse): string {
    const parts: string[] = [];
    for (const info of data.balance_infos ?? []) {
      const amount = Number.parseFloat(info.total_balance);
      if (!Number.isFinite(amount) || amount <= 0) continue;
      parts.push(`${currencySymbol(info.currency)}${amount.toFixed(2)}`);
    }
    if (parts.length === 0) return "Deepseek balance: n/a";
    return `Deepseek balance: ${parts.join(" · ")}`;
  }

  function setBalanceStatus(ctx: ExtensionContext, text: string): void {
    ctx.ui.setStatus(STATUS_ID, ctx.ui.theme.fg("dim", text));
  }

  async function refreshBalance(ctx: ExtensionContext, model: ModelLike): Promise<void> {
    // Fresh cache: just replay the status (no API hit).
    if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
      setBalanceStatus(ctx, cache.text);
      return;
    }

    // Coalesce concurrent requests (e.g. session_start + model_select restore).
    if (inFlight) {
      await inFlight;
      if (cache) setBalanceStatus(ctx, cache.text);
      return;
    }

    inFlight = (async () => {
      try {
        // Resolve the provider's API key from the model registry.
        let apiKey: string | undefined;
        let authBaseUrl: string | undefined;
        try {
          const auth = await ctx.modelRegistry.getProviderAuth(model.provider ?? "");
          apiKey = auth?.auth?.apiKey;
          authBaseUrl = auth?.auth?.baseUrl;
        } catch {
          apiKey = undefined;
        }

        // Prefer the composed model's baseUrl (reflects a models.json
        // provider-level override); getProviderAuth().auth.baseUrl is usually
        // only set for per-credential endpoints, so it is only a fallback.
        const origin = (model.baseUrl ?? authBaseUrl ?? "https://api.deepseek.com").trim();
        if (isFairouter(origin)) {
          // Fairouter exposes balance only behind a web session, not the API key.
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
          let result: FairouterResult;
          try {
            result = await fetchFairouterBalance(origin, controller.signal);
          } finally {
            clearTimeout(timer);
          }
          cache = { at: Date.now(), text: result.text };
          rememberBalances(result.infos);
          persistSnapshot(result.infos);
          setBalanceStatus(ctx, result.text);
          return;
        }

        if (!apiKey) {
          setBalanceStatus(ctx, "Deepseek balance: no API key (run /login)");
          return;
        }

        const nativeBaseUrl = origin.replace(/\/+$/, "").replace(/\/v1$/, "");

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        let res: Response;
        try {
          res = await fetch(`${nativeBaseUrl}/user/balance`, {
            headers: { Authorization: `Bearer ${apiKey}` },
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }

        if (!res.ok) {
          const body = await res.text().catch(() => "");
          throw new Error(`HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
        }

        const data = (await res.json()) as BalanceResponse;
        const text = data.is_available
          ? formatBalance(data)
          : "Deepseek balance: account unavailable";

        // Record only a successful, available snapshot: failures write nothing.
        if (data.is_available) {
          const infos = data.balance_infos ?? [];
          rememberBalances(infos);
          persistSnapshot(infos);
        }

        cache = { at: Date.now(), text };
        setBalanceStatus(ctx, text);
      } catch (err) {
        const detail =
          err instanceof Error
            ? err.name === "AbortError"
              ? "request timed out"
              : err.message
            : String(err);
        setBalanceStatus(ctx, `Deepseek balance: error (${detail})`);
      } finally {
        inFlight = undefined;
      }
    })();

    await inFlight;
  }

  async function handleModel(ctx: ExtensionContext, model?: ModelLike): Promise<void> {
    if (!model || !isDeepSeekModel(model)) return;
    await refreshBalance(ctx, model);
  }

  // Initial model (session start / resume / fork / reload).
  pi.on("session_start", async (_event, ctx) => {
    await handleModel(ctx, ctx.model);
  });

  // Model switched via /model, Ctrl+P, or session restore.
  pi.on("model_select", async (event, ctx) => {
    if (isDeepSeekModel(event.model)) {
      await handleModel(ctx, event.model);
    } else {
      // Switched away from DeepSeek: clear the stale balance status.
      cache = undefined;
      lastBalances = undefined;
      ctx.ui.setStatus(STATUS_ID, undefined);
    }
  });

  // Manual refresh: `/deepseek-balance`; per-day table: `/deepseek-balance show`.
  pi.registerCommand("deepseek-balance", {
    description: "Refresh the DeepSeek balance status; `show` renders per-day USD spend",
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim().toLowerCase();

      if (arg === "help" || arg === "-h" || arg === "--help") {
        ctx.ui.notify(
          [
            "Usage: /deepseek-balance [show|--show]",
            "  (no argument)  force a balance refresh now",
            "  show           refresh, then render per-day USD spend from the local CSV",
            `csv: ${usageCsvPath()}`,
          ].join("\n"),
          "info",
        );
        return;
      }

      if (arg && arg !== "show" && arg !== "--show") {
        ctx.ui.notify(`Unknown argument "${arg}". Try /deepseek-balance help.`, "warning");
        return;
      }

      const onDeepSeek = isDeepSeekModel(ctx.model);

      // Bare command keeps its original behaviour: force a refresh, no output.
      if (!arg) {
        cache = undefined;
        await handleModel(ctx, ctx.model);
        return;
      }

      // `show` refreshes first on a DeepSeek model, so today's row exists and
      // its closing balance is available for the table.
      if (onDeepSeek) {
        cache = undefined;
        await handleModel(ctx, ctx.model);
      }

      const rows = readUsage();
      const currency = pickSpendCurrency(rows);
      if (!currency) {
        ctx.ui.notify(
          [
            "DeepSeek daily spend: no samples yet.",
            "A row is recorded on the first successful balance check; run /deepseek-balance on a DeepSeek model first.",
            `csv: ${usageCsvPath()}`,
          ].join("\n"),
          "info",
        );
        return;
      }

      const table = computeSpend(rows, currency, lastBalances?.get(currency));
      const suffix = onDeepSeek
        ? ""
        : "\n(not on a DeepSeek model: recorded history only)";
      ctx.ui.notify(`${renderSpendTable(table)}${suffix}`, "info");
    },
  });
}

// Exported for fixture-driven tests; the extension entry point is the default export.
export {
  computeSpend,
  dayKeysBetween,
  localDateKey,
  parseUsageCsv,
  pickSpendCurrency,
  readUsage,
  recordUsage,
  renderSpendTable,
  serializeUsageCsv,
  usageCsvPath,
};
export type { SpendDay, SpendTable, UsageRow };
