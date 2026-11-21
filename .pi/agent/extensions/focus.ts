/**
 * Focus mode — a distraction-free 120-column view.
 *
 * `/focus` toggles it. While it is on the screen shows only:
 *
 *     ┌───────────────────────────────────────────────────────┐
 *     │ the prompt you last sent (two lines at most)          │
 *     └───────────────────────────────────────────────────────┘
 *      ... the last cell, bottom aligned, scrollable ...
 *     ┌── ~/path/to/current/working/directory ────────────────┐
 *     │ here I can type my prompt                             │
 *     └───────────────────────────────────────────────────────┘
 *     1.2% / 1.0M (auto)              ↑ 12             $85.65
 *
 * The cell is the most recent thing displayed, whether it is the current turn
 * still running or the last finished one: thinking, tool calls (bash, read,
 * edit, ...), and reply text. Nothing older is drawn and nothing is faded. It
 * sits at the bottom of the screen and scrolls when taller than the space
 * between the pinned prompt and the input box (PageUp/PageDown, ctrl+home and
 * ctrl+end, mouse wheel); the footer shows how many lines sit above the window.
 * Column width is 120 on a wide terminal, or terminal width minus 2 columns of
 * padding per side when the screen is narrower. Everything is centered
 * horizontally; vertically the box stays at the bottom.
 *
 * Implementation notes:
 * - Pi has no API to filter the chat transcript, so focus mode is a full-height
 *   extension overlay that paints over it. The cell is drawn from pi's own
 *   `UserMessageComponent`, `AssistantMessageComponent`, and
 *   `ToolExecutionComponent`, so markdown, inline-code colors, syntax
 *   highlighting, thinking blocks, tool boxes, and the `outputPad` setting are
 *   identical to the normal transcript. Nothing about message rendering is
 *   reimplemented here.
 * - Only the last cell is built; older entries are never rendered. Scrolling
 *   works on its rendered lines, so it needs no transcript access.
 * - Custom pieces are the input box style, the pinned prompt box, and the
 *   context/scroll/balance line under the box.
 * - That needs fullscreen TUI mode (`tuiMode: "fullscreen"`, the default). In
 *   regular mode the terminal owns scrollback, so `/focus` refuses instead of
 *   half-working. The check reads settings, not the `--tui-mode` flag.
 * - The input is its own `CustomEditor`, so typing, wrapping, history, paste,
 *   submit, and abort all behave like the normal editor. Autocomplete (slash
 *   commands, @files) is not active inside the box. Built-in commands
 *   (`/reload`, `/new`, `/compact`, `/quit`) run directly; other built-ins are
 *   handed back to the normal composer.
 * - Do not call `tui.setFocus()` on the overlay component from the factory:
 *   it hijacks the overlay's saved pre-focus and extension commands stop
 *   dispatching once focus mode is closed.
 *
 * Keys: Enter sends, Escape interrupts a run and otherwise leaves focus mode,
 * Ctrl+D on an empty box leaves focus mode, PageUp/PageDown (and ctrl+home,
 * ctrl+end, wheel) scroll the cell, and `/focus` typed in the box toggles it
 * off. Dialogs pi opens (permission prompts and the like) hide the overlay
 * while they are up.
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  KeybindingsManager,
  ReadonlyFooterDataProvider,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  AssistantMessageComponent,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  CustomEditor,
  getMarkdownTheme,
  getSelectListTheme,
  ToolExecutionComponent,
  UserMessageComponent,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type MarkdownTheme,
  type OverlayHandle,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { homedir } from "node:os";

/** Widest the focus column ever gets. */
const COLUMN_WIDTH = 120;
/** Side padding kept when the terminal is narrower than the focus column. */
const SIDE_PADDING = 2;

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/** Replace the home directory with `~`. */
function shortenPath(path: string): string {
  const home = homedir();
  return path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

/**
 * Focus column width for a terminal: 120 columns, or the terminal width minus
 * the side padding when the screen is narrower than that.
 */
function focusWidth(width: number): number {
  if (width >= COLUMN_WIDTH) return COLUMN_WIDTH;
  return Math.min(width, Math.max(8, width - SIDE_PADDING * 2));
}

/** Pad or truncate a line to exactly `width` visible columns. */
function fit(line: string, width: number): string {
  if (width <= 0) return "";
  const clipped = visibleWidth(line) > width ? truncateToWidth(line, width, "…\u001b[0m") : line;
  const pad = width - visibleWidth(clipped);
  return pad > 0 ? clipped + " ".repeat(pad) : clipped;
}

/** Token counts, formatted like pi's own footer. */
function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

/** Cost in dollars: two decimals, but small totals keep their third digit. */
function formatCost(cost: number): string {
  return cost > 0 && cost < 1 ? `$${cost.toFixed(3)}` : `$${cost.toFixed(2)}`;
}

/** Text content of a message, ignoring thinking and tool blocks. */
function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
      const text = (block as { text?: string }).text;
      if (typeof text === "string") parts.push(text);
    }
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Reading the conversation as cells
// ---------------------------------------------------------------------------

