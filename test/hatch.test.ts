import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  APPROVE_ORIGINAL,
  APPROVE_SEND,
  BY_TEMP_COLLECTION,
  OPT_IN_NO,
  OPT_IN_YES,
  PENDING_COLLECTION,
  STALE_MS,
  approvalQuestion,
  baseModel,
  cancelPlan,
  finalEnriched,
  gatekeeperPrompt,
  isApproved,
  isStale,
  preHatchResult,
  researchPrompt,
  shouldIntercept,
  userEventData,
} from "../src/hatch";
import { cancel } from "../src/verdict";

// A fake in-memory host so the host-touching handlers can be exercised.
// `store` mirrors the plugin data store; `calls` records the side effects we
// assert the flow does (and, crucially, does NOT do) after it hatches.
const h = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  calls: {
    deliver: [] as any[],
    ask: [] as any[],
    dispatch: [] as any[],
    answer: { status: "pending" } as any,
  },
}));

vi.mock("../src/host", () => ({
  storePut: vi.fn((i: any) => {
    h.store.set(`${i.collection}:${i.key}`, i.data);
    return {};
  }),
  storeGet: vi.fn((i: any) => {
    const k = `${i.collection}:${i.key}`;
    return { value: h.store.has(k) ? h.store.get(k) : null };
  }),
  storeDelete: vi.fn((i: any) => {
    h.store.delete(`${i.collection}:${i.key}`);
    return {};
  }),
  deliverMessage: vi.fn((i: any) => {
    h.calls.deliver.push(i);
    return {};
  }),
  askUser: vi.fn((i: any) => {
    h.calls.ask.push(i);
    return {};
  }),
  dispatchCapture: vi.fn((i: any) => {
    h.calls.dispatch.push(i);
    return {};
  }),
  getAnswer: vi.fn(() => h.calls.answer),
  createSession: vi.fn(() => ({ session: { id: "temp-1" } })),
  sessionMetaSet: vi.fn(() => ({})),
  terminateAgent: vi.fn(() => ({})),
  genId: vi.fn(() => "tok-1"),
  nowMs: vi.fn(() => 1000),
}));

describe("baseModel", () => {
  it("strips provider prefix and account suffix", () => {
    expect(baseModel("claude:claude-haiku-4-5")).toBe("claude-haiku-4-5");
    expect(baseModel("claude-haiku-4-5@acc_1")).toBe("claude-haiku-4-5");
    expect(baseModel("claude:claude-haiku-4-5@acc_1")).toBe("claude-haiku-4-5");
    expect(baseModel("claude-opus-4-8")).toBe("claude-opus-4-8");
  });
});

describe("shouldIntercept", () => {
  it("skips when the provider prices no cheaper model", () => {
    expect(shouldIntercept("please refactor the auth flow", "claude-opus-4-8", "")).toBe(false);
  });

  it("skips when the session already runs the cheapest model", () => {
    expect(
      shouldIntercept("please refactor the auth flow", "claude-haiku-4-5", "claude:claude-haiku-4-5"),
    ).toBe(false);
  });

  it("skips trivially short messages", () => {
    expect(shouldIntercept("ok", "claude-opus-4-8", "claude:claude-haiku-4-5")).toBe(false);
    expect(shouldIntercept("  yes  ", "claude-opus-4-8", "claude:claude-haiku-4-5")).toBe(false);
  });

  it("intercepts a substantive message on an expensive model", () => {
    expect(
      shouldIntercept(
        "fix the login redirect bug in the session handler",
        "claude-opus-4-8",
        "claude:claude-haiku-4-5",
      ),
    ).toBe(true);
  });
});

describe("isStale", () => {
  it("treats a fresh record as live and an old one as dead", () => {
    const now = 10_000_000;
    expect(isStale({ created_ms: now - 1000 }, now)).toBe(false);
    expect(isStale({ created_ms: now - STALE_MS - 1 }, now)).toBe(true);
    // Malformed record (no created_ms) counts as stale, not as a blocker.
    expect(isStale({}, now)).toBe(true);
  });
});

describe("finalEnriched", () => {
  it("keeps the model's message when it contains the original verbatim", () => {
    const original = "fix the login bug";
    const enriched = "fix the login bug\n\n## Context (pre-gathered)\n- src/auth.rs:42";
    expect(finalEnriched(original, enriched)).toBe(enriched);
  });

  it("prepends the original when the model paraphrased it away", () => {
    const out = finalEnriched("fix the login bug", "## Context\n- src/auth.rs:42");
    expect(out.startsWith("fix the login bug\n\n")).toBe(true);
    expect(out).toContain("src/auth.rs:42");
  });
});

