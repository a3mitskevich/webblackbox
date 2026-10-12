// Network scenarios: a WebSocket that drops without reconnecting, a request that never answers,
// a stale HTTP-cache response, and out-of-order search responses.

import { renderPage } from "../site/layout.js";
import type { Scenario } from "../types.js";

const SOCKET_DROP_AFTER_MS = 1_500;
const SOCKET_CLOSE_CODE = 1011;

export const websocketStale: Scenario = {
  id: "websocket-stale",
  caseId: "case-06",
  title: "WebSocket closes and the page never reconnects; the status stays stale",
  pages: {
    "/orders/1042/": renderPage({
      title: "Order #1042",
      body: `<h1>Order #1042</h1>
<p>Status: <strong id="status">Connecting…</strong></p>
<p class="muted">Updates arrive live; no need to refresh.</p>`,
      script: `
const statusLabels = { placed: "Placed", preparing: "Preparing", ready: "Ready for pickup" };
const socket = new WebSocket("ws://" + location.host + "/ws/orders?orderId=1042");
socket.addEventListener("message", (event) => {
  const update = JSON.parse(event.data);
  document.getElementById("status").textContent = statusLabels[update.status] ?? update.status;
});
socket.addEventListener("close", () => {
  console.debug("order updates closed");
});`
    })
  },
  sockets: {
    "/ws/orders": (socket) => {
      socket.sendText(JSON.stringify({ orderId: 1042, status: "preparing" }));
      setTimeout(() => socket.close(SOCKET_CLOSE_CODE, "upstream restart"), SOCKET_DROP_AFTER_MS);
    }
  },
  api: {
    "GET /api/orders/1042": () => ({ status: 200, body: { orderId: 1042, status: "ready" } })
  },
  steps: [
    { kind: "navigate", path: "/orders/1042/" },
    { kind: "wait", ms: 7_000 }
  ],
  symptom: `document.getElementById("status").textContent === "Preparing"`,
  report: {
    ru: "Открыла страницу заказа #1042 и жду — статус всё время «Preparing», хотя на кухне заказ давно готов и в админке он «Ready for pickup». Обновления «вживую» не приходят.",
    en: "I opened order #1042 and waited — the status keeps saying “Preparing”, although the order has long been ready and the admin shows “Ready for pickup”. Live updates never arrive."
  },
  rubric: {
    rootCause:
      "The order-updates WebSocket (/ws/orders) is closed by the server ~1.5 s after the first 'preparing' message (code 1011, upstream restart); the page has no reconnect or polling fallback, so the status stays stale.",
    keyEvidence: [
      "network.ws.open /ws/orders, one frame {status: preparing}",
      "network.ws.close code 1011 'upstream restart'; no reopen afterwards"
    ],
    required: [
      { id: "websocket", description: "Looks at the WebSocket", patterns: [/web ?socket|\bws\b/i] },
      {
        id: "closed",
        description: "Finds that the socket closed/dropped",
        patterns: [
          /\b(was|is|got|gets|been|being) (closed|disconnected|dropped|terminated|lost)/i,
          /\b(closed|disconnected|dropped|terminated) (by|after|about|~|at|with)\b/i,
          /\b(server|backend|socket|connection) (closes|closed|drops|dropped|disconnects|disconnected)/i,
          /\b1011\b|upstream restart/i
        ],
        scope: "rootCause"
      }
    ],
    bonus: [
      {
        id: "no-reconnect",
        description: "Notes the missing reconnect",
        patterns: [/reconnect|re-?open|retry|fallback|polling/i]
      },
      {
        id: "close-code",
        description: "Quotes the close code",
        patterns: [/1011|upstream restart/i]
      }
    ],
    forbidden: [
      {
        id: "server-status",
        description: "Blames the order status data on the server",
        patterns: [/server (still )?(returns|returned|reports) .{0,20}preparing/i]
      }
    ]
  },
  evidence: ["websocket", "dom"]
};