/** A tool call made inside a cell, with its result when it already ran. */
interface CellTool {
  toolCallId: string;
  toolName: string;
  args: unknown;
  result?: { content?: unknown; details?: unknown; isError?: boolean; durationMs?: number };
}

interface CellMessage {
  /** Session entry id, used to cache the rendered component. */
  id: string;
  role: "user" | "assistant";
  message: { role?: string; content?: unknown };
  /** Tool calls this assistant message made, in order. */
  tools: CellTool[];
}

interface Cell {
  messages: CellMessage[];
}

/** Tool call blocks of an assistant message. */
function toolCallsOf(content: unknown): CellTool[] {
  if (!Array.isArray(content)) return [];
  const calls: CellTool[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const call = block as { type?: string; id?: string; name?: string; arguments?: unknown };
    if (call.type !== "toolCall" || typeof call.id !== "string") continue;
    calls.push({ toolCallId: call.id, toolName: call.name ?? "tool", args: call.arguments });
  }
  return calls;
}

/**
 * One cell per user turn: its prompt plus every assistant message that
 * answered it, tool calls attached to the message that made them. Cells keep
 * the raw messages so the screen renders them with pi's own components instead
 * of flattening them to text.
 */
function readCells(ctx: ExtensionContext): Cell[] {
  const cells: Cell[] = [];
  let current: Cell | undefined;

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message") continue;
    const message = entry.message as {
      role?: string;
      content?: unknown;
      toolCallId?: string;
      details?: unknown;
      isError?: boolean;
      durationMs?: number;
    };

    if (message.role === "user") {
      current = { messages: [{ id: entry.id, role: "user", message, tools: [] }] };
      cells.push(current);
      continue;
    }

    if (message.role === "assistant") {
      if (!current) {
        current = { messages: [] };
        cells.push(current);
      }
      current.messages.push({ id: entry.id, role: "assistant", message, tools: toolCallsOf(message.content) });
      continue;
    }

    // A tool result belongs to the call that asked for it, inside this cell.
    if (message.role === "toolResult" && current && message.toolCallId) {
      for (const item of current.messages) {
        const call = item.tools.find((tool) => tool.toolCallId === message.toolCallId);
        if (call) {
          call.result = {
            content: message.content,
            details: message.details,
            isError: message.isError === true,
            durationMs: message.durationMs,
          };
          break;
        }
      }
    }
  }

  return cells;
}

/**
 * The money figure an extension status shows, e.g. `$85.46` out of
 * "Deepseek balance: $85.46". Used for the right side of the focus footer.
 */