describe("userEventData", () => {
  it("carries the rendered text plus the original for the expandable view", () => {
    const d = userEventData("enriched text", "original text", true, "temp-1");
    expect(d.text).toBe("enriched text");
    expect(d.pre_hatch.original).toBe("original text");
    expect(d.pre_hatch.enriched).toBe(true);
    expect(d.pre_hatch.temp_session_id).toBe("temp-1");
  });
});

  it("marks a cancelled delivery without touching the normal shape", () => {
    const d = userEventData("original", "original", false, "temp-1", true);
    expect(d.pre_hatch.cancelled).toBe(true);
    expect(d.pre_hatch.enriched).toBe(false);
    // The flag is absent — not false — on ordinary deliveries, so old
    // readers see the exact shape they always did.
    const plain = userEventData("original", "original", false, "temp-1");
    expect("cancelled" in plain.pre_hatch).toBe(false);
  });

describe("cancel", () => {
  it("carries structured data when given, and omits it when not", () => {
    const bare = JSON.parse(cancel("pre-hatching"));
    expect(bare).toEqual({ verdict: "cancel", reason: "pre-hatching" });
    const withData = JSON.parse(
      cancel("pre-hatching", { temp_session_id: "temp-1", model: "claude:claude-haiku-4-5" }),
    );
    expect(withData.data.temp_session_id).toBe("temp-1");
    expect(withData.data.model).toBe("claude:claude-haiku-4-5");
  });
});

describe("researchPrompt", () => {
  it("embeds the user message between markers and names the tool", () => {
    const p = researchPrompt("what does the orchestrator do?");
    expect(p).toContain("---BEGIN USER MESSAGE---");
    expect(p).toContain("what does the orchestrator do?");
    expect(p).toContain("---END USER MESSAGE---");
    expect(p).toContain("pre_hatch_result");
  });

  it("declares the session read-only, context-only, and names the blocked tools", () => {
    const p = researchPrompt("fix the login bug");
    expect(p).toContain("READ-ONLY");
    expect(p).toContain("NEVER make code changes");
    expect(p).toContain("that work belongs to the main model");
    for (const tool of ["write_file", "edit_file", "run_command", "run_tests"]) {
      expect(p).toContain(tool);
    }
    // The prompt must tell the model enforcement is server-side, not
    // just advisory.
    expect(p).toContain("the server refuses them");
  });
});

describe("gatekeeperPrompt", () => {
  it("holds the first turn and embeds the full research prompt", () => {
    const p = gatekeeperPrompt("fix the login bug");
    expect(p).toContain("do NOT call pre_hatch_result");
    expect(p).toContain("reply with exactly: ok");
    expect(p).toContain(researchPrompt("fix the login bug"));
  });

  it("branches on the exact opt-in option labels and declines to pass", () => {
    const p = gatekeeperPrompt("fix the login bug");
    expect(p).toContain(OPT_IN_YES);
    expect(p).toContain(OPT_IN_NO);
    // A decline or dismissal must deliver the original, never drop it.
    expect(p).toContain('{"action":"pass"}');
  });
});

describe("approvalQuestion", () => {
  it("embeds the proposal, clipped for the card", () => {
    const q = approvalQuestion("fix the bug\n\n## Context (pre-gathered)\n- src/a.rs:1");
    expect(q).toContain("Send");
    expect(q).toContain("## Context (pre-gathered)");
    const long = approvalQuestion("x".repeat(5000));
    expect(Array.from(long).length).toBeLessThan(1400);
    expect(long).toContain("…");
  });
});

describe("isApproved", () => {
  it("approves only an explicit, unrejected 'send expanded' answer", () => {
    expect(isApproved({ status: "answered", rejected: false, answer: APPROVE_SEND })).toBe(true);
    expect(isApproved({ status: "answered", answer: APPROVE_SEND })).toBe(true);
  });

  it("falls back to the original on decline, dismissal, or anything else", () => {
    expect(isApproved({ status: "answered", answer: APPROVE_ORIGINAL })).toBe(false);
    expect(isApproved({ status: "answered", rejected: true, answer: APPROVE_SEND })).toBe(false);
    expect(isApproved({ status: "pending" })).toBe(false);
    expect(isApproved({ status: "unknown" })).toBe(false);
    expect(isApproved(null)).toBe(false);
  });
});

describe("cancelPlan", () => {
  const pending = { temp_session_id: "temp-1", original_text: "fix the login bug" };

  it("delivers the recorded original for the matching pre-hatch", () => {
    expect(cancelPlan(pending, "temp-1")).toBe("deliver");
    // A cancel that doesn't name a temp session (legacy event) still hits
    // the chat's only pending record.
    expect(cancelPlan(pending, "")).toBe("deliver");
  });

  it("does nothing when no record is pending or a newer pre-hatch owns it", () => {
    expect(cancelPlan(null, "temp-1")).toBe("not-pending");
    expect(cancelPlan(pending, "temp-2")).toBe("not-pending");
  });

  it("falls back to core delivery when the record is unusable", () => {
    expect(cancelPlan({ temp_session_id: "temp-1" }, "temp-1")).toBe("fallback");
    expect(cancelPlan({ temp_session_id: "temp-1", original_text: "  " }, "temp-1")).toBe(
      "fallback",
    );
  });
});

