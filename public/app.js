const cfg = window.STATUS_CONFIG || {};
const API = () => String(window.STATUS_API || cfg.apiUrl || "").replace(/\/$/, "");

const checkBtn = document.getElementById("checkBtn");
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

function payload() {
  return {
    passportUser: cfg.passportUser || "",
    passportPass: cfg.passportPass || "",
    passportFileNo: cfg.passportFileNo || "",
    gstArn: cfg.gstArn || "",
  };
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

  row(gstFields, "ARN", g.arn);
  row(gstFields, "Form no.", g.form_no);
  row(gstFields, "Form description", g.form_desc);
  row(gstFields, "Submission date", g.submission);
  row(gstFields, "Status", g.status, true);

  row(passportFields, "File number", p.file_number);
  row(passportFields, "Payment", p.payment_status);
  row(passportFields, "Status", p.application_status, true);

  stamp.textContent = data.checkedAt
    ? `Updated ${new Date(data.checkedAt).toLocaleString()}`
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
      const data = await readJson(await fetch(apiUrl("/api/progress")));
      if (data && data.latest) live.textContent = data.latest;
    } catch (_) {
      /* ignore */
    }
  }, 800);
}

async function readJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (_) {
    throw new Error("API not ready. Wait a moment and try again.");
  }
}

async function checkStatus() {
  const body = payload();
  if (!body.passportUser || !body.passportPass || !body.passportFileNo || !body.gstArn) {
    showError("Missing credentials in config.js");
    return;
  }

  checkBtn.disabled = true;
  errorEl.hidden = true;
  live.hidden = false;
  live.textContent = "Checking…";
  startPolling();

  try {
    const res = await fetch(apiUrl("/api/check"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await readJson(res);
    if (!res.ok || data.ok === false) throw new Error(data.error || "Check failed");
    showResult(data);
    live.textContent = "Done";
  } catch (err) {
    showError(err.message || "Something went wrong");
    live.hidden = true;
  } finally {
    stopPolling();
    checkBtn.disabled = false;
  }
}

checkBtn.addEventListener("click", checkStatus);

fetch(apiUrl("/api/last"))
  .then((r) => readJson(r))
  .then((data) => {
    if (data.result && data.result.ok) showResult(data.result);
    if (data.busy) {
      checkBtn.disabled = true;
      live.hidden = false;
      live.textContent = "Checking…";
      startPolling();
    }
  })
  .catch(() => {});
