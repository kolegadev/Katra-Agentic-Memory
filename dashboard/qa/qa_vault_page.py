#!/usr/bin/env python3
"""Mechanical QA of the Katra Vault Secrets/Approvals dashboard page (Playwright).

Reusable regression harness — run against the live stack:
    python3 dashboard/qa/qa_vault_page.py
Requires: playwright + chromium (pip install playwright && playwright install chromium),
the stack running (health at localhost:9012), and KATRA_API_KEY in the repo .env
(the script reads it from /home/johnpellew/Katra-Agentic-Memory/.env — override
the ENV_PATH constant for other checkouts).

Covers: meta-only list rendering + DOM redaction, form validation, password input
type + clear-after-submit, owner-row visibility toggling, private-with-owner and
team creation flows, XSS adversarial names (onclick quote-breakout + HTML
injection — the F4 escaping fix), rotate flow, approvals grant/revoke,
localStorage hygiene, console errors, throwaway cleanup (real secrets untouched).

Exit code 0 = all checks pass; 1 = at least one check failed.
"""
Mechanical QA of the Katra Vault Secrets/Approvals dashboard page (Playwright).

Covers what manual testing may have missed:
- list rendering (meta-only, no secret material anywhere in the DOM)
- create-form validation, password input type, value cleared after submit
- owner-row visibility toggling (the F10c fix)
- private-with-owner and team creation flows
- XSS adversarial names (quote-breakout + HTML injection) — the F4 fix
- rotate flow (rotation_due_at appears)
- approvals grant/revoke flow
- localStorage hygiene, console errors
- cleanup of all throwaway secrets; REAL secrets never touched.
"""
import re
import sys
from playwright.sync_api import sync_playwright

BASE = "http://localhost:9012/dashboard/"
ENV_PATH = "/home/johnpellew/Katra-Agentic-Memory/.env"

def env(key):
    for line in open(ENV_PATH):
        if line.startswith(key + "="):
            return line.strip().split("=", 1)[1]
    raise RuntimeError(f"{key} not in .env")

ADMIN_KEY = env("KATRA_API_KEY")
V1, V2, V3, VX = "QA-VALUE-9f2c1d4e", "QA-VALUE-team-77aa", "QA-VALUE-rotate-33", "QA-VALUE-xss-4242"
results = []

def check(name, cond, detail=""):
    results.append((name, bool(cond), detail))

def create_and_wait(page):
    page.click('button:has-text("Create Secret")')
    page.wait_for_timeout(2500)
    return page.inner_text("#vault-form-status")

def main():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        console_msgs, dialogs = [], []

        page.on("console", lambda m: console_msgs.append((m.type, m.text)))
        page.on("dialog", lambda d: (dialogs.append((d.type, d.message)), d.accept()))
        page.add_init_script(f"localStorage.setItem('katra_admin_key', {ADMIN_KEY!r});")

        page.goto(BASE, wait_until="domcontentloaded")
        page.click('[data-tab="vault"]')
        page.wait_for_selector("#vault-secrets tr", timeout=15000)
        # pre-clean any qa-* leftovers from earlier runs
        for _ in range(6):
            rows = page.locator("#vault-secrets tr", has_text="qa-")
            if not rows.count(): break
            rows.first.locator("button:has-text('Delete')").click()
            page.wait_for_timeout(800)

        # ── 1. list: real secrets present, meta-only ────────────────────────
        t = page.inner_text("#vault-secrets")
        check("real secret 1 listed (agentmail)", "agentmail-api-key" in t, t[:120])
        check("real secret 2 listed (github PAT)", "Github PAT" in t)
        check("no secret values in list DOM", all(v not in t for v in ("ghp_", "am_us_", "sk-live")))

        # ── 2. form validation ──────────────────────────────────────────────
        page.click('button:has-text("Create Secret")')
        check("empty name → error", "name is required" in page.inner_text("#vault-form-status"))
        page.fill("#vault-name", "qa-mech-1")
        page.click('button:has-text("Create Secret")')
        check("empty value → error", "value is required" in page.inner_text("#vault-form-status"))

        # ── 3. value input type=password; owner-row toggle ──────────────────
        check("value input is password type", page.get_attribute("#vault-value", "type") == "password")
        check("owner row hidden by default (team?)", page.is_hidden("#vault-owner-row"))
        page.select_option("#vault-scope", "private")
        check("owner row visible for private", page.is_visible("#vault-owner-row"))
        page.select_option("#vault-scope", "team")
        check("owner row hidden for team", page.is_hidden("#vault-owner-row"))

        # ── 4. create private secret owned by lilly ─────────────────────────
        page.select_option("#vault-scope", "private")
        page.fill("#vault-owner", "lilly")
        page.fill("#vault-service", "qa")
        page.select_option("#vault-kind", "api_key")
        page.fill("#vault-value", V1)
        st = create_and_wait(page)
        check("private secret created for lilly", "lilly/qa-mech-1" in st, repr(st))
        check("value input cleared after submit", page.input_value("#vault-value") == "")
        check("new secret appears in list", "qa-mech-1" in page.inner_text("#vault-secrets"))
        check("V1 not anywhere in DOM", V1 not in page.inner_text("body"))

        # ── 5. create team secret ───────────────────────────────────────────
        page.fill("#vault-name", "qa-mech-2")
        page.fill("#vault-value", V2)
        page.select_option("#vault-scope", "team")
        st = create_and_wait(page)
        check("team secret created", "team:my-team/qa-mech-2" in st, repr(st))
        check("V2 not anywhere in DOM", V2 not in page.inner_text("body"))

        # ── 6. XSS adversarial 1: single-quote breakout in onclick ──────────
        xss1 = "qa' onmouseover='alert(1337)'"
        page.fill("#vault-name", xss1)
        page.fill("#vault-value", VX)
        page.select_option("#vault-scope", "private")
        page.fill("#vault-owner", "")
        st = create_and_wait(page)
        check("xss1 secret created", "Created" in st, repr(st))
        if "Created" not in st:
            check("xss1 error is the / rejection (defense in depth)", "must not contain" in st)
        row = page.locator("#vault-secrets tr", has_text="qa' onmouseover")
        check("xss1 row rendered", row.count() == 1)
        del_btn = row.locator("button:has-text('Delete')")
        del_btn.hover()
        page.wait_for_timeout(400)
        check("no alert on hover (quote breakout blocked)",
              not any(d[0] == "alert" for d in dialogs), str([d[:2] for d in dialogs][:3]))
        del_btn.click()  # confirm() → auto-accepted
        page.wait_for_timeout(800)
        check("xss1 secret deleted via its own button", "qa' onmouseover" not in page.inner_text("#vault-secrets"))

        # ── 7. XSS adversarial 2: HTML/script injection in name ─────────────
        xss2 = "<img src=x onerror=alert(1)>"
        page.fill("#vault-name", xss2)
        page.fill("#vault-value", VX)
        st = create_and_wait(page)
        check("xss2 secret created", "Created" in st, repr(st))
        check("no img element injected by name", page.locator("#vault-secrets img").count() == 0)
        check("xss2 name shown as literal text", xss2 in page.inner_text("#vault-secrets"))
        check("no alert from xss2", not any(d[0] == "alert" for d in dialogs))
        page.locator("#vault-secrets tr", has_text="<img src=x").locator("button:has-text('Delete')").click()
        page.wait_for_timeout(800)
        check("xss2 secret deleted", "<img src=x" not in page.inner_text("#vault-secrets"))

        # ── 8. rotate flow on a throwaway ───────────────────────────────────
        page.fill("#vault-name", "qa-mech-3")
        page.fill("#vault-value", V3)
        page.select_option("#vault-scope", "private")
        st = create_and_wait(page)
        check("rotate target created", "Created" in st, repr(st))
        r3 = page.locator("#vault-secrets tr", has_text="qa-mech-3")
        before = r3.inner_text()
        r3.locator("button:has-text('Rotate')").click()
        page.wait_for_timeout(1200)
        after = page.locator("#vault-secrets tr", has_text="qa-mech-3").inner_text()
        check("rotate produced rotation_due date", ("2026" in after) and (after != before), f"before={before[-60:]!r} after={after[-60:]!r}")

        # ── 9. approvals: grant + revoke ────────────────────────────────────
        page.fill("#va-identity", "lilly")
        page.fill("#va-service", "qa-svc")
        page.fill("#va-ttl", "1")
        page.click('button:has-text("Grant Approval")')
        page.wait_for_selector("#vault-approvals tr:has-text('qa-svc')", timeout=10000)
        check("approval granted + listed", "qa-svc" in page.inner_text("#vault-approvals"))
        page.locator("#vault-approvals tr", has_text="qa-svc").locator("button:has-text('Revoke')").click()
        page.wait_for_timeout(1000)
        check("approval revoked (status shows revoked)", "revoked" in page.locator("#vault-approvals tr", has_text="qa-svc").inner_text())

        # ── 10. localStorage hygiene ────────────────────────────────────────
        ls = page.evaluate("() => { const o={}; for (let i=0;i<localStorage.length;i++){const k=localStorage.key(i); o[k]=localStorage.getItem(k);} return o; }")
        check("admin key in localStorage", ls.get("katra_admin_key") == ADMIN_KEY)
        check("no QA values in localStorage", all(all(v not in val for v in (V1, V2, V3, VX)) for val in ls.values()))

        # ── 11. console errors ──────────────────────────────────────────────
        errs = [m for t, m in console_msgs if t == "error"]
        check("no console errors", not errs, str(errs[:4]))

        # ── 12. cleanup: throwaway secrets gone, real secrets intact ────────
        for name in ("qa-mech-1", "qa-mech-2", "qa-mech-3"):
            rows = page.locator("#vault-secrets tr", has_text=name)
            if rows.count():
                rows.first.locator("button:has-text('Delete')").click()
                page.wait_for_timeout(700)
        final = page.inner_text("#vault-secrets")
        check("throwaways cleaned up", all(n not in final for n in ("qa-mech-1", "qa-mech-2", "qa-mech-3")))
        check("real secrets intact", "agentmail-api-key" in final and "Github PAT" in final)
        page.screenshot(path="/tmp/vault-qa-final.png", full_page=True)
        browser.close()

    fails = [r for r in results if not r[1]]
    print(f"\n{'='*64}\nMECHANICAL QA: {len(results)-len(fails)}/{len(results)} passed")
    for name, ok, detail in results:
        print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f"  — {detail}" if detail and not ok else ""))
    print("screenshot: /tmp/vault-qa-final.png")
    sys.exit(1 if fails else 0)

if __name__ == "__main__":
    main()
