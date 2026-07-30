"""
Auto status checker
  1) Passport Seva application status
  2) GST ARN status (captcha solved via audio Whisper + image OCR)

Usage:
  python check_status.py
  python check_status.py --headless --json
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import time

import cv2
import ddddocr
import numpy as np
from dotenv import load_dotenv
from playwright.sync_api import sync_playwright

load_dotenv()

HAS_FFMPEG = bool(shutil.which("ffmpeg"))

LOGIN_URL = "https://services1.passportindia.gov.in/forms/login"
GST_URL = "https://services.gst.gov.in/services/arnstatus"

USERNAME = os.getenv("PASSPORT_USER", "ABHISHEKSHPS@GMAIL.COM")
PASSWORD = os.getenv("PASSPORT_PASS", "Mpasspw@01")
FILE_NO = os.getenv("PASSPORT_FILE_NO", "LKN067803930926")
GST_ARN = os.getenv("GST_ARN", "AA090726251099S")


def digits_only(text: str) -> str:
    return re.sub(r"\D", "", text or "")


def word_to_digit(w: str) -> str:
    mapping = {
        "zero": "0",
        "oh": "0",
        "o": "0",
        "one": "1",
        "two": "2",
        "three": "3",
        "four": "4",
        "five": "5",
        "six": "6",
        "seven": "7",
        "eight": "8",
        "nine": "9",
        "to": "2",
        "for": "4",
    }
    return mapping.get(w.lower().strip(), "")


def parse_spoken(text: str) -> str:
    text = (text or "").lower()
    d = digits_only(text)
    if len(d) >= 5:
        return d
    out = []
    for p in re.findall(r"[a-z0-9]+", text):
        if p.isdigit():
            out.append(p)
        else:
            dig = word_to_digit(p)
            if dig:
                out.append(dig)
    return "".join(out)


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
    pressable = page.locator('div[tabindex="0"]').filter(has_text=re.compile(rf"^{re.escape(text)}$"))
    if pressable.count():
        pressable.first.click(force=True)
    else:
        page.get_by_text(text, exact=True).first.click(force=True)


# -------------------- Passport --------------------


def check_passport(browser) -> dict:
    print("\n----- 1) PASSPORT STATUS -----")
    context = browser.new_context(viewport={"width": 1280, "height": 900}, ignore_https_errors=True)
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
        user.click()
        user.fill("")
        user.type(USERNAME, delay=15)
        pwd.click()
        pwd.fill("")
        pwd.type(PASSWORD, delay=15)
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
                f"Passport login did not reach Home screen. {exc}. Page text: {snippet or '(empty)'}"
            ) from exc
        time.sleep(1.2)

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
        time.sleep(0.8)

        details = page.locator("body").inner_text()
        payment = value_after_label(details, "Payment Status") or "(not found)"

        print("Opening Track Application Status…", flush=True)
        click_exact(page, "Track Application Status")
        page.wait_for_url(re.compile(r"TrackApplication", re.I), timeout=60000)
        page.wait_for_function(
            "() => /Status Tracker/i.test(document.body.innerText)",
            timeout=60000,
        )
        time.sleep(0.6)

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


# -------------------- GST captcha --------------------


class CaptchaSolver:
    def __init__(self):
        print("Loading captcha models (first run can take a minute)…")
        self.ocr = ddddocr.DdddOcr(show_ad=False)
        self.ocr_beta = ddddocr.DdddOcr(show_ad=False, beta=True)
        self.whisper = None
        if HAS_FFMPEG:
            import whisper

            self.whisper = whisper.load_model("tiny")
        else:
            print("ffmpeg not in PATH — audio captcha disabled (image OCR only).")

    def ocr_image(self, png: bytes) -> str:
        cands = [
            digits_only(self.ocr.classification(png)),
            digits_only(self.ocr_beta.classification(png)),
        ]
        bgr = cv2.imdecode(np.frombuffer(png, np.uint8), cv2.IMREAD_COLOR)
        if bgr is None:
            return max(cands, key=len) if any(cands) else ""

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
            cands.append(digits_only(self.ocr.classification(buf.tobytes())))
            cands.append(digits_only(self.ocr_beta.classification(buf.tobytes())))

        for c in cands:
            if len(c) == 6:
                return c
        cands = [c for c in cands if c]
        return max(cands, key=len) if cands else ""

    def ocr_audio(self, mp3_path: str) -> tuple[str, str]:
        if not self.whisper:
            return "", ""
        try:
            result = self.whisper.transcribe(mp3_path, language="en", fp16=False)
            spoken = result.get("text", "")
            guess = parse_spoken(spoken)
            return spoken, guess
        except FileNotFoundError:
            print("ffmpeg not found — skipping audio captcha, using image OCR only.")
            return "", ""
        except Exception as exc:
            print(f"Audio captcha failed ({exc}) — using image OCR only.")
            return "", ""

    def pick_code(self, audio_guess: str, image_guess: str) -> str:
        # Prefer agreement
        if audio_guess and audio_guess == image_guess and len(audio_guess) >= 5:
            return audio_guess
        for cand in (audio_guess, image_guess):
            if len(cand) == 6:
                return cand
        for cand in (audio_guess, image_guess):
            if len(cand) >= 5:
                return cand[:6]
        return audio_guess or image_guess or ""


def parse_gst_field(body: str, label: str) -> str | None:
    m = re.search(rf"{label}\s*[:：]?\s*\t\s*([^\n]+)", body, re.I)
    if not m:
        m = re.search(rf"{label}\s*[:：]\s*([^\n]+)", body, re.I)
    if not m:
        return None
    return re.sub(r"\s+", " ", m.group(1)).strip()


def check_gst(browser, solver: CaptchaSolver) -> dict:
    print("\n----- 2) GST APPLICATION STATUS -----")
    context = browser.new_context(viewport={"width": 1280, "height": 900}, ignore_https_errors=True)
    page = context.new_page()
    page.set_default_timeout(60000)

    try:
        print("Opening GST ARN page…", flush=True)
        page.goto(GST_URL, wait_until="domcontentloaded", timeout=90000)
        time.sleep(0.8)
        page.locator("#ifARN").check(force=True)
        page.locator("#arnp").fill(GST_ARN)
        page.locator("#imgCaptcha").wait_for(state="visible", timeout=20000)
        time.sleep(0.6)

        for attempt in range(1, 10):
            png = page.locator("#imgCaptcha").screenshot()
            image_guess = solver.ocr_image(png)

            spoken, audio_guess = "", ""
            if solver.whisper:
                audio_bytes = bytes(
                    page.evaluate(
                        """async () => {
                            const r = await fetch('/services/audiocaptcha', {credentials:'same-origin'});
                            const buf = await r.arrayBuffer();
                            return Array.from(new Uint8Array(buf));
                        }"""
                    )
                )
                mp3_path = os.path.join(os.path.dirname(__file__), "captcha-audio.mp3")
                with open(mp3_path, "wb") as f:
                    f.write(audio_bytes)
                spoken, audio_guess = solver.ocr_audio(mp3_path)

            code = solver.pick_code(audio_guess, image_guess)
            print(f"[{attempt}] image={image_guess!r} audio={audio_guess!r} ({spoken.strip()!r}) -> {code!r}")

            if not code:
                page.locator("button").filter(has=page.locator("i.fa-refresh")).click()
                time.sleep(1.0)
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
                print("Captcha rejected, refreshing…")
                page.locator("button").filter(has=page.locator("i.fa-refresh")).click()
                time.sleep(1.0)
                continue

            print("Unexpected response, refreshing captcha…")
            page.locator("button").filter(has=page.locator("i.fa-refresh")).click()
            time.sleep(1.0)

        raise RuntimeError("Could not solve GST captcha after several attempts")
    finally:
        context.close()


def format_status_message(passport: dict, gst: dict) -> str:
    lines = [
        "========== FINAL STATUS ==========",
        "1) PASSPORT",
    ]
    if passport.get("file_number"):
        lines.append(f"   File Number         : {passport['file_number']}")
    lines.append(f"   Payment Status     : {passport['payment_status']}")
    lines.append(f"   Application Status : {passport['application_status']}")
    lines.append("")
    lines.append("2) GST")
    lines.append(f"   ARN                : {gst['arn']}")
    if gst.get("form_no"):
        lines.append(f"   Form No.           : {gst['form_no']}")
    if gst.get("form_desc"):
        lines.append(f"   Form Description   : {gst['form_desc']}")
    if gst.get("submission"):
        lines.append(f"   Submission Date    : {gst['submission']}")
    lines.append(f"   Application Status : {gst['status']}")
    lines.append("==================================")
    return "\n".join(lines)


def run_status_check(headless: bool = False) -> dict:
    solver = CaptchaSolver()
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=headless, slow_mo=0 if headless else 40)
        try:
            passport = check_passport(browser)
            gst = check_gst(browser, solver)
            return {"passport": passport, "gst": gst}
        finally:
            browser.close()


def main() -> None:
    parser = argparse.ArgumentParser(description="Check Passport + GST application status")
    parser.add_argument("--headless", action="store_true", help="Run browser without UI")
    parser.add_argument("--json", action="store_true", help="Print results as JSON on stdout")
    args = parser.parse_args()

    # Keep progress logs off stdout so --json output stays machine-readable
    if args.json:
        sys.stdout = sys.stderr

    try:
        result = run_status_check(headless=args.headless)
        passport = result["passport"]
        gst = result["gst"]
        message = format_status_message(passport, gst)

        if args.json:
            sys.stdout = sys.__stdout__
            print(
                json.dumps(
                    {
                        "ok": True,
                        "message": message,
                        "passport": passport,
                        "gst": gst,
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
