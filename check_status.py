"""
Lightweight Passport / GST status checker (Render-friendly).

  python check_status.py --gst-only --headless --json
"""

from __future__ import annotations

import argparse
import gc
import json
import os
import re
import sys
import time

import ddddocr
from dotenv import load_dotenv
from playwright.sync_api import sync_playwright

load_dotenv()

LOGIN_URL = "https://services1.passportindia.gov.in/forms/login"
GST_URL = "https://services.gst.gov.in/services/arnstatus"

# Low-RAM Chromium flags for 512MB Render instances
CHROME_ARGS = [
    "--disable-dev-shm-usage",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-default-apps",
    "--disable-sync",
    "--disable-translate",
    "--mute-audio",
    "--no-first-run",
    "--renderer-process-limit=1",
    "--disable-features=TranslateUI,BlinkGenPropertyTrees",
    "--js-flags=--max-old-space-size=96",
]


def env(name: str, default: str = "") -> str:
    return (os.getenv(name) or default).strip()


def digits_only(text: str) -> str:
    return re.sub(r"\D", "", text or "")


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


def check_passport(browser, username: str, password: str, file_no: str) -> dict:
    print("Passport: signing in…", flush=True)
    context = browser.new_context(
        viewport={"width": 1024, "height": 720},
        ignore_https_errors=True,
    )
    page = context.new_page()
    page.set_default_timeout(45000)

    try:
        page.goto(LOGIN_URL, wait_until="domcontentloaded", timeout=60000)
        page.wait_for_selector('input[type="password"]', timeout=45000)
        page.locator('input[type="text"]').first.fill(username)
        page.locator('input[type="password"]').first.fill(password)
        click_exact(page, "Sign In")
        page.wait_for_url(re.compile(r"Home|homeScreen", re.I), timeout=60000)
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
    """Single OCR model — keeps RAM low on free Render."""

    def __init__(self) -> None:
        print("Loading OCR…", flush=True)
        self.ocr = ddddocr.DdddOcr(show_ad=False)

    def ocr_image(self, png: bytes) -> str:
        code = digits_only(self.ocr.classification(png))
        if len(code) >= 5:
            return code[:6]
        return code


def parse_gst_field(body: str, label: str) -> str | None:
    m = re.search(rf"{label}\s*[:：]?\s*\t\s*([^\n]+)", body, re.I) or re.search(
        rf"{label}\s*[:：]\s*([^\n]+)", body, re.I
    )
    return re.sub(r"\s+", " ", m.group(1)).strip() if m else None


def check_gst(browser, solver: CaptchaSolver, arn: str) -> dict:
    print("GST: opening ARN page…", flush=True)
    context = browser.new_context(
        viewport={"width": 1024, "height": 720},
        ignore_https_errors=True,
    )
    page = context.new_page()
    page.set_default_timeout(45000)

    try:
        page.goto(GST_URL, wait_until="domcontentloaded", timeout=60000)
        page.locator("#ifARN").check(force=True)
        page.locator("#arnp").fill(arn)
        page.locator("#imgCaptcha").wait_for(state="visible", timeout=20000)

        for attempt in range(1, 7):
            code = solver.ocr_image(page.locator("#imgCaptcha").screenshot())
            print(f"GST captcha try {attempt}: {code!r}", flush=True)
            if not code:
                page.locator("button").filter(has=page.locator("i.fa-refresh")).click()
                time.sleep(0.8)
                continue

            page.locator("#arnp").fill(arn)
            page.locator("#fo-captcha").fill(code)
            page.locator("#arnpreSearch").click()
            time.sleep(2.2)
            body = page.locator("body").inner_text()

            if "Search Result based on ARN" in body or "Pending for Processing" in body:
                status = parse_gst_field(body, "Status") or (
                    "Pending for Processing" if "Pending for Processing" in body else None
                )
                if not status:
                    raise RuntimeError("GST Status not found")
                return {
                    "arn": arn,
                    "status": status,
                    "form_no": parse_gst_field(body, r"Form No\.?"),
                    "form_desc": parse_gst_field(body, "Form Description"),
                    "submission": parse_gst_field(body, "Submission Date"),
                }

            page.locator("button").filter(has=page.locator("i.fa-refresh")).click()
            time.sleep(0.8)

        raise RuntimeError("Could not solve GST captcha")
    finally:
        context.close()


def format_status_message(passport: dict | None, gst: dict | None) -> str:
    lines = ["========== STATUS =========="]
    if passport:
        lines += [
            "PASSPORT",
            f"  File: {passport.get('file_number') or '-'}",
            f"  Payment: {passport.get('payment_status')}",
            f"  Status: {passport.get('application_status')}",
        ]
    if gst:
        if passport:
            lines.append("")
        lines += [
            "GST",
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
    if not gst_only and not all([username, password, file_no]):
        raise RuntimeError("Missing passport credentials")

    solver = CaptchaSolver()
    passport = None
    gst = None

    with sync_playwright() as p:
        # One browser at a time — frees RAM between steps
        if not gst_only:
            browser = launch_browser(p, headless)
            try:
                passport = check_passport(browser, username, password, file_no)
            finally:
                browser.close()
                gc.collect()

        browser = launch_browser(p, headless)
        try:
            gst = check_gst(browser, solver, arn)
        finally:
            browser.close()
            gc.collect()

    return {"passport": passport, "gst": gst}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--headless", action="store_true")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--gst-only", action="store_true", help="Only check GST (lighter RAM)")
    parser.add_argument("--with-passport", action="store_true", help="Also check passport")
    args = parser.parse_args()
    gst_only = args.gst_only or not args.with_passport

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
