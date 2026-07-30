"""
Lightweight Passport / GST status checker (Render-friendly).

  python check_status.py --gst-only --headless --json
"""

from __future__ import annotations

import argparse
import gc
import io
import json
import os
import re
import sys
import time

import ddddocr
from dotenv import load_dotenv
from PIL import Image
from playwright.sync_api import sync_playwright

load_dotenv()

LOGIN_URL = "https://services1.passportindia.gov.in/forms/login"
GST_URL = "https://services.gst.gov.in/services/arnstatus"

# Low-RAM Chromium flags for 512MB Render instances
CHROME_ARGS = [
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--no-sandbox",
    "--single-process",
    "--no-zygote",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-default-apps",
    "--disable-sync",
    "--disable-translate",
    "--mute-audio",
    "--no-first-run",
    "--renderer-process-limit=1",
    "--disable-features=TranslateUI,BlinkGenPropertyTrees,IsolateOrigins,site-per-process",
    "--js-flags=--max-old-space-size=96",
]


def env(name: str, default: str = "") -> str:
    return (os.getenv(name) or default).strip()


def digits_only(text: str) -> str:
    return re.sub(r"\D", "", text or "")


def alnum_only(text: str) -> str:
    return re.sub(r"[^A-Za-z0-9]", "", text or "")


def value_after_label(body: str, label: str) -> str | None:
    m = re.search(
        rf"{label}\s*\n\s*-\s*\n\s*([\s\S]*?)(?=\n\s*[A-Z][A-Za-z /()]+\s*\n\s*-\s*\n|\n\s*Close\b|\n\s*Home\b|$)",
        body,
        re.I,
    )
    if not m:
        return None
    return re.sub(r"\s+", " ", m.group(1)).strip()


def click_exact(page, text: str) -> None:
    pressable = page.locator('div[tabindex="0"]').filter(
        has_text=re.compile(rf"^{re.escape(text)}$")
    )
    if pressable.count():
        pressable.first.click(force=True)
    else:
        page.get_by_text(text, exact=True).first.click(force=True)


def launch_browser(playwright, headless: bool):
    return playwright.chromium.launch(
        headless=headless,
        args=CHROME_ARGS,
        chromium_sandbox=False,
    )


PASSPORT_STEALTH_JS = """
Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
Object.defineProperty(navigator, 'languages', { get: () => ['en-IN', 'en-US', 'en'] });
Object.defineProperty(navigator, 'plugins', {
  get: () => [1, 2, 3, 4, 5].map(() => ({ name: 'plugin', filename: 'internal' })),
});
window.chrome = window.chrome || { runtime: {} };
const origQuery = window.navigator.permissions && window.navigator.permissions.query;
if (origQuery) {
  window.navigator.permissions.query = (parameters) => (
    parameters && parameters.name === 'notifications'
      ? Promise.resolve({ state: Notification.permission })
      : origQuery(parameters)
  );
}
"""


REALISTIC_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
)


