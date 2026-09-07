/**
 * DeepSeek Balance extension
 *
 * When the currently selected model is a DeepSeek model (the provider id or
 * model id contains "deepseek"), queries the DeepSeek account balance from
 * `GET <baseUrl>/user/balance` and shows it in gray in the footer status bar:
 *
 *     Deepseek balance: $18.81 · ¥235.27
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

let cache: CachedResult | undefined;
let inFlight: Promise<void> | undefined;

export default function (pi: ExtensionAPI) {
  function isDeepSeekModel(model?: { provider?: string; id?: string; name?: string }): boolean {
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
   * currency DeepSeek is currently billing, so every balance is shown. Symbol
   * per currency: "$" (USD), "¥" (CNY), else "<CUR> 12.34".
   */
  function formatBalance(data: BalanceResponse): string {
    const parts: string[] = [];
    for (const info of data.balance_infos ?? []) {
      const amount = Number.parseFloat(info.total_balance);
      if (!Number.isFinite(amount)) continue;
      const symbol = info.currency === "USD" ? "$" : info.currency === "CNY" ? "¥" : `${info.currency} `;
      parts.push(`${symbol}${amount.toFixed(2)}`);
    }
    if (parts.length === 0) return "Deepseek balance: n/a";
    return `Deepseek balance: ${parts.join(" · ")}`;
  }

  function setBalanceStatus(ctx: ExtensionContext, text: string): void {
    ctx.ui.setStatus(STATUS_ID, ctx.ui.theme.fg("dim", text));
  }

  async function refreshBalance(ctx: ExtensionContext, model: { provider?: string; id?: string }): Promise<void> {
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
        // Resolve the provider's API key/base URL from the model registry.
        let apiKey: string | undefined;
        let baseUrl: string | undefined;
        try {
          const auth = await ctx.modelRegistry.getProviderAuth(model.provider ?? "");
          apiKey = auth?.auth?.apiKey;
          baseUrl = auth?.auth?.baseUrl;
        } catch {
          apiKey = undefined;
        }

        if (!apiKey) {
          setBalanceStatus(ctx, "Deepseek balance: no API key (run /login)");
          return;
        }

        baseUrl = (baseUrl ?? "https://api.deepseek.com").trim();
        baseUrl = baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        let res: Response;
        try {
          res = await fetch(`${baseUrl}/user/balance`, {
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

  async function handleModel(ctx: ExtensionContext, model?: { provider?: string; id?: string }): Promise<void> {
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
