// Shared response helpers: verdict envelopes and small formatting utilities.
// Pure — safe to import under vitest.

/// A `Verdict::Allow` carrying `value` as the payload.
export function allow(value: unknown): string {
  return JSON.stringify({ verdict: "allow", payload: value });
}

/// A `Verdict::Cancel` with a reason and optional structured `data`. On
/// `session.message.before` this means "the plugin took ownership of the
/// turn" — `data` (e.g. `{temp_session_id, model}`) is copied by core onto
/// the `pre-hatch` placeholder event; on `mcp.tool.invoke` it maps to a tool
/// error in core.
export function cancel(reason: string, data?: unknown): string {
  return data === undefined
    ? JSON.stringify({ verdict: "cancel", reason })
    : JSON.stringify({ verdict: "cancel", reason, data });
}

/// A `Verdict::Skip`.
export function skip(): string {
  return JSON.stringify({ verdict: "skip" });
}

/// Truncate `s` to at most `max` code points, appending an ellipsis when
/// clipped.
export function truncate(s: string, max: number): string {
  const chars = Array.from(s);
  if (chars.length <= max) {
    return s;
  }
  return chars.slice(0, max).join("") + "…";
}
