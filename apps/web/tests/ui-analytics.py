"""
Advanced analytics through the real dashboard + API + MySQL (TEST database). The section renders on Reports &
analytics; every KPI tile shows the API's own figure (nothing computed in the browser); the period switch reloads;
response times reflect a seeded AI exchange; heatmap is 7x24; CSV export downloads with the session; no page errors.

  Run:   TEST_DB_NAME=tacksharp_test python3 -I apps/web/tests/ui-analytics.py
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
with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 1440, 'height': 1000}, accept_downloads=True); pg = ctx.new_page()
    errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(WEB + '/login'); pg.get_by_label('Email').fill('owner@tacksharp.test'); pg.get_by_label('Password', exact=True).fill('correct-horse-battery')
    pg.get_by_role('button', name='Log in').click(); pg.wait_for_timeout(2500)
    org = sql("SELECT organizationId FROM User WHERE email='owner@tacksharp.test'")
    def api(path):
        return pg.evaluate("""async (u) => { const r = await fetch(u, { credentials: 'include' }); return { status: r.status, body: await r.json().catch(() => null) }; }""", API + path)
    # A known AI exchange right now: customer message, AI answer 42 s later (7-day window).
    cid = f'an_ui_cust_{run}'; conv = f'an_ui_conv_{run}'
    sql(f"INSERT INTO Customer (id, organizationId, name, phone, createdAt, updatedAt) VALUES ('{cid}', '{org}', 'Analytics UI {run}', '9192{run}81', NOW(3), NOW(3))")
    sql(f"INSERT INTO Conversation (id, organizationId, channel, externalId, customerId, status, createdAt, updatedAt) VALUES ('{conv}', '{org}', 'whatsapp', '9192{run}81', '{cid}', 'active', NOW(3), NOW(3))")
    sql(f"INSERT INTO Message (id, organizationId, conversationId, role, content, createdAt) VALUES ('an_ui_m1_{run}', '{org}', '{conv}', 'user', 'hello', NOW(3) - INTERVAL 42 SECOND), ('an_ui_m2_{run}', '{org}', '{conv}', 'assistant', 'hi!', NOW(3))")
    try:
        pg.goto(WEB + '/analytics')
        sec = pg.get_by_test_id('advanced-analytics')
        try: sec.get_by_test_id('aa-kpis').wait_for(timeout=20000)
        except Exception: pass
        check('advanced analytics section on Reports & analytics', sec.count() == 1 and sec.get_by_test_id('aa-kpis').count() == 1)
        check('11 KPI tiles, each with a comparison', sec.locator('[data-testid^="aa-kpi-"]').count() == 11)
        a30 = api('/analytics/advanced?days=30')['body']
        tile = lambda k: sec.get_by_test_id(f'aa-kpi-{k}').inner_text()
        check('tiles show the API figures (customer messages, conversations, leads)', f"{a30['kpis']['inboundMessages']['value']:,}".replace(',', '') in tile('inboundMessages').replace(',', '') and str(a30['kpis']['leads']['value']) in tile('leads').replace(',', ''), tile('inboundMessages')[:60])
        check('AI reply time is measured (seeded exchange present)', a30['responseTimes']['ai']['count'] >= 1 and a30['kpis']['aiMedianResponseSec']['value'] is not None and '—' not in tile('aiMedianResponseSec').split('\n')[1])
        check('definitions shown on hover (title)', 'Median seconds' in (sec.get_by_test_id('aa-kpi-aiMedianResponseSec').get_attribute('title') or ''))
        with pg.expect_response(lambda r: '/analytics/advanced?days=7' in r.url):
            sec.get_by_role('tab', name='7 days').click()
        pg.wait_for_timeout(1500)
        a7 = api('/analytics/advanced?days=7')['body']
        check('period switch reloads 7-day figures', 'previous 7 days' in sec.inner_text() and str(a7['kpis']['conversations']['value']) in tile('conversations').replace(',', ''))
        check('heatmap is 7 x 24', sec.get_by_test_id('aa-heatmap').locator('span[title]').count() == 168)
        check('channels, CRM, sources, automation, team, who-answered cards render', all(sec.get_by_test_id(t).count() == 1 for t in ['aa-channels', 'aa-crm', 'aa-sources', 'aa-automation', 'aa-team', 'aa-answered', 'aa-revenue']))
        pg.screenshot(path=os.path.join(SHOTS, 'analytics.png'), full_page=True)
        with pg.expect_download() as dl:
            sec.get_by_role('button', name='Export CSV').click()
        text = open(dl.value.path(), encoding='utf-8-sig').read()
        check('CSV export downloads with the session: header and KPI rows', text.startswith('"section","metric","value"') and '"kpi","inboundMessages"' in text and dl.value.suggested_filename == 'tacksharp-analytics-7d.csv', text[:80])
        check('no page errors', not errs, '; '.join(errs)[:200])
    finally:
        sql(f"DELETE FROM Message WHERE conversationId='{conv}'"); sql(f"DELETE FROM Conversation WHERE id='{conv}'"); sql(f"DELETE FROM Customer WHERE id='{cid}'")
    b.close()

print(f"\n{sum(results)}/{len(results)} passed")
raise SystemExit(0 if all(results) else 1)
