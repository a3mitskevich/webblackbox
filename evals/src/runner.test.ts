import { describe, expect, it } from "vitest";

import { buildClaudeArgs, summariseTranscript } from "./agent-runner.js";
import { type ManifestEntry, mergeEntries, parseManifest } from "./archive-manifest.js";
import { parseVerdict } from "./judge.js";
import { fillTemplate, loadPrompt } from "./prompts.js";

const line = (value: object) => JSON.stringify(value);

describe("summariseTranscript", () => {
  it("collects the model, tool calls, final text, usage, cost and time", () => {
    const transcript = [
      line({ type: "system", subtype: "init", model: "claude-sonnet-x" }),
      line({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "mcp__webblackbox__session_summary" },
            { type: "tool_use", name: "mcp__webblackbox__query_events" }
          ]
        }
      }),
      "not json",
      line({
        type: "assistant",
        message: { content: [{ type: "tool_use", name: "mcp__webblackbox__query_events" }] }
      }),
      line({ type: "assistant", message: { content: [{ type: "text", text: "draft" }] } }),
      line({
        type: "result",
        subtype: "success",
        result: "final answer",
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          cache_read_input_tokens: 300,
          cache_creation_input_tokens: 4000
        },
        total_cost_usd: 0.12,
        duration_ms: 3456,
        num_turns: 4
      })
    ].join("\n");

    expect(summariseTranscript(transcript)).toEqual({
      model: "claude-sonnet-x",
      text: "final answer",
      toolCalls: { query_events: 2, session_summary: 1 },
      toolCallCount: 3,
      tokens: { input: 10, output: 20, cacheRead: 300, cacheCreation: 4000, total: 4330 },
      costUsd: 0.12,
      durationMs: 3456,
      turns: 4
    });
  });

  it("falls back to the last assistant text and reports an error result", () => {
    const transcript = [
      line({ type: "assistant", message: { content: [{ type: "text", text: "partial" }] } }),
      line({ type: "result", subtype: "error_max_budget_usd", is_error: true })
    ].join("\n");
    const summary = summariseTranscript(transcript);

    expect(summary.text).toBe("partial");
    expect(summary.error).toMatch(/error_max_budget_usd/);
    expect(summary.model).toBe("unknown");
  });
});

describe("buildClaudeArgs", () => {
  it("disables built-in tools and outside settings, and limits MCP to the given config", () => {
    const args = buildClaudeArgs({
      prompt: "p",
      systemPrompt: "s",
      model: "sonnet",
      mcpConfigPath: "/tmp/mcp.json",
      allowedTools: ["mcp__webblackbox"],
      cwd: "/tmp",
      timeoutMs: 1,
      maxBudgetUsd: 2
    });

    expect(args).toEqual(expect.arrayContaining(["-p", "--strict-mcp-config"]));
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args[args.indexOf("--mcp-config") + 1]).toBe("/tmp/mcp.json");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("mcp__webblackbox");
    expect(args[args.indexOf("--max-budget-usd") + 1]).toBe("2");
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("omits MCP flags for the judge", () => {
    const args = buildClaudeArgs({
      prompt: "p",
      systemPrompt: "s",
      model: "sonnet",
      cwd: "/tmp",
      timeoutMs: 1,
      maxBudgetUsd: 1
    });

    expect(args).not.toContain("--mcp-config");
    expect(args).not.toContain("--allowedTools");
  });
});

describe("parseVerdict", () => {
  it("reads a JSON verdict, also inside prose", () => {
    expect(parseVerdict('{"pass": true, "reason": "same cause"}')).toEqual({
      pass: true,
      reason: "same cause"
    });
    expect(parseVerdict('Verdict: {"pass": false}')).toEqual({ pass: false, reason: "" });
  });

  it("fails an unreadable verdict", () => {
    expect(parseVerdict("I think it passes", "timeout").pass).toBe(false);
    expect(parseVerdict('{"pass": "yes"}').pass).toBe(false);
  });
});

describe("prompts", () => {
  it("fills every placeholder and rejects a missing one", () => {
    expect(fillTemplate("{{a}} and {{b}}", { a: "1", b: "2" })).toBe("1 and 2");
    expect(() => fillTemplate("{{a}} {{c}}", { a: "1" })).toThrow(/\{\{c\}\}/);
  });

  it("ships prompts whose placeholders the runner fills", async () => {
    const task = await loadPrompt("agent-task");
    const judge = await loadPrompt("judge");

    expect(() =>
      fillTemplate(task, { report: "r", archivePath: "/a", passphrase: "p" })
    ).not.toThrow();
    expect(() =>
      fillTemplate(judge, { rootCause: "c", keyEvidence: "e", answer: "a" })
    ).not.toThrow();
    expect(task).toMatch(/"rootCause"/);
    expect(await loadPrompt("agent-system")).toMatch(/MCP/);
  });
});

describe("archive manifest", () => {
  const entry = (profile: string, caseId: string, bytes: number): ManifestEntry => ({
    caseId,
    scenarioId: caseId,
    profile,
    file: `${profile}/${caseId}.webblackbox`,
    bytes,
    symptomReproduced: true,
    recordedAt: "2026-10-12T00:00:00.000Z"
  });

  it("replaces re-recorded entries and keeps the others, sorted", () => {
    const merged = mergeEntries(
      [entry("default", "case-02", 1), entry("default", "case-01", 1)],
      [entry("default", "case-02", 2), entry("full-capture", "case-01", 3)]
    );

    expect(merged.map((item) => `${item.profile}/${item.caseId}:${item.bytes}`)).toEqual([
      "default/case-01:1",
      "default/case-02:2",
      "full-capture/case-01:3"
    ]);
  });

  it("validates the manifest it reads", () => {
    const valid = {
      version: 1,
      createdAt: "now",
      passphrase: "secret-pass",
      entries: [entry("default", "case-01", 1)]
    };

    expect(parseManifest(valid).entries).toHaveLength(1);
    expect(() => parseManifest({ ...valid, version: 2 })).toThrow(/unsupported/);
    expect(() => parseManifest({ ...valid, entries: [{ caseId: 1 }] })).toThrow(/malformed/);
  });
});
