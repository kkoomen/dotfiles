/**
 * Focus mode — `/focus` toggles a narrow, boxed input.
 *
 * While enabled:
 * - The whole session is limited to 120 columns, or `terminal width - 4`
 *   (two columns of padding left and right) on a narrower screen.
 * - The input gets a full rectangle border with one column of padding inside.
 *   The top border shows the current working directory (`~` for home).
 * - The footer shows only two things, below the input: context on the left
 *   (`6.7%/1.0M (auto)`), the DeepSeek balance value on the right.
 * - `/focus` again restores the default editor, footer, and width.
 */

import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Component, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const MAX_WIDTH = 120;
const SIDE_PADDING = 2;
const BALANCE_STATUS_ID = "deepseek-balance";

/**
 * Session width in focus mode: 120 columns whenever the terminal fits them, and
 * the terminal minus two columns per side only on a terminal narrower than 120.
 */
function sessionWidth(width: number): number {
  if (width >= MAX_WIDTH) return MAX_WIDTH;
  return Math.max(1, width - SIDE_PADDING * 2);
}

function indentFor(width: number): number {
  return Math.max(0, Math.floor((width - sessionWidth(width)) / 2));
}

/** Inline images are positioned by escape sequence, so they are left unindented. */
function isImageLine(line: string): boolean {
  return line.includes("\u001b_G") || line.includes("\u001b]1337;File=");
}

/** `~` instead of the home directory prefix. */
function formatCwd(cwd: string): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return cwd;
  const resolvedCwd = resolve(cwd);
  const resolvedHome = resolve(home);
  const rel = relative(resolvedHome, resolvedCwd);
  const inside =
    rel === "" ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  if (!inside) return cwd;
  return rel === "" ? "~" : `~${sep}${rel}`;
}

