// Interaction scenarios: an exception in a click handler, a button covered by another element,
// an exception inside an iframe, and a slow request the user submits twice.

import { renderPage } from "../site/layout.js";
import type { Scenario } from "../types.js";

const PRODUCT_SCRIPT = `
let product = null;

async function loadProduct() {
  const response = await fetch("/api/products/42");
  product = await response.json();
  document.getElementById("name").textContent = product.name;
  document.getElementById("price").textContent = "€" + product.basePrice.toFixed(2);
}

function addToCart() {
  const variant = product.variants[0];
  const line = { productId: product.id, sku: variant.sku, price: variant.price, qty: 1 };
  const cart = JSON.parse(sessionStorage.getItem("cart") || "[]");
  sessionStorage.setItem("cart", JSON.stringify([...cart, line]));
  document.getElementById("cart-count").textContent = String(cart.length + 1);
}

document.getElementById("add").addEventListener("click", addToCart);
loadProduct();
`;

export const clickHandlerException: Scenario = {
  id: "click-handler-exception",
  caseId: "case-03",
  title: "Exception in the click handler",
  pages: {
    "/catalog/trail-backpack/": renderPage({
      title: "Trail Backpack",
      body: `<h1 id="name">…</h1><p class="muted">Lightweight 28 L backpack.</p>
<p>Price: <strong id="price">…</strong></p>
<button id="add">Add to cart</button>
<p>Cart: <span id="cart-count">0</span> items</p>`,
      scriptSrc: ["/static/js/product-page.js"]
    })
  },
  scripts: { "/static/js/product-page.js": PRODUCT_SCRIPT },
  api: {
    "GET /api/products/42": () => ({
      status: 200,
      body: { id: 42, name: "Trail Backpack", basePrice: 89.9, variants: [] }
    })
  },
  steps: [
    { kind: "navigate", path: "/catalog/trail-backpack/" },
    {
      kind: "waitFor",
      expression: `document.getElementById("price").textContent !== "…"`,
      timeoutMs: 5_000
    },
    { kind: "click", selector: "#add" },
    { kind: "wait", ms: 1_000 },
    { kind: "click", selector: "#add" },
    { kind: "wait", ms: 1_500 }
  ],
  symptom: `document.getElementById("cart-count").textContent === "0"`,
  report: {
    ru: "Открываю карточку Trail Backpack, жму «Add to cart» — счётчик корзины остаётся 0. Нажимала два раза, товар так и не добавился.",
    en: "I open the Trail Backpack product page and press “Add to cart” — the cart counter stays at 0. I pressed it twice; the item never got added."
  },
  rubric: {
    rootCause:
      "addToCart() reads product.variants[0].sku, but GET /api/products/42 returns an empty variants array, so the click handler throws TypeError: Cannot read properties of undefined (reading 'sku').",
    keyEvidence: [
      "uncaught TypeError … reading 'sku' at addToCart (product-page.js)",
      "GET /api/products/42 → variants: []"
    ],
    required: [
      {
        id: "type-error",
        description: "Finds the exception thrown on click",
        patterns: [/TypeError|cannot read propert(y|ies) of undefined|exception|uncaught/i]
      },
      {
        id: "variant",
        description: "Ties it to the missing variant/sku",
        patterns: [/variant|\bsku\b/i]
      }
    ],
    bonus: [
      {
        id: "empty-variants",
        description: "Notices the API returns no variants",
        patterns: [/variants[\s\S]{0,40}(empty|\[\s*\]|no variants)|(empty|no) variants/i]
      },
      { id: "handler", description: "Names the handler", patterns: [/addToCart/] }
    ],
    forbidden: [
      {
        id: "server-error",
        description: "Blames a failing request",
        patterns: [/(request|api|server) (failed|returned (an? )?(error|4\d\d|5\d\d))/i]
      }
    ]
  },
  evidence: ["exception", "click-target", "network-response-body"]
};

