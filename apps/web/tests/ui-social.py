"""
Instagram & Messenger through the real dashboard + API + MySQL (TEST database, DRY_RUN=true: nothing is sent to Meta).
Settings: save (secrets masked), connection test against the real Graph API (unreachable from the sandbox: must show as
failed), the passing test SEEDED in the test database, enable through the UI -> Page / Instagram account routed to the
workspace. Webhook: unsigned and wrongly signed deliveries refused (401); signed Messenger and Instagram messages land
in the Team inbox (channel filter, badges, masked id, "AI pending" badge, automatic acknowledgement marked not sent);
a re-delivery is stored once; a staff reply is saved but NOT sent (DRY_RUN). Disabling stops routing.

  Run:   TEST_DB_NAME=tacksharp_test python3 -I apps/web/tests/ui-social.py
"""
from playwright.sync_api import sync_playwright
import hashlib, hmac, json, os, re, subprocess, tempfile, time, urllib.request, urllib.error

WEB, API = 'http://localhost:3001', 'http://localhost:3000'
SHOTS = os.environ.get('SHOTS_DIR', tempfile.gettempdir())
DB = os.environ.get('TEST_DB_NAME', 'tacksharp_test')
def sql(q):
    return subprocess.run(['mysql', '-h127.0.0.1', f"-u{os.environ.get('DB_USER', 'root')}", f"-p{os.environ.get('DB_PASSWORD', '')}", DB, '-N', '-e', q], capture_output=True, text=True).stdout.strip()

results = []
def check(name, ok, detail=''):
    results.append(bool(ok)); print(('PASS ' if ok else 'FAIL ') + name + (f'  — {detail}' if detail else ''))

run = str(int(time.time()))[-6:]
PAGE, IG = '8800' + run + '01', '1780' + run + '02'
TOKEN, SECRET = f'EAAuisocial{run}Qz7', f'uiappsecret{run}k9'
M_USER, I_USER = '3100' + run + '11', '3200' + run + '22'

def webhook(body, secret=SECRET, signed=True):
    raw = json.dumps(body).encode()
    headers = {'content-type': 'application/json'}
    if signed: headers['x-hub-signature-256'] = 'sha256=' + hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()
    try:
        with urllib.request.urlopen(urllib.request.Request(API + '/webhooks/meta-social', data=raw, headers=headers, method='POST'), timeout=20) as r:
            return r.status, json.loads(r.read() or b'{}')
    except urllib.error.HTTPError as e:
        return e.code, None