export const endlessSpinner: Scenario = {
  id: "endless-spinner",
  caseId: "case-07",
  title: "Report request never answers; the spinner spins forever",
  pages: {
    "/reports/sales/": renderPage({
      title: "Sales report",
      body: `<h1>Sales report</h1>
<label for="range">Period</label>
<select id="range"><option value="30d">Last 30 days</option><option value="90d">Last 90 days</option></select>
<button id="generate">Generate report</button>
<div id="report" class="muted"></div>`,
      style: `.spinner { display: inline-block; width: 16px; height: 16px; border: 2px solid #c4cad4;
  border-top-color: #2457d6; border-radius: 50%; animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }`,
      script: `
document.getElementById("generate").addEventListener("click", async () => {
  const range = document.getElementById("range").value;
  const report = document.getElementById("report");
  report.innerHTML = '<span class="spinner"></span> Generating…';
  const response = await fetch("/api/reports/sales?range=" + range);
  const data = await response.json();
  report.textContent = "Revenue: €" + data.revenue.toFixed(2);
});`
    })
  },
  api: {
    "GET /api/reports/sales": () => ({ status: 200, hold: true })
  },
  steps: [
    { kind: "navigate", path: "/reports/sales/" },
    { kind: "click", selector: "#generate" },
    { kind: "wait", ms: 8_000 }
  ],
  symptom: `document.querySelector("#report .spinner") !== null`,
  report: {
    ru: "Раздел Sales report: выбираю «Last 30 days», жму «Generate report» — крутится «Generating…» бесконечно, ждала больше минуты. Ошибок на экране нет.",
    en: "Sales report: I pick “Last 30 days” and press “Generate report” — “Generating…” spins forever; I waited over a minute. No error on screen."
  },
  rubric: {
    rootCause:
      "GET /api/reports/sales?range=30d never receives a response (the server holds it open) and the page has no timeout or error handling, so the spinner never stops.",
    keyEvidence: [
      "GET /api/reports/sales?range=30d started after the click, no response/finish event",
      "no exception and no other failing request"
    ],
    required: [
      {
        id: "pending",
        description: "Finds the request that never completes",
        patterns: [
          /pending|never (complet|finish|resolv|respond|return|answer|got)|no response|unanswered|hang|hung|stall|still (open|in flight|loading)|did not (complete|finish|return|receive)|without (a )?response|not (complete|finish|receive)/i
        ]
      },
      {
        id: "endpoint",
        description: "Names the report request",
        patterns: [/\/api\/reports\/sales|reports\/sales/i]
      }
    ],
    bonus: [
      {
        id: "no-timeout",
        description: "Notes the missing timeout/error handling on the client",
        patterns: [/timeout|abort|error handling/i]
      }
    ],
    forbidden: [
      {
        id: "error-status",
        description: "Claims the request failed with an error status",
        patterns: [/(returned|responded with|failed with) (an? )?(4\d\d|5\d\d)/i]
      }
    ]
  },
  evidence: ["network-pending", "click-target"]
};

export const staleCache: Scenario = {
  id: "stale-cache",
  caseId: "case-10",
  title: "The re-read cart comes from the HTTP cache and shows the old quantity",
  pages: {
    "/cart/": renderPage({
      title: "Cart",
      body: `<h1>Cart</h1>
<div class="row"><span>Coffee beans 500 g</span>
  <button id="dec" aria-label="Decrease">−</button><strong id="qty">…</strong>
  <button id="inc" aria-label="Increase">+</button></div>
<p>Total: <strong id="total">…</strong></p>`,
      style: `.row button { margin-top: 0; padding: 4px 12px; }`,
      script: `
let cart = null;
async function loadCart() {
  const response = await fetch("/api/cart");
  cart = await response.json();
  document.getElementById("qty").textContent = String(cart.items[0].qty);
  document.getElementById("total").textContent = "€" + cart.total.toFixed(2);
}
async function changeQty(delta) {
  const qty = Math.max(1, cart.items[0].qty + delta);
  await fetch("/api/cart/items/1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ qty })
  });
  await loadCart();
}
document.getElementById("inc").addEventListener("click", () => changeQty(1));
document.getElementById("dec").addEventListener("click", () => changeQty(-1));
loadCart();`
    })
  },
  api: {
    "GET /api/cart": (_request, state) => {
      const qty = Number(state.get("qty") ?? 1);
      return {
        status: 200,
        headers: { "cache-control": "private, max-age=600" },
        body: {
          items: [{ id: 1, name: "Coffee beans 500 g", qty, price: 12.5 }],
          total: qty * 12.5
        }
      };
    },
    "PATCH /api/cart/items/1": (request, state) => {
      const qty = Number((JSON.parse(request.body || "{}") as { qty?: unknown }).qty ?? 1);
      state.set("qty", qty);
      return { status: 200, body: { ok: true, item: { id: 1, qty } } };
    }
  },
  steps: [
    { kind: "navigate", path: "/cart/" },
    {
      kind: "waitFor",
      expression: `document.getElementById("qty").textContent === "1"`,
      timeoutMs: 5_000
    },
    { kind: "click", selector: "#inc" },
    { kind: "wait", ms: 1_500 },
    { kind: "click", selector: "#inc" },
    { kind: "wait", ms: 1_500 }
  ],
  symptom: `document.getElementById("qty").textContent === "1"`,
  report: {
    ru: "В корзине жму «+» у кофе — количество остаётся 1 и сумма €12.50. Нажала ещё раз — то же самое. А в оформленном потом заказе почему-то 3 пачки.",
    en: "In the cart I press “+” next to the coffee — the quantity stays at 1 and the total at €12.50. Pressed again — same. Yet the order I placed later had 3 packs."
  },
  rubric: {
    rootCause:
      "GET /api/cart is served with Cache-Control: private, max-age=600; after each successful PATCH /api/cart/items/1 the page re-reads the cart, but the browser answers from its HTTP cache, so the old quantity (1) is shown while the server has 2, then 3.",
    keyEvidence: [
      "PATCH /api/cart/items/1 → 200 with qty 2 / 3",
      "the following GET /api/cart is served from the cache (no network, same body qty 1); response header max-age=600"
    ],
    required: [
      { id: "cache", description: "Identifies caching as the cause", patterns: [/cach/i] },
      { id: "endpoint", description: "Names the cart request", patterns: [/\/api\/cart\b/i] }
    ],
    bonus: [
      {
        id: "cache-header",
        description: "Points at the Cache-Control/max-age header",
        patterns: [/max-age|cache-control/i]
      },
      {
        id: "patch-ok",
        description: "Notes the update itself succeeded",
        patterns: [/PATCH[\s\S]{0,80}(200|succe|ok)/i]
      }
    ],
    forbidden: [
      {
        id: "patch-failed",
        description: "Claims the update request failed",
        patterns: [/PATCH[\s\S]{0,40}(failed|returned (an? )?(error|4\d\d|5\d\d))/i]
      }
    ]
  },
  evidence: ["network-cache", "network-response-body", "network-request-body"]
};

