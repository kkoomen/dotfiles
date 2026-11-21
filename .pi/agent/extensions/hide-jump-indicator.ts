/**
 * Hide the fullscreen "↓ Jump to latest message · Ctrl+End" pill.
 *
 * Pi's fullscreen (alt-screen) renderer paints that indicator over the transcript
 * whenever the view is scrolled away from the end. The label comes from the
 * `scrollToEndIndicator` option that `createInteractiveTui` passes to
 * `TuiAltScreen`; no setting or extension hook turns it off, and the TUI handle
 * extensions receive is a proxy that drops property assignment, so the option
 * object itself is out of reach.
 *
 * What is reachable is the renderer's prototype (the proxy forwards
 * `getPrototypeOf`), and the draw call is a plain prototype method:
 *
 *     compositeScrollToEndIndicator(screen, layout, width) { ... return screen }
 *
 * Replacing it with a pass-through leaves the composited screen untouched, so the
 * pill is never drawn. Applied on session start, independent of focus mode; in
 * regular (non-fullscreen) mode the method does not exist and this is a no-op.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

const METHOD = "compositeScrollToEndIndicator";
const PROBE_WIDGET = "hide-jump-indicator";

export default function (pi: ExtensionAPI) {
  let patched = false;

  /** Walk the renderer's prototype chain and neuter the indicator compositor. */
  const hideIndicator = (tui: TUI) => {
    let proto = Object.getPrototypeOf(tui) as Record<string, unknown> | null;
    while (proto) {
      if (typeof proto[METHOD] === "function") {
        // Hand the screen through unchanged instead of compositing the pill.
        proto[METHOD] = function (screen: unknown) {
          return screen;
        };
        patched = true;
        return;
      }
      proto = Object.getPrototypeOf(proto) as Record<string, unknown> | null;
    }
  };

  pi.on("session_start", (_event, ctx) => {
    if (patched || !ctx.hasUI) return;
    const probe: Component = { render: () => [], invalidate() {} };
    try {
      // A component factory is the only way to receive the TUI handle: install a
      // throwaway widget, capture the handle, then remove the widget again.
      ctx.ui.setWidget(PROBE_WIDGET, (tui) => {
        hideIndicator(tui);
        return probe;
      });
    } finally {
      try {
        ctx.ui.setWidget(PROBE_WIDGET, undefined);
      } catch {
        /* widget map already gone on shutdown */
      }
    }
  });
}