function statusAmount(statuses: ReadonlyMap<string, string> | undefined): string | undefined {
  if (!statuses) return undefined;
  for (const [key, value] of statuses) {
    if (!/balance|credit|cost|spend/i.test(key) && !/balance|credit/i.test(value)) continue;
    const amount = value.match(/[$€£¥]\s?[\d,]+(?:\.\d+)?/);
    return (amount ? amount[0] : value).trim();
  }
  return undefined;
}

/** Cumulative cost of the session, in dollars. */
function sessionCost(ctx: ExtensionContext): number {
  let total = 0;
  for (const entry of ctx.sessionManager.getEntries()) {
    const record = entry as { type?: string; usage?: { cost?: { total?: number } } };
    if (
      record.type === "message" ||
      record.type === "usage" ||
      record.type === "compaction" ||
      record.type === "branch_summary"
    ) {
      const cost = record.usage?.cost?.total;
      if (typeof cost === "number") total += cost;
    }
  }
  return total;
}

/** Name of a slash command typed into the box, without the leading slash. */
function commandName(text: string): string | undefined {
  if (!text.startsWith("/")) return undefined;
  const match = /^\/([^\s]+)/.exec(text);
  return match?.[1];
}

// ---------------------------------------------------------------------------
// The input box: a bordered editor with the context/cost line underneath
// ---------------------------------------------------------------------------

interface FocusEditorOptions {
  tui: TUI;
  theme: Theme;
  keybindings: KeybindingsManager;
  pathLabel: string;
  statusLine: () => { left: string; right: string };
}

class FocusEditor extends CustomEditor {
  private readonly focusTheme: Theme;
  private readonly pathLabel: string;
  private readonly statusLine: () => { left: string; right: string };
  private scrollInfo: (() => string) | undefined;

  constructor(options: FocusEditorOptions) {
    super(
      options.tui,
      { borderColor: (text: string) => options.theme.fg("borderMuted", text), selectList: getSelectListTheme() },
      options.keybindings,
      { paddingX: 1 },
    );
    this.focusTheme = options.theme;
    this.pathLabel = options.pathLabel;
    this.statusLine = options.statusLine;
  }

  /** Optional middle segment for the footer line, e.g. how far the cell is scrolled. */
  setScrollInfo(info: (() => string) | undefined): void {
    this.scrollInfo = info;
  }

  /** `┌─ ~/cwd ───┐` — one continuous line, exactly `width` columns wide. */
  private topBorder(width: number): string {
    const theme = this.focusTheme;
    const line = (count: number) => theme.fg("borderMuted", "─".repeat(Math.max(0, count)));
    const leftCorner = theme.fg("borderMuted", "┌");
    const rightCorner = theme.fg("borderMuted", "┐");
    const room = width - 10; // "┌──" + " " + label + " " + at least 4 dashes + "┐"
    const label = room > 4 ? truncateToWidth(this.pathLabel, room, "…") : "";
    if (!label) return `${leftCorner}${line(width - 2)}${rightCorner}`;
    const tail = width - 6 - visibleWidth(label);
    return `${leftCorner}${line(2)} ${theme.fg("muted", label)} ${line(tail)}${rightCorner}`;
  }

  /** Context usage on the left, scroll position in the middle, balance on the right. */
  private footerLine(width: number): string {
    const theme = this.focusTheme;
    const { left, right } = this.statusLine();
    const info = this.scrollInfo?.() ?? "";
    const rightWidth = visibleWidth(right);
    const infoWidth = info ? visibleWidth(info) + 2 : 0;
    const leftRoom = Math.max(0, width - rightWidth - infoWidth - 1);
    const leftText = visibleWidth(left) > leftRoom ? truncateToWidth(left, leftRoom, "…") : left;
    const gap = width - visibleWidth(leftText) - rightWidth - infoWidth;
    if (gap < (info ? 2 : 1)) return fit(theme.fg("muted", leftText), width);
    const middle = info ? `${" ".repeat(Math.floor(gap / 2))}${theme.fg("dim", info)}${" ".repeat(Math.ceil(gap / 2))}` : " ".repeat(gap);
    return theme.fg("muted", leftText) + middle + theme.fg("muted", right);
  }

