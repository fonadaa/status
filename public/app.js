const cfg = window.STATUS_CONFIG || {};
const API = () => String(window.STATUS_API || cfg.apiUrl || "").replace(/\/$/, "");
const POLL_MS = 8000; // light: 1 request every 8s while checking

const checkBtn = document.getElementById("checkBtn");
const btnLabel = checkBtn.querySelector(".btn-label") || checkBtn;
const live = document.getElementById("live");
const panel = document.getElementById("panel");
const errorEl = document.getElementById("error");
const stamp = document.getElementById("stamp");
const gstFields = document.getElementById("gstFields");
const gstBlock = document.getElementById("gstBlock");

let pollTimer = null;
let pollInFlight = false;
let checking = false;

function apiUrl(path) {
  return `${API()}${path}`;
}

function payload() {
  return {
    gstArn: cfg.gstArn || "",
    passportUser: cfg.passportUser || "",
    passportPass: cfg.passportPass || "",
    passportFileNo: cfg.passportFileNo || "",
  };
}

function setBusyUi(on, label) {
  checking = on;
  checkBtn.disabled = on;
  btnLabel.textContent = on ? label || "Checking…" : "GST status";
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
  const g = data.gst || {};
  if (!g.status) return;

  errorEl.hidden = true;
  panel.hidden = false;
  gstFields.replaceChildren();

  row(gstFields, "ARN", g.arn);
  row(gstFields, "Form no.", g.form_no);
  row(gstFields, "Form description", g.form_desc);
  row(gstFields, "Submission date", g.submission);
  row(gstFields, "Status", g.status, true);
  gstBlock.hidden = !gstFields.children.length;

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
    const maxMs = 6 * 60 * 1000;
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
        if (Date.now() - started > 20000) live.textContent = "Waiting for server…";
      } finally {
        pollInFlight = false;
      }
    };

    tick();
    pollTimer = setInterval(tick, POLL_MS);
  });
}

async function checkStatus() {
  if (checking) return;

  const body = payload();
  if (!body.gstArn) {
    showError("Missing GST ARN in config.js");
    return;
  }

  setBusyUi(true, "Checking…");
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
    if (!res.ok || started.ok === false) {
      throw new Error(started.error || "Could not start check");
    }
    live.textContent = started.alreadyRunning
      ? "Already checking… joining"
      : "Checking GST…";

    showResult(await waitForResult());
    live.textContent = "Done";
  } catch (err) {
    showError(err.message || "Something went wrong");
    live.hidden = true;
  } finally {
    stopPolling();
    setBusyUi(false);
  }
}

checkBtn.addEventListener("click", checkStatus);
