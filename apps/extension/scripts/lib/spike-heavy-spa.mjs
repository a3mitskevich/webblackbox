// Spike (task 56): a heavy single-page app for the rrweb measurements. Big DOM (a table of a few
// thousand rows), a mutation storm (a ticker rewriting cells every 100 ms), client-side routes,
// CSS-in-JS (rules inserted through CSSOM and an adopted stylesheet, which only page-world hooks
// see), a stylesheet from another origin (not readable without CORS, so rrweb cannot inline it),
// images, and planted secrets for the masking checks. `window.__heavy` exposes the click targets.

import { createServer } from "node:http";

export const HEAVY_PAGE_PATH = "/heavy/";
export const HEAVY_ROWS = 2_500;
export const HEAVY_SECRETS = {
  blockedText: "SECRET-BOX-TEXT-42",
  sensitiveText: "SENSITIVE-TEXT-77",
  card: "4111111111111111",
  password: "hunter2-SPIKE-PW",
  email: "alice.spike@example.test",
  name: "Alice Spikeperson",
  typed: "TYPED-NOTE-SPIKE-9"
};

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);
const LOGO_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="24"><rect width="96" height="24" rx="4" fill="#3a7"/></svg>';

const APP_CSS = `
body { font: 14px/1.4 system-ui, sans-serif; margin: 0; color: #222; }
header { display: flex; gap: 8px; padding: 8px; background: #263238 url(/heavy/img/bg.png); }
header button { padding: 6px 10px; }
main { display: grid; grid-template-columns: 1fr 320px; gap: 8px; padding: 8px; }
table { border-collapse: collapse; width: 100%; }
td { border: 1px solid #ddd; padding: 2px 6px; }
tr.selected td { background: #fff3c4; }
#ticker span { display: inline-block; width: 64px; font-family: monospace; }
`;
const THEME_CSS = `.theme-card { border: 2px solid #5c6bc0; border-radius: 6px; padding: 8px; }`;

function buildPage(themeOrigin) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Heavy SPA (spike)</title>
<link rel="stylesheet" href="/heavy/app.css">
<link rel="stylesheet" href="${themeOrigin}/heavy/theme.css">
</head>
<body>
<header>
  <img id="logo" src="/heavy/img/logo.svg" alt="logo" width="96" height="24">
  <button id="nav-0">Orders</button><button id="nav-1">Customers</button><button id="nav-2">Reports</button>
</header>
<main>
  <section><h1 id="title">Orders</h1><table><tbody id="rows"></tbody></table></section>
  <aside>
    <div class="theme-card adopted" id="detail">Select a row</div>
    <form id="profile">
      <input id="name" name="name" value="${HEAVY_SECRETS.name}">
      <input id="email" name="email" type="email" value="${HEAVY_SECRETS.email}">
      <input id="password" name="password" type="password" value="${HEAVY_SECRETS.password}">
      <input id="card" name="card" autocomplete="cc-number" value="${HEAVY_SECRETS.card}">
      <textarea id="notes" name="notes"></textarea>
    </form>
    <div class="secret" id="secret-box">${HEAVY_SECRETS.blockedText}</div>
    <div data-sensitive id="sensitive-box">${HEAVY_SECRETS.sensitiveText}</div>
    <p id="pii">Contact ${HEAVY_SECRETS.email}</p>
    <div id="ticker"></div>
  </aside>
</main>
<script>
(() => {
  const ROWS = ${HEAVY_ROWS};
  const routes = ["Orders", "Customers", "Reports"];
  const dynamic = document.createElement("style");
  document.head.appendChild(dynamic);
  let ruleIndex = 0;
  const adopted = new CSSStyleSheet();
  adopted.replaceSync(".adopted { outline: 3px solid #e91e63; }");
  document.adoptedStyleSheets = [adopted];

  function cssInJs(color) {
    // What styled-components / emotion do in production: rules through CSSOM, no text nodes.
    const name = "dyn-" + (ruleIndex += 1);
    dynamic.sheet.insertRule("." + name + " { color: " + color + "; font-weight: 600; }", dynamic.sheet.cssRules.length);
    return name;
  }

  function render(route) {
    document.getElementById("title").textContent = routes[route];
    document.getElementById("title").className = cssInJs(["#c62828", "#2e7d32", "#1565c0"][route]);
    const body = document.getElementById("rows");
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < ROWS; index += 1) {
      const row = document.createElement("tr");
      row.id = "row-" + index;
      row.innerHTML = "<td>" + routes[route] + " #" + index + "</td><td>" + ((index * 37) % 1000) +
        "</td><td>" + (index % 7 === 0 ? "late" : "ok") + "</td><td><button class=\\"act\\" id=\\"act-" + index +
        "\\">Open</button></td>";
      fragment.appendChild(row);
    }
    body.replaceChildren(fragment);
  }

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.id.startsWith("nav-")) {
      const route = Number(target.id.slice(4));
      history.pushState({ route }, "", "/heavy/" + routes[route].toLowerCase());
      render(route);
      return;
    }
    if (target.classList.contains("act")) {
      const row = target.closest("tr");
      row.classList.toggle("selected");
      document.getElementById("detail").textContent = "Detail of " + row.firstChild.textContent;
    }
  });

  const ticker = document.getElementById("ticker");
  for (let index = 0; index < 120; index += 1) {
    ticker.appendChild(document.createElement("span"));
  }
  setInterval(() => {
    for (const cell of ticker.children) {
      cell.textContent = (Math.random() * 1000).toFixed(2);
    }
  }, 100);

  render(0);
  window.__heavy = {
    rows: ROWS,
    clickTargets: () => ["nav-1", "act-3", "act-12", "nav-2", "act-40", "nav-0", "act-7", "act-1"]
  };
})();
</script>
</body>
</html>`;
}

function send(response, status, type, body) {
  response.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  response.end(body);
}

/** Serves the heavy SPA on 127.0.0.1; its theme stylesheet comes from the `localhost` name. */
export async function startHeavySpa({ port = 0 } = {}) {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;
    const themeOrigin = `http://localhost:${request.socket.localPort}`;

    if (path === "/heavy/app.css") {
      return send(response, 200, "text/css", APP_CSS);
    }

    if (path === "/heavy/theme.css") {
      return send(response, 200, "text/css", THEME_CSS);
    }

    if (path === "/heavy/img/logo.svg") {
      return send(response, 200, "image/svg+xml", LOGO_SVG);
    }

    if (path === "/heavy/img/bg.png") {
      return send(response, 200, "image/png", PNG_BYTES);
    }

    if (path.startsWith("/heavy")) {
      return send(response, 200, "text/html; charset=utf-8", buildPage(themeOrigin));
    }

    return send(response, 404, "text/plain", "not found");
  });

  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  return {
    origin,
    pageUrl: `${origin}${HEAVY_PAGE_PATH}`,
    server,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  };
}
