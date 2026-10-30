"""
Enterprise platform, end to end through the real dashboard + API + MySQL (TEST database only). Nothing is sent: the
server runs with DRY_RUN=true and provider hosts are not reachable from the test machine, so provider tests here prove
that failures are reported honestly; live provider success needs real credentials (see INTEGRATIONS.md).

  Needs: API on :3000 (DB_NAME=<test db>, CREDENTIALS_KEYS set), web on :3001, a platform admin staff@tacksharp.test
         (npm run platform:admin -- grant staff@tacksharp.test).
  Run:   TEST_DB_NAME=tacksharp_test python3 -I apps/web/tests/ui-enterprise.py

Covers: public website pages (desktop + phone, no horizontal scroll), self-service signup (UI), duplicate / bot /
weak-password refusal, tenant isolation between two new organizations, integration credentials (masked, encrypted,
not enabled before a passing test, honest failure), role enforcement on integrations, the platform console
(activate, suspend → sessions end), forgot-password.
"""
from playwright.sync_api import sync_playwright
import json, os, re, subprocess, tempfile, time

WEB, API = 'http://localhost:3001', 'http://localhost:3000'
SHOTS = os.environ.get('SHOTS_DIR', tempfile.gettempdir())
DB = os.environ.get('TEST_DB_NAME', 'tacksharp_test')
run = str(int(time.time()))[-7:]
results = []
created_orgs = []

def check(name, ok, detail=''):
    results.append(bool(ok)); print(('PASS ' if ok else 'FAIL ') + name + (f'  — {detail}' if detail else ''))

def sql(q):
    out = subprocess.run(['mysql', f"-u{os.environ.get('DB_USER', 'root')}", f"-p{os.environ.get('DB_PASSWORD', 'password')}", '-h127.0.0.1', DB, '-N', '-e', q], capture_output=True, text=True)
    if out.returncode: raise RuntimeError(out.stderr)
    return out.stdout.strip()

def fetcher(pg):
    return lambda path, body=None, method=None: pg.evaluate("""async ([url, body, method]) => { const r = await fetch(url, { method: method || (body ? 'POST' : 'GET'), credentials: 'include', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); const t = await r.text(); let j = null; try { j = JSON.parse(t) } catch {} return { status: r.status, body: j, raw: t }; }""", [API + path, body, method])

def login(b, email, password, viewport=None):
    ctx = b.new_context(viewport=viewport or {'width': 1440, 'height': 950}); pg = ctx.new_page()
    errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(WEB + '/login'); pg.get_by_label('Email').fill(email); pg.get_by_label('Password', exact=True).fill(password)
    pg.get_by_role('button', name='Log in').click(); pg.wait_for_timeout(2500)
    return ctx, pg, fetcher(pg), errs

