"""
Customer management in a LIVE (non-demo) workspace through the real dashboard + API + MySQL (TEST database only), DRY_RUN=true:
the workspace badge, add a customer (validation, consent source), search, edit, the consent-gated WhatsApp test and test call
(confirmation dialog; simulated / not placed under DRY_RUN — nothing reaches WhatsApp or the phone network), opt-out, the
history, and tenant isolation against a demo workspace.

  Needs: API on :3000 (DB_NAME=<test db> DRY_RUN=true RATE_LIMIT_API_PER_MIN=2000 RATE_LIMIT_LOGIN=100), web on :3001,
         with WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID / PLIVO_FROM_NUMBER set (placeholders are fine: DRY_RUN
         stops every provider request) — without them the contact buttons are, correctly, disabled as "not configured".
         owner@tacksharp.test (home workspace is a real one; memberships to the demo workspaces).
  Run:   TEST_DB_NAME=tacksharp_test python3 -I apps/web/tests/ui-contacts.py

Creates customers named "UI Contact <run>" in the owner's home workspace of the TEST database. No message, no call.
"""
from playwright.sync_api import sync_playwright
import json, os, re, tempfile, time

WEB, API = 'http://localhost:3001', 'http://localhost:3000'
SHOTS = os.environ.get('SHOTS_DIR', tempfile.gettempdir())
results = []
def check(name, ok, detail=''):
    results.append(bool(ok)); print(('PASS ' if ok else 'FAIL ') + name + (f'  — {detail}' if detail else ''))

