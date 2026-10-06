export type PortMessageHandler = (message: unknown) => void;

export type PortDisconnectHandler = () => void;

export type RuntimeMessageSender = {
  id?: string;
  url?: string;
  frameId?: number;
  tab?: {
    id?: number;
  };
};

export type PortLike = {
  name: string;
  sender?: RuntimeMessageSender;
  onMessage: {
    addListener(handler: PortMessageHandler): void;
    removeListener(handler: PortMessageHandler): void;
  };
  onDisconnect: {
    addListener(handler: PortDisconnectHandler): void;
    removeListener(handler: PortDisconnectHandler): void;
  };
  postMessage(message: unknown): void;
  disconnect?: () => void;
};

export type ChromeEvent<TListener> = {
  addListener(listener: TListener): void;
  removeListener(listener: TListener): void;
};

/** The `chrome.tabs.Tab` fields the extension reads. */
export type ChromeTab = {
  id?: number;
  windowId?: number;
  active?: boolean;
  url?: string;
  pendingUrl?: string;
  title?: string;
  incognito?: boolean;
  discarded?: boolean;
  frozen?: boolean;
  openerTabId?: number;
  lastAccessed?: number;
  status?: "unloaded" | "loading" | "complete";
};

export type ChromeTabChangeInfo = {
  status?: "loading" | "complete" | "unloaded";
  url?: string;
  title?: string;
  discarded?: boolean;
  frozen?: boolean;
  [field: string]: unknown;
};

export type RegisteredContentScript = {
  id: string;
  matches?: string[];
  js?: string[];
  allFrames?: boolean;
  runAt?: "document_start" | "document_end" | "document_idle";
  persistAcrossSessions?: boolean;
};

export type StorageChangeListener = (
  changes: Record<string, { oldValue?: unknown; newValue?: unknown }>,
  areaName: string
) => void;

export type TabUpdatedListener = (tabId: number, changeInfo: ChromeTabChangeInfo) => void;

export type FrameCommittedDetails = {
  tabId: number;
  frameId: number;
  url: string;
};

export type FrameCommittedListener = (details: FrameCommittedDetails) => void;

