/**
 * Status Desk API + static UI
 *   npm start → http://localhost:3000
 *
 * Checks run in the background so Render's short HTTP timeout
 * does not kill the Playwright job (client polls /api/last).
 */

require("dotenv").config({ quiet: true });
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const VERSION = "2026-07-30-lite";
const PORT = Number(process.env.PORT || 3000);
const PUBLIC = path.join(__dirname, "public");
const IS_CLOUD = Boolean(
  process.env.RENDER || process.env.RAILWAY_ENVIRONMENT || process.env.FLY_APP_NAME
);

const HEADLESS = (() => {
  const raw = String(process.env.CHECK_HEADLESS || "").toLowerCase();
  if (raw === "true") return true;
  if (raw === "false") return false;
  return IS_CLOUD || process.platform === "linux";
})();

const ALLOWED_ORIGINS = (
  process.env.CORS_ORIGINS ||
  "*,https://dolly.vercel.app,https://dolly-status.vercel.app,https://status-desk.vercel.app,http://localhost:3000,http://127.0.0.1:3000"
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
    if (spawnSync(cmd, ["--version"], { encoding: "utf8" }).status === 0) return cmd;
  }
  return "python";
}

const PYTHON = resolvePython();

function pickOrigin(req) {
  const origin = req.headers.origin || "";
  if (!origin) return "*";
  if (ALLOWED_ORIGINS.includes("*") || ALLOWED_ORIGINS.includes(origin)) return origin;
  if (/\.vercel\.app$/i.test(origin)) return origin;
  return "*";
}

function applyCors(req, res) {
  res.setHeader("Access-Control-Allow-Origin", pickOrigin(req));
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Requested-With"
  );
  res.setHeader("Access-Control-Max-Age", "86400");
  res.setHeader("Vary", "Origin");
  res.setHeader("Cache-Control", "no-store");
}

function sendJson(req, res, status, body) {
  applyCors(req, res);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function sendText(req, res, status, body, type) {
  applyCors(req, res);
  res.writeHead(status, { "Content-Type": `${type}; charset=utf-8` });
  res.end(body);
}

function pushProgress(line) {
  const text = String(line || "").trim();
  if (!text) return;
  progress.push(text);
  if (progress.length > 80) progress = progress.slice(-80);
  process.stdout.write(`${text}\n`);
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
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function runStatusCheck(overrides = {}) {
  return new Promise((resolve, reject) => {
    const args = [path.join(__dirname, "check_status.py"), "--json", "--gst-only"];
    if (HEADLESS) args.push("--headless");
    // Optional full check if explicitly requested
    if (overrides.withPassport === true) {
      const i = args.indexOf("--gst-only");
      if (i >= 0) args.splice(i, 1);
      args.push("--with-passport");
    }

    const child = spawn(PYTHON, args, {
      cwd: __dirname,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
        PYTHONDONTWRITEBYTECODE: "1",
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
        if (!line.trim().startsWith("{")) pushProgress(line);
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
        return reject(
          new Error(
            progress.slice(-5).join(" | ") ||
              `Status check failed (exit ${code}) with no JSON output`
          )
        );
      }
      try {
        const data = JSON.parse(jsonLine);
        if (!data.ok) return reject(new Error(data.error || "Status check failed"));
        resolve(data);
      } catch (err) {
        reject(new Error(`Could not parse status JSON: ${err.message}`));
      }
    });
  });
}

function startCheckJob(overrides) {
  busy = true;
  progress = ["Starting status check…"];
  runStatusCheck(overrides)
    .then((result) => {
      lastResult = { ...result, checkedAt: new Date().toISOString() };
      pushProgress("Done.");
    })
    .catch((err) => {
      const message = err.message || "Status check failed";
      lastResult = {
        ok: false,
        error: message,
        checkedAt: new Date().toISOString(),
      };
      pushProgress(`Failed: ${message}`);
    })
    .finally(() => {
      busy = false;
    });
}

function contentType(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case ".html":
      return "text/html";
    case ".css":
      return "text/css";
    case ".js":
      return "application/javascript";
    case ".svg":
      return "image/svg+xml";
    case ".ico":
      return "image/x-icon";
    default:
      return "application/octet-stream";
  }
}

function normalizePath(pathname) {
  if (!pathname) return "/";
  return pathname.length > 1 && pathname.endsWith("/")
    ? pathname.slice(0, -1)
    : pathname;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      applyCors(req, res);
      res.writeHead(204);
      return res.end();
    }

    const pathname = normalizePath(
      new URL(req.url || "/", `http://${req.headers.host || "localhost"}`).pathname
    );

    if (req.method === "GET" && pathname === "/api/health") {
      return sendJson(req, res, 200, {
        ok: true,
        version: VERSION,
        headless: HEADLESS,
        python: PYTHON,
        busy,
      });
    }
    if (req.method === "GET" && pathname === "/api/last") {
      return sendJson(req, res, 200, { busy, result: lastResult, progress });
    }
    if (req.method === "GET" && pathname === "/api/progress") {
      return sendJson(req, res, 200, {
        busy,
        progress,
        latest: progress[progress.length - 1] || "",
        result: busy ? null : lastResult,
      });
    }
    if (req.method === "GET" && pathname === "/favicon.ico") {
      applyCors(req, res);
      res.writeHead(204);
      return res.end();
    }

    if (req.method === "POST" && pathname === "/api/check") {
      if (busy) {
        return sendJson(req, res, 409, {
          ok: false,
          error: "A check is already running.",
          busy: true,
        });
      }
      let overrides = {};
      try {
        overrides = await readBody(req);
      } catch (err) {
        return sendJson(req, res, 400, { ok: false, error: err.message });
      }

      // Return immediately — Render free tier times out long requests (~30–100s)
      startCheckJob(overrides);
      return sendJson(req, res, 202, {
        ok: true,
        started: true,
        message: "Check started. Poll /api/progress or /api/last.",
      });
    }

    const filePath = normalizePath(pathname === "/" ? "/index.html" : pathname).replace(
      /^(\.\.[/\\])+/,
      ""
    );
    const abs = path.join(PUBLIC, filePath);
    if (!abs.startsWith(PUBLIC) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
      return sendJson(req, res, 404, { ok: false, error: "Not found", path: pathname });
    }
    return sendText(req, res, 200, fs.readFileSync(abs, "utf8"), contentType(abs));
  } catch (err) {
    console.error("Request error:", err);
    return sendJson(req, res, 500, { ok: false, error: err.message || "Server error" });
  }
});

server.requestTimeout = 0;
server.headersTimeout = 0;
server.timeout = 0;
server.keepAliveTimeout = 120000;

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} already in use`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[${VERSION}] http://localhost:${PORT}  python=${PYTHON}  headless=${HEADLESS}`);
});
