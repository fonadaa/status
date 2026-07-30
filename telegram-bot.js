/**
 * Telegram status bot (works when WhatsApp Web is network-blocked)
 *   Message the bot "hi" / "status" to run passport + GST checks.
 *
 * Setup:
 *   1) Telegram → @BotFather → /newbot → copy token
 *   2) Message your bot once, then get your user id via @userinfobot
 *   3) .env:
 *        TELEGRAM_BOT_TOKEN=...
 *        TELEGRAM_ALLOWED=123456789
 *   4) npm run telegram
 */

require("dotenv").config({ quiet: true });
const { spawn } = require("child_process");
const path = require("path");
const https = require("https");

const TRIGGERS = new Set(["hi", "hello", "status", "check", "/start", "/status"]);

const token = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const allowed = (process.env.TELEGRAM_ALLOWED || "")
  .split(",")
  .map((n) => n.replace(/\D/g, ""))
  .filter(Boolean);

if (!token) {
  console.error("Set TELEGRAM_BOT_TOKEN in .env (from @BotFather).");
  process.exit(1);
}
if (!allowed.length) {
  console.error(
    "Set TELEGRAM_ALLOWED in .env to your Telegram numeric user id (from @userinfobot)."
  );
  process.exit(1);
}

let busy = false;
let offset = 0;

function tgApi(method, payload) {
  const body = JSON.stringify(payload || {});
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.telegram.org",
        path: `/bot${token}/${method}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        // office SSL inspection
        rejectUnauthorized: false,
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            if (!json.ok) {
              reject(new Error(json.description || `Telegram API error on ${method}`));
              return;
            }
            resolve(json.result);
          } catch (err) {
            reject(new Error(`Bad Telegram response: ${err.message}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function runStatusCheck() {
  return new Promise((resolve, reject) => {
    const script = path.join(__dirname, "check_status.py");
    const child = spawn("python", [script, "--json", "--headless"], {
      cwd: __dirname,
      env: process.env,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      const s = d.toString();
      stdout += s;
      process.stdout.write(s);
    });
    child.stderr.on("data", (d) => {
      const s = d.toString();
      stderr += s;
      process.stderr.write(s);
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
            stderr.trim() ||
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

async function handleUpdate(update) {
  const msg = update.message;
  if (!msg || !msg.text) return;

  const chatId = msg.chat.id;
  const fromId = String(msg.from && msg.from.id);
  const text = msg.text.trim().toLowerCase();

  if (!TRIGGERS.has(text)) return;

  if (!allowed.some((a) => fromId === a)) {
    console.log("Ignored message from unauthorized Telegram user:", fromId);
    await tgApi("sendMessage", {
      chat_id: chatId,
      text: `Unauthorized. Your Telegram id is ${fromId}. Add it to TELEGRAM_ALLOWED in .env`,
    });
    return;
  }

  if (busy) {
    await tgApi("sendMessage", {
      chat_id: chatId,
      text: "Busy running a check — try again in a minute.",
    });
    return;
  }

  busy = true;
  try {
    await tgApi("sendMessage", {
      chat_id: chatId,
      text: "Checking passport & GST status… this may take 1–2 minutes.",
    });
    const result = await runStatusCheck();
    await tgApi("sendMessage", { chat_id: chatId, text: result.message });
  } catch (err) {
    console.error("Check failed:", err.message);
    await tgApi("sendMessage", {
      chat_id: chatId,
      text: `Failed to fetch status:\n${err.message}`,
    });
  } finally {
    busy = false;
  }
}

async function poll() {
  try {
    const updates = await tgApi("getUpdates", {
      offset,
      timeout: 30,
      allowed_updates: ["message"],
    });
    for (const u of updates) {
      offset = u.update_id + 1;
      await handleUpdate(u);
    }
  } catch (err) {
    console.error("Poll error:", err.message);
    await new Promise((r) => setTimeout(r, 3000));
  }
  setImmediate(poll);
}

(async () => {
  const me = await tgApi("getMe");
  console.log(`Telegram bot ready: @${me.username}`);
  console.log("Allowed user ids:", allowed.join(", "));
  console.log('Message the bot with: hi | hello | status | check\n');
  poll();
})().catch((err) => {
  console.error("Failed to start Telegram bot:", err.message);
  process.exit(1);
});
