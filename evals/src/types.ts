// The scenario model shared by the fixture site, the recorder, the evaluation runner and the
// rubric. One scenario = one seeded bug: its pages and API, the steps a tester takes to reproduce
// it, the tester's report (symptom only), and the rubric an analysis is scored against.

/** What the fixture server answers to one API call. */
export type ApiReply = {
  status: number;
  headers?: Readonly<Record<string, string>>;
  /** Objects are sent as JSON. */
  body?: string | object;
  /** Answer after this delay. */
  delayMs?: number;
  /** Never answer: the request stays in flight until the server closes. */
  hold?: boolean;
};

export type ApiRequest = {
  method: string;
  url: URL;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  body: string;
};

/** Mutable per-server state (the site restarts for every recording, so it starts empty). */
export type ScenarioState = Map<string, unknown>;

export type ApiHandler = (request: ApiRequest, state: ScenarioState) => ApiReply;

/** A connected WebSocket the scenario drives. */
export type ScenarioSocket = {
  sendText(text: string): void;
  close(code: number, reason: string): void;
};

/**
 * Steps run over CDP. `click` dispatches real mouse events at the centre of `selector` (inside
 * `frame` when given), so whatever element is on top at that point receives the click.
 */
export type ScenarioStep =
  | { kind: "navigate"; path: string }
  | { kind: "click"; selector: string; frame?: string; clickCount?: 1 | 2 }
  | { kind: "type"; selector: string; text: string; frame?: string }
  | { kind: "wait"; ms: number }
  | { kind: "waitFor"; expression: string; timeoutMs: number }
  | { kind: "evaluate"; expression: string };

/** One fact the analysis must (or must not) state; any of `patterns` matching is enough. */
export type RubricFact = {
  id: string;
  description: string;
  patterns: readonly RegExp[];
  /**
   * Where a required or bonus fact is looked for: the whole answer (default) or only the stated
   * root cause, for facts the evidence often mentions in passing or negated ("no close event").
   */
  scope?: "answer" | "rootCause";
};

export type Rubric = {
  /** The real cause, for people reading the report. */
  rootCause: string;
  /** The evidence a correct analysis points to, for people reading the report. */
  keyEvidence: readonly string[];
  /** Every one of them must be stated in the answer. */
  required: readonly RubricFact[];
  /** Extra credit: they raise the score but do not decide pass/fail. */
  bonus: readonly RubricFact[];
  /** Wrong conclusions: matching any of them in the stated root cause fails the answer. */
  forbidden: readonly RubricFact[];
};

/** Kinds of data a correct analysis needs; the report lists which ones were missing. */
export type EvidenceKind =
  | "click-target"
  | "dom"
  | "exception"
  | "iframe"
  | "navigation"
  | "network-cache"
  | "network-pending"
  | "network-request-body"
  | "network-response-body"
  | "network-status"
  | "network-timing"
  | "storage-value"
  | "user-input"
  | "websocket";

export type Scenario = {
  /** Internal, descriptive id (never shown to the agent). */
  id: string;
  /** Opaque id used for archive names, so the file name does not give the cause away. */
  caseId: string;
  title: string;
  /** Pages, keyed by their path (neutral product-like routes, no hint of the bug). */
  pages: Readonly<Record<string, string>>;
  /** Static scripts, keyed by their path. */
  scripts?: Readonly<Record<string, string>>;
  /** API handlers keyed by "METHOD /path" (no query string). */
  api?: Readonly<Record<string, ApiHandler>>;
  /** WebSocket endpoints keyed by path; called once per connection. */
  sockets?: Readonly<Record<string, (socket: ScenarioSocket) => void>>;
  /** Steps run before the recording starts (state the tester already had). */
  setup?: readonly ScenarioStep[];
  steps: readonly ScenarioStep[];
  /** A page expression that is truthy once the symptom is visible: proves the bug reproduced. */
  symptom: string;
  report: { ru: string; en: string };
  rubric: Rubric;
  evidence: readonly EvidenceKind[];
};
