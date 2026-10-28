"""
Shared WhatsApp / Plivo number across industry workspaces, end to end through the real dashboard + API + worker +
MySQL (TEST database only), DRY_RUN=true: nothing reaches Meta or Plivo.

  Needs: API on :3000 with DB_NAME=<test db> DRY_RUN=true RUN_WORKERS=true LIVE_TEST_RECIPIENTS=919800011122
         WHATSAPP_PHONE_NUMBER_ID=PNID_LOCAL (identifier only) and no META_APP_SECRET (local signature check off),
         web on :3001, owner@tacksharp.test with the demo workspaces.
  Run:   TEST_DB_NAME=tacksharp_test python3 -I apps/web/tests/ui-demo-sessions.py

Checks: the live-demo card shows honest status; a session binds the approved tester to the HOTEL demo workspace; a
signed-format Meta webhook from the tester is answered by the hotel agent and stored only there; a stranger reaches the
number's owner; switching the dashboard to another workspace does not move the tester; ending the session restores
normal routing; the session is not visible from another workspace.
"""
from playwright.sync_api import sync_playwright
import json, os, re, tempfile, time, urllib.request

WEB, API = 'http://localhost:3001', 'http://localhost:3000'
SHOTS = os.environ.get('SHOTS_DIR', tempfile.gettempdir())
TESTER, STRANGER = '919800011122', '919800099911'
results = []
def check(name, ok, detail=''):
    results.append(bool(ok)); print(('PASS ' if ok else 'FAIL ') + name + (f'  — {detail}' if detail else ''))

