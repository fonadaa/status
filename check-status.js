/**
 * Status checker
 *   1) Passport Seva application status
 *   2) GST ARN application status
 *
 * Usage: npm start
 *
 * GST captcha: script tries OCR; if unsure, type the characters shown in the browser into the terminal.
 */

require("dotenv").config({ quiet: true });
const readline = require("readline");
const { chromium } = require("playwright");
const Tesseract = require("tesseract.js");
const sharp = require("sharp");

const LOGIN_URL = "https://services1.passportindia.gov.in/forms/login";
const GST_URL = "https://services.gst.gov.in/services/arnstatus";

const USERNAME = process.env.PASSPORT_USER || "ABHISHEKSHPS@GMAIL.COM";
const PASSWORD = process.env.PASSPORT_PASS || "Mpasspw@01";
const FILE_NO = process.env.PASSPORT_FILE_NO || "LKN067803930926";
const GST_ARN = process.env.GST_ARN || "AA090726251099S";

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve((answer || "").trim());
    });
  });
}

function valueAfterLabel(bodyText, label) {
  const re = new RegExp(
    `${label}\\s*\\n\\s*-\\s*\\n\\s*([\\s\\S]*?)(?=\\n\\s*[A-Z][A-Za-z /()]+\\s*\\n\\s*-\\s*\\n|\\n\\s*Close\\b|\\n\\s*Home\\b|$)`,
    "i"
  );
  const m = bodyText.match(re);
  if (!m) return null;
  return m[1].replace(/\s+/g, " ").trim();
}

async function clickByExactText(page, text) {
  const pressable = page.locator('div[tabindex="0"]').filter({ hasText: new RegExp(`^${text}$`) });
  if (await pressable.count()) {
    await pressable.first().click({ force: true });
    return;
  }
  await page.getByText(text, { exact: true }).first().click({ force: true });
}

/* -------------------- Passport -------------------- */

