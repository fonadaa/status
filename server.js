/**
 * Local / cloud status UI + API
 *   npm start  →  http://localhost:3000
 *
 * Cloud: Docker on Render. Frontend may be on Vercel.
 */

require("dotenv").config({ quiet: true });
const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const VERSION = "2026-07-30-nowhisper";
const PORT = Number(process.env.PORT || 3000);
const PUBLIC = path.join(__dirname, "public");
const IS_CLOUD = Boolean(
  process.env.RENDER || process.env.RAILWAY_ENVIRONMENT || process.env.FLY_APP_NAME
);

function resolveHeadless() {
  const raw = String(process.env.CHECK_HEADLESS || "").toLowerCase();
  if (raw === "true") return true;
  if (raw === "false") return false;
  return IS_CLOUD || process.platform === "linux";
}

const HEADLESS = resolveHeadless();

const DEFAULT_ORIGINS = [
  "*",
  "https://status-desk.vercel.app",
  "https://status-desk-mjxi49kdm-devs-projects-b6bc0bb4.vercel.app",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || DEFAULT_ORIGINS.join(","))
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

function pickOrigin(req) {
  const origin = req.headers.origin || "";
  if (!origin) return "*";
  if (ALLOWED_ORIGINS.includes("*")) return origin; // reflect for credential-less preflight reliability
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  if (/\.vercel\.app$/i.test(origin)) return origin;
  return ALLOWED_ORIGINS.find((o) => o !== "*") || "*";
}

function applyCors(req, res) {
  const allowOrigin = pickOrigin(req);
  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
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
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function sendText(req, res, status, body, type = "text/plain") {
  applyCors(req, res);
  res.statusCode = status;
  res.setHeader("Content-Type", `${type}; charset=utf-8`);
  res.end(body);
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
      } catch {
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

function normalizePath(pathname) {
  if (!pathname) return "/";
  // trim trailing slash except root
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.slice(0, -1);
  return pathname;
}

const server = http.createServer(async (req, res) => {
  try {
    // Always answer preflight first (before anything else)
    if (req.method === "OPTIONS") {
      applyCors(req, res);
      res.statusCode = 204;
      res.end();
      return;
    }

    const host = req.headers.host || "localhost";
    const url = new URL(req.url || "/", `http://${host}`);
    const pathname = normalizePath(url.pathname);

    console.log(`[${VERSION}] ${req.method} ${pathname}`);

    if (req.method === "GET" && pathname === "/api/health") {
      return sendJson(req, res, 200, {
        ok: true,
        version: VERSION,
        headless: HEADLESS,
        python: PYTHON,
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
      });
    }

    if (req.method === "GET" && pathname === "/favicon.ico") {
      applyCors(req, res);
      res.statusCode = 204;
      res.end();
      return;
    }

    if (req.method === "POST" && pathname === "/api/check") {
      if (busy) {
        return sendJson(req, res, 409, {
          ok: false,
          error: "A check is already running.",
        });
      }
      let overrides = {};
      try {
        overrides = await readBody(req);
      } catch (err) {
        return sendJson(req, res, 400, { ok: false, error: err.message });
      }
      busy = true;
      progress = ["Starting status check…"];
      try {
        const result = await runStatusCheck(overrides);
        lastResult = { ...result, checkedAt: new Date().toISOString() };
        pushProgress("Done.");
        return sendJson(req, res, 200, lastResult);
      } catch (err) {
        const message = err.message || "Status check failed";
        lastResult = {
          ok: false,
          error: message,
          checkedAt: new Date().toISOString(),
        };
        pushProgress(`Failed: ${message}`);
        return sendJson(req, res, 500, lastResult);
      } finally {
        busy = false;
      }
    }

    let filePath = pathname === "/" ? "/index.html" : pathname;
    filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, "");
    const abs = path.join(PUBLIC, filePath);

    if (!abs.startsWith(PUBLIC) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
      return sendJson(req, res, 404, {
        ok: false,
        error: "Not found",
        path: pathname,
        version: VERSION,
      });
    }

    return sendText(req, res, 200, fs.readFileSync(abs, "utf8"), contentType(abs));
  } catch (err) {
    console.error("Request error:", err);
    try {
      return sendJson(req, res, 500, {
        ok: false,
        error: err.message || "Server error",
        version: VERSION,
      });
    } catch (_) {
      res.statusCode = 500;
      res.end("error");
    }
  }
});

server.requestTimeout = 0;
server.headersTimeout = 0;
server.timeout = 0;
server.keepAliveTimeout = 120000;

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`\nPort ${PORT} is already in use.\n`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`\n[${VERSION}] Status UI/API on 0.0.0.0:${PORT}`);
  console.log(`Python: ${PYTHON}`);
  console.log(HEADLESS ? "Mode: headless" : "Mode: visible browser");
  console.log("CORS origins:", ALLOWED_ORIGINS.join(", "));
});
