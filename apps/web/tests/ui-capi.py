"""
Meta Conversions API through the real dashboard + API + worker + MySQL (TEST database, DRY_RUN=true).
Save (token masked, field validation), connection test against the real Graph API (unreachable from the sandbox: must be
reported as a failure, never as success), enable refused until a test passes. The passing test is then SEEDED in the
test database (status ok) because Meta cannot be reached here; enable through the UI; the worker records a Lead for a
new enquiry within a minute and, in DRY_RUN, marks it simulated (nothing sent); the log shows it; the token never
appears in the page.

  Run:   TEST_DB_NAME=tacksharp_test python3 -I apps/web/tests/ui-capi.py
"""
from playwright.sync_api import sync_playwright
import os, subprocess, tempfile, time

WEB, API = 'http://localhost:3001', 'http://localhost:3000'
SHOTS = os.environ.get('SHOTS_DIR', tempfile.gettempdir())
DB = os.environ.get('TEST_DB_NAME', 'tacksharp_test')
def sql(q):
    return subprocess.run(['mysql', '-h127.0.0.1', f"-u{os.environ.get('DB_USER', 'root')}", f"-p{os.environ.get('DB_PASSWORD', '')}", DB, '-N', '-e', q], capture_output=True, text=True).stdout.strip()

results = []
def check(name, ok, detail=''):
    results.append(bool(ok)); print(('PASS ' if ok else 'FAIL ') + name + (f'  — {detail}' if detail else ''))

run = str(int(time.time()))[-6:]
TOKEN = f'EAAuitest{run}Zx9Qw7'
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_context(viewport={'width': 1440, 'height': 950}).new_page()
    errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(WEB + '/login'); pg.get_by_label('Email').fill('owner@tacksharp.test'); pg.get_by_label('Password', exact=True).fill('correct-horse-battery')
    pg.get_by_role('button', name='Log in').click(); pg.wait_for_timeout(2500)
    org = sql("SELECT organizationId FROM User WHERE email='owner@tacksharp.test'")
    sql(f"DELETE FROM IntegrationCredential WHERE organizationId='{org}' AND provider='meta_capi'")
    def api(path, body=None, method=None):
        return pg.evaluate("""async ([u, b, m]) => { const r = await fetch(u, { method: m || (b ? 'POST' : 'GET'), credentials: 'include', headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; }""", [API + path, body, method])
    cust = None
    try:
        pg.goto(WEB + '/settings/integrations'); pg.wait_for_timeout(2500)
        check('integrations list has a "Meta Conversions API" card', pg.get_by_test_id('integration-meta_capi').count() == 1)
        pg.get_by_test_id('integration-meta_capi').click(); pg.wait_for_timeout(2500)
        check('settings page opens', '/settings/integrations/meta-capi' in pg.url and pg.get_by_text('Dataset (pixel) ID').count() >= 1)
        pg.get_by_label('Conversions API access token', exact=True).fill(TOKEN)
        pg.get_by_label('Dataset (pixel) ID').fill('12ab')
        pg.get_by_role('button', name='Save').first.click(); pg.wait_for_timeout(1500)
        check('invalid dataset id refused with the reason', 'Digits only' in pg.content())
        pg.get_by_label('Dataset (pixel) ID').fill('123456789012345')
        pg.get_by_label('Conversions API access token', exact=True).fill(TOKEN)
        pg.get_by_role('button', name='Save').first.click(); pg.wait_for_timeout(2000)
        row = sql(f"SELECT CONCAT(status,'/',enabled) FROM IntegrationCredential WHERE organizationId='{org}' AND provider='meta_capi'")
        check('saved encrypted, untested, not enabled', row == 'untested/0', row)
        check('token never shown in the page (masked hint only)', TOKEN not in pg.content() and '••••' in pg.content())
        check('token not stored in plain text', sql(f"SELECT COUNT(*) FROM IntegrationCredential WHERE organizationId='{org}' AND (secretCiphertext LIKE '%{TOKEN}%' OR config LIKE '%{TOKEN}%')") == '0')
        enable = pg.get_by_role('button', name='Enable integration')
        check('enable is not possible before a passing connection test', enable.count() == 1 and enable.is_disabled())
        pg.get_by_role('button', name='Test connection').click(); pg.wait_for_timeout(15000)
        st = sql(f"SELECT status FROM IntegrationCredential WHERE organizationId='{org}' AND provider='meta_capi'")
        check('connection test against the real Graph API (unreachable here) is reported as failed, never ok', st == 'failed', st)
        # Meta is unreachable from the sandbox: seed the passing test (TEST DATABASE ONLY) to exercise the rest.
        sql(f"UPDATE IntegrationCredential SET status='ok', lastError=NULL WHERE organizationId='{org}' AND provider='meta_capi'")
        pg.reload(); pg.wait_for_timeout(2500)
        pg.get_by_role('button', name='Enable integration').click(); pg.wait_for_timeout(1500)
        check('enabled through the UI after the (seeded) passing test', sql(f"SELECT enabled FROM IntegrationCredential WHERE organizationId='{org}' AND provider='meta_capi'") == '1')
        check('"Send test event" needs a test event code', pg.get_by_role('button', name='Send test event').is_disabled())
        cust = api('/customers', {'name': f'Capi Lead {run}', 'phone': '96' + run + '61', 'email': f'capi{run}@example.com'})['body']
        lead = sql(f"INSERT INTO Lead (id, organizationId, customerId, status, source, createdAt, updatedAt) VALUES ('capi_lead_{run}', '{org}', '{cust['id']}', 'new', 'whatsapp', NOW(3), NOW(3))")
        st = ''
        for _ in range(45):
            st = sql(f"SELECT status FROM MetaCapiEvent WHERE organizationId='{org}' AND eventId='lead:capi_lead_{run}'")
            if st in ('simulated', 'sent', 'failed', 'skipped'): break
            time.sleep(2)
        check('worker recorded the new enquiry as a Lead and, in DRY_RUN, marked it simulated (nothing sent)', st == 'simulated', st)
        pg.reload(); pg.wait_for_timeout(2500)
        panel = pg.get_by_test_id('capi-panel')
        check('event log shows the Lead as simulated', panel.get_by_test_id('capi-event').filter(has_text='Lead').filter(has_text='simulated').count() >= 1)
        check('counts shown', 'simulated' in panel.get_by_test_id('capi-counts').inner_text())
        pg.screenshot(path=os.path.join(SHOTS, 'capi.png'), full_page=True)
        ev = api('/meta-capi/events')['body']
        check('event API returns no customer phone / email', cust['phone'] not in str(ev) and f'capi{run}@example.com' not in str(ev))
        check('no page errors', not errs, '; '.join(errs)[:200])
    finally:
        sql(f"DELETE FROM IntegrationCredential WHERE organizationId='{org}' AND provider='meta_capi'")
        sql(f"DELETE FROM MetaCapiEvent WHERE organizationId='{org}'")  # test database: everything the worker recorded for this run
        if cust and cust.get('id'):
            sql(f"DELETE FROM Lead WHERE id='capi_lead_{run}'"); sql(f"DELETE FROM Customer WHERE id='{cust['id']}'")
    b.close()

print(f"\n{sum(results)}/{len(results)} passed")
raise SystemExit(0 if all(results) else 1)
