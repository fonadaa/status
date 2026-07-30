const cfg = window.STATUS_CONFIG || {};
const API = () => String(window.STATUS_API || cfg.apiUrl || "").replace(/\/$/, "");
const POLL_MS = 5000; // one call every 5s while checking — not spam

const checkBtn = document.getElementById("checkBtn");
const live = document.getElementById("live");
const panel = document.getElementById("panel");
const errorEl = document.getElementById("error");
const stamp = document.getElementById("stamp");
const passportFields = document.getElementById("passportFields");
const gstFields = document.getElementById("gstFields");
const gstBlock = document.getElementById("gstBlock");
const passportBlock = document.getElementById("passportBlock");

let pollTimer = null;
let pollInFlight = false;

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
  const p = data.passport || {};
  const g = data.gst || {};
  if (!g.status && !p.application_status) return;

  errorEl.hidden = true;
  panel.hidden = false;
  passportFields.replaceChildren();
  gstFields.replaceChildren();

  row(gstFields, "ARN", g.arn);
  row(gstFields, "Form no.", g.form_no);
  row(gstFields, "Form description", g.form_desc);
  row(gstFields, "Submission date", g.submission);
  row(gstFields, "Status", g.status, true);
  gstBlock.hidden = !gstFields.children.length;

  row(passportFields, "File number", p.file_number);
  row(passportFields, "Payment", p.payment_status);
  row(passportFields, "Status", p.application_status, true);
  passportBlock.hidden = !passportFields.children.length;

  stamp.textContent = data.checkedAt
    ? `Updated ${new Date(data.checkedAt).toLocaleString()}`
    : "";
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  pollInFlight = false;
}

async function readJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (_) {
    throw new Error("API not ready. Wait a moment and try again.");
  }
}

function waitForResult() {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const maxMs = 8 * 60 * 1000;
    live.hidden = false;

    const tick = async () => {
      if (pollInFlight) return;
      pollInFlight = true;
      try {
        if (Date.now() - started > maxMs) {
          stopPolling();
          reject(new Error("Timed out. Try again."));
          return;
        }

        const data = await readJson(await fetch(apiUrl("/api/progress")));
        if (data.latest) live.textContent = data.latest;

        if (!data.busy && data.result) {
          stopPolling();
          if (data.result.ok === false) {
            reject(new Error(data.result.error || "Check failed"));
            return;
          }
          resolve(data.result);
        }
      } catch (_) {
        if (Date.now() - started > 20000) {
          live.textContent = "Waiting for server…";
        }
      } finally {
        pollInFlight = false;
      }
    };

    tick(); // first check soon after start
    pollTimer = setInterval(tick, POLL_MS);
  });
}

async function checkStatus() {
  const body = payload();
  if (!body.passportUser || !body.passportPass || !body.passportFileNo || !body.gstArn) {
    showError("Missing credentials in config.js");
    return;
  }

  checkBtn.disabled = true;
  errorEl.hidden = true;
  panel.hidden = true;
  live.hidden = false;
  live.textContent = "Starting…";

  try {
    const res = await fetch(apiUrl("/api/check"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const started = await readJson(res);
    if (res.status === 409 || (started && started.busy)) {
      live.textContent = "Already running…";
    } else if (!res.ok || started.ok === false) {
      throw new Error(started.error || "Could not start check");
    } else {
      live.textContent = "Checking…";
    }

    const result = await waitForResult();
    showResult(result);
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
// No API calls on page load — only when you tap the button.
