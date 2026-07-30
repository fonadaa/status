/**
 * WhatsApp status bot
 *   Scan QR once, then message "hi" / "status" from an allowed number
 *   to run passport + GST checks and get a reply.
 *
 * Usage: npm run whatsapp
 *
 * Note: many office networks block web.whatsapp.com. If that happens,
 * use a phone hotspot, or run: npm run telegram
 */

require("dotenv").config({ quiet: true });
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const qrcode = require("qrcode-terminal");
const puppeteer = require("puppeteer");

// Patch BEFORE loading whatsapp-web.js so its puppeteer.launch gets cert-ignore
const _launch = puppeteer.launch.bind(puppeteer);
puppeteer.launch = async function patchedLaunch(options = {}) {
  const browser = await _launch(options);
  async function ignoreCerts(page) {
    try {
      const session = await page.createCDPSession();
      await session.send("Security.setIgnoreCertificateErrors", { ignore: true });
    } catch (_) {
      /* ignore */
    }
  }
  for (const page of await browser.pages()) await ignoreCerts(page);
  const _newPage = browser.newPage.bind(browser);
  browser.newPage = async function patchedNewPage(...args) {
    const page = await _newPage(...args);
    await ignoreCerts(page);
    return page;
  };
  return browser;
};

const { Client, LocalAuth } = require("whatsapp-web.js");

const TRIGGERS = new Set(["hi", "hello", "status", "check"]);

const allowed = (process.env.WHATSAPP_ALLOWED || "")
  .split(",")
  .map((n) => n.replace(/\D/g, ""))
  .filter(Boolean);

if (!allowed.length) {
  console.error(
    "Set WHATSAPP_ALLOWED in .env (country code + number, e.g. 9198XXXXXXXX)."
  );
  process.exit(1);
}

function resolveChromePath() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(process.env.LOCALAPPDATA || "", "Google\\Chrome\\Application\\chrome.exe"),
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
  return candidates.find((p) => p && fs.existsSync(p));
}

let busy = false;

function senderDigits(msg) {
  const from = (msg.author || msg.from || "").split("@")[0];
  return from.replace(/\D/g, "");
}

function isAllowed(msg) {
  const digits = senderDigits(msg);
  return allowed.some((a) => digits === a || digits.endsWith(a) || a.endsWith(digits));
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

const chromePath = resolveChromePath();
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: path.join(__dirname, ".wwebjs_auth") }),
  authTimeoutMs: 120000,
  puppeteer: {
    headless: true,
    ...(chromePath ? { executablePath: chromePath } : {}),
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--ignore-certificate-errors",
      "--ignore-certificate-errors-spki-list",
      "--disable-web-security",
    ],
  },
});

client.on("qr", (qr) => {
  console.log("\nScan this QR with WhatsApp → Linked devices:\n");
  qrcode.generate(qr, { small: true });
});

client.on("ready", () => {
  console.log("WhatsApp bot ready.");
  console.log("Allowed numbers:", allowed.join(", "));
  console.log('Message this account with: hi | hello | status | check\n');
});

client.on("auth_failure", (msg) => {
  console.error("WhatsApp auth failed:", msg);
});

client.on("message", async (msg) => {
  const text = (msg.body || "").trim().toLowerCase();
  if (!TRIGGERS.has(text)) return;
  if (!isAllowed(msg)) {
    console.log("Ignored message from unauthorized sender:", senderDigits(msg));
    return;
  }

  if (busy) {
    await msg.reply("Busy running a check — try again in a minute.");
    return;
  }

  busy = true;
  try {
    await msg.reply("Checking passport & GST status… this may take 1–2 minutes.");
    const result = await runStatusCheck();
    await msg.reply(result.message);
  } catch (err) {
    console.error("Check failed:", err.message);
    await msg.reply(`Failed to fetch status:\n${err.message}`);
  } finally {
    busy = false;
  }
});

console.log("Starting WhatsApp bot…");
if (chromePath) console.log("Using browser:", chromePath);

client.initialize().catch(async (err) => {
  const msg = String(err && err.message ? err.message : err);
  console.error("\nWhatsApp bot failed to start:", msg);

  // Probe whether the network firewall is blocking WhatsApp Web
  try {
    const browser = await puppeteer.launch({
      headless: true,
      ...(chromePath ? { executablePath: chromePath } : {}),
      args: ["--no-sandbox", "--ignore-certificate-errors"],
    });
    const context = await browser.createBrowserContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await page.goto("https://web.whatsapp.com/", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    const finalUrl = page.url();
    const body = await page.evaluate(() =>
      document.body ? document.body.innerText.slice(0, 400) : ""
    );
    await browser.close();
    if (/ips\/block|blocked|categorized as whatsapp/i.test(finalUrl + "\n" + body)) {
      console.error(`
============================================================
Your network FIREWALL is blocking WhatsApp Web.
(Detected Fortinet/IPS category block for whatsapp.)

Fixes:
  1) Connect PC to phone hotspot / home Wi‑Fi, then retry:
       npm run whatsapp
  2) Or use Telegram instead (works on this network):
       - Message @BotFather on Telegram → /newbot → copy token
       - Put in .env:
           TELEGRAM_BOT_TOKEN=123456:ABC...
           TELEGRAM_ALLOWED=your_numeric_telegram_user_id
       - Run: npm run telegram
============================================================
`);
      process.exit(1);
    }
  } catch (_) {
    /* probe failed; fall through */
  }

  console.error(`
If you are on office Wi‑Fi, WhatsApp Web is often blocked.
Try a phone hotspot, or use: npm run telegram
`);
  process.exit(1);
});