async function loginPassport(page) {
  await page.goto(LOGIN_URL, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(1000);

  const userInput = page.locator('input[type="text"]').first();
  const passInput = page.locator('input[type="password"]').first();
  await userInput.waitFor({ state: "visible", timeout: 30000 });

  await userInput.click();
  await userInput.fill("");
  await userInput.type(USERNAME, { delay: 15 });

  await passInput.click();
  await passInput.fill("");
  await passInput.type(PASSWORD, { delay: 15 });

  await clickByExactText(page, "Sign In");

  await page.waitForURL(/Home|homeScreen/i, { timeout: 60000 });
  await page.waitForFunction(
    () => /Submitted Applications|Welcome back/i.test(document.body.innerText),
    null,
    { timeout: 60000 }
  );
  await page.waitForTimeout(1500);
}

async function openPassportApplication(page) {
  await page.waitForFunction(
    (fileNo) => !fileNo || document.body.innerText.includes(fileNo),
    FILE_NO,
    { timeout: 30000 }
  );

  const viewButtons = page.locator('div[tabindex="0"]').filter({ hasText: /^View$/ });
  const count = await viewButtons.count();

  if (!count) {
    await page.getByText("View", { exact: true }).first().click({ force: true });
  } else if (FILE_NO) {
    let clicked = false;
    for (let i = 0; i < count; i++) {
      const btn = viewButtons.nth(i);
      const hasFile = await btn.evaluate((el, fileNo) => {
        let node = el;
        for (let d = 0; d < 12 && node; d++) {
          if ((node.innerText || "").includes(fileNo)) return true;
          node = node.parentElement;
        }
        return false;
      }, FILE_NO);
      if (hasFile) {
        await btn.click({ force: true });
        clicked = true;
        break;
      }
    }
    if (!clicked) await viewButtons.first().click({ force: true });
  } else {
    await viewButtons.first().click({ force: true });
  }

  await page.waitForURL(/UserApplicationsDetails/i, { timeout: 60000 });
  await page.waitForFunction(
    () => /Track Application Status/i.test(document.body.innerText),
    null,
    { timeout: 60000 }
  );
  await page.waitForTimeout(1000);
}

async function openPassportTrackStatus(page) {
  await clickByExactText(page, "Track Application Status");
  await page.waitForURL(/TrackApplication/i, { timeout: 60000 });
  await page.waitForFunction(
    () => /Status Tracker/i.test(document.body.innerText),
    null,
    { timeout: 60000 }
  );
  await page.waitForTimeout(800);
}

async function checkPassport(browser) {
  console.log("\n----- 1) PASSPORT STATUS -----");
  console.log("Opening Passport Seva login…");

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(60000);
  page.on("dialog", async (d) => {
    console.log("Dialog:", d.message());
    await d.accept();
  });

  try {
    console.log("Signing in…");
    await loginPassport(page);
    console.log("Logged in. Opening application (View)…");
    await openPassportApplication(page);

    const detailsBody = await page.locator("body").innerText();
    const paymentStatus = valueAfterLabel(detailsBody, "Payment Status") || "(not found)";

    console.log("Opening Track Application Status…");
    await openPassportTrackStatus(page);
    const statusBody = await page.locator("body").innerText();
    const applicationStatus = valueAfterLabel(statusBody, "Status");
    const fileNumber = valueAfterLabel(statusBody, "File Number");

    if (!applicationStatus) throw new Error("Could not read Passport Status");

    return { fileNumber, paymentStatus, applicationStatus };
  } finally {
    await context.close();
  }
}

/* -------------------- GST -------------------- */

async function ocrGstCaptcha(pngBuffer) {
  try {
    const { data, info } = await sharp(pngBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const out = Buffer.alloc(info.width * info.height);
    for (let i = 0, p = 0; i < data.length; i += info.channels, p++) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      if (r > 140 && g < 120 && b < 120) {
        out[p] = 255;
        continue;
      }
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      out[p] = lum < 95 ? 0 : 255;
    }

    const cleaned = await sharp(out, {
      raw: { width: info.width, height: info.height, channels: 1 },
    })
      .resize({ width: info.width * 3, height: info.height * 3, kernel: "nearest" })
      .png()
      .toBuffer();

    const worker = await Tesseract.createWorker("eng");
    await worker.setParameters({
      tessedit_char_whitelist: "0123456789",
      tessedit_pageseg_mode: Tesseract.PSM.SINGLE_LINE,
    });
    const result = await worker.recognize(cleaned);
    await worker.terminate();

    const digits = (result.data.text || "").replace(/\D/g, "");
    if (digits.length >= 5 && digits.length <= 7) return digits;
    return "";
  } catch {
    return "";
  }
}

async function refreshGstCaptcha(page) {
  // Refresh icon is usually the 2nd button next to captcha image
  const refreshBtn = page.locator("button").filter({ has: page.locator("img, i, span, svg") });
  // Safer: reload captcha by clicking image's sibling refresh, or change img src
  const clicked = await page.evaluate(() => {
    const img = document.querySelector("#imgCaptcha");
    if (!img) return false;
    // Find nearby button with title/refresh
    const parent = img.parentElement;
    if (!parent) return false;
    const buttons = parent.querySelectorAll("button, a, i, span");
    for (const b of buttons) {
      const t = (b.getAttribute("title") || b.className || b.id || "").toLowerCase();
      if (t.includes("refresh") || t.includes("reload") || t.includes("captcha")) {
        b.click();
        return true;
      }
    }
    // Fallback: force new captcha URL
    img.src = "https://services.gst.gov.in/services/captcha?rnd=" + Math.random();
    return true;
  });
  if (!clicked) {
    await page.locator("#imgCaptcha").evaluate((img) => {
      img.src = "https://services.gst.gov.in/services/captcha?rnd=" + Math.random();
    });
  }
  await page.waitForTimeout(1000);
}

function parseGstField(bodyText, label) {
  // GST result rows look like: "Status\tPending for Processing"
  const re = new RegExp(`${label}\\s*[:：]?\\s*\\t\\s*([^\\n]+)`, "i");
  const m = bodyText.match(re) || bodyText.match(new RegExp(`${label}\\s*[:：]\\s*([^\\n]+)`, "i"));
  if (!m) return null;
  return m[1].replace(/\s+/g, " ").trim();
}

function parseGstStatus(bodyText) {
  const status = parseGstField(bodyText, "Status");
  if (status && !/^status$/i.test(status)) return status;
  if (/Pending for Processing/i.test(bodyText)) return "Pending for Processing";
  return null;
}

async function checkGst(browser) {
  console.log("\n----- 2) GST APPLICATION STATUS -----");
  console.log("Opening GST ARN status page…");

  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    ignoreHTTPSErrors: true,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(60000);

  try {
    await page.goto(GST_URL, { waitUntil: "networkidle", timeout: 90000 });
    await page.waitForTimeout(1000);

    await page.locator("#ifARN").check({ force: true }).catch(() => {});
    await page.locator("#arnp").fill(GST_ARN);

    // Captcha appears after ARN is entered
    await page.locator("#imgCaptcha").waitFor({ state: "visible", timeout: 20000 });
    await page.locator("#fo-captcha").waitFor({ state: "visible", timeout: 20000 });

    const maxAttempts = 5;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await page.waitForTimeout(500);
      const captchaBuf = await page.locator("#imgCaptcha").screenshot();
      let code = await ocrGstCaptcha(captchaBuf);

      if (code) {
        console.log(`OCR captcha guess (attempt ${attempt}): ${code}`);
        const override = await ask("Press Enter to use guess, OR type captcha from browser: ");
        if (override) code = override;
      } else {
        console.log(`Look at the captcha in the browser (attempt ${attempt}/${maxAttempts}).`);
        code = await ask("Type the captcha numbers here, then press Enter: ");
      }

      if (!code) {
        console.log("Empty captcha — refreshing…");
        await refreshGstCaptcha(page);
        continue;
      }

      await page.locator("#arnp").fill(GST_ARN);
      await page.locator("#fo-captcha").fill("");
      await page.locator("#fo-captcha").fill(code);
      await page.locator("#arnpreSearch").click();
      await page.waitForTimeout(3000);

      const body = await page.locator("body").innerText();

      if (/Enter valid Letters|Please enter the mandatory fields|Invalid Captcha|invalid captcha/i.test(body)
          && !/Pending for Processing|Approved|Rejected|Form No/i.test(body)) {
        console.log("Captcha rejected. Refreshing and retrying…");
        await refreshGstCaptcha(page);
        await page.locator("#fo-captcha").fill("");
        continue;
      }

      const status = parseGstStatus(body);
      if (!status) {
        throw new Error("GST search ran but Status was not found on the page");
      }

      return {
        arn: GST_ARN,
        status,
        formNo: parseGstField(body, "Form No\\.?"),
        formDesc: parseGstField(body, "Form Description"),
        submission: parseGstField(body, "Submission Date"),
      };
    }

    throw new Error("Failed to solve GST captcha after several attempts");
  } finally {
    await context.close();
  }
}

/* -------------------- Main -------------------- */

async function main() {
  const browser = await chromium.launch({ headless: false, slowMo: 40 });
  const results = { passport: null, gst: null };

  try {
    results.passport = await checkPassport(browser);
    results.gst = await checkGst(browser);

    console.log("\n========== FINAL STATUS ==========");
    console.log("1) PASSPORT");
    if (results.passport.fileNumber) {
      console.log("   File Number         :", results.passport.fileNumber);
    }
    console.log("   Payment Status     :", results.passport.paymentStatus);
    console.log("   Application Status :", results.passport.applicationStatus);
    console.log("");
    console.log("2) GST");
    console.log("   ARN                :", results.gst.arn);
    if (results.gst.formNo) console.log("   Form No.           :", results.gst.formNo);
    if (results.gst.formDesc) console.log("   Form Description   :", results.gst.formDesc);
    if (results.gst.submission) console.log("   Submission Date    :", results.gst.submission);
    console.log("   Application Status :", results.gst.status);
    console.log("==================================\n");
  } catch (err) {
    console.error("\nFailed:", err.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
