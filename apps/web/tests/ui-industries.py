"""
Multi-industry experience end to end through the real dashboard + API + MySQL (TEST database only), DRY_RUN=true.

  Needs: API on :3000 (DB_NAME=<test db> DRY_RUN=true RATE_LIMIT_API_PER_MIN=2000 RATE_LIMIT_LOGIN=100), web on :3001,
         owner@tacksharp.test (test fixture) with memberships to the six demo workspaces:
           DEMO_SEED_CONFIRM=yes DEMO_USER_PASSWORD=... DEMO_GRANT_EMAILS=owner@tacksharp.test npm run seed:industry-demos
  Run:   TEST_DB_NAME=tacksharp_test SHOTS_DIR=/tmp/shots python3 -I apps/web/tests/ui-industries.py

Checks: login screen (validation, password toggle, no fake SSO), workspace switching across the six industries, menu
per industry (relevant items present, irrelevant ones absent), dashboard KPIs per industry, demo banner, agent
catalogue per industry + a playground run, tenant isolation, live-workspace playground refusal, the accessible mobile
drawer, and no horizontal overflow at 320 / 375 / 390 / 768 / 1024 / 1366 / 1440 px. Nothing is sent to anyone.
"""
from playwright.sync_api import sync_playwright
import os, re, subprocess, tempfile

WEB, API = 'http://localhost:3001', 'http://localhost:3000'
DB = os.environ.get('TEST_DB_NAME', 'tacksharp_test')
SHOTS = os.environ.get('SHOTS_DIR', tempfile.gettempdir())
WIDTHS = [320, 375, 390, 768, 1024, 1366, 1440]
results = []
def check(name, ok, detail=''):
    results.append(bool(ok)); print(('PASS ' if ok else 'FAIL ') + name + (f'  — {detail}' if detail else ''))

def sql(q):
    out = subprocess.run(['mysql', f"-u{os.environ.get('DB_USER', 'root')}", f"-p{os.environ.get('DB_PASSWORD', 'password')}", '-h127.0.0.1', DB, '-N', '-e', q], capture_output=True, text=True)
    if out.returncode: raise RuntimeError(out.stderr)
    return out.stdout.strip()

# Menu items that MUST appear / MUST NOT appear per industry (sidebar link names).
MENU = {
    'textile': (['Product catalogue', 'Quotations', 'Sales orders', 'WhatsApp campaigns', 'Finance'], ['Site visits', 'Inspections & defects', 'Orders & tracking', 'Menu & stock']),
    'restaurant': (['Orders & tracking', 'Menu & stock', 'Live operations', 'Test chat'], ['Quotations', 'Site visits', 'Inspections & defects', 'Leads & CRM']),
    'real_estate': (['Leads & CRM', 'Site visits', 'AI voice calls', 'Human handoff'], ['Quotations', 'Product catalogue', 'Inspections & defects', 'Menu & stock']),
    'retail': (['Product catalogue', 'Orders & fulfilment', 'Offers & campaigns', 'Revenue analytics'], ['Quotations', 'Site visits', 'Inspections & defects', 'Menu & stock']),
    'manufacturing': (['Inspections & defects', 'Corrective actions', 'Quality analytics'], ['Quotations', 'Site visits', 'Leads & CRM', 'Product catalogue', 'Orders & tracking']),
    'agency': (['Lead management', 'Campaign management', 'ROI reporting', 'Conversion analytics'], ['Quotations', 'Site visits', 'Inspections & defects', 'Menu & stock']),
}
# A KPI label that must be on the overview, and one that must not.
KPI = {
    'textile': ('Pending quotations', 'Site visits scheduled'),
    'retail': ('Sales (confirmed orders)', 'Pending quotations'),
    'manufacturing': ('Rejection rate', 'Sales (confirmed orders)'),
    'agency': ('Leads processed', 'Rejection rate'),
}
# Overflow pages per industry (besides / and /agents).
EXTRA_PAGE = {'textile': '/catalogue', 'restaurant': '/orders', 'real_estate': '/leads', 'retail': '/sales-orders', 'manufacturing': '/quality', 'agency': '/leads'}

