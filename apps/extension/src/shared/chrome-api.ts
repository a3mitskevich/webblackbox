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

export type TabUpdatedListener = (
  tabId: number,
  changeInfo: {
    status?: "loading" | "complete";
    url?: string;
  }
) => void;

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
    get(tabId: number): Promise<{
      id?: number;
      active?: boolean;
      url?: string;
      title?: string;
      incognito?: boolean;
      lastAccessed?: number;
      status?: "unloaded" | "loading" | "complete";
    }>;
    query(queryInfo: {
      active?: boolean;
      currentWindow?: boolean;
      lastFocusedWindow?: boolean;
    }): Promise<
      Array<{
        id?: number;
        active?: boolean;
        url?: string;
        title?: string;
        lastAccessed?: number;
      }>
    >;
    onUpdated?: {
      addListener(callback: TabUpdatedListener): void;
      removeListener?(callback: TabUpdatedListener): void;
    };
    onRemoved?: {
      addListener(callback: (tabId: number) => void): void;
      removeListener?(callback: (tabId: number) => void): void;
    };
    reload?(tabId: number, reloadProperties?: { bypassCache?: boolean }): Promise<void>;
    sendMessage(tabId: number, message: unknown): Promise<unknown>;
  };
};

export function getChromeApi(): ChromeApi | null {
  const chromeApi = (globalThis as { chrome?: ChromeApi }).chrome;
  return chromeApi ?? null;
}