describe("researchPrompt with session context", () => {
  it("embeds the full chat transcript when history is supplied", () => {
    const history = "User: earlier question\n\nAssistant: earlier answer";
    const p = researchPrompt("and now fix that", history);
    expect(p).toContain("---BEGIN CONVERSATION---");
    expect(p).toContain("earlier question");
    expect(p).toContain("earlier answer");
    expect(p).toContain("---END CONVERSATION---");
    // The new message stays clearly separated from the transcript.
    expect(p).toContain("---BEGIN USER MESSAGE---");
    expect(p).toContain("and now fix that");
  });

  it("omits the conversation block when there is no history", () => {
    const p = researchPrompt("standalone question");
    expect(p).not.toContain("---BEGIN CONVERSATION---");
  });

  it("instructs the model to ALWAYS ask when the request is ambiguous", () => {
    const p = researchPrompt("do the thing");
    expect(p).toContain("ALWAYS resolve ambiguity by ASKING");
    expect(p).toContain('{"action":"ask"');
  });
});

describe("gatekeeperPrompt threads history into the research prompt", () => {
  it("embeds the history-carrying research prompt", () => {
    const history = "User: prior\n\nAssistant: reply";
    const p = gatekeeperPrompt("fix that", history);
    expect(p).toContain(researchPrompt("fix that", history));
    expect(p).toContain("prior");
  });
});

describe("preHatchResult stops after generating the hatched prompt", () => {
  beforeEach(() => {
    h.store.clear();
    h.calls.deliver.length = 0;
    h.calls.ask.length = 0;
    h.calls.dispatch.length = 0;
    h.calls.answer = { status: "pending" };
    vi.clearAllMocks();
  });

  it("enrich proposes, finalize delivers the hatched prompt once, then the flow is over", () => {
    // The link a live pre-hatch would have stored before the temp agent runs.
    h.store.set(`${BY_TEMP_COLLECTION}:temp-1`, {
      chat_session_id: "chat-1",
      original_text: "fix the login bug",
    });
    h.store.set(`${PENDING_COLLECTION}:chat-1`, {
      temp_session_id: "temp-1",
      original_text: "fix the login bug",
      created_ms: 1000,
    });

    // enrich: PROPOSES the expanded ("hatched") message. Nothing is delivered
    // yet — only the approval card is raised.
    const enriched =
      "fix the login bug\n\n## Context (pre-gathered)\n- src/auth.rs:42";
    const r1 = preHatchResult({ action: "enrich", message: enriched }, "temp-1");
    expect(r1.status).toBe("waiting_for_user");
    expect(h.calls.deliver).toHaveLength(0);
    expect(h.calls.ask).toHaveLength(1);

    // The user approves; finalize delivers the hatched prompt EXACTLY once.
    h.calls.answer = { status: "answered", answer: APPROVE_SEND };
    const r2 = preHatchResult({ action: "finalize" }, "temp-1");
    expect(r2).toEqual({ ok: true, delivered: "enriched" });
    expect(h.calls.deliver).toHaveLength(1);
    expect(h.calls.deliver[0].text).toBe(enriched);

    // STOPPED: both records cleared, and no further question or dispatch that
    // could re-run the temp research agent.
    expect(h.store.has(`${BY_TEMP_COLLECTION}:temp-1`)).toBe(false);
    expect(h.store.has(`${PENDING_COLLECTION}:chat-1`)).toBe(false);
    expect(h.calls.ask).toHaveLength(1);
    expect(h.calls.dispatch).toHaveLength(0);

    // Re-entry is refused — the pre-hatch is truly finished, not looping.
    expect(() => preHatchResult({ action: "finalize" }, "temp-1")).toThrow();
    expect(h.calls.deliver).toHaveLength(1);
  });

  it("pass delivers the original once and then stops", () => {
    h.store.set(`${BY_TEMP_COLLECTION}:temp-2`, {
      chat_session_id: "chat-2",
      original_text: "explain the parser",
    });
    h.store.set(`${PENDING_COLLECTION}:chat-2`, {
      temp_session_id: "temp-2",
      original_text: "explain the parser",
      created_ms: 1000,
    });
    const r = preHatchResult({ action: "pass" }, "temp-2");
    expect(r).toEqual({ ok: true, delivered: "original" });
    expect(h.calls.deliver).toHaveLength(1);
    expect(h.calls.dispatch).toHaveLength(0);
    expect(h.store.has(`${BY_TEMP_COLLECTION}:temp-2`)).toBe(false);
    expect(h.store.has(`${PENDING_COLLECTION}:chat-2`)).toBe(false);
  });
});