def webhook(frm, text):
    mid = f'wamid.UI{int(time.time()*1000)}{frm[-3:]}'
    body = {'object': 'whatsapp_business_account', 'entry': [{'changes': [{'field': 'messages', 'value': {
        'metadata': {'phone_number_id': 'PNID_LOCAL'}, 'contacts': [{'wa_id': frm, 'profile': {'name': 'UI Tester'}}],
        'messages': [{'from': frm, 'id': mid, 'type': 'text', 'text': {'body': text}, 'timestamp': str(int(time.time()))}]}}]}]}
    req = urllib.request.Request(API + '/webhooks/whatsapp', data=json.dumps(body).encode(), method='POST', headers={'content-type': 'application/json'})
    return urllib.request.urlopen(req).status, mid

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 1440, 'height': 950}); pg = ctx.new_page()
    errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(WEB + '/login'); pg.get_by_label('Email').fill('owner@tacksharp.test'); pg.get_by_label('Password').fill('correct-horse-battery')
    pg.get_by_role('button', name='Log in').click(); pg.wait_for_timeout(2500)
    def api(path, body=None, method=None):
        return pg.evaluate("""async ([url, body, method]) => { const r = await fetch(url, { method: method || (body ? 'POST' : 'GET'), credentials: 'include', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; }""", [API + path, body, method])
    home = api('/auth/me')['body']['organizationId']
    spaces = {w['organizationId']: w for w in api('/auth/workspaces')['body']}
    HOTEL, TEXTILE = 'org_demo_hotel', 'org_demo_textile'
    check('hotel and textile demo workspaces available', HOTEL in spaces and TEXTILE in spaces)
    try:
        # clean slate for this tester in the involved workspaces (test DB)
        api('/auth/workspace', {'organizationId': HOTEL})
        for s in api('/demo-sessions')['body'] or []:
            if s['status'] == 'active': api(f"/demo-sessions/{s['id']}/end", {})
        pg.goto(WEB + '/demo-data'); pg.wait_for_timeout(2500)
        card = pg.locator('section, div').filter(has=pg.get_by_role('heading', name='Live demo on the shared number')).first
        check('live-demo card on the hotel workspace Data & APIs page', pg.get_by_role('heading', name='Live demo on the shared number').count() == 1)
        body_txt = pg.locator('body').inner_text()
        check('mode shown honestly as simulated (DRY_RUN)', 'Demo mode · simulated (DRY_RUN)' in body_txt)
        before = re.findall(r'(Configured · not checked|Connected|Authentication failed|Provider unavailable)', body_txt)
        check('providers show "not checked" or the last real check — never an invented "Connected"', len(before) >= 2 and 'Connected' not in before, ', '.join(before))
        pg.get_by_role('button', name='Check connections').click(); pg.wait_for_timeout(9000)
        body_txt = pg.locator('body').inner_text()
        probed = re.findall(r'(Connected|Authentication failed|Provider unavailable)', body_txt)
        check('connection check reports the real provider result (placeholders cannot be "Connected")', len(probed) >= 2 and 'Connected' not in probed, ', '.join(probed))

        # start without confirmation -> refused; with -> session
        pg.get_by_label('Approved test number').select_option(TESTER)
        pg.get_by_role('button', name='Start demo session').click(); pg.wait_for_timeout(400)
        check('start refused without the tester confirmation', pg.get_by_role('alert').filter(has_text='Confirm that the tester agreed').count() == 1)
        pg.get_by_text('This number belongs to an approved tester').click()
        pg.get_by_role('button', name='Start demo session').click(); pg.wait_for_timeout(2000)
        check('session started message', pg.get_by_role('status').filter(has_text='Session started').count() == 1)
        sess = [s for s in api('/demo-sessions')['body'] if s['status'] == 'active']
        check('API: one active session, industry hotel', len(sess) == 1 and sess[0]['industry'] == 'hotel', json.dumps(sess)[:160])
        pg.screenshot(path=os.path.join(SHOTS, 'demo-session-card.png'), full_page=False)

        # a stranger's id is refused by the API (not on the approved list)
        refused = api('/demo-sessions', {'phone': STRANGER, 'confirm': True})
        check('API refuses a number that is not an approved test recipient', refused['status'] == 400)

        # switch the dashboard to TEXTILE before the tester writes: routing must still follow the session (hotel)
        api('/auth/workspace', {'organizationId': TEXTILE})
        st, mid = webhook(TESTER, 'Hi, do you have a deluxe room for 2 adults this Friday and Saturday?')
        check('webhook accepted (HTTP 200)', st == 200)
        st2, mid2 = webhook(STRANGER, 'hello')
        time.sleep(9)
        api('/auth/workspace', {'organizationId': HOTEL})
        convs = api('/conversations')['body']
        convs = convs if isinstance(convs, list) else convs.get('rows', convs.get('items', []))
        mine = [c for c in convs if TESTER in json.dumps(c)]
        check('tester conversation stored in the HOTEL workspace (dashboard was on textile)', len(mine) >= 1)
        got = api(f"/conversations/{mine[0]['id']}/messages")['body'] if mine else []
        msgs = got if isinstance(got, list) else (got.get('messages') or got.get('rows') or [])
        text = json.dumps(msgs, ensure_ascii=False)
        check('inbound message and an AI reply recorded in the hotel conversation', 'deluxe room' in text and any(m.get('role') == 'assistant' for m in msgs), f'{len(msgs)} messages')
        replies = [m.get('content', '') for m in msgs if m.get('role') == 'assistant']
        check('reply comes from the hotel agent (not real-estate wording)', replies and not re.search(r'\bBHK\b|property|site visit', replies[-1], re.I), (replies[-1] if replies else '')[:140])
        check('reply not actually sent (DRY_RUN): no provider message id', all(not m.get('externalId') for m in msgs if m.get('role') == 'assistant'))
        api('/auth/workspace', {'organizationId': TEXTILE})
        tconvs = api('/conversations')['body']; tconvs = tconvs if isinstance(tconvs, list) else tconvs.get('rows', tconvs.get('items', []))
        check('nothing from the tester leaked into the textile workspace', not any(TESTER in json.dumps(c) for c in tconvs))
        api('/auth/workspace', {'organizationId': home})
        hconvs = api('/conversations')['body']; hconvs = hconvs if isinstance(hconvs, list) else hconvs.get('rows', hconvs.get('items', []))
        check("stranger's message reached the number's owner workspace, the tester's did not", any(STRANGER in json.dumps(c) for c in hconvs) and not any(TESTER in json.dumps(c) and 'deluxe' in json.dumps(c) for c in hconvs))

        # the hotel session is invisible / not endable from textile
        api('/auth/workspace', {'organizationId': TEXTILE})
        check('session not visible from another workspace', not any(s['id'] == sess[0]['id'] for s in api('/demo-sessions')['body']))
        check('session cannot be ended from another workspace (404)', api(f"/demo-sessions/{sess[0]['id']}/end", {})['status'] == 404)

        # end it from hotel: tester now reaches the owner
        api('/auth/workspace', {'organizationId': HOTEL})
        pg.goto(WEB + '/demo-data'); pg.wait_for_timeout(2500)
        pg.get_by_role('button', name='End', exact=True).first.click(); pg.wait_for_timeout(1500)
        check('session ended from the dashboard', all(s['status'] != 'active' for s in api('/demo-sessions')['body']))
        webhook(TESTER, 'one more question'); time.sleep(6)
        api('/auth/workspace', {'organizationId': home})
        hconvs = api('/conversations')['body']; hconvs = hconvs if isinstance(hconvs, list) else hconvs.get('rows', hconvs.get('items', []))
        check('after the session ended, the tester reaches the owner workspace again', any(TESTER in json.dumps(c) for c in hconvs))
        check('no page errors', not errs, '; '.join(errs)[:200])
    finally:
        api('/auth/workspace', {'organizationId': home})
    b.close()

print(f"\n{sum(results)}/{len(results)} passed")
raise SystemExit(0 if all(results) else 1)