run = str(int(time.time()))[-6:]
phone = '98' + run + '77'  # 10 digits, unique per run

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 1440, 'height': 950}); pg = ctx.new_page()
    errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.on('dialog', lambda d: d.accept())  # the opt-out window.confirm
    pg.goto(WEB + '/login'); pg.get_by_label('Email').fill('owner@tacksharp.test'); pg.get_by_label('Password').fill('correct-horse-battery')
    pg.get_by_role('button', name='Log in').click(); pg.wait_for_timeout(2500)
    def api(path, body=None, method=None):
        return pg.evaluate("""async ([url, body, method]) => { const r = await fetch(url, { method: method || (body ? 'POST' : 'GET'), credentials: 'include', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; }""", [API + path, body, method])

    me = api('/auth/me')['body']; home = me['organizationId']
    spaces = api('/auth/workspaces')['body']
    homews = next(w for w in spaces if w['organizationId'] == home)
    check('home workspace is a live (non-demo) workspace', not homews['isDemo'], homews['name'])
    demo = next((w for w in spaces if w['isDemo'] and w['organizationId'].startswith('org_demo_') and w['industry'] == 'real_estate'), None)
    try:
        pg.goto(WEB + '/contacts'); pg.wait_for_timeout(2500)
        check('header badge says "Live workspace"', pg.get_by_text('Live workspace', exact=True).count() > 0)
        check('no "Demo data" badge in a live workspace', pg.get_by_text('Demo data', exact=True).count() == 0)

        # ---- add: validation first
        pg.get_by_role('button', name=re.compile(r'^Add ')).first.click(); pg.wait_for_timeout(500)
        d = pg.locator('dialog[open]')
        d.get_by_role('button', name=re.compile(r'^Save ')).click(); pg.wait_for_timeout(300)
        check('add: empty form shows field errors (no request)', d.get_by_text('Enter the name.').is_visible() and d.get_by_text(re.compile('10-digit mobile number')).is_visible())
        d.get_by_label('Name *').fill(f'UI Contact {run}'); d.get_by_label('Mobile number *').fill(phone); d.get_by_label('Email').fill(f'ui{run}@example.com')
        d.get_by_text('May receive WhatsApp messages from us').click()
        d.get_by_role('button', name=re.compile(r'^Save ')).click(); pg.wait_for_timeout(300)
        check('add: consent without a source is refused', d.get_by_text('Say how they gave consent.').is_visible())
        d.get_by_label('How did they give consent? *').select_option('in_person')
        d.get_by_role('button', name=re.compile(r'^Save ')).click(); pg.wait_for_timeout(2500)
        drawer = pg.locator('dialog[open]').filter(has_text='Contact test')
        check('add: saved and the record opens', drawer.count() == 1 and drawer.get_by_text('+91' + phone).count() > 0)
        check('readiness says NOT live (DRY_RUN) — no real send possible', drawer.get_by_text(re.compile(r'not live \(DRY_RUN')).count() > 0)
        found = api(f'/customers?q={phone}')['body']
        cust = found['rows'][0] if found['total'] == 1 else None
        check('API: stored once, in this workspace, not marked demo', cust is not None and cust['organizationId'] == home and cust['isDemo'] is False and cust['messagingConsent'] is True)
        dup = api('/customers', {'name': 'Dup', 'phone': phone})
        check('API: duplicate number refused (409) with the existing id', dup['status'] == 409 and dup['body'].get('customerId') == (cust or {}).get('id'))

        # ---- WhatsApp test: confirmation, then simulated (DRY_RUN)
        drawer.get_by_role('button', name='Send WhatsApp test').click(); pg.wait_for_timeout(500)
        conf = pg.locator('dialog[open]').filter(has_text='Send a WhatsApp test?').last  # nested inside the record dialog
        check('WhatsApp test asks for confirmation and says it is simulated', conf.is_visible() and 'nothing is sent' in conf.inner_text())
        conf.get_by_role('button', name='Continue').click(); pg.wait_for_timeout(2000)
        check('WhatsApp test reported as simulated, not "sent"', drawer.get_by_role('status').filter(has_text='Simulated, not sent').count() == 1)
        # ---- test call: no calling consent -> button disabled with the reason
        call_btn = drawer.get_by_role('button', name='Test call')
        check('test call disabled without calling consent (reason shown)', call_btn.is_disabled() and drawer.get_by_text('No calling consent recorded.').count() > 0)
        pg.screenshot(path=os.path.join(SHOTS, 'contacts-drawer.png'))

        # ---- edit
        drawer.get_by_role('button', name='Edit details & consent').click(); pg.wait_for_timeout(400)
        drawer.get_by_label('Name *').fill(f'UI Contact {run} edited')
        drawer.get_by_text('May receive calls (including AI calls)').click()
        drawer.get_by_label('How did they give consent? *').select_option('phone_call')
        drawer.get_by_role('button', name='Save changes').click(); pg.wait_for_timeout(2000)
        after = api(f"/customers/{cust['id']}")['body']['customer'] if cust else {}
        check('edit: name and calling consent saved', after.get('name') == f'UI Contact {run} edited' and after.get('callingConsent') is True)
        drawer.get_by_role('button', name='Test call').click(); pg.wait_for_timeout(500)
        conf = pg.locator('dialog[open]').filter(has_text='Place a test call?').last
        conf.get_by_role('button', name='Continue').click(); pg.wait_for_timeout(2000)
        check('test call: not placed under DRY_RUN (reported honestly)', drawer.get_by_role('status').filter(has_text='No call placed').count() == 1)
        calls = api(f"/customers/{cust['id']}")['body']['calls'] if cust else [1]
        check('test call: no Call row created', len(calls) == 0)

        # ---- opt out, then the contact buttons are blocked
        drawer.get_by_role('button', name='Mark opted out').click(); pg.wait_for_timeout(2000)
        check('opt-out: shown as opted out and WhatsApp test blocked', drawer.get_by_text('opted out', exact=True).count() > 0 and drawer.get_by_role('button', name='Send WhatsApp test').is_disabled())
        hist = drawer.inner_text()
        check('history lists created / updated / contact tests', all(k in hist for k in ('created', 'updated')) and re.search(r'whatsapp test|test call', hist, re.I) is not None)
        drawer.get_by_role('button', name='Close').first.click(); pg.wait_for_timeout(500)

        # ---- search + filter on the list
        pg.get_by_placeholder('Name, phone or email').fill(run); pg.wait_for_timeout(1800)
        check('search finds the customer by number fragment', pg.get_by_text(f'UI Contact {run} edited').count() > 0)
        pg.get_by_label('Consent filter').select_option('opted_out'); pg.wait_for_timeout(1500)
        check('filter "opted out" keeps it', pg.get_by_text(f'UI Contact {run} edited').count() > 0)
        pg.get_by_label('Consent filter').select_option('messaging'); pg.wait_for_timeout(1500)
        check('filter "can message" drops it', pg.get_by_text(f'UI Contact {run} edited').count() == 0)

        # ---- isolation: a demo workspace can neither see nor read this record
        if demo and cust:
            api('/auth/workspace', {'organizationId': demo['organizationId']})
            other = api(f"/customers/{cust['id']}")
            check('demo workspace: the live record is 404', other['status'] == 404)
            check('demo workspace: search does not return it', api(f'/customers?q={phone}')['body']['total'] == 0)
            check('demo workspace: cannot edit it', api(f"/customers/{cust['id']}", {'name': 'x'}, 'PATCH')['status'] == 404)
            pg.goto(WEB + '/contacts'); pg.wait_for_timeout(2500)
            check('demo workspace header badge says "Demo data"', pg.get_by_text('Demo data', exact=True).count() > 0)
            check('demo customers are labelled demo', pg.get_by_text('demo', exact=True).count() > 0)
            pg.screenshot(path=os.path.join(SHOTS, 'contacts-demo.png'))
        else:
            check('a demo workspace to test isolation against', False, 'none found')
        check('no page errors', not errs, '; '.join(errs)[:200])
    finally:
        api('/auth/workspace', {'organizationId': home})
    b.close()

print(f"\n{sum(results)}/{len(results)} passed")
raise SystemExit(0 if all(results) else 1)