function formatTokens(count: number): string {
  if (count < 1000) return `${count}`;
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

/** `6.7%/1.0M (auto)`, matching the built-in footer's context field. */
function formatContext(ctx: ExtensionContext): string {
  const usage = ctx.getContextUsage();
  const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
  const percent = usage?.percent !== null && usage?.percent !== undefined ? usage.percent.toFixed(1) : "?";
  return `${percent}%/${formatTokens(contextWindow)} (auto)`;
}

function balanceValue(statuses: ReadonlyMap<string, string>): string {
  const status = statuses.get(BALANCE_STATUS_ID);
  if (!status) return "";
  return status.replace("Deepseek balance: ", "").trim();
}

/**
 * A component whose `render` is wrapped to enforce the focus width.
 *
 * The renderer handle extensions receive (Pi's `createInteractiveTuiReference`
 * proxy) accepts assignment but does not keep it, so the root `render` cannot be
 * patched. The renderer's children are the real container objects that the app
 * mounts (document, editor, footer, widgets) — and they are the same objects a
 * fullscreen layout root references — so wrapping them limits every cell in both
 * regular and fullscreen mode, and survives a renderer swap.
 */
interface WrappedComponent {
  component: Component;
  original: (width: number) => readonly string[];
}

export default function (pi: ExtensionAPI) {
  let enabled = false;
  let wrapped: WrappedComponent[] = [];
  /** Columns the width wrapper adds on the left; 0 when no width limit is active. */
  let rootIndent = 0;

  /**
   * Limit the width of every rendered cell (transcript, header, widgets, input,
   * footer) by wrapping each mounted component's render.
   */
  const limitSessionWidth = (tui: TUI) => {
    if (wrapped.length > 0) return;
    const children = (tui as unknown as { children?: Component[] }).children;
    if (!Array.isArray(children)) return;

    for (const child of children) {
      if (!child || typeof child.render !== "function") continue;
      const original = child.render.bind(child);
      const installed = (width: number): readonly string[] => {
        const inner = sessionWidth(width);
        const indent = indentFor(width);
        rootIndent = indent;
        const source = original(inner) ?? [];
        if (cache && cache.source === source && cache.width === width) return cache.out;
        const pad = " ".repeat(indent);
        const out = indent
          ? source.map((line) => (isImageLine(line) ? line : pad + line))
          : [...source];
        cache = { source, width, out };
        return out;
      };
      let cache: { source: readonly string[]; width: number; out: string[] } | undefined;
      child.render = installed;
      wrapped.push({ component: child, original });
    }
  };

  /** Are the mounted components rendering at the limited width? */
  const widthLimited = () => wrapped.length > 0;

  const restoreWidth = () => {
    for (const entry of wrapped) entry.component.render = entry.original;
    wrapped = [];
    rootIndent = 0;
  };

  pi.registerCommand("focus", {
    description: "Toggle focus mode: 120-column boxed input, minimal footer",
    handler: async (_args, ctx) => {
      enabled = !enabled;

      if (!enabled) {
        ctx.ui.setEditorComponent(undefined);
        ctx.ui.setFooter(undefined);
        restoreWidth();
        ctx.ui.notify("Focus mode off", "info");
        return;
      }

      class FocusEditor extends CustomEditor {
        private lastIndent = 0;

        constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
          super(tui, theme, keybindings, { paddingX: 0 });
        }

        handleMouse(event: Parameters<CustomEditor["handleMouse"]>[0]) {
          const shift = this.lastIndent || rootIndent;
          if (!event || shift === 0) return super.handleMouse(event);
          return super.handleMouse({ ...event, x: event.x - shift });
        }

        render(width: number): string[] {
          // When the mounted components are wrapped, `width` is already the limited
          // width and the wrapper applies the side padding.
          const limited = widthLimited();
          const outerWidth = limited ? Math.max(1, width) : sessionWidth(width);
          const indent = limited ? 0 : indentFor(width);
          this.lastIndent = indent;
          // Two columns are the left and right border, two more the inside padding.
          const innerWidth = Math.max(5, outerWidth - 2);
          const textWidth = Math.max(1, innerWidth - 2);
          const rendered = super.render(textWidth);
          const contentLines =
            (this as unknown as { renderedVisibleLineCount?: number }).renderedVisibleLineCount ??
            Math.max(0, rendered.length - 2);

          const border = (text: string) => this.borderColor(text);
          const pad = " ".repeat(indent);

          // Top border: ┌─ <cwd> ────┐
          const cwdText = truncateToWidth(` ${formatCwd(ctx.cwd)} `, Math.max(0, outerWidth - 4), "…");
          const fillWidth = Math.max(0, outerWidth - 3 - visibleWidth(cwdText));
          const top = `${border("┌─")}${cwdText}${border("─".repeat(fillWidth))}${border("┐")}`;

          const lines: string[] = [pad + top];
          for (let i = 1; i <= contentLines && i < rendered.length - 1; i++) {
            const text = truncateToWidth(rendered[i] ?? "", textWidth, "");
            const gap = " ".repeat(Math.max(0, textWidth - visibleWidth(text)));
            lines.push(pad + border("│") + " " + text + gap + " " + border("│"));
          }
          lines.push(pad + border("└") + border("─".repeat(Math.max(0, outerWidth - 2))) + border("┘"));

          // Anything the editor renders after its bottom border (autocomplete list).
          for (const line of rendered.slice(contentLines + 2)) {
            lines.push(pad + " " + truncateToWidth(line, textWidth, "") + " ");
          }
          return lines;
        }
      }

      ctx.ui.setEditorComponent((tui, theme, keybindings) => {
        limitSessionWidth(tui);
        return new FocusEditor(tui, theme, keybindings);
      });

      ctx.ui.setFooter((tui, theme, footerData) => {
        limitSessionWidth(tui);
        const footer: Component = {
          render(width: number): string[] {
            limitSessionWidth(tui);
            const limited = widthLimited();
            const outerWidth = limited ? Math.max(1, width) : sessionWidth(width);
            const indent = " ".repeat(limited ? 0 : indentFor(width));
            const left = theme.fg("dim", formatContext(ctx));
            const right = balanceValue(footerData.getExtensionStatuses());
            const gap = " ".repeat(Math.max(1, outerWidth - visibleWidth(left) - visibleWidth(right)));
            return [indent + truncateToWidth(left + gap + right, outerWidth, "")];
          },
          invalidate(): void {},
        };
        return footer;
      });

      ctx.ui.notify("Focus mode on", "info");
    },
  });
}
