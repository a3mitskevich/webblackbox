// Runs one `claude -p` session and summarises its stream-json transcript: the final text, the
// tools it called, token use, cost and time. The agent sees only the tools we allow; with an MCP
// config it sees only that server (`--strict-mcp-config`), never the built-in file/shell tools.

import { spawn } from "node:child_process";

export type AgentRunOptions = {
  prompt: string;
  systemPrompt: string;
  model: string;
  /** MCP config file; omitted = no MCP servers (the judge). */
  mcpConfigPath?: string;
  /** Tools allowed without a permission prompt, e.g. `mcp__webblackbox`. */
  allowedTools?: readonly string[];
  cwd: string;
  timeoutMs: number;
  maxBudgetUsd: number;
  /** Extra CLI flags (e.g. `--bare` when ANTHROPIC_API_KEY is set). */
  extraArgs?: readonly string[];
  claudeBin?: string;
};

export type TokenUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  /** Everything the model read or wrote. */
  total: number;
};

export type AgentRun = {
  /** The model the CLI resolved (e.g. claude-sonnet-…), from its init message. */
  model: string;
  text: string;
  toolCalls: Readonly<Record<string, number>>;
  toolCallCount: number;
  tokens: TokenUsage;
  costUsd: number;
  durationMs: number;
  turns: number;
  /** Raw stream-json lines, for the transcript file. */
  transcript: string;
  error?: string;
};

type TranscriptSummary = Omit<AgentRun, "transcript">;

export async function runAgent(options: AgentRunOptions): Promise<AgentRun> {
  const started = Date.now();
  const { stdout, stderr, exitCode, timedOut } = await spawnWithTimeout(
    options.claudeBin ?? "claude",
    buildClaudeArgs(options),
    options.prompt,
    options.cwd,
    options.timeoutMs
  );
  const summary = summariseTranscript(stdout);
  const failure = timedOut
    ? `Timed out after ${options.timeoutMs} ms`
    : exitCode !== 0 && !summary.text
      ? `claude exited with ${exitCode}: ${stderr.slice(0, 500)}`
      : summary.error;

  return {
    ...summary,
    durationMs: summary.durationMs || Date.now() - started,
    transcript: stdout,
    ...(failure ? { error: failure } : {})
  };
}

export function buildClaudeArgs(options: AgentRunOptions): string[] {
  return [
    "-p",
    "--model",
    options.model,
    "--output-format",
    "stream-json",
    "--verbose",
    "--system-prompt",
    options.systemPrompt,
    // No built-in tools (no shell, no file access): only what MCP exposes.
    "--tools",
    "",
    "--strict-mcp-config",
    ...(options.mcpConfigPath ? ["--mcp-config", options.mcpConfigPath] : []),
    ...(options.allowedTools?.length ? ["--allowedTools", ...options.allowedTools] : []),
    // Ignore the user's and the project's settings (hooks, plugins, permissions).
    "--setting-sources",
    "",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--max-budget-usd",
    String(options.maxBudgetUsd),
    ...(options.extraArgs ?? [])
  ];
}

/** Folds the stream-json lines of one session into its result. */
export function summariseTranscript(stdout: string): TranscriptSummary {
  const toolCalls = new Map<string, number>();
  let model = "unknown";
  let text = "";
  let lastAssistantText = "";
  let tokens = readUsage(undefined);
  let costUsd = 0;
  let durationMs = 0;
  let turns = 0;
  let error: string | undefined;

  for (const message of stdout.split("\n").map(parseLine)) {
    if (!message) {
      continue;
    }

    if (message.type === "system" && message.subtype === "init") {
      model = typeof message.model === "string" ? message.model : model;
    } else if (message.type === "assistant") {
      for (const block of contentBlocks(message)) {
        if (block.type === "tool_use" && typeof block.name === "string") {
          const name = toolName(block.name);
          toolCalls.set(name, (toolCalls.get(name) ?? 0) + 1);
        } else if (block.type === "text" && typeof block.text === "string") {
          lastAssistantText = block.text;
        }
      }
    } else if (message.type === "result") {
      text = typeof message.result === "string" ? message.result : "";
      tokens = readUsage(message.usage);
      costUsd = typeof message.total_cost_usd === "number" ? message.total_cost_usd : 0;
      durationMs = typeof message.duration_ms === "number" ? message.duration_ms : 0;
      turns = typeof message.num_turns === "number" ? message.num_turns : 0;

      if (message.is_error === true) {
        error = `Agent session ended with ${String(message.subtype ?? "an error")}`;
      }
    }
  }

  return {
    model,
    text: text || lastAssistantText,
    toolCalls: Object.fromEntries([...toolCalls].sort(([a], [b]) => a.localeCompare(b))),
    toolCallCount: [...toolCalls.values()].reduce((sum, count) => sum + count, 0),
    tokens,
    costUsd,
    durationMs,
    turns,
    ...(error ? { error } : {})
  };
}

/** `mcp__webblackbox__query_events` → `query_events`. */
function toolName(name: string): string {
  return name.startsWith("mcp__") ? name.split("__").slice(2).join("__") : name;
}

function readUsage(value: unknown): TokenUsage {
  const usage = isRecord(value) ? value : {};
  const read = (key: string): number => {
    const field = usage[key];
    return typeof field === "number" ? field : 0;
  };
  const input = read("input_tokens");
  const output = read("output_tokens");
  const cacheRead = read("cache_read_input_tokens");
  const cacheCreation = read("cache_creation_input_tokens");

  return {
    input,
    output,
    cacheRead,
    cacheCreation,
    total: input + output + cacheRead + cacheCreation
  };
}

function contentBlocks(message: Record<string, unknown>): Record<string, unknown>[] {
  const inner = isRecord(message.message) ? message.message : {};
  return Array.isArray(inner.content) ? inner.content.filter(isRecord) : [];
}

function parseLine(line: string): Record<string, unknown> | null {
  if (!line.trim()) {
    return null;
  }

  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function spawnWithTimeout(
  command: string,
  args: readonly string[],
  stdin: string,
  cwd: string,
  timeoutMs: number
): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode,
        timedOut
      });
    });
    child.stdin.end(stdin);
  });
}
