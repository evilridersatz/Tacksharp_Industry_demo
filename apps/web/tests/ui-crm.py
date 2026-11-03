"""
CRM through the real dashboard + API + MySQL (TEST database only): stage and follow-up date, lead score with reasons,
custom attributes, notes and tasks in the customer drawer; stage / follow-up-due filters; CSV export (downloaded with
the session, formula-safe); possible duplicates.

  Run:   TEST_DB_NAME=tacksharp_test python3 -I apps/web/tests/ui-crm.py
"""
from playwright.sync_api import sync_playwright
import os, re, subprocess, tempfile, time

WEB, API = 'http://localhost:3001', 'http://localhost:3000'
SHOTS = os.environ.get('SHOTS_DIR', tempfile.gettempdir())
DB = os.environ.get('TEST_DB_NAME', 'tacksharp_test')
def sql(q):
    return subprocess.run(['mysql', '-h127.0.0.1', f"-u{os.environ.get('DB_USER', 'root')}", f"-p{os.environ.get('DB_PASSWORD', '')}", DB, '-N', '-e', q], capture_output=True, text=True).stdout.strip()

results = []
def check(name, ok, detail=''):
    results.append(bool(ok)); print(('PASS ' if ok else 'FAIL ') + name + (f'  — {detail}' if detail else ''))

run = str(int(time.time()))[-6:]
with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 1440, 'height': 950}, accept_downloads=True); pg = ctx.new_page()
    errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(WEB + '/login'); pg.get_by_label('Email').fill('owner@tacksharp.test'); pg.get_by_label('Password', exact=True).fill('correct-horse-battery')
    pg.get_by_role('button', name='Log in').click(); pg.wait_for_timeout(2500)
    def api(path, body=None, method=None):
        return pg.evaluate("""async ([u, b, m]) => { const r = await fetch(u, { method: m || (b ? 'POST' : 'GET'), credentials: 'include', headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; }""", [API + path, body, method])
    a = api('/customers', {'name': f'CRM Meena {run}', 'phone': '98' + run + '41', 'email': f'crm{run}@example.com', 'messagingConsent': True, 'consentSource': 'customer_message'})['body']
    d = api('/customers', {'name': f'CRM Meena {run}', 'phone': '98' + run + '42'})['body']
    try:
        pg.goto(WEB + '/contacts'); pg.wait_for_timeout(2500)
        pg.get_by_placeholder('Name, phone or email').fill(f'CRM Meena {run}'); pg.wait_for_timeout(1500)
        check('list shows stage and a lead score with reasons', pg.get_by_text('New', exact=True).count() >= 1 and pg.locator('[title*="WhatsApp consent"]').count() >= 1)
        pg.goto(WEB + f"/contacts?open={a['id']}"); pg.wait_for_timeout(2500); panel = pg.get_by_test_id('crm-panel')
        panel.get_by_label('Stage').select_option('qualified'); pg.wait_for_timeout(1500)
        check('stage saved; score rises with "Qualified"', sql(f"SELECT stage FROM Customer WHERE id='{a['id']}'") == 'qualified' and 'Qualified' in panel.get_by_test_id('lead-score').inner_text(), panel.get_by_test_id('lead-score').inner_text() if panel.get_by_test_id('lead-score').count() else '')
        panel.get_by_label('Next follow-up').fill('2026-01-15'); pg.wait_for_timeout(1500)
        check('follow-up date saved', sql(f"SELECT DATE(followUpAt) FROM Customer WHERE id='{a['id']}'") == '2026-01-15')
        panel.get_by_label('Attribute name').fill('budget_band'); panel.get_by_label('Attribute value').fill('60-80L'); panel.get_by_role('button', name='Add').first.click(); pg.wait_for_timeout(1500)
        check('custom attribute saved and shown', 'budget_band: 60-80L' in panel.inner_text() and '60-80L' in sql(f"SELECT attributes FROM Customer WHERE id='{a['id']}'"))
        panel.get_by_label('Attribute name').fill('Bad Key'); panel.get_by_label('Attribute value').fill('x'); panel.get_by_role('button', name='Add').first.click(); pg.wait_for_timeout(1200)
        check('invalid attribute name refused with the reason', panel.get_by_role('alert').count() == 1 and 'lowercase' in panel.get_by_role('alert').inner_text())
        panel.get_by_label('New note').fill('Prefers a call after 6 PM'); panel.get_by_role('button', name='Add').nth(1).click(); pg.wait_for_timeout(1500)
        panel.get_by_label('New task').fill('Send brochure'); panel.get_by_label('Task due').fill('2026-12-01'); panel.get_by_role('button', name='Add').nth(2).click(); pg.wait_for_timeout(1500)
        check('note and task saved and listed', 'Prefers a call after 6 PM' in panel.inner_text() and 'Send brochure' in panel.inner_text() and sql(f"SELECT COUNT(*) FROM WorkTask WHERE entityType='customer' AND entityId='{a['id']}'") == '1')
        pg.screenshot(path=os.path.join(SHOTS, 'crm-drawer.png'))
        pg.goto(WEB + '/contacts'); pg.wait_for_timeout(2500)
        pg.get_by_placeholder('Name, phone or email').fill(f'CRM Meena {run}'); pg.wait_for_timeout(1500)
        pg.get_by_label('Stage filter').select_option('qualified'); pg.wait_for_timeout(1500)
        check('stage filter: only the qualified record', pg.get_by_text(re.compile(run + '41')).count() >= 1 and pg.get_by_text(re.compile(run + '42')).count() == 0)
        pg.get_by_label('Stage filter').select_option(''); pg.get_by_label('Follow-up due').check(); pg.wait_for_timeout(1500)
        check('follow-up due filter: only the record with a past follow-up date', pg.get_by_text(re.compile(run + '41')).count() >= 1 and pg.get_by_text(re.compile(run + '42')).count() == 0)
        pg.get_by_label('Follow-up due').uncheck(); pg.wait_for_timeout(800)
        with pg.expect_download() as dl:
            pg.get_by_role('button', name='Export CSV').click()
        path = dl.value.path(); text = open(path, encoding='utf-8-sig').read()
        check('CSV export downloads with the session: header, the filtered customer, stage, attribute', text.startswith('"name","phone"') and f'CRM Meena {run}' in text and '"qualified"' in text and 'budget_band' in text, text[:120])
        pg.get_by_role('button', name='Possible duplicates').click()
        dl_ = pg.get_by_test_id('duplicates')
        try: dl_.wait_for(timeout=15000)
        except Exception: pass
        check('possible duplicates: the two records with the same name are listed', dl_.count() == 1 and f'crm meena {run}' in dl_.inner_text().lower())
        check('no page errors', not errs, '; '.join(errs)[:200])
    finally:
        for c in (a, d):
            if c and c.get('id'): sql(f"DELETE FROM WorkTask WHERE entityId='{c['id']}'"); sql(f"DELETE FROM Customer WHERE id='{c['id']}'")
    b.close()

print(f"\n{sum(results)}/{len(results)} passed")
raise SystemExit(0 if all(results) else 1)