def check_passport(browser, username: str, password: str, file_no: str) -> dict:
    print("Passport: signing in…", flush=True)
    context = browser.new_context(
        viewport={"width": 1280, "height": 800},
        user_agent=REALISTIC_UA,
        locale="en-IN",
        timezone_id="Asia/Kolkata",
        ignore_https_errors=True,
    )
    context.add_init_script(PASSPORT_STEALTH_JS)
    page = context.new_page()
    page.set_default_timeout(45000)

    try:
        page.goto(LOGIN_URL, wait_until="networkidle", timeout=60000)
        try:
            page.wait_for_selector('input[type="password"]', timeout=45000)
        except Exception:
            # Sometimes login UI is inside iframe/lazy — try one more time
            page.wait_for_load_state("networkidle", timeout=15000)
            page.wait_for_selector('input[type="password"]', timeout=15000)
        # Prefer password login if OTP / Password tabs exist
        for label in ("Password", "Login with Password"):
            tab = page.get_by_text(label, exact=True)
            if tab.count():
                for i in range(min(tab.count(), 3)):
                    try:
                        tab.nth(i).click(force=True)
                        time.sleep(0.4)
                        break
                    except Exception:
                        continue
                break
        page.locator('input[type="text"]').first.fill(username)
        page.locator('input[type="password"]').first.fill(password)

        clicked = False
        for locator in (
            page.locator('div[tabindex="0"]').filter(
                has_text=re.compile(r"^\s*Sign\s*In\s*$", re.I)
            ),
            page.get_by_role("button", name=re.compile(r"^\s*Sign\s*In\s*$", re.I)),
            page.locator("button, input[type=submit]").filter(
                has_text=re.compile(r"Sign\s*In", re.I)
            ),
        ):
            try:
                if locator.count():
                    locator.first.click(force=True)
                    clicked = True
                    break
            except Exception:
                continue
        if not clicked:
            page.get_by_text("Sign In", exact=True).first.click(force=True)

        try:
            page.wait_for_url(re.compile(r"Home|homeScreen", re.I), timeout=45000)
        except Exception:
            body = page.locator("body").inner_text()
            if re.search(r"invalid\s+(?:captcha|user\s*id|password)", body, re.I):
                raise RuntimeError("Passport site rejected the login credentials/captcha.")
            if re.search(r"captcha", body, re.I):
                raise RuntimeError("Passport login requires captcha (headless mode blocked).")
            raise RuntimeError("Passport login did not complete (site blocked headless login).")
        page.wait_for_function(
            "() => /Submitted Applications|Welcome back/i.test(document.body.innerText)",
            timeout=45000,
        )

        print("Passport: opening application…", flush=True)
        views = page.locator('div[tabindex="0"]').filter(has_text=re.compile(r"^View$"))
        clicked = False
        if file_no and views.count():
            for i in range(views.count()):
                btn = views.nth(i)
                if btn.evaluate(
                    """(el, fileNo) => {
                        let n = el;
                        for (let d = 0; d < 12 && n; d++) {
                          if ((n.innerText || '').includes(fileNo)) return true;
                          n = n.parentElement;
                        }
                        return false;
                    }""",
                    file_no,
                ):
                    btn.click(force=True)
                    clicked = True
                    break
        if not clicked:
            if views.count():
                views.first.click(force=True)
            else:
                page.get_by_text("View", exact=True).first.click(force=True)

        page.wait_for_url(re.compile(r"UserApplicationsDetails", re.I), timeout=45000)
        details = page.locator("body").inner_text()
        payment = value_after_label(details, "Payment Status") or "(not found)"

        click_exact(page, "Track Application Status")
        page.wait_for_url(re.compile(r"TrackApplication", re.I), timeout=45000)
        body = page.locator("body").inner_text()
        status = value_after_label(body, "Status")
        if not status:
            raise RuntimeError("Could not read Passport Status")
        return {
            "file_number": value_after_label(body, "File Number"),
            "payment_status": payment,
            "application_status": status,
        }
    finally:
        context.close()


class CaptchaSolver:
    """Fast solver: raw OCR + one preprocessed pass; picks the ~6-char guess."""

    def __init__(self) -> None:
        print("Loading OCR…", flush=True)
        self.ocr = ddddocr.DdddOcr(show_ad=False)

    @staticmethod
    def _preprocess(png: bytes) -> bytes:
        try:
            img = Image.open(io.BytesIO(png)).convert("L")
            w, h = img.size
            img = img.resize((w * 2, h * 2), Image.LANCZOS)
            buf = io.BytesIO()
            img.convert("RGB").save(buf, format="PNG")
            return buf.getvalue()
        except Exception:
            return png

    def _ocr(self, data: bytes) -> str:
        try:
            raw = self.ocr.classification(data) or ""
        except Exception:
            raw = ""
        return alnum_only(raw)[:8]

    def guess(self, png: bytes) -> str:
        candidates: list[str] = []
        for data in (png, self._preprocess(png)):
            code = self._ocr(data)
            if code and code not in candidates:
                candidates.append(code)
        if not candidates:
            return ""
        # Prefer 6-char, then 5-char, then longest
        candidates.sort(key=lambda g: (abs(len(g) - 6), -len(g)))
        return candidates[0]


