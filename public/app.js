const cfg = window.STATUS_CONFIG || {};
const API = () => String(window.STATUS_API || cfg.apiUrl || "").replace(/\/$/, "");
const POLL_MS = 8000;

const checkBtn = document.getElementById("checkBtn");
const btnLabel = checkBtn.querySelector(".btn-label") || checkBtn;
const live = document.getElementById("live");
const panel = document.getElementById("panel");
const errorEl = document.getElementById("error");
const stamp = document.getElementById("stamp");

const gstBlock = document.getElementById("gstBlock");
const gstFields = document.getElementById("gstFields");
const gstError = document.getElementById("gstError");

const passportBlock = document.getElementById("passportBlock");
const passportFields = document.getElementById("passportFields");
const passportError = document.getElementById("passportError");

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
    withPassport: cfg.withPassport !== false, // default: run both
  };
}

function setBusyUi(on, label) {
  checking = on;
  checkBtn.disabled = on;
  btnLabel.textContent = on ? label || "Checking…" : "Check status";
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

function renderGst(g) {
  gstFields.replaceChildren();
  gstError.hidden = true;
  gstError.textContent = "";

  if (!g) {
    gstBlock.hidden = true;
    return false;
  }

  if (g.arn) row(gstFields, "ARN", g.arn);
  if (g.form_no) row(gstFields, "Form no.", g.form_no);
  if (g.form_desc) row(gstFields, "Form description", g.form_desc);
  if (g.submission) row(gstFields, "Submission date", g.submission);
  if (g.status) row(gstFields, "Status", g.status, true);

  if (g.error) {
    gstError.hidden = false;
    gstError.textContent = `Could not read GST: ${g.error}`;
  }

  const hasContent = gstFields.children.length > 0 || !gstError.hidden;
  gstBlock.hidden = !hasContent;
  return hasContent;
}

function renderPassport(p) {
  passportFields.replaceChildren();
  passportError.hidden = true;
  passportError.textContent = "";

  if (!p) {
    passportBlock.hidden = true;
    return false;
  }

  if (p.file_number) row(passportFields, "File number", p.file_number);
  if (p.payment_status) row(passportFields, "Payment", p.payment_status);
  if (p.application_status) row(passportFields, "Status", p.application_status, true);

  if (p.error) {
    passportError.hidden = false;
    passportError.textContent = `Could not read Passport: ${p.error}`;
  }

  const hasContent = passportFields.children.length > 0 || !passportError.hidden;
  passportBlock.hidden = !hasContent;
  return hasContent;
}

function showResult(data) {
  console.log("Status result:", data);
  errorEl.hidden = true;
  panel.hidden = false;

  const hasGst = renderGst(data && data.gst);
  const hasPassport = renderPassport(data && data.passport);

  stamp.textContent = data && data.checkedAt
    ? `Updated ${new Date(data.checkedAt).toLocaleString()}`
    : "";

  if (!hasGst && !hasPassport) {
    panel.hidden = true;
    showError("No status returned. Try again in a minute.");
  }
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

function postCheck(body) {
  return fetch(apiUrl("/api/check"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then(readJson);
}

function waitForResult(body) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const maxMs = 6 * 60 * 1000;
    let restartRetries = 0;
    let sawBusy = false;
    let idleSince = 0;
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
        if (data.busy) {
          sawBusy = true;
          idleSince = 0;
        } else if (!data.result) {
          // Server thinks it isn't running, but we have no result.
          // Likely Render restarted the process mid-check. Retry the POST.
          idleSince = idleSince || Date.now();
          const idleFor = Date.now() - idleSince;
          if (idleFor > 15000 && restartRetries < 2) {
            restartRetries++;
            idleSince = 0;
            sawBusy = false;
            live.textContent =
              restartRetries === 1
                ? "Server restarted, retrying…"
                : "Retrying once more…";
            try {
              await postCheck(body);
            } catch (_) {
              /* keep polling */
            }
          } else if (idleFor > 40000 && restartRetries >= 2) {
            stopPolling();
            reject(
              new Error(
                "Server keeps restarting (Render free tier memory limit). Try again shortly."
              )
            );
            return;
          }
        }
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
    const started = await postCheck(body);
    if (started.ok === false) {
      throw new Error(started.error || "Could not start check");
    }
    live.textContent = started.alreadyRunning
      ? "Already checking… joining"
      : "Checking…";

    showResult(await waitForResult(body));
    live.textContent = "Done";
    setTimeout(() => {
      live.hidden = true;
    }, 1500);
  } catch (err) {
    showError(err.message || "Something went wrong");
    live.hidden = true;
  } finally {
    stopPolling();
    setBusyUi(false);
  }
}

checkBtn.addEventListener("click", checkStatus);