export const coveredButton: Scenario = {
  id: "covered-button",
  caseId: "case-04",
  title: "A transparent banner covers the button, the click hits the banner",
  pages: {
    "/cart/coupon/": renderPage({
      title: "Cart",
      body: `<h1>Cart</h1>
<p>Espresso beans 1 kg × 1 — €24.00</p>
<div class="coupon">
  <label for="coupon">Coupon code</label>
  <div class="row"><input id="coupon" autocomplete="off"><button id="apply-coupon">Apply</button></div>
  <div id="promo-strip" class="promo-strip"><span>Free delivery from €50</span></div>
</div>
<p>Total: <strong id="total">€24.00</strong></p>
<p id="coupon-message" class="muted"></p>`,
      style: `.coupon { position: relative; }
.coupon .row button { margin-top: 0; }
.promo-strip { position: absolute; left: 0; right: 0; top: 30px; height: 64px; z-index: 5;
  display: flex; align-items: flex-end; justify-content: flex-end; font-size: 12px; color: #2e7d32; }`,
      script: `
document.getElementById("apply-coupon").addEventListener("click", async () => {
  const code = document.getElementById("coupon").value.trim();
  const response = await fetch("/api/coupons/apply", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code })
  });
  const result = await response.json();
  document.getElementById("total").textContent = "€" + result.total.toFixed(2);
  document.getElementById("coupon-message").textContent = "Coupon applied: −10%";
});`
    })
  },
  api: {
    "POST /api/coupons/apply": () => ({ status: 200, body: { code: "SPRING10", total: 21.6 } })
  },
  steps: [
    { kind: "navigate", path: "/cart/coupon/" },
    { kind: "type", selector: "#coupon", text: "SPRING10" },
    { kind: "click", selector: "#apply-coupon" },
    { kind: "wait", ms: 1_500 },
    { kind: "click", selector: "#apply-coupon" },
    { kind: "wait", ms: 1_500 }
  ],
  symptom: `document.getElementById("total").textContent === "€24.00"`,
  report: {
    ru: "В корзине ввожу купон SPRING10 и жму «Apply» — ничего не меняется, сумма остаётся €24.00, сообщения нет. Купон точно рабочий, у коллеги применился.",
    en: "In the cart I enter the coupon SPRING10 and press “Apply” — nothing changes, the total stays €24.00 and there is no message. The coupon is valid; it worked for a colleague."
  },
  rubric: {
    rootCause:
      "The absolutely positioned #promo-strip (z-index 5, transparent) lies on top of the Apply button; the user's clicks land on the banner, so the button handler never runs and no /api/coupons/apply request is sent.",
    keyEvidence: [
      "user.click target is div#promo-strip (or its span), not button#apply-coupon",
      "no POST /api/coupons/apply after the clicks"
    ],
    required: [
      {
        id: "covered",
        description: "States the click hit another element that covers the button",
        patterns: [
          /overlay|overlap|covers?|covered|on top|intercept|z-index|obscur|block(s|ed|ing) the (button|click)/i,
          /promo-strip|promo strip|banner/i
        ]
      }
    ],
    bonus: [
      {
        id: "no-request",
        description: "Notices the coupon request was never sent",
        patterns: [
          /no (network |post |api )?(request|call)/i,
          /(never|not|wasn't|was not) (sent|made|fired|issued)/i
        ]
      }
    ],
    forbidden: [
      {
        id: "coupon-invalid",
        description: "Blames the coupon or the API",
        patterns: [
          /coupon (is |was )?(invalid|expired|rejected)|(server|api|backend) (rejected|returned (an? )?error)/i
        ]
      }
    ]
  },
  evidence: ["click-target", "dom", "network-status"]
};

const PAYMENT_FRAME_SCRIPT = `
function formatAmount(amount) {
  return currencyFormatter.format(amount);
}

document.getElementById("pay").addEventListener("click", () => {
  const amount = Number(document.body.dataset.amount);
  document.getElementById("pay").textContent = "Paying " + formatAmount(amount) + "…";
  parent.postMessage({ type: "payment-started" }, location.origin);
});
`;

export const iframeException: Scenario = {
  id: "iframe-exception",
  caseId: "case-09",
  title: "Exception inside the payment iframe",
  pages: {
    "/checkout/payment/": renderPage({
      title: "Payment",
      body: `<h1>Payment</h1><p>Order total: <strong>€64.50</strong></p>
<iframe id="payment-frame" src="/widgets/pay/frame.html" title="Card payment"
  style="width:100%;height:260px;border:1px solid #c4cad4;border-radius:8px"></iframe>
<p id="status" class="muted">Waiting for payment…</p>`,
      script: `
window.addEventListener("message", (event) => {
  if (event.origin === location.origin && event.data?.type === "payment-started") {
    document.getElementById("status").textContent = "Processing payment…";
  }
});`
    }),
    "/widgets/pay/frame.html": `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Card payment</title>
<style>body{font:14px system-ui,sans-serif;margin:16px}input{display:block;width:100%;margin:6px 0 12px;padding:8px}
button{padding:9px 18px;background:#2457d6;color:#fff;border:0;border-radius:6px}</style></head>
<body data-amount="64.5"><label>Card number<input id="card" autocomplete="off"></label>
<label>Expiry<input id="expiry" autocomplete="off"></label>
<button id="pay">Pay €64.50</button>
<script src="/widgets/pay/frame.js"></script></body></html>`
  },
  scripts: { "/widgets/pay/frame.js": PAYMENT_FRAME_SCRIPT },
  steps: [
    { kind: "navigate", path: "/checkout/payment/" },
    {
      kind: "waitFor",
      expression: `document.getElementById("payment-frame").contentDocument?.getElementById("pay") != null`,
      timeoutMs: 5_000
    },
    { kind: "type", selector: "#card", frame: "#payment-frame", text: "4242 4242 4242 4242" },
    { kind: "type", selector: "#expiry", frame: "#payment-frame", text: "09/28" },
    { kind: "click", selector: "#pay", frame: "#payment-frame" },
    { kind: "wait", ms: 1_500 },
    { kind: "click", selector: "#pay", frame: "#payment-frame" },
    { kind: "wait", ms: 1_500 }
  ],
  symptom: `document.getElementById("status").textContent === "Waiting for payment…"`,
  report: {
    ru: "На оплате ввожу тестовую карту 4242 4242 4242 4242, срок 09/28, жму «Pay €64.50» — кнопка не реагирует, внизу так и висит «Waiting for payment…».",
    en: "On the payment step I enter the test card 4242 4242 4242 4242, expiry 09/28, and press “Pay €64.50” — the button does not react and “Waiting for payment…” stays below."
  },
  rubric: {
    rootCause:
      "Inside the payment iframe (/widgets/pay/frame.js) the Pay handler calls formatAmount(), which uses an undefined currencyFormatter: ReferenceError: currencyFormatter is not defined, so the frame never posts payment-started to the page.",
    keyEvidence: [
      "ReferenceError: currencyFormatter is not defined at formatAmount (frame.js)",
      "the error comes from the /widgets/pay/frame.html iframe"
    ],
    required: [
      {
        id: "reference-error",
        description: "Finds the ReferenceError",
        patterns: [/ReferenceError|currencyFormatter|is not defined/i]
      },
      {
        id: "iframe",
        description: "Locates it in the payment iframe/widget",
        patterns: [/i?frame|widget/i]
      }
    ],
    bonus: [{ id: "function", description: "Names formatAmount", patterns: [/formatAmount/] }],
    forbidden: [
      {
        id: "card-declined",
        description: "Blames the card or the payment API",
        patterns: [
          /card (was |is )?(declined|invalid|rejected)|payment (api|request) (failed|returned)/i
        ]
      }
    ]
  },
  evidence: ["iframe", "exception", "click-target"]
};

export const doubleSubmit: Scenario = {
  id: "double-submit",
  caseId: "case-12",
  title: "A slow order request without a disabled button leads to a duplicate order",
  pages: {
    "/checkout/confirm/": renderPage({
      title: "Confirm order",
      body: `<h1>Confirm order</h1>
<p>Espresso beans 1 kg × 2 — €48.00</p>
<button id="place-order">Place order</button>
<p id="confirmation" class="muted"></p>`,
      script: `
document.getElementById("place-order").addEventListener("click", async () => {
  const response = await fetch("/api/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cartId: "c-7781", paymentMethod: "card-on-file" })
  });
  const order = await response.json();
  document.getElementById("confirmation").textContent = "Order #" + order.orderId + " placed. Thank you!";
});`
    })
  },
  api: {
    "POST /api/orders": (_request, state) => {
      const next = Number(state.get("orders") ?? 0) + 1;
      state.set("orders", next);
      return { status: 201, delayMs: 2_500, body: { orderId: 5000 + next, charged: 48 } };
    }
  },
  steps: [
    { kind: "navigate", path: "/checkout/confirm/" },
    { kind: "click", selector: "#place-order" },
    { kind: "wait", ms: 900 },
    { kind: "click", selector: "#place-order" },
    { kind: "wait", ms: 4_500 }
  ],
  symptom: `document.getElementById("confirmation").textContent.includes("#5002")`,
  report: {
    ru: "Оформляю заказ, жму «Place order». Секунды две ничего не происходит, я нажала ещё раз. В итоге в истории два одинаковых заказа и деньги списались дважды.",
    en: "I place an order with “Place order”. For a couple of seconds nothing happened, so I pressed it again. Now there are two identical orders in my history and I was charged twice."
  },
  rubric: {
    rootCause:
      "POST /api/orders takes ~2.5 s and the Place order button is not disabled (no in-flight guard or idempotency key), so the second click sends a second POST and creates order #5002 next to #5001.",
    keyEvidence: [
      "two POST /api/orders ~0.9 s apart, both 201 (orderId 5001 and 5002)",
      "each request takes ~2.5 s; the button stays enabled"
    ],
    required: [
      {
        id: "two-posts",
        description: "Finds the two order requests",
        patterns: [
          /(two|2|duplicate|second|both|double|multiple) [\w /-]{0,30}(POST|requests?|orders?|submissions?|calls?)/i,
          /(POST|request)[\w /.-]{0,40}(twice|two times|2 times)/i
        ]
      },
      { id: "endpoint", description: "Names the order request", patterns: [/\/api\/orders/i] }
    ],
    bonus: [
      {
        id: "no-guard",
        description: "Explains the missing guard (button not disabled / no idempotency)",
        patterns: [/disabl|debounc|idempot|in-flight|in flight|guard/i]
      },
      {
        id: "slow",
        description: "Notices the slow response",
        patterns: [/2\.5 ?s|25\d\d ?ms|slow|latency|took (about |~)?\d/i]
      }
    ],
    forbidden: [
      {
        id: "single-request",
        description: "Claims only one request was sent",
        patterns: [/(only one|single) (request|POST)/i]
      }
    ]
  },
  evidence: ["click-target", "network-status", "network-timing", "network-response-body"]
};