with sync_playwright() as p:
    b = p.chromium.launch()
    try:
        # ---------------------------------------------------------------- public website
        for vp, label in (({'width': 1440, 'height': 950}, 'desktop'), ({'width': 390, 'height': 844}, 'phone')):
            ctx = b.new_context(viewport=vp); pg = ctx.new_page(); errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
            bad = []
            for path in ['/welcome', '/product', '/solutions', '/pricing', '/docs', '/demo', '/signup', '/forgot-password', '/terms', '/privacy']:
                pg.goto(WEB + path); pg.wait_for_timeout(900)
                h1 = pg.locator('h1').first.inner_text() if pg.locator('h1').count() else ''
                over = pg.evaluate('document.scrollingElement.scrollWidth - window.innerWidth')
                if not h1 or over > 1 or pg.url.rstrip('/').endswith('/login'): bad.append(f'{path} h1={bool(h1)} overflow={over} url={pg.url}')
            check(f'public website: 10 pages render with a heading and no horizontal scroll ({label})', not bad, '; '.join(bad))
            check(f'public website: no page errors ({label})', not errs, '; '.join(errs)[:200])
            if label == 'desktop':
                pg.goto(WEB + '/welcome'); pg.wait_for_timeout(800)
                pg.get_by_role('tab', name=re.compile('Restaurant')).click(); pg.wait_for_timeout(500)
                check('landing: industry tabs switch the example conversation', 'Curry cut' in pg.locator('#scene').inner_text())
                check('landing: example is labelled as illustrative', pg.get_by_text('Illustrative conversation').count() == 1)
                pg.screenshot(path=os.path.join(SHOTS, 'site-welcome.png'), full_page=True)
            else:
                pg.goto(WEB + '/welcome'); pg.get_by_role('button', name='Open menu').click(); pg.wait_for_timeout(300)
                check('phone: menu opens with sign-up and log-in', pg.locator('#site-menu').get_by_role('link', name='Create an account').is_visible())
                pg.screenshot(path=os.path.join(SHOTS, 'site-welcome-phone.png'), full_page=True)
            ctx.close()

        # ---------------------------------------------------------------- signup (UI)
        A_EMAIL, A_ORG, PW = f'ent-a-{run}@example.test', f'Ent UI Alpha {run}', 'a long signup passphrase'
        ctxA = b.new_context(viewport={'width': 1440, 'height': 950}); a = ctxA.new_page(); aerrs = []; a.on('pageerror', lambda e: aerrs.append(str(e)))
        a.goto(WEB + '/signup'); a.wait_for_timeout(1200)
        a.get_by_role('button', name='Create organization').click(); a.wait_for_timeout(300)
        check('signup: empty form names every missing field', a.get_by_text('Enter your organization name.').count() == 1 and a.get_by_text('Choose your industry.').count() == 1)
        a.get_by_label('Organization name').fill(A_ORG)
        a.get_by_label('Your name').fill('Alpha Admin')
        a.get_by_label('Business email').fill(A_EMAIL)
        a.get_by_label('Password', exact=True).fill('short')
        a.get_by_role('radio', name=re.compile('^Retail & e-commerce')).check(force=True)
        a.get_by_role('checkbox').check()
        a.get_by_role('button', name='Create organization').click(); a.wait_for_timeout(300)
        check('signup: weak password refused before submitting', a.get_by_text('Use at least 12 characters.').count() == 1)
        a.get_by_label('Password', exact=True).fill(PW)
        a.get_by_role('button', name='Create organization').click(); a.wait_for_timeout(4500)
        aapi = fetcher(a)
        me = aapi('/auth/me')['body'] or {}
        check('signup: lands signed in, as an ORGANIZATION admin, pending review', me.get('role') == 'admin' and me.get('organizationStatus') == 'pending_review' and me.get('isPlatformAdmin') is False, json.dumps({k: me.get(k) for k in ('role', 'organizationStatus', 'isPlatformAdmin')}))
        A = me.get('organizationId'); created_orgs.append(A)
        a.goto(WEB + '/'); a.wait_for_timeout(2500)
        check('dashboard: awaiting-activation banner shown', a.get_by_text('Awaiting activation.').count() == 1)
        a.screenshot(path=os.path.join(SHOTS, 'signup-dashboard.png'))

        # duplicates / bots via the public API (fresh context: no session)
        pub = b.new_context().new_page(); pub.goto(WEB + '/welcome'); papi = fetcher(pub)
        base = {'organizationName': f'Ent dup {run}', 'adminName': 'Xavier', 'email': A_EMAIL, 'password': PW, 'industry': 'retail', 'acceptTerms': True}
        check('signup: an existing email is refused (409)', papi('/auth/signup', base)['status'] == 409)
        check('signup: the same organization name is refused (409)', papi('/auth/signup', {**base, 'email': f'other-{run}@example.test', 'organizationName': A_ORG.upper()})['status'] == 409)
        check('signup: honeypot (bot) refused', papi('/auth/signup', {**base, 'email': f'bot-{run}@example.test', 'organizationName': f'Bot {run}', 'website': 'http://spam'})['status'] == 400)
        B_EMAIL = f'ent-b-{run}@example.test'
        rb = papi('/auth/signup', {**base, 'email': B_EMAIL, 'organizationName': f'Ent UI Beta {run}', 'industry': 'hospital', 'isPlatformAdmin': True, 'organizationId': A})
        check('signup: second organization created; injected organizationId / platform flag ignored', rb['status'] == 201 and rb['body']['organization']['id'] != A, str(rb['status']))
        B = rb['body']['organization']['id']; created_orgs.append(B)
        check('signup: the new admin is not a platform admin (database)', sql(f"SELECT isPlatformAdmin FROM User WHERE email='{B_EMAIL}'") == '0')

        # ---------------------------------------------------------------- tenant isolation (A vs B)
        ctxB, bpg, bapi, berrs = login(b, B_EMAIL, PW)
        cust = aapi('/customers', {'name': f'Alpha customer {run}', 'phone': f'98{run}11'[:10]})
        cid = (cust['body'] or {}).get('id')
        check('isolation: A created a customer', cust['status'] in (200, 201) and cid, str(cust['status']))
        check('isolation: B cannot read A\'s customer by id', bapi(f'/customers/{cid}')['status'] in (403, 404))
        check('isolation: B cannot change A\'s customer', bapi(f'/customers/{cid}', {'name': 'hijack'}, 'PATCH')['status'] in (403, 404))
        rows = (bapi('/customers?pageSize=100')['body'] or {}).get('rows', [])
        check('isolation: A\'s customer is not in B\'s list', all(r.get('id') != cid for r in rows))
        inj = bapi('/customers', {'name': f'Beta injected {run}', 'phone': f'97{run}22'[:10], 'organizationId': A})
        inj_id = (inj['body'] or {}).get('id')
        check('isolation: an organizationId in the body is ignored (record lands in B)', inj_id and sql(f"SELECT organizationId FROM Customer WHERE id='{inj_id}'") == B, str(inj['status']))
        for path in ['/leads', '/conversations', '/calls', '/properties', '/follow-ups']:
            r = bapi(path)
            check(f'isolation: B reading {path} sees nothing of A', A not in (r['raw'] or ''), str(r['status']))
        check('isolation: B cannot switch into A (403)', bapi('/auth/workspace', {'organizationId': A})['status'] == 403)

        # ---------------------------------------------------------------- integrations (A, admin)
        a.goto(WEB + '/settings/integrations'); a.wait_for_timeout(2500)
        check('integrations: list shows Plivo and WhatsApp, not configured', a.get_by_text('Plivo voice').count() >= 1 and a.get_by_text('Not configured').count() >= 2)
        check('integrations: a self-service org does not use the platform account', a.get_by_text(re.compile('Not in use')).count() >= 1)
        a.goto(WEB + '/settings/integrations/plivo'); a.wait_for_timeout(2500)
        SECRET = f'plivo-ui-secret-{run}-ZZ'
        a.get_by_label('Auth ID', exact=True).fill(f'MAUITEST{run}AAAA')
        a.get_by_label('Auth Token', exact=True).fill(SECRET)
        a.get_by_label('Outbound caller ID', exact=True).fill('+91 44 0000 0001')
        a.get_by_role('button', name='Save configuration').click(); a.wait_for_timeout(2500)
        check('integrations: saved, shown as "Saved, not tested" (saving is not a passing test)', a.get_by_text('Saved, not tested').count() >= 1)
        check('integrations: the token is masked, never shown', SECRET not in a.content() and a.get_by_placeholder(f'Saved ••••{SECRET[-4:]} — type to replace').count() == 1)
        g = aapi('/integrations/plivo')
        check('integrations: API response contains no secret', SECRET not in g['raw'] and g['body']['secrets']['authToken'] == '••••' + SECRET[-4:])
        check('integrations: stored encrypted in the database', SECRET not in sql(f"SELECT secretCiphertext FROM IntegrationCredential WHERE organizationId='{A}' AND provider='plivo'"))
        check('integrations: "Enable" disabled until a test passes', a.get_by_role('button', name='Enable integration').is_disabled())
        check('integrations: enabling via the API is refused too', aapi('/integrations/plivo/enable', {'enabled': True})['status'] == 400)
        a.get_by_role('button', name='Test connection').click(); a.wait_for_timeout(12000)
        t = aapi('/integrations/plivo')['body']
        check('integrations: an unreachable provider is reported as a failure (never as connected)', t['status'] == 'failed' and t['lastError'] and SECRET not in t['lastError'], (t.get('lastError') or '')[:120])
        a.screenshot(path=os.path.join(SHOTS, 'integrations-plivo.png'), full_page=True)
        check('integrations: unsupported OpenAI model refused by the server', aapi('/integrations/openai', {'apiKey': 'sk-test-abcdefgh', 'model': 'gpt-3.5-turbo'}, 'PUT')['status'] == 400)
        check('integrations: B does not see A\'s Plivo configuration', (bapi('/integrations/plivo')['body'] or {}).get('saved') is False)
        check('integrations: test call refused while pending / dry run', aapi('/integrations/plivo/test/call', {'to': '919800011122', 'confirm': True})['status'] == 403)

        # roles: operator cannot see or change integrations; manager can see, not change
        for role in ('operator', 'manager'):
            inv = aapi('/team/invitations', {'email': f'{role}-{run}@example.test', 'role': role})['body']
            c2 = b.new_context(); p2 = c2.new_page(); p2.goto(WEB + '/welcome'); api2 = fetcher(p2)
            acc = api2('/team/links/accept', {'token': inv['token'], 'name': role, 'password': 'role passphrase for test'})
            got, put = api2('/integrations/plivo')['status'], api2('/integrations/plivo', {'authToken': 'x' * 20}, 'PUT')['status']
            expect_get = 403 if role == 'operator' else 200
            check(f'roles: {role} sees integrations = {expect_get == 200}, cannot save (server-enforced)', acc['status'] in (200, 201) and got == expect_get and put == 403, f'accept={acc["status"]} get={got} put={put}')
            c2.close()

        # ---------------------------------------------------------------- platform console
        check('platform: an organization admin is refused', aapi('/platform/overview')['status'] == 403)
        ctxS, s, sapi, serrs = login(b, 'staff@tacksharp.test', 'platform staff test pass')
        s.goto(WEB + f'/platform?'); s.wait_for_timeout(2500)
        s.get_by_label('Search organizations').fill(f'Ent UI Alpha {run}'); s.get_by_role('button', name='Search').click(); s.wait_for_timeout(1500)
        check('platform: finds the new organization, pending review', s.get_by_role('link', name=A_ORG).count() == 1 and s.get_by_text('Pending review').count() >= 1)
        s.get_by_role('link', name=A_ORG).click(); s.wait_for_timeout(2500)
        check('platform: detail shows onboarding from records and integration STATUS only', s.get_by_text('Onboarding').count() >= 1 and SECRET not in s.content() and SECRET[-4:] not in s.content())
        s.get_by_role('button', name='Activate').click(); s.wait_for_timeout(400)
        dlg = s.locator('dialog[open]')
        check('platform: activation needs the exact name typed', dlg.get_by_role('button', name='Activate').is_disabled())
        dlg.get_by_label(re.compile('to confirm')).fill(A_ORG); dlg.get_by_role('button', name='Activate').click(); s.wait_for_timeout(2500)
        check('platform: organization activated', sql(f"SELECT status FROM Organization WHERE id='{A}'") == 'active')
        s.screenshot(path=os.path.join(SHOTS, 'platform-org.png'), full_page=True)
        time.sleep(1)
        r = sapi(f'/platform/organizations/{B}/suspend', {'confirmName': f'Ent UI Beta {run}', 'reason': 'ui test suspension'})
        check('platform: suspend B', r['status'] == 200, str(r['status']))
        check('platform: B\'s open session stops at once', bapi('/auth/me')['status'] == 401)
        c3 = b.new_context().new_page(); c3.goto(WEB + '/welcome')
        lr = fetcher(c3)('/auth/login', {'email': B_EMAIL, 'password': PW})
        check('platform: B cannot log in while suspended (clear message)', lr['status'] == 403 and 'suspended' in json.dumps(lr['body']))
        s.goto(WEB + '/platform/health'); s.wait_for_timeout(2500)
        check('platform: service health shows database and queues', s.get_by_text('Database').count() >= 1 and s.get_by_role('heading', name='Queues').count() == 1)
        s.goto(WEB + '/platform/failures'); s.wait_for_timeout(2000)
        check('platform: failures page loads', s.get_by_role('heading', name='Failed background jobs').count() == 1)
        s.goto(WEB + '/platform/audit'); s.wait_for_timeout(2000)
        check('platform: audit log lists the activation', s.get_by_text('organization.activated').count() >= 1)
        check('no page errors in the dashboards', not aerrs and not berrs and not serrs, '; '.join(aerrs + berrs + serrs)[:200])

        # ---------------------------------------------------------------- forgot password
        f = b.new_context().new_page(); f.goto(WEB + '/forgot-password'); f.wait_for_timeout(1000)
        f.get_by_label(re.compile('record a reset request')).fill(A_EMAIL); f.get_by_role('button', name='Record reset request').click(); f.wait_for_timeout(1500)
        check('forgot password: honest answer, request recorded for the admins', f.get_by_role('status').filter(has_text='no message is sent').count() == 1 and sql(f"SELECT COUNT(*) FROM AuditEvent WHERE organizationId='{A}' AND action='password.reset_requested'") == '1')
    finally:
        # Test organizations only (created by this run); cascades remove their users, settings, credentials.
        for o in [x for x in created_orgs if x]:
            sql(f"DELETE FROM Organization WHERE id='{o}' AND selfServe=1")
        sql(f"DELETE FROM User WHERE email LIKE '%-{run}@example.test'")
        b.close()

print(f"\n{sum(results)}/{len(results)} passed")
raise SystemExit(0 if all(results) else 1)