def event(obj, entry, frm, mid, text):
    return {'object': obj, 'entry': [{'id': entry, 'time': int(time.time() * 1000), 'messaging': [{'sender': {'id': frm}, 'recipient': {'id': entry}, 'timestamp': int(time.time() * 1000), 'message': {'mid': mid, 'text': text}}]}]}

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_context(viewport={'width': 1440, 'height': 950}).new_page()
    errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(WEB + '/login'); pg.get_by_label('Email').fill('owner@tacksharp.test'); pg.get_by_label('Password', exact=True).fill('correct-horse-battery')
    pg.get_by_role('button', name='Log in').click(); pg.wait_for_timeout(2500)
    org = sql("SELECT organizationId FROM User WHERE email='owner@tacksharp.test'")
    sql(f"DELETE FROM IntegrationCredential WHERE organizationId='{org}' AND provider='meta_social'")
    sql(f"DELETE FROM OrganizationChannel WHERE organizationId='{org}' AND kind IN ('messenger_page_id','instagram_account_id')")
    try:
        pg.goto(WEB + '/settings/integrations'); pg.wait_for_timeout(2500)
        check('integrations list has an "Instagram & Messenger" card', pg.get_by_test_id('integration-meta_social').count() == 1)
        pg.goto(WEB + '/settings/integrations/meta-social'); pg.wait_for_timeout(2500)
        pg.get_by_label('Page access token', exact=True).fill(TOKEN)
        pg.get_by_label('App secret', exact=True).fill(SECRET)
        pg.get_by_label('Facebook Page ID').fill(PAGE)
        pg.get_by_label('Instagram account ID').fill(IG)
        pg.get_by_label('Automatic acknowledgement').fill('Thanks! Our team will reply shortly.')
        pg.get_by_role('button', name='Save').first.click(); pg.wait_for_timeout(2000)
        check('saved; token and app secret never shown again', TOKEN not in pg.content() and SECRET not in pg.content() and sql(f"SELECT status FROM IntegrationCredential WHERE organizationId='{org}' AND provider='meta_social'") == 'untested')
        check('webhook setup card shows the callback URL', '/webhooks/meta-social' in pg.get_by_test_id('social-setup').inner_text())
        pg.get_by_role('button', name='Test connection').click(); pg.wait_for_timeout(15000)
        check('connection test against the real Graph API (unreachable here) is reported as failed', sql(f"SELECT status FROM IntegrationCredential WHERE organizationId='{org}' AND provider='meta_social'") == 'failed')
        # Meta is unreachable from the sandbox: seed the passing test (TEST DATABASE ONLY).
        sql(f"UPDATE IntegrationCredential SET status='ok', lastError=NULL WHERE organizationId='{org}' AND provider='meta_social'")
        pg.reload(); pg.wait_for_timeout(2500)
        pg.get_by_role('button', name='Enable integration').click(); pg.wait_for_timeout(2000)
        routed = sql(f"SELECT GROUP_CONCAT(kind ORDER BY kind) FROM OrganizationChannel WHERE organizationId='{org}' AND kind IN ('messenger_page_id','instagram_account_id')")
        check('enabling routes the Page and the Instagram account to this workspace', routed == 'instagram_account_id,messenger_page_id', routed)
        time.sleep(1)

        st, _ = webhook(event('page', PAGE, M_USER, f'm.ui.{run}.0', 'hi'), signed=False)
        check('unsigned delivery refused (401)', st == 401, st)
        st, _ = webhook(event('page', PAGE, M_USER, f'm.ui.{run}.0', 'hi'), secret='wrong-secret')
        check('wrongly signed delivery refused (401)', st == 401, st)
        st, r = webhook(event('page', PAGE, M_USER, f'm.ui.{run}.1', f'Velachery 2BHK details please {run}'))
        st2, r2 = webhook(event('page', PAGE, M_USER, f'm.ui.{run}.1', f'Velachery 2BHK details please {run}'))
        check('signed Messenger message stored once (re-delivery ignored)', st == 200 and r.get('stored') == 1 and r2.get('stored') == 0, f'{r} {r2}')
        st, r = webhook(event('instagram', IG, I_USER, f'm.ui.{run}.ig', f'Price list? {run}'))
        check('signed Instagram message stored', st == 200 and r.get('stored') == 1, r)

        pg.goto(WEB + '/inbox'); pg.wait_for_timeout(2500)
        pg.get_by_label('Channel').select_option('messenger'); pg.get_by_label('Search conversations').fill(run); pg.wait_for_timeout(2500)
        items = pg.get_by_role('list', name='Conversations').get_by_role('listitem')
        check('Messenger filter shows the conversation with a "Messenger" badge and "AI off"', items.count() == 1 and 'Messenger' in items.first.inner_text() and 'AI off' in items.first.inner_text(), items.first.inner_text() if items.count() else '')
        items.first.click(); pg.wait_for_timeout(2000)
        check('header: masked Meta id, channel, and "AI pending" badge (no Return to AI)', f'Messenger id ••{M_USER[-4:]}' in pg.get_by_test_id('contact-line').inner_text() and pg.get_by_text(re.compile('AI on Messenger pending')).count() == 1 and pg.get_by_role('button', name='Return to AI').count() == 0)
        check('thread: customer message and the automatic acknowledgement marked not sent', pg.get_by_text(f'Velachery 2BHK details please {run}').count() >= 1 and pg.get_by_text('Thanks! Our team will reply shortly.').count() >= 1 and pg.get_by_text(re.compile('not sent \\(test mode\\)')).count() >= 1)
        pg.get_by_role('tab', name='Reply to customer').click()
        pg.get_by_label('Reply message').fill(f'Sharing the brochure now {run}'); pg.get_by_role('button', name='Send').click(); pg.wait_for_timeout(2500)
        meta = sql(f"SELECT metadata FROM Message WHERE content='Sharing the brochure now {run}'").replace(' ', '')
        check('staff reply recorded with the author; DRY_RUN: saved but NOT sent', '"author":"staff"' in meta and '"simulated":true' in meta and pg.get_by_text(re.compile('Saved but NOT sent')).count() >= 1, meta[:150])
        pg.screenshot(path=os.path.join(SHOTS, 'inbox-messenger.png'))
        pg.get_by_label('Channel').select_option('instagram'); pg.wait_for_timeout(2500)
        check('Instagram filter shows the Instagram conversation', items.count() == 1 and 'Instagram' in items.first.inner_text())

        pg.goto(WEB + '/settings/integrations/meta-social'); pg.wait_for_timeout(2500)
        pg.get_by_role('button', name='Disable integration').click(); pg.wait_for_timeout(2000)
        check('disabling removes the routing', sql(f"SELECT COUNT(*) FROM OrganizationChannel WHERE organizationId='{org}' AND kind IN ('messenger_page_id','instagram_account_id')") == '0')
        time.sleep(1)
        check('no page errors', not errs, '; '.join(errs)[:200])
    finally:
        cust = sql(f"SELECT GROUP_CONCAT(CONCAT('''', customerId, '''')) FROM SocialIdentity WHERE organizationId='{org}' AND externalUserId IN ('{M_USER}','{I_USER}')")
        sql(f"DELETE FROM Conversation WHERE organizationId='{org}' AND externalId IN ('{M_USER}','{I_USER}')")
        if cust: sql(f"DELETE FROM Customer WHERE id IN ({cust})")
        sql(f"DELETE FROM OrganizationChannel WHERE organizationId='{org}' AND kind IN ('messenger_page_id','instagram_account_id')")
        sql(f"DELETE FROM IntegrationCredential WHERE organizationId='{org}' AND provider='meta_social'")
    b.close()

print(f"\n{sum(results)}/{len(results)} passed")
raise SystemExit(0 if all(results) else 1)