with sync_playwright() as p:
    b = p.chromium.launch()

    # ---------------------------------------------------------------- login screen
    for w in (375, 1440):
        ctx = b.new_context(viewport={'width': w, 'height': 900}); pg = ctx.new_page()
        pg.goto(WEB + '/login'); pg.wait_for_timeout(1200)
        pg.screenshot(path=os.path.join(SHOTS, f'login-{w}.png'), full_page=True)
        over = pg.evaluate('document.documentElement.scrollWidth - window.innerWidth')
        check(f'login @{w}px: no horizontal overflow', over <= 1, f'{over}px')
        if w == 375:
            pg.get_by_role('button', name='Log in').click(); pg.wait_for_timeout(300)
            check('login: empty submit shows field errors (no request)', pg.get_by_text('Enter a valid email address.').is_visible() and pg.get_by_text('Enter your password.').is_visible())
            pg.get_by_label('Password').fill('secret-value')
            pg.get_by_role('button', name='Show password').click()
            check('login: password toggle reveals', pg.get_by_label('Password').get_attribute('type') == 'text')
            pg.get_by_role('button', name='Hide password').click()
            check('login: password toggle hides again', pg.get_by_label('Password').get_attribute('type') == 'password')
            pg.get_by_role('button', name='Forgot password?').click()
            check('login: forgot password explains the real process (no fake reset)', pg.get_by_text('Ask your workspace admin').is_visible())
            check('login: no fake Google / Microsoft buttons', pg.get_by_role('button', name='Google').count() == 0 and pg.get_by_text('Microsoft').count() == 0)
            pg.get_by_label('Email').fill('owner@tacksharp.test'); pg.get_by_label('Password').fill('wrong-password-x')
            pg.get_by_role('button', name='Log in').click(); pg.wait_for_timeout(1500)
            check('login: wrong password shows the server error', pg.get_by_role('alert').filter(has_text='Wrong email or password').count() == 1)
        ctx.close()

    # ---------------------------------------------------------------- session
    ctx = b.new_context(viewport={'width': 1440, 'height': 950}); pg = ctx.new_page()
    errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(WEB + '/login'); pg.get_by_label('Email').fill('owner@tacksharp.test'); pg.get_by_label('Password').fill('correct-horse-battery')
    pg.get_by_role('button', name='Log in').click(); pg.wait_for_timeout(2500)
    def api(path, body=None):
        return pg.evaluate("""async ([url, body]) => { const r = await fetch(url, { method: body ? 'POST' : 'GET', credentials: 'include', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; }""", [API + path, body])
    home = api('/auth/me')['body']['organizationId']
    spaces = api('/auth/workspaces')['body']
    demos = {w['industry']: w for w in spaces if w['isDemo'] and w['organizationId'].startswith('org_demo_')}
    check('owner can open all six demo workspaces', set(demos) == set(MENU), ', '.join(sorted(demos)))

    def switch_to(w):
        pg.get_by_role('button', name='Switch workspace').first.click(); pg.wait_for_timeout(700)
        pg.get_by_role('option').filter(has_text=w['name']).first.click()
        pg.wait_for_url(WEB + '/', timeout=15000); pg.wait_for_timeout(2500)

    for ind, (must, never) in MENU.items():
        w = demos.get(ind)
        if not w: continue
        pg.goto(WEB + '/'); pg.wait_for_timeout(1500)
        switch_to(w)
        me = api('/auth/me')['body']
        check(f'{ind}: session switched to {w["organizationId"]}', me['organizationId'] == w['organizationId'])
        nav = pg.get_by_role('navigation', name='Main')
        named = lambda m: nav.get_by_role('link', name=re.compile('^' + re.escape(m) + r'( \d+( live)?)?$'))  # a live count badge may follow
        missing = [m for m in must if named(m).count() == 0]
        present = [m for m in never if named(m).count() > 0]
        check(f'{ind}: menu has its own items', not missing, f'missing {missing}')
        check(f'{ind}: menu hides other industries\' items', not present, f'shown {present}')
        check(f'{ind}: demo banner shown', pg.get_by_role('note').filter(has_text='Demo workspace').count() > 0)
        if ind in KPI:
            yes, no = KPI[ind]
            pg.wait_for_selector('section[aria-label="Key figures"] p', timeout=15000); pg.wait_for_timeout(800)
            figures = pg.locator('section[aria-label="Key figures"]').inner_text()
            check(f'{ind}: dashboard shows "{yes}"', yes in figures)
            check(f'{ind}: dashboard has no "{no}"', no not in figures)
            check(f'{ind}: charts carry their data source', pg.get_by_text('Source:').count() >= 2)
        pg.screenshot(path=os.path.join(SHOTS, f'overview-{ind}.png'), full_page=True)

        # Agents: own catalogue only.
        pg.goto(WEB + '/agents'); pg.wait_for_timeout(2500)
        cat = api('/industry/agents')['body']
        cards = pg.get_by_role('list', name='AI agents').get_by_role('listitem')
        check(f'{ind}: agent catalogue lists {len(cat["agents"])} agents of this industry', cards.count() == len(cat['agents']) and all(a['industry'] in (ind, 'shared') for a in cat['agents']))
        if ind in ('retail', 'manufacturing', 'agency'):
            check(f'{ind}: no property assistant offered', 'Property' not in pg.get_by_role('list', name='AI agents').inner_text())
        pg.screenshot(path=os.path.join(SHOTS, f'agents-{ind}.png'), full_page=True)

        # Isolation: what the API shows equals this organization's rows.
        if ind in ('real_estate', 'agency', 'textile', 'retail'):
            leads = api('/leads')['body']
            db = int(sql(f"SELECT COUNT(*) FROM Lead WHERE organizationId='{w['organizationId']}'"))
            check(f'{ind}: leads shown = this workspace\'s leads only', len(leads) == db, f'{len(leads)} vs {db}')

    # ---------------------------------------------------------------- manufacturing playground + quality page
    w = demos['manufacturing']; pg.goto(WEB + '/'); pg.wait_for_timeout(1200); switch_to(w)
    pg.goto(WEB + '/agents'); pg.wait_for_timeout(2500)
    pg.get_by_role('list', name='AI agents').get_by_role('button').filter(has_text='Inspection Summary Agent').first.click()
    pg.wait_for_timeout(600)
    dlg = pg.locator('dialog[open]')
    dlg.get_by_role('tab', name='Playground').click(); dlg.get_by_role('button', name='Run on demo data').click(); pg.wait_for_timeout(3500)
    check('manufacturing: playground ran the real quality task on demo data', 'completed' in dlg.get_by_role('status').inner_text().lower(), dlg.inner_text()[:160])
    pg.screenshot(path=os.path.join(SHOTS, 'agents-playground.png'))
    dlg.get_by_role('button', name='Close').click()
    before = int(sql(f"SELECT COUNT(*) FROM QualityInspection WHERE organizationId='{w['organizationId']}'"))
    pg.goto(WEB + '/quality'); pg.wait_for_timeout(2000)
    pg.get_by_role('button', name='Record inspection').click(); pg.wait_for_timeout(500)
    dlg = pg.locator('dialog[open]')
    import time as _t; batch = f'UI-{int(_t.time()) % 100000}'
    dlg.get_by_label('Batch / lot code').fill(batch); dlg.get_by_label('Product', exact=True).fill('Test bracket')
    dlg.get_by_label('Units inspected').fill('50'); dlg.get_by_label('Units rejected').fill('60')
    dlg.get_by_role('button', name='Save inspection').click(); pg.wait_for_timeout(500)
    check('quality: rejected > inspected is refused in the form', dlg.get_by_role('alert').count() == 1)
    dlg.get_by_label('Units rejected').fill('3'); dlg.get_by_role('button', name='Save inspection').click(); pg.wait_for_timeout(1500)
    check('quality: inspection recorded in this workspace', int(sql(f"SELECT COUNT(*) FROM QualityInspection WHERE organizationId='{w['organizationId']}'")) == before + 1)
    sql(f"DELETE FROM QualityInspection WHERE organizationId='{w['organizationId']}' AND batchCode='{batch}'")  # leave the demo data as seeded

    # ---------------------------------------------------------------- responsive
    for ind in MENU:
        w = demos.get(ind)
        if not w: continue
        pg.set_viewport_size({'width': 1440, 'height': 950}); pg.goto(WEB + '/'); pg.wait_for_timeout(1200); switch_to(w)
        bad = []
        for width in WIDTHS:
            pg.set_viewport_size({'width': width, 'height': 860})
            for path in ('/', '/agents', EXTRA_PAGE[ind]):
                pg.goto(WEB + path); pg.wait_for_timeout(1300)
                over = pg.evaluate('document.documentElement.scrollWidth - window.innerWidth')
                if over > 1: bad.append(f'{path}@{width}:{over}px')
            if width in (375, 1024): pg.screenshot(path=os.path.join(SHOTS, f'resp-{ind}-{width}.png'))
        check(f'{ind}: no horizontal page overflow at {"/".join(map(str, WIDTHS))} px', not bad, ', '.join(bad[:8]))

    # Accessible drawer (phone width).
    pg.set_viewport_size({'width': 375, 'height': 800}); pg.goto(WEB + '/'); pg.wait_for_timeout(1500)
    pg.get_by_role('button', name='Open menu').click(); pg.wait_for_timeout(400)
    drawer = pg.get_by_role('dialog', name='Navigation')
    check('drawer: opens as a modal dialog and locks page scroll', drawer.is_visible() and pg.evaluate('document.body.style.overflow') == 'hidden')
    links = drawer.get_by_role('link')
    small = [l.inner_text() for l in links.all() if (l.bounding_box() or {'height': 0})['height'] < 43.5]
    check('drawer: menu touch targets at least 44 px tall', not small, ', '.join(small[:5]))
    pg.keyboard.press('Escape'); pg.wait_for_timeout(300)
    check('drawer: Escape closes it and restores scrolling', not drawer.is_visible() and pg.evaluate('document.body.style.overflow') != 'hidden')
    pg.screenshot(path=os.path.join(SHOTS, 'drawer-closed-375.png'))

    # ---------------------------------------------------------------- live workspace: playground refused, back home
    pg.set_viewport_size({'width': 1440, 'height': 950})
    r = api('/auth/workspace', {'organizationId': home})
    pg.goto(WEB + '/'); pg.wait_for_timeout(1500)
    check('back in the home (live) workspace', api('/auth/me')['body']['organizationId'] == home)
    live_agent = next((a for a in api('/industry/agents')['body']['agents'] if a['playground'] != 'none'), None)
    refused = api('/industry/playground', {'agentId': live_agent['id'], 'message': 'hello'}) if live_agent else {'status': 403}
    check('live workspace: playground refused (403)', refused['status'] == 403)
    check('non-member workspace cannot be opened (403)', api('/auth/workspace', {'organizationId': 'org_does_not_exist_x'})['status'] == 403)
    check('no page errors', not errs, '; '.join(errs)[:300])
    b.close()

print(f"\n{sum(results)}/{len(results)} passed")
raise SystemExit(0 if all(results) else 1)