  override render(width: number): string[] {
    const boxWidth = Math.max(8, width);
    // "│ " + content + " │" — the inner editor gets the remaining columns.
    const innerWidth = boxWidth - 4;
    const inner = super.render(innerWidth);
    const content = inner.length > 2 ? inner.slice(1, inner.length - 1) : [];
    const theme = this.focusTheme;
    const side = theme.fg("borderMuted", "│");

    const lines: string[] = [this.topBorder(boxWidth)];
    for (const line of content) {
      lines.push(`${side} ${fit(line, innerWidth)} ${side}`);
    }
    lines.push(theme.fg("borderMuted", `└${"─".repeat(Math.max(0, boxWidth - 2))}┘`));
    lines.push(this.footerLine(boxWidth));
    return lines;
  }
}

// ---------------------------------------------------------------------------
// The screen: last two cells + the box, centered
// ---------------------------------------------------------------------------

interface FocusScreenOptions {
  tui: TUI;
  theme: Theme;
  editor: FocusEditor;
  cells: () => Cell[];
  /** Partial assistant message while a run streams, if any. */
  liveMessage: () => { role?: string; content?: unknown } | undefined;
  markdownTheme: MarkdownTheme;
  outputPad: number;
  hideThinking: boolean;
  /** Pi's own tool renderers per tool name, so tool boxes look like the transcript. */
  toolDefinitions: Partial<Record<string, ToolDefinition<any, any, any>>>;
  cwd: string;
  keybindings: KeybindingsManager;
  onInput: (data: string) => boolean; // true when the screen consumed the key
}

class FocusScreen implements Component, Focusable {
  focused = false;
  /** Lines scrolled up from the newest output; 0 keeps the cell pinned to the box. */
  private scrollOffset = 0;
  /** Rendered output rows of the last frame, used to size page scrolls. */
  private viewportRows = 1;
  /** Cell lines above the visible window on the last frame. */
  private hiddenAbove = 0;
  /** Rendered message components, cached by session entry id. */
  private readonly components = new Map<string, Component>();
  private liveComponent: AssistantMessageComponent | undefined;

  constructor(private readonly options: FocusScreenOptions) {}

  invalidate(): void {
    this.options.editor.invalidate();
    for (const component of this.components.values()) component.invalidate();
    this.liveComponent?.invalidate();
  }

  /** Back to the newest output, e.g. after sending a prompt. */
  resetScroll(): void {
    this.scrollOffset = 0;
  }

  /** Footer middle segment: how many cell lines sit above the visible window. */
  scrollLabel(): string {
    return this.hiddenAbove > 0 ? `↑ ${this.hiddenAbove}` : "";
  }

  private scrollBy(lines: number): void {
    this.scrollOffset = Math.max(0, this.scrollOffset + lines);
  }

  /** Viewport keys scroll the cell instead of the (hidden) transcript. */
  private handleScrollKey(data: string): boolean {
    const keys = this.options.keybindings;
    const page = Math.max(1, this.viewportRows - 2);
    if (keys.matches(data, "tui.altScreen.pageUp")) this.scrollBy(page);
    else if (keys.matches(data, "tui.altScreen.pageDown")) this.scrollBy(-page);
    else if (keys.matches(data, "tui.altScreen.halfPageUp")) this.scrollBy(Math.max(1, Math.floor(page / 2)));
    else if (keys.matches(data, "tui.altScreen.halfPageDown")) this.scrollBy(-Math.max(1, Math.floor(page / 2)));
    else if (keys.matches(data, "tui.altScreen.lineUp")) this.scrollBy(1);
    else if (keys.matches(data, "tui.altScreen.lineDown")) this.scrollBy(-1);
    else if (keys.matches(data, "tui.altScreen.top")) this.scrollBy(Number.MAX_SAFE_INTEGER);
    else if (keys.matches(data, "tui.altScreen.bottom")) this.scrollOffset = 0;
    else return false;
    this.options.tui.requestRender();
    return true;
  }

