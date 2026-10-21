"""
Marketing agent end to end through the real dashboard + API + MySQL (TEST database only), DRY_RUN=true.

  Needs: API on :3000 (DB_NAME=<test db> DRY_RUN=true RATE_LIMIT_API_PER_MIN=2000 RATE_LIMIT_LOGIN=100, workers on),
         web on :3001, the owner@tacksharp.test admin (created by e2e-live / seed).
  Run:   TEST_DB_NAME=tacksharp_test python3 -I apps/web/tests/ui-marketing.py   (DB_USER / DB_PASSWORD from the env)

TEST FIXTURES (test database only): a `marketing` role user inserted with SQL. Every campaign message is simulated
(DRY_RUN): no WhatsApp message is sent, no call is placed.
"""
from playwright.sync_api import sync_playwright
import base64, hashlib, json, os, subprocess, tempfile, time, urllib.request

WEB, API = 'http://localhost:3001', 'http://localhost:3000'
DB = os.environ.get('TEST_DB_NAME', 'tacksharp_test')
SHOTS = os.environ.get('SHOTS_DIR', tempfile.gettempdir())
results = []
def check(name, ok, detail=''):
    results.append(bool(ok)); print(('PASS ' if ok else 'FAIL ') + name + (f'  — {detail}' if detail else ''))

def sql(q):
    out = subprocess.run(['mysql', f"-u{os.environ.get('DB_USER', 'root')}", f"-p{os.environ.get('DB_PASSWORD', 'password')}", '-h127.0.0.1', DB, '-N', '-e', q], capture_output=True, text=True)
    if out.returncode: raise RuntimeError(out.stderr)
    return out.stdout.strip()

def scrypt_hash(pw):
    salt = os.urandom(16)
    return f"scrypt${base64.b64encode(salt).decode()}${base64.b64encode(hashlib.scrypt(pw.encode(), salt=salt, n=16384, r=8, p=1, dklen=64)).decode()}"

run = str(int(time.time()))[-6:]
phones = [f'9197{run}{i:02d}' for i in range(4)]
csv_path = os.path.join(tempfile.mkdtemp(), 'customers.csv')
with open(csv_path, 'w') as f:
    f.write('Name,Mobile,Tags,WhatsApp consent\n')
    f.write(f'Demo Anitha {run},{phones[0]},mk{run},yes\n')
    f.write(f'Demo Bala {run},{phones[1]},mk{run},no\n')
    f.write(f'Demo Chitra {run},{phones[2]},mk{run},yes\n')
    f.write('Broken,12,x,yes\n')

