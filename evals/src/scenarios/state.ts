// Client-state scenarios: an expired token kept in localStorage that sends the user around a
// redirect loop, and a leftover feature-flag override that disables checkout.

import { renderPage } from "../site/layout.js";
import type { Scenario } from "../types.js";

/** A JWT-shaped token that expired on 2026-09-01 (`exp` 1788220800). */
const EXPIRED_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
  Buffer.from(JSON.stringify({ sub: "u-311", exp: 1788220800 })).toString("base64url") +
  ".c2lnbmF0dXJl";
const MAX_REDIRECT_ATTEMPTS = 5;

export const authRedirectLoop: Scenario = {
  id: "auth-redirect-loop",
  caseId: "case-08",
  title: "An expired token in localStorage causes an account ↔ login redirect loop",
  pages: {
    "/account/": renderPage({
      title: "My account",
      body: `<h1>My account</h1><p id="greeting" class="muted">Loading…</p>`,
      script: `
const token = localStorage.getItem("authToken");
if (!token) {
  location.replace("/login/?next=/account/");
} else {
  fetch("/api/me", { headers: { authorization: "Bearer " + token } }).then(async (response) => {
    if (response.status === 401) {
      location.replace("/login/?next=/account/");
      return;
    }
    const me = await response.json();
    document.getElementById("greeting").textContent = "Hello, " + me.name;
  });
}`
    }),
    "/login/": renderPage({
      title: "Sign in",
      body: `<h1>Sign in</h1><p id="login-state" class="muted">Signing you in…</p>`,
      script: `
const next = new URLSearchParams(location.search).get("next") || "/";
const attempts = Number(sessionStorage.getItem("redirectAttempts") || 0);
if (localStorage.getItem("authToken") && attempts < ${MAX_REDIRECT_ATTEMPTS}) {
  sessionStorage.setItem("redirectAttempts", String(attempts + 1));
  location.replace(next);
}`
    })
  },
  api: {
    "GET /api/me": (request) => {
      const authorization = String(request.headers.authorization ?? "");
      return authorization === `Bearer ${EXPIRED_TOKEN}` || authorization === ""
        ? { status: 401, body: { error: "token_expired", message: "Access token expired" } }
        : { status: 401, body: { error: "invalid_token" } };
    }
  },
  setup: [
    { kind: "navigate", path: "/" },
    {
      kind: "evaluate",
      expression: `localStorage.setItem("authToken", ${JSON.stringify(EXPIRED_TOKEN)})`
    }
  ],
  steps: [
    { kind: "navigate", path: "/account/" },
    {
      kind: "waitFor",
      expression: `sessionStorage.getItem("redirectAttempts") === "${MAX_REDIRECT_ATTEMPTS}" && location.pathname === "/login/"`,
      timeoutMs: 15_000
    },
    { kind: "wait", ms: 2_000 }
  ],
  symptom: `location.pathname === "/login/" && document.getElementById("login-state") !== null`,
  report: {
    ru: "Захожу в «Account» — страница несколько раз дёргается между «My account» и «Sign in» и в итоге висит «Signing you in…». Формы входа нет, войти заново не могу. Вчера всё работало.",
    en: "I open “Account” — the page jumps back and forth between “My account” and “Sign in” several times and ends up stuck on “Signing you in…”. There is no login form, I cannot sign in again. It worked yesterday."
  },
  rubric: {
    rootCause:
      "localStorage keeps an expired authToken: /account/ sends it to GET /api/me, gets 401 token_expired and redirects to /login/; the login page only checks that a token exists, treats the user as signed in and redirects back — a redirect loop (stopped after 5 attempts on 'Signing you in…'). The expired token is never cleared.",
    keyEvidence: [
      "repeated navigations /account/ → /login/?next=/account/ → /account/",
      "GET /api/me → 401 {error: token_expired} each round",
      "localStorage authToken present (exp in the past)"
    ],
    required: [
      {
        id: "status-401",
        description: "Finds the 401 answers",
        patterns: [/\b401\b|unauthori[sz]ed/i]
      },
      {
        id: "loop",
        description: "Identifies the redirect loop",
        patterns: [/loop|ping-?pong|back and forth|bounc|cycl|repeated(ly)? redirect/i]
      },
      {
        id: "token",
        description: "Blames the expired/stale token",
        patterns: [/expired|token_expired|stale token|(auth)?token/i]
      }
    ],
    bonus: [
      {
        id: "storage",
        description: "Locates the token in localStorage",
        patterns: [/local ?storage/i]
      },
      {
        id: "login-check",
        description: "Explains the login page only checks token presence",
        patterns: [/(only|just) checks?|presence|exists?|without (validat|check)/i]
      }
    ],
    forbidden: [
      {
        id: "server-down",
        description: "Blames a server outage",
        patterns: [/\b5\d\d\b|server (is )?down|outage/i]
      }
    ]
  },
  evidence: ["navigation", "network-status", "storage-value", "network-response-body"]
};

