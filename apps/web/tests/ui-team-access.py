"""
Sharable, per-workspace access through the real dashboard + API + MySQL (TEST database only). No email is sent.

  Needs: API on :3000 (DB_NAME=<test db>), web on :3001, owner@tacksharp.test (admin, member of the demo workspaces).
  Run:   TEST_DB_NAME=tacksharp_test python3 -I apps/web/tests/ui-team-access.py

An admin opens the HOTEL demo workspace → Team & access, creates a viewer invitation link; a different browser opens
the link, sets a password and lands in the hotel workspace, read-only, seeing no other workspace; its writes are
refused; the admin removes it and the open session stops working; the used link cannot be reused.
"""
from playwright.sync_api import sync_playwright
import json, os, re, tempfile, time

WEB, API = 'http://localhost:3001', 'http://localhost:3000'
SHOTS = os.environ.get('SHOTS_DIR', tempfile.gettempdir())
run = str(int(time.time()))[-7:]
EMAIL = f'viewer.{run}@example.test'
results = []
def check(name, ok, detail=''):
    results.append(bool(ok)); print(('PASS ' if ok else 'FAIL ') + name + (f'  — {detail}' if detail else ''))

def fetcher(pg):
    return lambda path, body=None, method=None: pg.evaluate("""async ([url, body, method]) => { const r = await fetch(url, { method: method || (body ? 'POST' : 'GET'), credentials: 'include', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; }""", [API + path, body, method])

with sync_playwright() as p:
    b = p.chromium.launch()
    admin_ctx = b.new_context(viewport={'width': 1440, 'height': 950}); pg = admin_ctx.new_page()
    errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(WEB + '/login'); pg.get_by_label('Email').fill('owner@tacksharp.test'); pg.get_by_label('Password').fill('correct-horse-battery')
    pg.get_by_role('button', name='Log in').click(); pg.wait_for_timeout(2500)
    api = fetcher(pg)
    home = api('/auth/me')['body']['organizationId']
    try:
        api('/auth/workspace', {'organizationId': 'org_demo_hotel'})
        pg.goto(WEB + '/team'); pg.wait_for_timeout(2500)
        check('Team & access page lists the people of the hotel workspace', pg.get_by_role('heading', name=re.compile('People with access to')).count() == 1)
        check('menu has Team & access', pg.get_by_role('link', name='Team & access').count() > 0)
        pg.get_by_label('Email address').fill(EMAIL)
        pg.get_by_label('Invite as').select_option('viewer')
        pg.get_by_role('button', name='Create invitation link').click(); pg.wait_for_timeout(1500)
        link = pg.locator('#share-link').input_value() if pg.locator('#share-link').count() else ''
        check('invitation link shown once, as /invite#<token>', re.match(rf'^{re.escape(WEB)}/invite#[A-Za-z0-9_-]{{40,}}$', link) is not None, link[:40] + '…')
        check('honest note: email is not configured, nothing was emailed', 'Email sending is not configured' in pg.locator('body').inner_text())
        pg.screenshot(path=os.path.join(SHOTS, 'team-invite-link.png'))
        pg.get_by_role('button', name='Done').click(); pg.wait_for_timeout(500)
        check('open invitation listed', pg.get_by_text(EMAIL).count() > 0)

        # the invited person, in a separate browser
        vctx = b.new_context(viewport={'width': 390, 'height': 844}); v = vctx.new_page()
        verrs = []; v.on('pageerror', lambda e: verrs.append(str(e)))
        v.goto(link); v.wait_for_timeout(2500)
        check('token removed from the address bar after reading it', '#' not in v.url, v.url)
        check('invite page names the workspace and the read-only role', 'Join' in v.locator('h1').inner_text() and 'read-only' in v.locator('body').inner_text())
        v.get_by_label('Your name').fill('Demo Viewer')
        v.get_by_label('New password').fill('short')
        v.get_by_label('Repeat the password').fill('short')
        v.get_by_role('button', name='Accept and sign in').click(); v.wait_for_timeout(500)
        check('weak password refused', v.get_by_role('alert').filter(has_text='12 characters').count() == 1)
        v.get_by_label('New password').fill('a viewer sentence passphrase')
        v.get_by_label('Repeat the password').fill('a viewer sentence passphrase')
        v.get_by_role('button', name='Accept and sign in').click(); v.wait_for_timeout(4500)
        vapi = fetcher(v)
        me = vapi('/auth/me')['body'] or {}
        check('viewer lands in the hotel workspace', me.get('organizationId') == 'org_demo_hotel', me.get('organizationName', ''))
        spaces = vapi('/auth/workspaces')['body'] or []
        check('viewer sees only that workspace (no other industry)', [w['organizationId'] for w in spaces] == ['org_demo_hotel'], json.dumps([w['organizationId'] for w in spaces]))
        check('switching into another workspace is refused (403)', vapi('/auth/workspace', {'organizationId': 'org_demo_textile'})['status'] == 403)
        check('another workspace\'s data is not readable', all(c.get('organizationId', 'org_demo_hotel') == 'org_demo_hotel' for c in (vapi('/customers?pageSize=50')['body'] or {}).get('rows', [])))
        v.goto(WEB + '/'); v.wait_for_timeout(3000)
        check('dashboard shows "Read-only" and the hotel workspace', v.get_by_text('Read-only', exact=True).count() > 0 and v.get_by_text('Demo data', exact=True).count() > 0)
        v.screenshot(path=os.path.join(SHOTS, 'viewer-mobile.png'))
        w = vapi('/customers', {'name': 'Should Fail', 'phone': '9876500000'})
        check('viewer writes are refused (403 read-only)', w['status'] == 403 and 'read-only' in json.dumps(w['body']), str(w['status']))
        check('viewer cannot open Team & access (admins only)', vapi('/team')['status'] == 403)
        reuse = vapi('/team/links/inspect', {'token': link.split('#', 1)[1]})
        check('used link cannot be used again', reuse['status'] == 400)

        # admin removes the viewer: the open session stops at once
        team = api('/team')['body']
        vid = next(m['userId'] for m in team['members'] if m['email'] == EMAIL)
        pg.reload(); pg.wait_for_timeout(2500)
        row = pg.locator('tr').filter(has_text=EMAIL)
        row.get_by_role('button', name=re.compile('Remove')).click(); pg.wait_for_timeout(400)
        pg.get_by_role('button', name='Remove access').click(); pg.wait_for_timeout(1500)
        check('admin removed the viewer', pg.get_by_role('status').filter(has_text='no longer has access').count() == 1)
        check("viewer's open session is refused right away (401)", vapi('/auth/me')['status'] == 401)
        audit = api('/team')['body']
        check('viewer no longer listed as active', not any(m['email'] == EMAIL and not m['disabled'] for m in audit['members']))
        check('no page errors', not errs and not verrs, '; '.join(errs + verrs)[:200])
        vctx.close()
    finally:
        api('/auth/workspace', {'organizationId': home})
    b.close()

print(f"\n{sum(results)}/{len(results)} passed")
raise SystemExit(0 if all(results) else 1)