export type ChromeApi = {
  action?: {
    setBadgeText(details: { text: string }): Promise<void>;
    setBadgeBackgroundColor(details: { color: string }): Promise<void>;
  };
  commands?: {
    onCommand: {
      addListener(callback: (command: string) => void): void;
    };
  };
  debugger?: {
    attach(target: { tabId: number }, version: string): Promise<void>;
    detach(target: { tabId: number }): Promise<void>;
    sendCommand<TResult = unknown>(
      target: { tabId: number; sessionId?: string },
      method: string,
      params?: Record<string, unknown>
    ): Promise<TResult>;
    onEvent: {
      addListener(
        callback: (
          source: { tabId: number; sessionId?: string },
          method: string,
          params: unknown
        ) => void
      ): void;
      removeListener(
        callback: (
          source: { tabId: number; sessionId?: string },
          method: string,
          params: unknown
        ) => void
      ): void;
    };
    onDetach: {
      addListener(callback: (source: { tabId: number }, reason: string) => void): void;
      removeListener(callback: (source: { tabId: number }, reason: string) => void): void;
    };
  };
  downloads?: {
    download(options: { url: string; filename: string; saveAs?: boolean }): Promise<number>;
  };
  i18n?: {
    getUILanguage(): string;
  };
  /** Persisted timers: they fire after the service worker was stopped and restarted. */
  alarms?: {
    create(name: string, alarmInfo: { when: number }): Promise<void> | void;
    clear(name: string): Promise<boolean> | void;
    onAlarm: {
      addListener(callback: (alarm: { name: string }) => void): void;
    };
  };
  offscreen?: {
    createDocument(options: {
      url: string;
      reasons: string[];
      justification: string;
    }): Promise<void>;
    closeDocument(): Promise<void>;
  };
  tabCapture?: {
    getMediaStreamId(options?: { targetTabId?: number; consumerTabId?: number }): Promise<string>;
  };
  runtime?: {
    /** Undefined once the extension context is gone (an orphaned content script). */
    id?: string;
    connect(connectInfo: { name: string }): PortLike;
    getManifest?: () => {
      version?: string;
      permissions?: string[];
      content_scripts?: Array<{ js?: string[] }>;
      host_permissions?: string[];
    };
    getURL(path: string): string;
    getContexts?: (options: {
      contextTypes: string[];
      documentUrls?: string[];
    }) => Promise<unknown[]>;
    onConnect: {
      addListener(callback: (port: PortLike) => void): void;
    };
    onInstalled: {
      addListener(callback: () => void): void;
    };
    onStartup?: {
      addListener(callback: () => void): void;
    };
    onMessage: {
      addListener(
        callback: (
          message: unknown,
          sender: RuntimeMessageSender,
          sendResponse: (response: unknown) => void
        ) => boolean | void
      ): void;
    };
    sendMessage(message: unknown): Promise<unknown>;
  };
  webNavigation?: {
    onCommitted: {
      addListener(callback: FrameCommittedListener): void;
      removeListener(callback: FrameCommittedListener): void;
    };
  };
  webRequest?: {
    onBeforeRequest: {
      addListener(
        callback: (details: {
          requestId: string;
          tabId: number;
          frameId?: number;
          method?: string;
          url: string;
          timeStamp?: number;
        }) => void,
        filter: { urls: string[] }
      ): void;
      removeListener(
        callback: (details: {
          requestId: string;
          tabId: number;
          frameId?: number;
          method?: string;
          url: string;
          timeStamp?: number;
        }) => void
      ): void;
    };
    onCompleted: {
      addListener(
        callback: (details: {
          requestId: string;
          tabId: number;
          frameId?: number;
          method?: string;
          url: string;
          statusCode?: number;
          statusLine?: string;
          timeStamp?: number;
        }) => void,
        filter: { urls: string[] }
      ): void;
      removeListener(
        callback: (details: {
          requestId: string;
          tabId: number;
          frameId?: number;
          method?: string;
          url: string;
          statusCode?: number;
          statusLine?: string;
          timeStamp?: number;
        }) => void
      ): void;
    };
    onErrorOccurred: {
      addListener(
        callback: (details: {
          requestId: string;
          tabId: number;
          frameId?: number;
          method?: string;
          url: string;
          error?: string;
          timeStamp?: number;
        }) => void,
        filter: { urls: string[] }
      ): void;
      removeListener(
        callback: (details: {
          requestId: string;
          tabId: number;
          frameId?: number;
          method?: string;
          url: string;
          error?: string;
          timeStamp?: number;
        }) => void
      ): void;
    };
  };
  scripting?: {
    executeScript(options: {
      target: { tabId: number; allFrames?: boolean; frameIds?: number[] };
      world?: "MAIN" | "ISOLATED";
      files?: string[];
      func?: (...args: never[]) => unknown;
      args?: unknown[];
      injectImmediately?: boolean;
    }): Promise<Array<{ result?: unknown }> | void>;
    registerContentScripts?(scripts: RegisteredContentScript[]): Promise<void>;
    unregisterContentScripts?(filter?: { ids?: string[] }): Promise<void>;
    getRegisteredContentScripts?(filter?: { ids?: string[] }): Promise<RegisteredContentScript[]>;
  };
  storage?: {
    local: {
      get(
        keys?: string[] | string | Record<string, unknown> | null
      ): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove?(keys: string | string[]): Promise<void>;
    };
    /** In-memory area: cleared when the browser exits or the extension reloads. */
    session?: {
      get(keys: string): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      setAccessLevel?(options: { accessLevel: "TRUSTED_CONTEXTS" }): Promise<void>;
    };
    managed?: {
      get(
        keys?: string[] | string | Record<string, unknown> | null
      ): Promise<Record<string, unknown>>;
    };
    onChanged?: {
      addListener(callback: StorageChangeListener): void;
    };
  };
  tabs?: {
    create(createProperties: { url?: string; active?: boolean }): Promise<{
      id?: number;
      active?: boolean;
      url?: string;
      title?: string;
      lastAccessed?: number;
    }>;
    get(tabId: number): Promise<ChromeTab>;
    query(queryInfo: {
      active?: boolean;
      currentWindow?: boolean;
      lastFocusedWindow?: boolean;
    }): Promise<ChromeTab[]>;
    onCreated?: ChromeEvent<(tab: ChromeTab) => void>;
    onUpdated?: ChromeEvent<TabUpdatedListener>;
    onRemoved?: ChromeEvent<(tabId: number) => void>;
    onActivated?: ChromeEvent<(activeInfo: { tabId: number; windowId: number }) => void>;
    reload?(tabId: number, reloadProperties?: { bypassCache?: boolean }): Promise<void>;
    sendMessage(tabId: number, message: unknown): Promise<unknown>;
  };
  windows?: {
    WINDOW_ID_NONE?: number;
    getLastFocused(): Promise<{ id?: number; focused?: boolean }>;
    onFocusChanged: ChromeEvent<(windowId: number) => void>;
  };
};

export function getChromeApi(): ChromeApi | null {
  const chromeApi = (globalThis as { chrome?: ChromeApi }).chrome;
  return chromeApi ?? null;
}