with sync_playwright() as p:
    b = p.chromium.launch()
    def session(email, pw):
        ctx = b.new_context(viewport={'width': 1440, 'height': 950}); pg = ctx.new_page()
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto(WEB + '/login'); pg.get_by_label('Email').fill(email); pg.get_by_label('Password').fill(pw)
        pg.get_by_role('button', name='Log in').click(); pg.wait_for_timeout(2500)
        cookie = lambda: '; '.join(f"{c['name']}={c['value']}" for c in ctx.cookies(API))
        def api(path, body=None, method=None):
            data = json.dumps(body).encode() if body is not None else None
            req = urllib.request.Request(API + path, data=data, method=method or ('POST' if data is not None else 'GET'), headers={'cookie': cookie(), 'content-type': 'application/json'})
            return json.load(urllib.request.urlopen(req))
        return pg, api, errs

    pg, api, errs = session('owner@tacksharp.test', 'correct-horse-battery')
    org = api('/auth/me')['organizationId']
    original_industry = api('/settings')['settings'].get('industry', 'real_estate')
    api('/settings', {'industry': 'textile'}, 'PUT')
    api('/textile/products', {'sku': f'MKUI-{run}', 'name': f'Kanchi Silk {run}', 'fabricCategory': 'silk saree', 'priceUnit': 'piece', 'price': 12000, 'priceApproved': True, 'stockStatus': 'in_stock'})

    pg.goto(WEB + '/marketing'); pg.wait_for_timeout(2500)
    check('marketing page opens with the DRY_RUN banner', pg.get_by_text('DRY_RUN: simulated, nothing is sent').count() > 0)
    check('WhatsApp campaigns is in the menu', pg.get_by_role('link', name='WhatsApp campaigns').count() > 0)

    # ---- import customers (consent only when confirmed)
    pg.get_by_role('tab', name='Customers & segments').click(); pg.wait_for_timeout(800)
    pg.get_by_role('button', name='Import').click()
    pg.locator('dialog input[type=file]').set_input_files(csv_path)
    pg.get_by_role('button', name='Check file').click(); pg.wait_for_timeout(1500)
    dlg = pg.locator('dialog[open]')
    check('import preview shows 3 valid / 1 with problems', '3 valid' in dlg.inner_text() and '1 with problems' in dlg.inner_text(), dlg.inner_text()[:160])
    dlg.get_by_label('The consent column records real permission').check()
    dlg.get_by_role('button', name='Import 3').click(); pg.wait_for_timeout(2000)
    consent = sql(f"SELECT COUNT(*) FROM Customer WHERE organizationId='{org}' AND phone IN ('{phones[0]}','{phones[1]}','{phones[2]}') AND messagingConsent=1")
    check('consent recorded only for the two "yes" rows', consent == '2', consent)

    # ---- segment
    pg.get_by_role('button', name='New segment').click(); pg.wait_for_timeout(500)
    dlg = pg.locator('dialog[open]')
    dlg.get_by_label('Name').fill(f'UI saree {run}')
    dlg.get_by_role('button', name=f'mk{run} (3)').click(); pg.wait_for_timeout(1200)
    check('segment preview: 2 can be messaged of 3', '2 can be messaged' in dlg.inner_text() and '3 match' in dlg.inner_text(), dlg.inner_text()[-160:])
    dlg.get_by_role('button', name='Save segment').click(); pg.wait_for_timeout(1500)
    check('segment listed', pg.get_by_text(f'UI saree {run}').count() > 0)
    pg.screenshot(path=os.path.join(SHOTS, 'marketing-audience.png'))

    # ---- agent drafts a campaign, owner reviews and approves it
    pg.get_by_role('tab', name='Campaigns').click(); pg.wait_for_timeout(800)
    pg.get_by_role('button', name='Draft with agent').click(); pg.wait_for_timeout(500)
    dlg = pg.locator('dialog[open]')
    dlg.get_by_label('Occasion').select_option('diwali')
    dlg.get_by_label('Segment').select_option(label=f'UI saree {run} (2 with consent)')
    dlg.get_by_role('button', name='Draft').click(); pg.wait_for_timeout(3000)
    check('agent draft opened in the editor', pg.get_by_text('Agent brief').count() > 0 and pg.get_by_text(f'Kanchi Silk {run}').count() > 0)
    tpl = pg.get_by_label('Approved template name (as in Meta)')
    if tpl.count():
        tpl.fill('diwali_offer'); pg.get_by_label('Language', exact=True).fill('en')
    pg.get_by_role('button', name='Save draft').click(); pg.wait_for_timeout(2000)
    check('WhatsApp preview shows the filled variables', pg.get_by_label('WhatsApp preview').first.inner_text().find('Demo') >= 0, pg.get_by_label('WhatsApp preview').first.inner_text()[:200])
    pg.get_by_role('button', name='Review & ask for approval').click(); pg.wait_for_timeout(800)
    dlg = pg.locator('dialog[open]')
    check('confirmation shows 2 recipients and the exclusions', '2 customer(s) with marketing consent' in dlg.inner_text() and '1 without consent' in dlg.inner_text())
    approve = dlg.get_by_role('button', name='Approve & send')
    check('approve disabled until the checkbox is ticked', approve.is_disabled())
    dlg.locator('input[type=checkbox]').check(); approve.click(); pg.wait_for_timeout(6000)
    cid = sql(f"SELECT id FROM MarketingCampaign WHERE organizationId='{org}' ORDER BY createdAt DESC LIMIT 1")
    rs = sql(f"SELECT GROUP_CONCAT(status ORDER BY status) FROM CampaignRecipient WHERE campaignId='{cid}'")
    check('worker processed recipients as SIMULATED (DRY_RUN)', rs == 'simulated,simulated', rs)
    check('approval recorded as executed', sql(f"SELECT status FROM Approval WHERE entityId='{cid}' ORDER BY createdAt DESC LIMIT 1") == 'executed')
    pg.reload(); pg.wait_for_timeout(2500)
    check('results card says simulated', pg.get_by_text('Results (simulated)').count() > 0)
    pg.screenshot(path=os.path.join(SHOTS, 'marketing-campaign.png'))

    # ---- marketing staff request → appears in the owner's approval queue
    sql(f"INSERT IGNORE INTO User (id, organizationId, email, name, passwordHash, role, createdAt, updatedAt) VALUES ('u_mkui_{run}', '{org}', 'mkt{run}@tacksharp.test', 'Marketing UI', '{scrypt_hash('mkt-pass-123')}', 'marketing', NOW(3), NOW(3))")  # TEST FIXTURE
    mpg, mapi, merrs = session(f'mkt{run}@tacksharp.test', 'mkt-pass-123')
    seg = [s for s in mapi('/marketing/segments') if s['name'] == f'UI saree {run}'][0]
    c2 = mapi('/marketing/campaigns', {'name': f'Staff campaign {run}', 'segmentId': seg['id'], 'templateName': 'diwali_offer', 'templateLanguage': 'en', 'templateParams': ['{{name}}']})
    est = mapi(f"/marketing/campaigns/{c2['id']}/estimate")
    r = mapi(f"/marketing/campaigns/{c2['id']}/request-send", {'confirm': True, 'expectedRecipients': est['eligible']})
    check('marketing staff cannot self-approve: request is pending', r['status'] == 'pending_approval', r['status'])
    pg.goto(WEB + '/marketing?tab=approvals'); pg.wait_for_timeout(2500)
    item = pg.locator('li', has_text=f'Staff campaign {run}')
    check('owner sees the request in Approvals', item.count() > 0)
    item.get_by_role('button', name='Approve').click(); pg.wait_for_timeout(5000)
    check('approved request started the campaign (simulated)', sql(f"SELECT status FROM MarketingCampaign WHERE id='{c2['id']}'") in ('sending', 'completed'))

    # ---- content calendar
    pg.goto(WEB + '/marketing?tab=content'); pg.wait_for_timeout(2000)
    pg.get_by_role('button', name='Plan 2 weeks').click(); pg.wait_for_timeout(3000)
    drafts = int(sql(f"SELECT COUNT(*) FROM ContentItem WHERE organizationId='{org}' AND status='draft'"))
    check('agent drafted content items', drafts >= 14, str(drafts))
    pg.locator('.grid button', has_text='Draft').first.click(); pg.wait_for_timeout(800)  # a calendar item (not the "AI draft" button)
    dlg = pg.locator('dialog[open]')
    dlg.get_by_role('button', name='Approve').click(); pg.wait_for_timeout(1500)
    approved = sql(f"SELECT id FROM ContentItem WHERE organizationId='{org}' AND status='approved' ORDER BY updatedAt DESC LIMIT 1")
    check('owner approved a post', bool(approved))
    pg.locator('.grid button', has_text='Approved').first.click(); pg.wait_for_timeout(800)
    dlg = pg.locator('dialog[open]')
    dlg.get_by_label('Posted it? Link or note (optional)').fill('Posted on WhatsApp status')
    dlg.get_by_role('button', name='Mark published').click(); pg.wait_for_timeout(1500)
    check('post marked published by a person', sql(f"SELECT status FROM ContentItem WHERE id='{approved}'") == 'published')
    pg.screenshot(path=os.path.join(SHOTS, 'marketing-content.png'))

    pg.goto(WEB + '/marketing?tab=performance'); pg.wait_for_timeout(2500)
    check('performance says ad spend is not available', pg.get_by_text('Meta ad spend / ad ROI').count() > 0)
    check('no page errors', not errs and not merrs, '; '.join(errs + merrs)[:300])
    api('/settings', {'industry': original_industry}, 'PUT')  # leave the shared test business as we found it
    b.close()

print(f"\n{sum(results)}/{len(results)} passed")
raise SystemExit(0 if all(results) else 1)