  handleInput(data: string): void {
    if (this.handleScrollKey(data)) return;
    if (this.options.onInput(data)) return;
    this.options.editor.handleInput(data);
  }

  /** Mouse wheel scrolls the cell like the transcript does. */
  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type !== "wheel" || !event.wheelDelta) return undefined;
    this.scrollBy(-Math.sign(event.wheelDelta) * 3);
    this.options.tui.requestRender();
    return { handled: true };
  }

  /** Focused overlays get viewport keys, including PageUp/PageDown. */
  get capturesViewportInput(): boolean {
    return true;
  }

  /**
   * Pi's own component for one message, so markdown, inline-code colors,
   * syntax highlighting, thinking blocks, and the tool boxes look exactly as
   * they do in the normal transcript. Cached per entry: resize and streaming
   * frames are cheap.
   */
  private componentFor(item: CellMessage): Component {
    const cached = this.components.get(item.id);
    if (cached) return cached;

    const { markdownTheme, outputPad, hideThinking } = this.options;
    const component: Component =
      item.role === "user"
        ? new UserMessageComponent(messageText(item.message.content), markdownTheme, outputPad)
        : new AssistantMessageComponent(
            item.message as never,
            hideThinking,
            markdownTheme,
            undefined,
            outputPad,
          );
    this.components.set(item.id, component);
    return component;
  }

  /** Pi's tool box for one call, with its result when it already ran. */
  private toolComponentFor(call: CellTool): ToolExecutionComponent {
    const cached = this.components.get(call.toolCallId);
    if (cached) return cached as ToolExecutionComponent;

    const { tui, outputPad, toolDefinitions, cwd } = this.options;
    const component = new ToolExecutionComponent(
      call.toolName,
      call.toolCallId,
      call.args,
      { outputPad },
      toolDefinitions[call.toolName],
      tui,
      cwd,
    );
    if (call.result) {
      component.markExecutionStarted();
      component.setArgsComplete();
      component.updateResult(
        {
          content: Array.isArray(call.result.content)
            ? (call.result.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>)
            : [],
          details: call.result.details,
          isError: call.result.isError === true,
          durationMs: call.result.durationMs,
        },
        false,
      );
    }
    this.components.set(call.toolCallId, component);
    return component;
  }

  /** Every line of one cell: prompt, thinking, tool boxes, reply. */
  private rawCellLines(cell: Cell, width: number): string[] {
    const lines: string[] = [];
    for (const item of cell.messages) {
      // Copy: component render results are cached arrays and must not be modified.
      lines.push(...this.componentFor(item).render(width));
      for (const call of item.tools) {
        lines.push(...this.toolComponentFor(call).render(width));
      }
    }
    return lines;
  }

  /** Streaming component for the partial assistant message, updated in place. */
  private liveCellLines(width: number): string[] {
    const live = this.options.liveMessage();
    if (!live || live.role !== "assistant") return [];
    if (!this.liveComponent) {
      this.liveComponent = new AssistantMessageComponent(
        live as never,
        this.options.hideThinking,
        this.options.markdownTheme,
        undefined,
        this.options.outputPad,
      );
    } else {
      this.liveComponent.updateContent(live as never, true);
    }
    return [...this.liveComponent.render(width)];
  }

  /** The prompt of the cell on screen, shown pinned above the output. */
  private pinnedPrompt(): string {
    const cell = this.options.cells().at(-1);
    const prompt = cell?.messages.find((item) => item.role === "user");
    return prompt ? messageText(prompt.message.content).trim() : "";
  }

  /** Boxed prompt for the top of the screen: same width as the input box, two lines at most. */
  private pinnedLines(width: number, prompt: string): string[] {
    if (!prompt) return [];
    const theme = this.options.theme;
    const innerWidth = Math.max(1, width - 4);
    const wrapped = wrapTextWithAnsi(prompt, innerWidth);
    const kept = wrapped.slice(0, 2);
    if (kept.length < wrapped.length) {
      kept[kept.length - 1] = truncateToWidth(`${kept[kept.length - 1]}  …`, innerWidth, "…");
    }

    const side = theme.fg("borderMuted", "│");
    const lines = [theme.fg("borderMuted", `┌${"─".repeat(Math.max(0, width - 2))}┐`)];
    for (const line of kept) lines.push(`${side} ${fit(theme.fg("muted", line), innerWidth)} ${side}`);
    lines.push(theme.fg("borderMuted", `└${"─".repeat(Math.max(0, width - 2))}┘`));
    return lines;
  }

  render(width: number): string[] {
    const { tui, editor, cells, liveMessage } = this.options;
    const rows = Math.max(6, tui.terminal.rows);
    const columnWidth = focusWidth(width);
    const indent = " ".repeat(Math.max(0, Math.floor((width - columnWidth) / 2)));

    if (!liveMessage()) this.liveComponent = undefined;

    editor.focused = this.focused;
    // First pass measures the input box; the footer it draws also reads the
    // scroll position, so it is rendered again once that is known below.
    let inputLines = editor.render(columnWidth);
    let pinned = this.pinnedLines(columnWidth, this.pinnedPrompt());
    // No room for both: the input box always wins.
    if (pinned.length + inputLines.length + 1 > rows) pinned = [];

    const outputRows = Math.max(0, rows - pinned.length - inputLines.length);
    this.viewportRows = Math.max(1, outputRows);

    // Only the last cell is drawn: the turn that is running, or the last one
    // that ran. Its live partial reply is appended while it streams.
    const last = cells().at(-1);
    const cellLines = last ? this.rawCellLines(last, columnWidth) : [];
    cellLines.push(...this.liveCellLines(columnWidth));

    // Scroll window over the rendered cell, newest at the bottom.
    const total = cellLines.length;
    this.scrollOffset = Math.min(this.scrollOffset, Math.max(0, total - outputRows));
    const end = total - this.scrollOffset;
    const start = Math.max(0, end - outputRows);
    this.hiddenAbove = start;
    const visible = cellLines.slice(start, end);
    // Second pass: the footer now knows how many lines sit above the window.
    inputLines = editor.render(columnWidth);
    const filler = new Array<string>(Math.max(0, outputRows - visible.length)).fill("");

    // Pinned prompt on top, output filling the middle, input box and footer at
    // the bottom edge.
    const block = [...pinned, ...filler, ...visible, ...inputLines];
    while (block.length > rows) block.shift();
    while (block.length < rows) block.unshift("");

    const lines: string[] = [];
    for (const blockLine of block) {
      lines.push(blockLine === "" ? fit("", width) : fit(indent + blockLine, width));
    }
    return lines;
  }
}

