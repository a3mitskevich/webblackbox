// Demo shop for the WebBlackbox usage videos: a login form, an order list loaded with fetch, a
// report endpoint that fails (HTTP 500, JSON body) and logs a console error with a stack, and live
// notifications over a WebSocket. Fake data only.

const $ = (selector) => document.querySelector(selector);

function setText(element, text) {
  element.textContent = text;
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

function renderOrders(orders) {
  const rows = orders.map((order) => {
    const row = document.createElement("tr");
    for (const value of [order.id, order.customer, order.total, order.status]) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    return row;
  });
  $("#orders").replaceChildren(...rows);
}

async function loadOrders() {
  const response = await fetch("/api/orders?page=1");
  renderOrders((await response.json()).orders);
}

function parseReport(payload) {
  if (!payload || !Array.isArray(payload.rows)) {
    throw new Error(`Отчёт не получен: ${payload?.message ?? "пустой ответ"}`);
  }
  return payload.rows;
}

function renderReport(payload) {
  const rows = parseReport(payload);
  setText($("#report"), `Строк в отчёте: ${rows.length}`);
}

async function loadReport() {
  const report = $("#report");
  report.className = "muted";
  setText(report, "Строим отчёт…");
  const response = await fetch("/api/report?period=week");
  const payload = await response.json();
  try {
    renderReport(payload);
  } catch (error) {
    console.error("Не удалось построить отчёт за неделю", error);
    report.className = "error";
    setText(report, `Ошибка ${response.status}: ${payload.message}`);
  }
}

function connectNotifications() {
  const socket = new WebSocket(`ws://${location.host}/ws/notifications`);
  socket.addEventListener("open", () => socket.send(JSON.stringify({ subscribe: "orders" })));
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const item = document.createElement("li");
    item.textContent = message.text;
    $("#notifications").prepend(item);
  });
}

$("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const result = await postJson("/api/login", {
    email: $("#email").value,
    password: $("#password").value
  });
  if (result.status !== 200) {
    setText($("#user"), "Неверная почта или пароль");
    return;
  }
  setText($("#user"), result.body.user.name);
  $("#login").hidden = true;
  $("#dashboard").hidden = false;
  await loadOrders();
  connectNotifications();
});

$("#reload-orders").addEventListener("click", () => {
  void loadOrders();
});

$("#load-report").addEventListener("click", () => {
  void loadReport();
});
