// Types for `profile-e2e-harness.mjs`, for TypeScript callers (the bug zoo recorder in evals/).

export interface CdpClient {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  on(method: string, handler: (params: Record<string, unknown>) => void): void;
  /** Runs `expression` (awaiting promises) and returns its value; throws on an exception. */
  evaluate(expression: string): Promise<unknown>;
  close(): void;
}

export interface LaunchedBrowser {
  browser: CdpClient;
  page: CdpClient;
  popup: CdpClient;
  sw: CdpClient;
  swExceptions: string[];
  dialogs: string[];
  extensionId: string | undefined;
}

export interface DevtoolsTarget {
  id: string;
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}

export interface ProfileE2eHarness {
  chromeLogPath: string;
  launch(pageUrl: string, options?: { keepProfile?: boolean }): Promise<LaunchedBrowser>;
  stopBrowser(): Promise<void>;
  attach(target: DevtoolsTarget): Promise<CdpClient>;
  listTargets(): Promise<DevtoolsTarget[]>;
  openPage(url: string): Promise<{ client: CdpClient; targetId: string }>;
  closePage(targetId: string): Promise<void>;
  waitForDownload(): Promise<string>;
  trackServer(server: { close(): unknown }): void;
  cleanup(): Promise<void>;
}

export declare function createProfileE2eHarness(options: {
  name: string;
  appRoot: string;
  defaultPort: string;
}): ProfileE2eHarness;

export declare function fetchJson(url: string, init?: RequestInit): Promise<unknown>;

export declare function waitFor<T>(
  fn: () => Promise<T | null | undefined> | T | null | undefined,
  timeoutMs: number,
  message: string
): Promise<T>;

export declare function assert(condition: unknown, message: string, details?: unknown): void;

export declare function sleep(ms: number): Promise<void>;
