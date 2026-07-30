/**
 * Local / cloud status UI + API
 *   npm start  →  http://localhost:3000
 *
 * Cloud note: Playwright cannot run on Vercel.
 * Deploy this server (Docker) to Render/Railway; host public/ on Vercel.
 */

require("dotenv").config({ quiet: true });
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const PORT = Number(process.env.PORT || 3000);
const PUBLIC = path.join(__dirname, "public");
const IS_CLOUD = Boolean(
  process.env.RENDER || process.env.RAILWAY_ENVIRONMENT || process.env.FLY_APP_NAME
);

function resolveHeadless() {
  const raw = String(process.env.CHECK_HEADLESS || "").toLowerCase();
  if (raw === "true") return true;
  if (raw === "false") return false;
  // Local Windows/mac: visible browser. Cloud/Linux servers: headless.
  return IS_CLOUD || process.platform === "linux";
}

const HEADLESS = resolveHeadless();

const ALLOWED_ORIGINS = (
  process.env.CORS_ORIGINS ||
  "*,https://status-desk.vercel.app,http://localhost:3000"
)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

let busy = false;
let lastResult = null;
let progress = [];

function resolvePython() {
  if (process.env.PYTHON_PATH) return process.env.PYTHON_PATH;
  for (const cmd of ["python", "python3", "py"]) {
    const check = spawnSync(cmd, ["--version"], { encoding: "utf8" });
    if (check.status === 0) return cmd;
  }
  return "python";
}

const PYTHON = resolvePython();

function corsHeaders(req) {
  const origin = req.headers.origin || "";
  const allowAll = ALLOWED_ORIGINS.includes("*");
  const allowed = allowAll || ALLOWED_ORIGINS.includes(origin);
  const headers = {
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
  };
  if (allowed) {
    headers["Access-Control-Allow-Origin"] = allowAll ? "*" : origin;
  }
  return headers;
}

function send(res, req, status, body, type = "application/json") {
  const data = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    ...corsHeaders(req),
    "Content-Type": `${type}; charset=utf-8`,
  });
  res.end(data);
}

function pushProgress(line) {
  const text = String(line || "").trim();
  if (!text) return;
  progress.push(text);
  if (progress.length > 80) progress = progress.slice(-80);
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function runStatusCheck(overrides = {}) {
  return new Promise((resolve, reject) => {
    const script = path.join(__dirname, "check_status.py");
    const args = [script, "--json"];
    if (HEADLESS) args.push("--headless");

    const child = spawn(PYTHON, args, {
      cwd: __dirname,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
        PASSPORT_USER: overrides.passportUser || process.env.PASSPORT_USER || "",
        PASSPORT_PASS: overrides.passportPass || process.env.PASSPORT_PASS || "",
        PASSPORT_FILE_NO: overrides.passportFileNo || process.env.PASSPORT_FILE_NO || "",
        GST_ARN: overrides.gstArn || process.env.GST_ARN || "",
      },
      windowsHide: HEADLESS,
    });

    let stdout = "";
    child.stdout.on("data", (d) => {
      const s = d.toString();
      stdout += s;
      for (const line of s.split(/\r?\n/)) {
        if (line.trim().startsWith("{")) continue;
        pushProgress(line);
      }
    });
    child.stderr.on("data", (d) => {
      for (const line of d.toString().split(/\r?\n/)) pushProgress(line);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const jsonLine = stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .reverse()
        .find((l) => l.startsWith("{") && l.endsWith("}"));

      if (!jsonLine) {
        reject(
          new Error(
            progress.slice(-5).join(" | ") ||
              `Status check failed (exit ${code}) with no JSON output`
          )
        );
        return;
      }
      try {
        const data = JSON.parse(jsonLine);
        if (!data.ok) {
          reject(new Error(data.error || "Status check failed"));
          return;
        }
        resolve(data);
      } catch (err) {
        reject(new Error(`Could not parse status JSON: ${err.message}`));
      }
    });
  });
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html";
  if (ext === ".css") return "text/css";
  if (ext === ".js") return "application/javascript";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".ico") return "image/x-icon";
  return "application/octet-stream";
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders(req));
    return res.end();
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    return send(res, req, 200, { ok: true, headless: HEADLESS, python: PYTHON });
  }

  if (req.method === "GET" && url.pathname === "/api/last") {
    return send(res, req, 200, { busy, result: lastResult, progress });
  }

  if (req.method === "GET" && url.pathname === "/api/progress") {
    return send(res, req, 200, {
      busy,
      progress,
      latest: progress[progress.length - 1] || "",
    });
  }

  if (req.method === "GET" && url.pathname === "/favicon.ico") {
    res.writeHead(204, corsHeaders(req));
    return res.end();
  }

  if (req.method === "POST" && url.pathname === "/api/check") {
    if (busy) {
      return send(res, req, 409, { ok: false, error: "A check is already running." });
    }
    let overrides = {};
    try {
      overrides = await readBody(req);
    } catch (err) {
      return send(res, req, 400, { ok: false, error: err.message });
    }
    busy = true;
    progress = ["Starting status check…"];
    try {
      const result = await runStatusCheck(overrides);
      lastResult = { ...result, checkedAt: new Date().toISOString() };
      pushProgress("Done.");
      return send(res, req, 200, lastResult);
    } catch (err) {
      const message = err.message || "Status check failed";
      lastResult = {
        ok: false,
        error: message,
        checkedAt: new Date().toISOString(),
      };
      pushProgress(`Failed: ${message}`);
      return send(res, req, 500, lastResult);
    } finally {
      busy = false;
    }
  }

  let filePath = url.pathname === "/" ? "/index.html" : url.pathname;
  filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, "");
  const abs = path.join(PUBLIC, filePath);

  if (!abs.startsWith(PUBLIC) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
    return send(res, req, 404, "Not found", "text/plain");
  }

  return send(res, req, 200, fs.readFileSync(abs, "utf8"), contentType(abs));
});

// Long-running Playwright checks
server.requestTimeout = 0;
server.headersTimeout = 0;
server.timeout = 0;

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `\nPort ${PORT} is already in use.\n` +
        `Open http://localhost:${PORT} or stop the other process and retry.\n`
    );
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`\nStatus UI/API running at http://localhost:${PORT}`);
  console.log(`Python: ${PYTHON}`);
  console.log(HEADLESS ? "Mode: headless" : "Mode: visible browser");
  console.log("Open that link and click Check status.\n");
});