const SLOW_QUERY = "lap";
const SLOW_QUERY_DELAY_MS = 1_800;
const FAST_QUERY_DELAY_MS = 150;
const SEARCH_INDEX = [
  "Lap desk with cushion",
  "Lapel pin set",
  'Laptop 14" UltraBook',
  'Laptop sleeve 13"',
  "Laptop stand aluminium"
];

export const searchRace: Scenario = {
  id: "search-race",
  caseId: "case-13",
  title: "Out-of-order search responses: the slower, older query overwrites the newer results",
  pages: {
    "/search/": renderPage({
      title: "Search",
      body: `<h1>Search</h1>
<label for="q">Find products</label><input id="q" autocomplete="off" placeholder="Start typing…">
<ul id="results"></ul>`,
      script: `
let timer = null;
document.getElementById("q").addEventListener("input", (event) => {
  clearTimeout(timer);
  const query = event.target.value.trim();
  timer = setTimeout(async () => {
    const response = await fetch("/api/search?q=" + encodeURIComponent(query));
    const data = await response.json();
    document.getElementById("results").innerHTML = data.results
      .map((name) => "<li>" + name.replace(/</g, "&lt;") + "</li>")
      .join("");
  }, 200);
});`
    })
  },
  api: {
    "GET /api/search": (request) => {
      const query = (request.url.searchParams.get("q") ?? "").toLowerCase();
      return {
        status: 200,
        delayMs: query === SLOW_QUERY ? SLOW_QUERY_DELAY_MS : FAST_QUERY_DELAY_MS,
        body: {
          query,
          results: SEARCH_INDEX.filter((name) => name.toLowerCase().includes(query))
        }
      };
    }
  },
  steps: [
    { kind: "navigate", path: "/search/" },
    { kind: "type", selector: "#q", text: "lap" },
    { kind: "wait", ms: 450 },
    { kind: "type", selector: "#q", text: "top" },
    { kind: "wait", ms: 3_500 }
  ],
  symptom: `document.getElementById("q").value === "laptop" && document.getElementById("results").textContent.includes("Lapel pin")`,
  report: {
    ru: "В поиске набираю «laptop» — в выдаче «Lap desk» и «Lapel pin», ноутбуков нет. Иногда на долю секунды мелькают ноутбуки, а потом список меняется.",
    en: "I type “laptop” into search — the results show “Lap desk” and “Lapel pin”, no laptops. Sometimes the laptops flash for a split second and then the list changes."
  },
  rubric: {
    rootCause:
      "Two searches race: GET /api/search?q=lap (sent first, ~1.8 s) answers after GET /api/search?q=laptop (~0.15 s), and the page renders whichever response arrives last without checking it matches the current query, so the stale 'lap' results overwrite the 'laptop' ones.",
    keyEvidence: [
      "GET /api/search?q=lap starts first and finishes last (~1.8 s)",
      "GET /api/search?q=laptop finishes first (~0.15 s)"
    ],
    required: [
      {
        id: "race",
        description: "Identifies out-of-order responses / race",
        patterns: [
          /race|out[- ]of[- ]order|arriv\w* (after|later|last)|(finish|complet|return|respond)\w* (after|later|last)|overwr|stale (response|result)|slower|older (request|response|query)/i
        ]
      },
      {
        id: "queries",
        description: "Names the two queries",
        patterns: [/q=lap\b|["'“«`]lap["'”»`]|\blap\b[\s\S]{0,60}\blaptop\b/i]
      }
    ],
    bonus: [
      {
        id: "fix",
        description: "Suggests ignoring stale responses (abort/sequence check)",
        patterns: [/abort|cancel|sequence|latest (request|query)|ignore (stale|older)/i]
      }
    ],
    forbidden: [
      {
        id: "search-backend",
        description: "Blames the search index returning wrong items for 'laptop'",
        patterns: [/(search|api|backend) returns? (wrong|incorrect) results for .{0,5}laptop/i]
      }
    ]
  },
  evidence: ["network-timing", "network-response-body", "user-input"]
};
