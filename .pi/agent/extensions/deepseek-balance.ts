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
 * - Use `/deepseek-balance` to force a manual refresh.
 * - Results are cached for 5 minutes; concurrent fetches are coalesced.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_ID = "deepseek-balance";
const CACHE_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

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

async function fetchFairouterBalance(baseUrl: string, signal: AbortSignal): Promise<string> {
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
  if (!Number.isFinite(balance) || balance <= 0) return "Deepseek balance: n/a";
  const symbol = currencySymbol(wallet.currency ?? "USD");
  const spent = Number.parseFloat(String(wallet.total_spent));
  return Number.isFinite(spent) && spent > 0
    ? `Deepseek balance: ${symbol}${balance.toFixed(2)} · spent ${symbol}${spent.toFixed(2)}`
    : `Deepseek balance: ${symbol}${balance.toFixed(2)}`;
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
          let text: string;
          try {
            text = await fetchFairouterBalance(origin, controller.signal);
          } finally {
            clearTimeout(timer);
          }
          cache = { at: Date.now(), text };
          setBalanceStatus(ctx, text);
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
      ctx.ui.setStatus(STATUS_ID, undefined);
    }
  });

  // Manual refresh: /deepseek-balance
  pi.registerCommand("deepseek-balance", {
    description: "Refresh the DeepSeek balance status",
    handler: async (_args, ctx) => {
      cache = undefined; // force a fresh API call
      await handleModel(ctx, ctx.model);
    },
  });
}