GST_FIELD_BLACKLIST = {
    "-",
    "search",
    "back",
    "close",
    "home",
    "track application status",
    "track return status",
    "track payment status",
    "logout",
    "help",
}

KNOWN_GST_STATUSES = [
    "Pending for Processing",
    "Pending for Order",
    "Pending for Clarification",
    "Clarification filed - Pending for Order",
    "Approved",
    "Rejected",
    "Migrated",
    "Cancelled",
    "Provisional",
    "Withdrawn",
    "Validation Error",
]


def parse_gst_field(body: str, label: str) -> str | None:
    # Anchor label at line start so "Track Application Status" is never matched
    anchor = r"(?:^|\n)\s*"
    patterns = [
        rf"{anchor}{label}\s*[:：]?\s*\t+\s*([^\n\t]+)",
        rf"{anchor}{label}\s*[:：]\s*([^\n]+)",
        rf"{anchor}{label}\s*\n\s*([^\n]+)",
    ]
    for pat in patterns:
        for m in re.finditer(pat, body, re.I):
            value = re.sub(r"\s+", " ", m.group(1)).strip().strip("|:")
            if not value:
                continue
            low = value.lower()
            if low == label.lower() or low in GST_FIELD_BLACKLIST:
                continue
            return value
    return None


def detect_gst_status(body: str) -> str | None:
    for name in KNOWN_GST_STATUSES:
        if re.search(rf"\b{re.escape(name)}\b", body, re.I):
            return name
    return parse_gst_field(body, "Status")


def refresh_gst_captcha(page) -> None:
    try:
        page.locator("button").filter(has=page.locator("i.fa-refresh")).first.click(
            force=True
        )
    except Exception:
        try:
            page.locator("#imgCaptcha").click(force=True)
        except Exception:
            pass


OUTCOME_JS = (
    "() => {"
    "const t = document.body.innerText;"
    "return /Search Result based on ARN|Pending for Processing|Pending for Order|"
    "Approved|Rejected|Provisional|Migrated|Cancelled|invalid\\s+captcha|"
    "please\\s+enter\\s+valid\\s+captcha/i.test(t);"
    "}"
)


def check_gst(browser, solver: CaptchaSolver, arn: str) -> dict:
    print("GST: opening ARN page…", flush=True)
    context = browser.new_context(
        viewport={"width": 800, "height": 600},
        ignore_https_errors=True,
    )
    page = context.new_page()
    page.set_default_timeout(20000)

    try:
        page.goto(GST_URL, wait_until="domcontentloaded", timeout=25000)
        page.locator("#ifARN").check(force=True)
        page.locator("#arnp").fill(arn)
        page.locator("#imgCaptcha").wait_for(state="visible", timeout=10000)

        for attempt in range(1, 13):
            png = page.locator("#imgCaptcha").screenshot()
            code = solver.guess(png)
            print(f"GST try {attempt}: {code!r}", flush=True)

            if not code or len(code) < 4:
                refresh_gst_captcha(page)
                page.wait_for_timeout(300)
                continue

            page.locator("#fo-captcha").fill(code)
            page.locator("#arnpreSearch").click()

            # Event-driven wait: as soon as the page shows a result or an error
            try:
                page.wait_for_function(OUTCOME_JS, timeout=5000)
            except Exception:
                pass

            body = page.locator("body").inner_text()
            status = detect_gst_status(body)
            form_no = parse_gst_field(body, r"Form No\.?")
            form_desc = parse_gst_field(body, "Form Description")
            submission = parse_gst_field(
                body, r"(?:Date of Submission|Submission Date)"
            )
            has_known_status = any(
                s.lower() in body.lower() for s in KNOWN_GST_STATUSES
            )
            result_visible = (
                "Search Result based on ARN" in body
                or has_known_status
                or (status and (form_no or submission))
            )
            if result_visible and status:
                return {
                    "arn": arn,
                    "status": status,
                    "form_no": form_no,
                    "form_desc": form_desc,
                    "submission": submission,
                }

            refresh_gst_captcha(page)
            page.wait_for_timeout(250)

        raise RuntimeError("Could not solve GST captcha")
    finally:
        context.close()