export const featureFlagStorage: Scenario = {
  id: "feature-flag-storage",
  caseId: "case-11",
  title: "A leftover localStorage flag override disables checkout",
  pages: {
    "/checkout/review/": renderPage({
      title: "Review order",
      body: `<h1>Review order</h1>
<p>Espresso beans 1 kg × 1 — €24.00</p>
<button id="checkout" disabled>Loading…</button>
<p id="note" class="muted"></p>`,
      script: `
async function loadFlags() {
  const response = await fetch("/api/flags");
  const remote = await response.json();
  const overrides = JSON.parse(localStorage.getItem("flagOverrides") || "{}");
  return { ...remote, ...overrides };
}
loadFlags().then((flags) => {
  const button = document.getElementById("checkout");
  if (flags.newCheckout) {
    button.disabled = false;
    button.textContent = "Place order";
  } else {
    button.disabled = true;
    button.textContent = "Checkout temporarily unavailable";
    document.getElementById("note").textContent = "Please try again later.";
  }
});`
    })
  },
  api: {
    "GET /api/flags": () => ({
      status: 200,
      body: { newCheckout: true, recommendations: true, darkMode: false }
    })
  },
  setup: [
    { kind: "navigate", path: "/" },
    {
      kind: "evaluate",
      expression: `localStorage.setItem("flagOverrides", JSON.stringify({ newCheckout: false, darkMode: true }))`
    }
  ],
  steps: [
    { kind: "navigate", path: "/checkout/review/" },
    {
      kind: "waitFor",
      expression: `document.getElementById("checkout").textContent !== "Loading…"`,
      timeoutMs: 5_000
    },
    { kind: "click", selector: "#checkout" },
    { kind: "wait", ms: 1_000 },
    { kind: "click", selector: "#checkout" },
    { kind: "wait", ms: 1_500 }
  ],
  symptom: `document.getElementById("checkout").disabled === true`,
  report: {
    ru: "На шаге Review order кнопка серая и пишет «Checkout temporarily unavailable» — уже второй день. У других тестировщиков на тех же данных кнопка «Place order» работает, у меня нет.",
    en: "On the Review order step the button is grey and says “Checkout temporarily unavailable” — for the second day now. Other testers with the same data get a working “Place order” button, I do not."
  },
  rubric: {
    rootCause:
      "GET /api/flags enables newCheckout, but the page merges localStorage flagOverrides ({newCheckout: false}, left from an earlier experiment) over it, so checkout is disabled only in this browser.",
    keyEvidence: [
      "GET /api/flags → {newCheckout: true}",
      "localStorage flagOverrides = {newCheckout: false, darkMode: true}",
      "button#checkout disabled with 'Checkout temporarily unavailable'"
    ],
    required: [
      {
        id: "override",
        description: "Finds the local override",
        patterns: [/local ?storage|flagOverrides|override/i]
      },
      {
        id: "flag",
        description: "Names the flag",
        patterns: [/newCheckout|feature[- ]?flag|flag/i]
      }
    ],
    bonus: [
      {
        id: "server-true",
        description: "Notes the server flag is on",
        patterns: [/newCheckout"?:? ?true|\/api\/flags[\s\S]{0,60}true/i]
      }
    ],
    forbidden: [
      {
        id: "server-disabled",
        description: "Claims the server turned checkout off",
        patterns: [/(server|api|backend) (disabled|turned off|returns? (newCheckout:? ?)?false)/i]
      }
    ]
  },
  evidence: ["storage-value", "network-response-body", "dom"]
};
