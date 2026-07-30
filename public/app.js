const API = () => String(window.STATUS_API || "").replace(/\/$/, "");

const checkBtn = document.getElementById("checkBtn");
const hint = document.getElementById("hint");
const live = document.getElementById("live");
const panel = document.getElementById("panel");
const errorEl = document.getElementById("error");
const stamp = document.getElementById("stamp");
const passportFields = document.getElementById("passportFields");
const gstFields = document.getElementById("gstFields");

let pollTimer = null;

function apiUrl(path) {
  return `${API()}${path}`;
}

function row(dl, label, value, isStatus = false) {
  if (value == null || value === "") return;
  const dt = document.createElement("dt");
  dt.textContent = label;
  const dd = document.createElement("dd");
  dd.textContent = value;
  if (isStatus) dd.className = "status";
  dl.append(dt, dd);
}

function showError(message) {
  panel.hidden = true;
  errorEl.hidden = false;
  errorEl.textContent = message;
}

function showResult(data) {
  errorEl.hidden = true;
  panel.hidden = false;
  passportFields.replaceChildren();
  gstFields.replaceChildren();

  const p = data.passport || {};
  const g = data.gst || {};

  row(passportFields, "File number", p.file_number);
  row(passportFields, "Payment status", p.payment_status);
  row(passportFields, "Application status", p.application_status, true);

  row(gstFields, "ARN", g.arn);
  row(gstFields, "Form no.", g.form_no);
  row(gstFields, "Form description", g.form_desc);
  row(gstFields, "Submission date", g.submission);
  row(gstFields, "Application status", g.status, true);

  stamp.textContent = data.checkedAt
    ? `Last checked ${new Date(data.checkedAt).toLocaleString()}`
    : "";
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function startPolling() {
  stopPolling();
  live.hidden = false;
  pollTimer = setInterval(async () => {
    try {
      const res = await fetch(apiUrl("/api/progress"));
      const data = await res.json();
      if (data.latest) live.textContent = data.latest;
    } catch (_) {
      /* ignore */
    }
  }, 800);
}

async function checkStatus() {
  checkBtn.disabled = true;
  hint.textContent = "Checking… keep this tab open.";
  hint.classList.add("busy");
  errorEl.hidden = true;
  live.hidden = false;
  live.textContent = "Starting…";
  startPolling();

  try {
    const res = await fetch(apiUrl("/api/check"), { method: "POST" });
    const data = await res.json();
    if (!res.ok || data.ok === false) {
      throw new Error(data.error || "Status check failed");
    }
    showResult(data);
    hint.textContent = "Done. Tap again anytime to refresh.";
    live.textContent = "Done.";
  } catch (err) {
    showError(err.message || "Something went wrong");
    hint.textContent = "Failed. You can try again.";
    live.textContent = "";
    live.hidden = true;
  } finally {
    stopPolling();
    checkBtn.disabled = false;
    hint.classList.remove("busy");
  }
}

checkBtn.addEventListener("click", checkStatus);

fetch(apiUrl("/api/last"))
  .then((r) => r.json())
  .then((data) => {
    if (data.result && data.result.ok) showResult(data.result);
    if (data.result && data.result.ok === false && data.result.error) {
      showError(data.result.error);
    }
    if (data.busy) {
      checkBtn.disabled = true;
      hint.textContent = "A check is already running…";
      hint.classList.add("busy");
      startPolling();
    }
  })
  .catch(() => {});
