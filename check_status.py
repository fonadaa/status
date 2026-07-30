"""
Passport Seva + GST ARN status checker.

  python check_status.py
  python check_status.py --headless --json
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time

import cv2
import ddddocr
import numpy as np
from dotenv import load_dotenv
from playwright.sync_api import sync_playwright

load_dotenv()

LOGIN_URL = "https://services1.passportindia.gov.in/forms/login"
GST_URL = "https://services.gst.gov.in/services/arnstatus"

USERNAME = os.getenv("PASSPORT_USER", "")
PASSWORD = os.getenv("PASSPORT_PASS", "")
FILE_NO = os.getenv("PASSPORT_FILE_NO", "")
GST_ARN = os.getenv("GST_ARN", "")


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


def refresh_gst_captcha(page) -> None:
    page.locator("button").filter(has=page.locator("i.fa-refresh")).click()
    time.sleep(1.0)


def check_passport(browser) -> dict:
    print("\n----- 1) PASSPORT STATUS -----", flush=True)
    context = browser.new_context(
        viewport={"width": 1280, "height": 900}, ignore_https_errors=True
    )
    page = context.new_page()
    page.set_default_timeout(60000)
    page.on("dialog", lambda d: d.accept())

    try:
        print("Signing in…", flush=True)
        page.goto(LOGIN_URL, wait_until="domcontentloaded", timeout=90000)
        page.wait_for_selector('input[type="password"]', timeout=60000)
        time.sleep(1)

        user = page.locator('input[type="text"]').first
        pwd = page.locator('input[type="password"]').first
        user.fill(USERNAME)
        pwd.fill(PASSWORD)
        click_exact(page, "Sign In")

        try:
            page.wait_for_url(re.compile(r"Home|homeScreen", re.I), timeout=90000)
            page.wait_for_function(
                "() => /Submitted Applications|Welcome back/i.test(document.body.innerText)",
                timeout=60000,
            )
        except Exception as exc:
            snippet = ""
            try:
                snippet = re.sub(r"\s+", " ", page.locator("body").inner_text())[:240]
            except Exception:
                pass
            raise RuntimeError(
                f"Passport login failed. {exc}. Page: {snippet or '(empty)'}"
            ) from exc

        print("Opening application (View)…", flush=True)
        page.wait_for_function(
            "(fileNo) => !fileNo || document.body.innerText.includes(fileNo)",
            arg=FILE_NO,
            timeout=30000,
        )

        views = page.locator('div[tabindex="0"]').filter(has_text=re.compile(r"^View$"))
        clicked = False
        if FILE_NO and views.count():
            for i in range(views.count()):
                btn = views.nth(i)
                has_file = btn.evaluate(
                    """(el, fileNo) => {
                        let node = el;
                        for (let d = 0; d < 12 && node; d++) {
                          if ((node.innerText || '').includes(fileNo)) return true;
                          node = node.parentElement;
                        }
                        return false;
                    }""",
                    FILE_NO,
                )
                if has_file:
                    btn.click(force=True)
                    clicked = True
                    break
        if not clicked:
            if views.count():
                views.first.click(force=True)
            else:
                page.get_by_text("View", exact=True).first.click(force=True)

        page.wait_for_url(re.compile(r"UserApplicationsDetails", re.I), timeout=60000)
        page.wait_for_function(
            "() => /Track Application Status/i.test(document.body.innerText)",
            timeout=60000,
        )

        details = page.locator("body").inner_text()
        payment = value_after_label(details, "Payment Status") or "(not found)"

        print("Opening Track Application Status…", flush=True)
        click_exact(page, "Track Application Status")
        page.wait_for_url(re.compile(r"TrackApplication", re.I), timeout=60000)
        page.wait_for_function(
            "() => /Status Tracker/i.test(document.body.innerText)",
            timeout=60000,
        )

        body = page.locator("body").inner_text()
        status = value_after_label(body, "Status")
        file_no = value_after_label(body, "File Number")
        if not status:
            raise RuntimeError("Could not read Passport Status")

        return {
            "file_number": file_no,
            "payment_status": payment,
            "application_status": status,
        }
    finally:
        context.close()


class CaptchaSolver:
    def __init__(self) -> None:
        print("Loading captcha OCR…", flush=True)
        self.ocr = ddddocr.DdddOcr(show_ad=False)
        self.ocr_beta = ddddocr.DdddOcr(show_ad=False, beta=True)

    def ocr_image(self, png: bytes) -> str:
        cands = [
            digits_only(self.ocr.classification(png)),
            digits_only(self.ocr_beta.classification(png)),
        ]
        bgr = cv2.imdecode(np.frombuffer(png, np.uint8), cv2.IMREAD_COLOR)
        if bgr is None:
            return max((c for c in cands if c), key=len, default="")

        hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
        red = cv2.bitwise_or(
            cv2.inRange(hsv, (0, 60, 40), (15, 255, 255)),
            cv2.inRange(hsv, (160, 60, 40), (180, 255, 255)),
        )
        bgr[red > 0] = (255, 255, 255)
        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
        _, th = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
        big = cv2.resize(th, None, fx=3, fy=3, interpolation=cv2.INTER_CUBIC)
        ok, buf = cv2.imencode(".png", big)
        if ok:
            raw = buf.tobytes()
            cands.append(digits_only(self.ocr.classification(raw)))
            cands.append(digits_only(self.ocr_beta.classification(raw)))

        for c in cands:
            if len(c) == 6:
                return c
        return max((c for c in cands if c), key=len, default="")


def parse_gst_field(body: str, label: str) -> str | None:
    m = re.search(rf"{label}\s*[:：]?\s*\t\s*([^\n]+)", body, re.I) or re.search(
        rf"{label}\s*[:：]\s*([^\n]+)", body, re.I
    )
    if not m:
        return None
    return re.sub(r"\s+", " ", m.group(1)).strip()


def check_gst(browser, solver: CaptchaSolver) -> dict:
    print("\n----- 2) GST APPLICATION STATUS -----", flush=True)
    context = browser.new_context(
        viewport={"width": 1280, "height": 900}, ignore_https_errors=True
    )
    page = context.new_page()
    page.set_default_timeout(60000)

    try:
        print("Opening GST ARN page…", flush=True)
        page.goto(GST_URL, wait_until="domcontentloaded", timeout=90000)
        time.sleep(0.8)
        page.locator("#ifARN").check(force=True)
        page.locator("#arnp").fill(GST_ARN)
        page.locator("#imgCaptcha").wait_for(state="visible", timeout=20000)
        time.sleep(0.5)

        for attempt in range(1, 10):
            code = solver.ocr_image(page.locator("#imgCaptcha").screenshot())
            print(f"[{attempt}] captcha guess={code!r}", flush=True)

            if not code:
                refresh_gst_captcha(page)
                continue

            page.locator("#arnp").fill(GST_ARN)
            page.locator("#fo-captcha").fill(code)
            page.locator("#arnpreSearch").click()
            time.sleep(2.8)

            body = page.locator("body").inner_text()
            if "Search Result based on ARN" in body or "Pending for Processing" in body:
                status = parse_gst_field(body, "Status") or (
                    "Pending for Processing" if "Pending for Processing" in body else None
                )
                if not status:
                    raise RuntimeError("GST result loaded but Status not found")
                return {
                    "arn": GST_ARN,
                    "status": status,
                    "form_no": parse_gst_field(body, r"Form No\.?"),
                    "form_desc": parse_gst_field(body, "Form Description"),
                    "submission": parse_gst_field(body, "Submission Date"),
                }

            if re.search(r"Enter valid Letters|Invalid Captcha|mandatory fields", body, re.I):
                print("Captcha rejected, refreshing…", flush=True)
                refresh_gst_captcha(page)
                continue

            print("Unexpected response, refreshing captcha…", flush=True)
            refresh_gst_captcha(page)

        raise RuntimeError("Could not solve GST captcha after several attempts")
    finally:
        context.close()


def format_status_message(passport: dict, gst: dict) -> str:
    lines = ["========== FINAL STATUS ==========", "1) PASSPORT"]
    if passport.get("file_number"):
        lines.append(f"   File Number         : {passport['file_number']}")
    lines += [
        f"   Payment Status     : {passport['payment_status']}",
        f"   Application Status : {passport['application_status']}",
        "",
        "2) GST",
        f"   ARN                : {gst['arn']}",
    ]
    if gst.get("form_no"):
        lines.append(f"   Form No.           : {gst['form_no']}")
    if gst.get("form_desc"):
        lines.append(f"   Form Description   : {gst['form_desc']}")
    if gst.get("submission"):
        lines.append(f"   Submission Date    : {gst['submission']}")
    lines += [
        f"   Application Status : {gst['status']}",
        "==================================",
    ]
    return "\n".join(lines)


def run_status_check(headless: bool = False) -> dict:
    global USERNAME, PASSWORD, FILE_NO, GST_ARN
    USERNAME = os.getenv("PASSPORT_USER", USERNAME)
    PASSWORD = os.getenv("PASSPORT_PASS", PASSWORD)
    FILE_NO = os.getenv("PASSPORT_FILE_NO", FILE_NO)
    GST_ARN = os.getenv("GST_ARN", GST_ARN)

    if not all([USERNAME, PASSWORD, FILE_NO, GST_ARN]):
        raise RuntimeError("Missing PASSPORT_USER / PASSPORT_PASS / PASSPORT_FILE_NO / GST_ARN")

    solver = CaptchaSolver()
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=headless, slow_mo=0 if headless else 40)
        try:
            return {
                "passport": check_passport(browser),
                "gst": check_gst(browser, solver),
            }
        finally:
            browser.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Check Passport + GST status")
    parser.add_argument("--headless", action="store_true")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    if args.json:
        sys.stdout = sys.stderr

    try:
        result = run_status_check(headless=args.headless)
        message = format_status_message(result["passport"], result["gst"])
        if args.json:
            sys.stdout = sys.__stdout__
            print(
                json.dumps(
                    {
                        "ok": True,
                        "message": message,
                        "passport": result["passport"],
                        "gst": result["gst"],
                    }
                )
            )
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
