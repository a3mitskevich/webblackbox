// Form scenarios: a submit blocked by silent client validation, a server error whose toast is
// hidden by CSS, and a request body the API rejects.

import { renderPage } from "../site/layout.js";
import type { Scenario } from "../types.js";

export const silentValidation: Scenario = {
  id: "silent-validation",
  caseId: "case-01",
  title: "Silent client validation blocks the submit",
  pages: {
    "/signup/": renderPage({
      title: "Create account",
      body: `<h1>Create account</h1>
<form id="signup" novalidate>
  <label for="name">Full name</label><input id="name" name="name" autocomplete="off">
  <label for="email">Email</label><input id="email" name="email" autocomplete="off">
  <label for="password">Password</label><input id="password" name="password" type="password">
  <button id="create" type="submit">Create account</button>
</form>
<p id="result" class="muted"></p>`,
      style: `.field-error { }`,
      script: `
const EMAIL_PATTERN = /^[a-z0-9._-]+@[a-z0-9.-]+\\.[a-z]{2,}$/i;
const form = document.getElementById("signup");
form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = form.email.value.trim();
  if (!EMAIL_PATTERN.test(email)) {
    form.email.setAttribute("aria-invalid", "true");
    form.email.classList.add("field-error");
    return;
  }
  form.email.removeAttribute("aria-invalid");
  const response = await fetch("/api/signup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: form.name.value, email, password: form.password.value })
  });
  document.getElementById("result").textContent = response.ok ? "Welcome aboard!" : "Sign-up failed";
});`
    })
  },
  api: {
    "POST /api/signup": () => ({ status: 201, body: { id: "u-311", status: "created" } })
  },
  steps: [
    { kind: "navigate", path: "/signup/" },
    { kind: "type", selector: "#name", text: "Anna Petrova" },
    { kind: "type", selector: "#email", text: "anna.qa+signup@example.com" },
    { kind: "type", selector: "#password", text: "Spring-2026!" },
    { kind: "click", selector: "#create" },
    { kind: "wait", ms: 1_500 },
    { kind: "click", selector: "#create" },
    { kind: "wait", ms: 2_000 }
  ],
  symptom: `document.getElementById("result").textContent === "" && document.getElementById("email").getAttribute("aria-invalid") === "true"`,
  report: {
    ru: "На странице регистрации заполняю имя, почту anna.qa+signup@example.com и пароль, жму «Create account» — ничего не происходит. Ни ошибки, ни перехода, нажимала несколько раз.",
    en: "On the sign-up page I fill in the name, the email anna.qa+signup@example.com and a password, then press “Create account” — nothing happens. No error, no redirect; I pressed it several times."
  },
  rubric: {
    rootCause:
      "The client-side email pattern rejects the '+' in the address; the submit handler marks the field aria-invalid without any visible message and returns, so no request is sent.",
    keyEvidence: [
      "clicks on #create with no following POST /api/signup",
      "email input value contains '+', field gets aria-invalid=true / class field-error"
    ],
    required: [
      {
        id: "client-validation",
        description: "Names client-side validation (pattern/format check) as the blocker",
        patterns: [/valid/i, /regex|pattern|format check/i]
      },
      {
        id: "email-field",
        description: "Points at the email field",
        patterns: [/e-?mail/i]
      }
    ],
    bonus: [
      {
        id: "plus-sign",
        description: "Notices the '+' in the address",
        patterns: [/plus|"\+"|'\+'|`\+`|\+ ?sign|\+signup/i]
      },
      {
        id: "no-request",
        description: "States that no request reached the server",
        patterns: [
          /no (network |http |api |post |xhr |fetch )?(request|call)s?\b/i,
          /(never|not|wasn't|was not) (sent|made|fired|issued|reach)/i
        ]
      }
    ],
    forbidden: [
      {
        id: "server-error",
        description: "Blames a server/API error",
        patterns: [
          /(server|backend|api) (returned|responded with|failed with) (an? )?(error|4\d\d|5\d\d)/i
        ]
      }
    ]
  },
  evidence: ["click-target", "user-input", "dom", "network-status"]
};

export const hiddenErrorToast: Scenario = {
  id: "hidden-error-toast",
  caseId: "case-02",
  title: "500 on save; the error toast is hidden by CSS",
  pages: {
    "/account/profile/": renderPage({
      title: "Profile",
      body: `<h1>Profile</h1>
<label for="display-name">Display name</label><input id="display-name" value="Anna">
<label for="phone">Phone</label><input id="phone" value="+48 600 100 200">
<button id="save">Save changes</button>
<div id="toast" class="toast" role="status"></div>`,
      style: `.toast { position: fixed; right: 24px; bottom: 24px; padding: 12px 16px; border-radius: 6px;
  background: #1d2433; color: #fff; }
.toast:empty { display: none; }
.toast--error { background: #c62828; visibility: hidden; }`,
      script: `
const toast = document.getElementById("toast");
const showToast = (text, kind) => {
  toast.className = "toast toast--" + kind;
  toast.textContent = text;
};
document.getElementById("save").addEventListener("click", async () => {
  const button = document.getElementById("save");
  button.disabled = true;
  try {
    const response = await fetch("/api/profile", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        displayName: document.getElementById("display-name").value,
        phone: document.getElementById("phone").value
      })
    });
    if (response.ok) {
      showToast("Profile saved", "success");
    } else {
      showToast("Could not save your profile. Please try again later.", "error");
    }
  } finally {
    button.disabled = false;
  }
});`
    })
  },
  api: {
    "PUT /api/profile": () => ({
      status: 500,
      body: { error: "profile_store_unavailable", requestId: "req-8812" }
    })
  },
  steps: [
    { kind: "navigate", path: "/account/profile/" },
    { kind: "evaluate", expression: `document.getElementById("display-name").select()` },
    { kind: "type", selector: "#display-name", text: "Anna Petrova" },
    { kind: "click", selector: "#save" },
    { kind: "wait", ms: 2_500 }
  ],
  symptom: `getComputedStyle(document.getElementById("toast")).visibility === "hidden" && document.getElementById("toast").textContent.length > 0`,
  report: {
    ru: "В профиле меняю отображаемое имя на «Anna Petrova» и жму «Save changes». Кнопка на секунду моргает, ничего не пишет, а после обновления страницы имя старое.",
    en: "In my profile I change the display name to “Anna Petrova” and press “Save changes”. The button blinks for a second, no message appears, and after a reload the old name is back."
  },
  rubric: {
    rootCause:
      "PUT /api/profile fails with 500 {error: profile_store_unavailable}; the page shows an error toast, but the .toast--error CSS rule sets visibility: hidden, so the user sees nothing.",
    keyEvidence: [
      "PUT /api/profile → 500, body error profile_store_unavailable",
      "toast element gets class toast--error, hidden by visibility: hidden"
    ],
    required: [
      { id: "status-500", description: "Finds the 500 response", patterns: [/\b500\b/] },
      {
        id: "endpoint",
        description: "Names the profile save request",
        patterns: [/\/api\/profile/i]
      }
    ],
    bonus: [
      {
        id: "hidden-toast",
        description: "Explains why no error was visible (toast hidden)",
        patterns: [/toast|notification/i]
      },
      {
        id: "error-code",
        description: "Quotes the server error",
        patterns: [/profile_store_unavailable/i]
      }
    ],
    forbidden: [
      {
        id: "no-request",
        description: "Claims no request was sent",
        patterns: [/no (network )?request (was|is) (sent|made)/i]
      }
    ]
  },
  evidence: ["network-status", "network-response-body", "dom"]
};

export const wrongRequestBody: Scenario = {
  id: "wrong-request-body",
  caseId: "case-05",
  title: "Request body uses the wrong field name; the API answers 400",
  pages: {
    "/checkout/address/": renderPage({
      title: "Delivery address",
      body: `<h1>Delivery address</h1>
<label for="street">Street</label><input id="street" autocomplete="off">
<label for="city">City</label><input id="city" autocomplete="off">
<label for="zip">Postal code</label><input id="zip" autocomplete="off">
<button id="continue">Continue to payment</button>
<p id="message" class="muted"></p>`,
      script: `
document.getElementById("continue").addEventListener("click", async () => {
  const address = {
    street: document.getElementById("street").value,
    city: document.getElementById("city").value,
    zipcode: document.getElementById("zip").value
  };
  const response = await fetch("/api/checkout/address", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(address)
  });
  document.getElementById("message").textContent = response.ok
    ? "Address saved"
    : "Something went wrong. Please try again.";
});`
    })
  },
  api: {
    "POST /api/checkout/address": (request) => {
      const parsed = safeJson(request.body);
      const hasPostalCode = typeof parsed?.postalCode === "string" && parsed.postalCode !== "";

      return hasPostalCode
        ? { status: 200, body: { ok: true } }
        : {
            status: 400,
            body: {
              error: "validation_failed",
              details: [{ field: "postalCode", message: "is required" }]
            }
          };
    }
  },
  steps: [
    { kind: "navigate", path: "/checkout/address/" },
    { kind: "type", selector: "#street", text: "Marszałkowska 10" },
    { kind: "type", selector: "#city", text: "Warszawa" },
    { kind: "type", selector: "#zip", text: "00-590" },
    { kind: "click", selector: "#continue" },
    { kind: "wait", ms: 2_000 }
  ],
  symptom: `document.getElementById("message").textContent.startsWith("Something went wrong")`,
  report: {
    ru: "На шаге адреса доставки заполняю улицу, город и индекс 00-590, жму «Continue to payment» — пишет «Something went wrong. Please try again.» Повтор не помогает, все поля заполнены.",
    en: "On the delivery address step I fill in the street, city and postal code 00-590, press “Continue to payment” and get “Something went wrong. Please try again.” Retrying does not help; every field is filled in."
  },
  rubric: {
    rootCause:
      "The page posts the postal code as `zipcode`, but the API expects `postalCode`; POST /api/checkout/address answers 400 validation_failed (postalCode is required).",
    keyEvidence: [
      "POST /api/checkout/address → 400",
      "request body has zipcode, response details: postalCode is required"
    ],
    required: [
      { id: "status-400", description: "Finds the 400 response", patterns: [/\b400\b/] },
      {
        id: "field-name",
        description: "Identifies the postal code field mismatch",
        patterns: [/postal_?code|zip_?code/i]
      }
    ],
    bonus: [
      {
        id: "mismatch",
        description: "States the field name is wrong (zipcode vs postalCode)",
        patterns: [/zipcode[\s\S]{0,80}postalCode|postalCode[\s\S]{0,80}zipcode/i]
      }
    ],
    forbidden: [
      {
        id: "server-outage",
        description: "Blames a server crash/outage",
        patterns: [/\b(500|server (crash|outage|down))\b/i]
      }
    ]
  },
  evidence: ["network-status", "network-request-body", "network-response-body"]
};

function safeJson(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