def format_status_message(passport: dict | None, gst: dict | None) -> str:
    lines = ["========== STATUS =========="]
    if passport:
        lines.append("PASSPORT")
        if passport.get("error"):
            lines.append(f"  Error: {passport['error']}")
        else:
            lines += [
                f"  File: {passport.get('file_number') or '-'}",
                f"  Payment: {passport.get('payment_status')}",
                f"  Status: {passport.get('application_status')}",
            ]
    if gst:
        if passport:
            lines.append("")
        lines.append("GST")
        if gst.get("error"):
            lines += [f"  ARN: {gst.get('arn') or '-'}", f"  Error: {gst['error']}"]
        else:
            lines += [
                f"  ARN: {gst.get('arn')}",
                f"  Form: {gst.get('form_no') or '-'}",
                f"  Submitted: {gst.get('submission') or '-'}",
                f"  Status: {gst.get('status')}",
            ]
    lines.append("============================")
    return "\n".join(lines)


def run_status_check(headless: bool = False, gst_only: bool = True) -> dict:
    username = env("PASSPORT_USER")
    password = env("PASSPORT_PASS")
    file_no = env("PASSPORT_FILE_NO")
    arn = env("GST_ARN")

    if not arn:
        raise RuntimeError("Missing GST_ARN")

    solver = CaptchaSolver()
    passport = None
    gst = None
    gst_error = None

    with sync_playwright() as p:
        # One browser at a time — frees RAM between steps
        if not gst_only:
            if not all([username, password, file_no]):
                passport = {"error": "Missing passport credentials"}
            else:
                browser = launch_browser(p, headless)
                try:
                    passport = check_passport(browser, username, password, file_no)
                except Exception as exc:
                    raw = str(exc) or "Passport check failed"
                    # Trim Playwright's verbose "===logs===" section
                    friendly = raw.split("\n")[0].strip()
                    if "Timeout" in friendly and "exceeded" in friendly:
                        friendly = "Passport site blocked headless login (bot detection)."
                    passport = {"error": friendly}
                    print(f"Passport failed: {friendly}", flush=True)
                finally:
                    browser.close()
                    gc.collect()

        browser = launch_browser(p, headless)
        try:
            gst = check_gst(browser, solver, arn)
        except Exception as exc:
            gst_error = str(exc) or "GST check failed"
            print(f"GST failed: {gst_error}", flush=True)
        finally:
            browser.close()
            gc.collect()

    if gst is None and passport is None:
        raise RuntimeError(gst_error or "No status returned")
    if gst is None:
        gst = {"arn": arn, "error": gst_error or "GST check failed"}
    return {"passport": passport, "gst": gst}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--headless", action="store_true")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--gst-only", action="store_true", help="Only check GST (default for API)")
    parser.add_argument("--with-passport", action="store_true", help="Also check passport")
    args = parser.parse_args()
    # Default: GST only. Passport runs ONLY with explicit --with-passport.
    gst_only = not args.with_passport
    print(f"Mode: {'GST only' if gst_only else 'Passport + GST'}", flush=True)

    if args.json:
        sys.stdout = sys.stderr

    try:
        result = run_status_check(headless=args.headless, gst_only=gst_only)
        message = format_status_message(result.get("passport"), result.get("gst"))
        if args.json:
            sys.stdout = sys.__stdout__
            print(json.dumps({"ok": True, "message": message, **result}))
        else:
            print("\n" + message + "\n")
    except Exception as exc:
        if args.json:
            sys.stdout = sys.__stdout__
            print(json.dumps({"ok": False, "error": str(exc)}))
            sys.exit(1)
        raise


if __name__ == "__main__":
    main()