// ---------------------------------------------------------------------------
// Extension wiring
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  let handle: OverlayHandle | undefined;
  let active = false;
  let exitFocus: (() => void) | undefined;
  let hiddenForDialog = false;
  let liveMessage: { role?: string; content?: unknown } | undefined;
  let footerData: ReadonlyFooterDataProvider | undefined;
  let statusTimer: ReturnType<typeof setInterval> | undefined;
  let requestRender: () => void = () => undefined;

  const refresh = () => {
    if (active) requestRender();
  };
  const stopLive = () => {
    liveMessage = undefined;
  };

  /** Extension statuses (`ctx.ui.setStatus`) only reach an extension through a footer factory. */
  const statusSignature = (): string => {
    try {
      return [...(footerData?.getExtensionStatuses() ?? [])].map(([key, value]) => `${key}=${value}`).join("\n");
    } catch {
      return "";
    }
  };

  const startStatusWatch = () => {
    let signature = statusSignature();
    stopStatusWatch();
    statusTimer = setInterval(() => {
      const next = statusSignature();
      if (next === signature) return;
      signature = next;
      refresh();
    }, 1000);
  };

  const stopStatusWatch = () => {
    if (statusTimer) clearInterval(statusTimer);
    statusTimer = undefined;
  };

  pi.on("message_update", (event) => {
    if (!active) return;
    const message = event.message as { role?: string; content?: unknown };
    if (message.role !== "assistant") return;
    liveMessage = message;
    refresh();
  });
  pi.on("message_end", () => {
    stopLive();
    refresh();
  });
  pi.on("tool_execution_start", refresh);
  pi.on("tool_execution_end", refresh);
  pi.on("turn_end", () => {
    stopLive();
    refresh();
  });
  pi.on("agent_end", () => {
    stopLive();
    refresh();
  });
  pi.on("session_shutdown", () => {
    active = false;
    handle = undefined;
    exitFocus = undefined;
  });

  // A dialog drawn behind a full-height overlay would be invisible; step aside.
  pi.on("ui_prompt_start", (event) => {
    if (!active || !handle || hiddenForDialog) return;
    if (event.kind === "select" || event.kind === "confirm" || event.kind === "input" || event.kind === "editor") {
      hiddenForDialog = true;
      handle.setHidden(true);
    }
  });
  pi.on("ui_prompt_end", () => {
    if (!active || !handle || !hiddenForDialog) return;
    hiddenForDialog = false;
    handle.setHidden(false);
    handle.focus();
    refresh();
  });

  const enter = async (ctx: ExtensionCommandContext) => {
    if (ctx.mode !== "tui") {
      ctx.ui.notify("/focus needs interactive TUI mode", "error");
      return;
    }
    const tuiMode = (pi.getSettings() as { tuiMode?: string }).tuiMode ?? "fullscreen";
    if (tuiMode !== "fullscreen") {
      ctx.ui.notify('Focus mode needs fullscreen TUI mode (settings: "tuiMode": "fullscreen")', "error");
      return;
    }

    const settings = pi.getSettings() as {
      outputPad?: number;
      hideThinkingBlock?: boolean;
      markdown?: { codeBlockIndent?: string };
    };
    const markdownTheme: MarkdownTheme = {
      ...getMarkdownTheme(),
      codeBlockIndent: settings.markdown?.codeBlockIndent ?? "  ",
    };
    const outputPad = settings.outputPad === 0 ? 0 : 1;
    const hideThinking = settings.hideThinkingBlock === true;

    // Pi's own tool renderers, so a bash/read/edit box inside a cell looks
    // exactly like the transcript's version of it.
    const toolDefinitions: Partial<Record<string, ToolDefinition<any, any, any>>> = {
      bash: createBashToolDefinition(ctx.cwd),
      read: createReadToolDefinition(ctx.cwd),
      edit: createEditToolDefinition(ctx.cwd),
      write: createWriteToolDefinition(ctx.cwd),
      find: createFindToolDefinition(ctx.cwd),
      grep: createGrepToolDefinition(ctx.cwd),
      ls: createLsToolDefinition(ctx.cwd),
    };

    // A footer factory is the only way an extension can read the statuses that
    // `ctx.ui.setStatus()` publishes (the DeepSeek balance among them).
    try {
      ctx.ui.setFooter((_footerTui, _footerTheme, data) => {
        footerData = data;
        return { render: () => [], invalidate: () => {}, dispose: () => {} };
      });
    } catch {
      footerData = undefined;
    }
    startStatusWatch();

    const pathLabel = shortenPath(ctx.cwd);
    const statusLine = () => {
      const usage = ctx.getContextUsage();
      const percent = usage?.percent === null || usage?.percent === undefined ? "?" : usage.percent.toFixed(1);
      const window = formatTokens(usage?.contextWindow ?? ctx.model?.contextWindow ?? 0);
      const auto = (pi.getSettings() as { compaction?: { enabled?: boolean } }).compaction?.enabled === false ? "" : " (auto)";
      const balance =
        statusAmount(footerData?.getExtensionStatuses()) ?? formatCost(sessionCost(ctx));
      return {
        left: `${percent}% / ${window}${auto}`,
        right: balance,
      };
    };

    active = true;

    const result = ctx.ui.custom<void>(
      (tui, theme, keybindings, done) => {
        requestRender = () => tui.requestRender();
        exitFocus = () => done();

        const editor = new FocusEditor({ tui, theme, keybindings, pathLabel, statusLine });
        let screen: FocusScreen | undefined;
        editor.onSubmit = (text: string) => {
          const prompt = text.trim();
          if (!prompt) return;
          editor.setText("");
          screen?.resetScroll();

          // Built-in TUI commands (`/reload`, `/model`, ...) are dispatched by
          // the composer, not by the session, so they never reach
          // pi.sendUserMessage(). Run the ones with an API and hand the rest
          // back to the normal composer instead of sending them to the model.
          const name = commandName(prompt);
          const known = name ? pi.getCommands().some((command) => command.name === name) : true;
          if (name && !known) {
            if (name === "reload") {
              done();
              void ctx.reload();
              return;
            }
            if (name === "quit" || name === "exit") {
              done();
              ctx.shutdown();
              return;
            }
            if (name === "new") {
              done();
              void ctx.newSession().catch((error: unknown) => {
                ctx.ui.notify(`/new failed: ${String(error)}`, "error");
              });
              return;
            }
            if (name === "compact") {
              ctx.compact();
              tui.requestRender();
              return;
            }
            done();
            ctx.ui.setEditorText(prompt);
            ctx.ui.notify(`/${name} only runs in the normal composer — press Enter there`, "info");
            return;
          }

          // expandPromptTemplates keeps /focus and the other extensions' commands working here.
          if (ctx.isIdle()) pi.sendUserMessage(prompt, { expandPromptTemplates: true });
          else pi.sendUserMessage(prompt, { deliverAs: "steer", expandPromptTemplates: true });
          tui.requestRender();
        };

        screen = new FocusScreen({
          tui,
          theme,
          editor,
          cells: () => readCells(ctx),
          liveMessage: () => liveMessage,
          markdownTheme,
          outputPad,
          hideThinking,
          toolDefinitions,
          cwd: ctx.cwd,
          keybindings,
          onInput: (data: string) => {
            if (keybindings.matches(data, "app.interrupt")) {
              if (!ctx.isIdle()) {
                ctx.abort();
                return true;
              }
              if (editor.getText().length === 0) {
                done();
                return true;
              }
              return false;
            }
            if (keybindings.matches(data, "app.exit") && editor.getText().length === 0) {
              done();
              return true;
            }
            return false;
          },
        });
        editor.setScrollInfo(() => screen?.scrollLabel() ?? "");
        return screen;
      },
      {
        overlay: true,
        overlayOptions: () => ({ anchor: "top-left", width: "100%", maxHeight: "100%", row: 0, col: 0 }),
        onHandle: (overlayHandle) => {
          handle = overlayHandle;
          overlayHandle.focus();
        },
      },
    );

    try {
      await result;
    } finally {
      active = false;
      handle = undefined;
      exitFocus = undefined;
      hiddenForDialog = false;
      stopLive();
      stopStatusWatch();
      footerData = undefined;
      requestRender = () => undefined;
      try {
        ctx.ui.setFooter(undefined);
      } catch {
        // session already replaced; nothing to restore
      }
    }
  };

  pi.registerCommand("focus", {
    description: "Toggle focus mode: only the last cell, a bordered input, and the context/cost line",
    handler: async (_args, ctx) => {
      if (active) {
        exitFocus?.();
        return;
      }
      await enter(ctx);
    },
  });
}
