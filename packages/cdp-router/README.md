<p align="center">
  <a href="https://github.com/a3mitskevich/webblackbox"><img src="https://raw.githubusercontent.com/a3mitskevich/webblackbox/main/logo.png" alt="WebBlackbox" width="80" /></a>
</p>

<h1 align="center">@webblackbox/cdp-router</h1>

<p align="center">
  Chrome DevTools Protocol routing, target tracking, and debugger management.
</p>

<p align="center">
  <a href="https://github.com/a3mitskevich/webblackbox/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-374151" alt="License" /></a>
  <a href="https://github.com/a3mitskevich/webblackbox"><img src="https://img.shields.io/badge/Part%20of-WebBlackbox-000?logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNiIgaGVpZ2h0PSIxNiI+PHJlY3Qgd2lkdGg9IjE2IiBoZWlnaHQ9IjE2IiByeD0iMyIgZmlsbD0iIzFhMWEyZSIvPjxwYXRoIGQ9Ik0zIDhoMi41bDIuNS00TDEwLjUgMTIgMTMgOCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjZjk3MzE2IiBzdHJva2Utd2lkdGg9IjEuNSIvPjwvc3ZnPg==" alt="WebBlackbox" /></a>
</p>

---

Chrome DevTools Protocol (CDP) routing layer for WebBlackbox. Manages debugger connections, target tracking, and CDP command execution for the Chrome extension.

## Overview

- **CdpRouter** — High-level interface for managing CDP sessions and sending commands
- **DefaultCdpRouter** — Full implementation with multi-target tracking (tabs, iframes, workers)
- **Transport Layer** — Abstraction over Chrome's `chrome.debugger` API
- **Auto-Attach** — Attachment to child targets (iframes, workers, service workers) once `enableAutoAttach()` is called

This fork does not publish the package to npm; use it from the pnpm workspace (`"@webblackbox/cdp-router": "workspace:*"`) or build it with `pnpm --filter @webblackbox/cdp-router build`.

## Usage

### Creating a Router

```typescript
import { createCdpRouter, createChromeDebuggerTransport } from "@webblackbox/cdp-router";

const transport = createChromeDebuggerTransport();
const router = createCdpRouter(transport);
```

### Attaching to a Tab

```typescript
// Attach debugger to tab (protocol version "1.3" by default, or "1.2")
await router.attach(tabId, "1.3");

// Enable baseline CDP domains (Network, Runtime, Log, Page)
await router.enableBaseline(tabId);

// Enable auto-attach for child targets. Options are partial; the defaults are
// { autoAttach: true, waitForDebuggerOnStart: false, flatten: true,
//   filter: iframe, worker and service_worker targets }
await router.enableAutoAttach(tabId);
```

### Sending CDP Commands

```typescript
// Send CDP command to main target
const result = await router.send<ResponseType>({ tabId }, "Network.getResponseBody", {
  requestId: "12345"
});

// Send CDP command to child target (iframe, worker)
const childResult = await router.send<ResponseType>(
  { tabId, sessionId: "child-session-id" },
  "Runtime.evaluate",
  { expression: "document.title" }
);
```

### Receiving Events

A router delivers events and detaches only for the tabs it attached with `attach()`, child sessions
(iframes, workers) of those tabs included. `chrome.debugger.onEvent` is global to the extension, so
events of tabs attached by another router or by other code are ignored. Child-session events arrive
with their root tab's `tabId` and stay with that tab, so each tab's events end up in that tab's
recording. A detach (from `detach()` or reported by Chrome) stops routing for the tab; `onDetach`
fires only for detaches Chrome reports.

```typescript
// Listen for CDP events
const unsubscribe = router.onEvent((event) => {
  console.log(event.tabId);
  console.log(event.sessionId); // undefined for main target
  console.log(event.method); // "Network.requestWillBeSent", etc.
  console.log(event.params); // CDP event parameters
});

// Listen for detach events
const unsubDetach = router.onDetach((info) => {
  console.log(info.tabId);
  console.log(info.reason); // "target_closed", etc.
});
```

### Target Management

The router tracks child targets from `Target.attachedToTarget` / `Target.detachedFromTarget`
events; the tab's own page target is not listed.

```typescript
// Get the attached child targets (iframes, workers) of a tab
const targets = router.getAttachedTargets(tabId);

for (const target of targets) {
  console.log(target.tabId);
  console.log(target.sessionId); // CDP session ID of the child target
  console.log(target.targetId); // Target ID
  console.log(target.targetType); // "iframe", "worker", "service_worker", ...
  console.log(target.url); // Target URL
  // target.frameId is part of the type but the router does not fill it
}
```

### Detaching and Cleanup

```typescript
// Detach from a specific tab
await router.detach(tabId);

// Clean up all connections
router.dispose();
```

## API Reference

### CdpRouter Interface

```typescript
interface CdpRouter {
  attach(tabId: number, protocolVersion?: "1.3" | "1.2"): Promise<void>;
  detach(tabId: number): Promise<void>;
  send<TResult = unknown>(
    target: Debuggee,
    method: string,
    params?: Record<string, unknown>
  ): Promise<TResult>;
  enableBaseline(tabId: number, sessionId?: string): Promise<void>;
  enableAutoAttach(
    tabId: number,
    options?: Partial<AutoAttachOptions>,
    sessionId?: string
  ): Promise<void>;
  getAttachedTargets(tabId: number): RouterAttachedTarget[];
  onEvent(callback: CdpEventHandler): () => void;
  onDetach(callback: CdpDetachHandler): () => void;
  dispose(): void;
}
```

### Types

```typescript
type DebuggerRoot = { tabId: number };
type DebuggerChild = { tabId: number; sessionId: string };
type Debuggee = DebuggerRoot | DebuggerChild;

type RawCdpEvent = {
  tabId: number;
  sessionId?: string;
  method: string;
  params?: unknown;
};

type DetachInfo = {
  tabId: number;
  reason: string;
};

type RouterAttachedTarget = {
  tabId: number;
  sessionId?: string;
  targetId?: string;
  frameId?: string;
  targetType?: string;
  url?: string;
};

type AutoAttachOptions = {
  autoAttach: boolean;
  waitForDebuggerOnStart: boolean;
  flatten: boolean;
  filter?: Array<{ type: string; exclude: boolean }>;
};
```

### Baseline Domains

When `enableBaseline()` is called, the following CDP domains are enabled:

- **Network.enable** — HTTP request/response monitoring
- **Runtime.enable** — JavaScript runtime events (exceptions, console)
- **Log.enable** — Browser log entries
- **Page.enable** — Page lifecycle events (navigation, DOM)

### Transport Interface

```typescript
type DebuggerTransport = {
  attach(debuggee: DebuggerRoot, version: string): Promise<void>;
  detach(debuggee: DebuggerRoot): Promise<void>;
  sendCommand<TResult = unknown>(
    debuggee: Debuggee,
    method: string,
    params?: Record<string, unknown>
  ): Promise<TResult>;
  addEventListener(handler: CdpEventHandler): () => void;
  addDetachListener(handler: CdpDetachHandler): () => void;
};
```

`createChromeDebuggerTransport()` implements it over `chrome.debugger` and throws when
`chrome.debugger` is unavailable.

## License

[MIT](https://github.com/a3mitskevich/webblackbox/blob/main/LICENSE)
