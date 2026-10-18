"""
AI agents + Operations, end to end through the real dashboard + API + MySQL (test database only).

  Needs: API on :3000 (DB_NAME=tacksharp_test RATE_LIMIT_API_PER_MIN=2000 RATE_LIMIT_LOGIN=100), web on :3001,
         the owner@tacksharp.test admin (created by e2e-live).
  Run:   python3 -I apps/web/tests/ui-agents.py

TEST FIXTURES (test database only, clearly not product behaviour):
  - a `sales` role user is inserted with SQL (there is no user-management page yet);
  - a quotation is marked "sent" with SQL, because the real send is (correctly) refused without WhatsApp credentials.
Nothing here sends a message or places a call.
"""
from playwright.sync_api import sync_playwright
import base64, hashlib, json, os, re, subprocess, time, urllib.error, urllib.request

WEB, API = 'http://localhost:3001', 'http://localhost:3000'
results = []
def check(name, ok, detail=''):
    results.append(bool(ok)); print(('PASS ' if ok else 'FAIL ') + name + (f'  — {detail}' if detail else ''))

def sql(q):
    out = subprocess.run(['mysql', f"-u{os.environ.get('DB_USER', 'root')}", f"-p{os.environ.get('DB_PASSWORD', 'password')}", '-h127.0.0.1', os.environ.get('TEST_DB_NAME', 'tacksharp_test'), '-N', '-e', q], capture_output=True, text=True)
    if out.returncode: raise RuntimeError(out.stderr)
    return out.stdout.strip()

def scrypt_hash(pw):  # same format as apps/api/src/auth/password.ts (Node scrypt defaults)
    salt = os.urandom(16)
    h = hashlib.scrypt(pw.encode(), salt=salt, n=16384, r=8, p=1, dklen=64)
    return f"scrypt${base64.b64encode(salt).decode()}${base64.b64encode(h).decode()}"

run = str(int(time.time()))[-6:]
SALES_EMAIL, SALES_PW = 'sales-ui@tacksharp.test', 'sales-password-123'

with sync_playwright() as p:
    b = p.chromium.launch()
    def session(email, pw):
        ctx = b.new_context(viewport={'width': 1440, 'height': 900}); pg = ctx.new_page()
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
    api('/settings', {'industry': 'textile', 'textile': {'maxDiscountPct': 10}, 'agents': {'paused': []}}, 'PUT')
    pg.reload(); pg.wait_for_timeout(1500)
    check('Menu shows AI agents + Inventory & stock', pg.get_by_role('link', name='AI agents', exact=True).is_visible() and pg.get_by_role('link', name='Inventory & stock').is_visible())

    # Catalogue product for this run.
    for x in api('/textile/products'):
        if x['sku'].startswith('AGUI-') and x['active']: api(f"/textile/products/{x['id']}", {'active': False}, 'PATCH')
    prod = api('/textile/products', {'sku': f'AGUI-{run}', 'name': f'Agent Twill {run}', 'fabricCategory': 'cotton twill', 'priceUnit': 'metre', 'price': 150, 'priceApproved': True, 'stockStatus': 'in_stock'})

    # 1. Operations: start tracking, receive stock (through the UI).
    pg.goto(f"{WEB}/operations"); pg.wait_for_timeout(2000)
    row = pg.locator('tr', has_text=prod['name'])
    check('Operations: new product shows "Not tracked"', row.get_by_text('Not tracked').is_visible())
    row.get_by_role('button', name='Start tracking').click()
    d = pg.locator('dialog[open]'); d.get_by_label(re.compile('Low-stock alert')).fill('50'); d.get_by_role('button', name='Start tracking').click(); pg.wait_for_timeout(1500)
    row.get_by_role('button', name='Receive').click()
    d = pg.locator('dialog[open]'); d.get_by_label(re.compile('Quantity received')).fill('300'); d.get_by_label(re.compile('Reference')).fill(f'GRN-{run}'); d.get_by_label('Lot / batch').fill('L7')
    d.get_by_role('button', name='Record receipt').click(); pg.wait_for_timeout(1500)
    inv = next(r for r in api('/operations/inventory') if r['productId'] == prod['id'])
    check('Receive 300 m → on hand 300, available 300', inv['tracked'] and inv['onHand'] == 300 and inv['available'] == 300, json.dumps({k: inv[k] for k in ('onHand', 'reserved', 'available')}))

    # Helper: lead -> quotation -> approved -> (fixture: sent) -> accepted -> order
    def make_order(qty, discount=0, approve=True):
        phone = '9197' + str(int(time.time() * 1000))[-8:]
        lead = api('/ai/chat', {'phone': phone, 'name': f'Ops Buyer {run}', 'message': 'hello'})['leadId']
        q = api('/textile/quotations', {'leadId': lead, 'items': [{'productId': prod['id'], 'quantity': qty}], 'discount': discount})
        if not approve: return q
        api(f"/textile/quotations/{q['id']}/status", {'status': 'approved'})
        sql(f"UPDATE Quotation SET status='sent', sentAt=NOW() WHERE id='{q['id']}'")  # TEST FIXTURE
        api(f"/textile/quotations/{q['id']}/status", {'status': 'accepted'})
        return api(f"/textile/quotations/{q['id']}/convert", {})['order']

    # 2. Confirm an order in the Orders page → Operations agent reserves stock.
    o1 = make_order(200)
    pg.goto(f"{WEB}/sales-orders?id={o1['id']}"); pg.wait_for_timeout(2000)
    pg.locator('section', has_text='Move order').get_by_role('button', name='Confirmed', exact=True).click(); pg.wait_for_timeout(2000)
    t = [x for x in api(f"/agents/tasks?entityType=order&entityId={o1['id']}") if x['agent'] == 'operations']  # Finance also drafts an invoice
    check('Confirm → Operations agent task completed, stock reserved', len(t) == 1 and t[0]['status'] == 'COMPLETED' and t[0]['result']['outcome'] == 'reserved', json.dumps([(x['kind'], x['status']) for x in t]))
    inv = next(r for r in api('/operations/inventory') if r['productId'] == prod['id'])
    check('Inventory: 200 reserved, 100 available', inv['reserved'] == 200 and inv['available'] == 100)

    # 3. Agent Centre shows the task with its execution history.
    pg.goto(f"{WEB}/agents?task={t[0]['id']}"); pg.wait_for_timeout(2500)
    hist = pg.locator('section', has_text='Execution history').inner_text()
    check('Agent Centre: task detail with real execution history', 'Reserve stock for' in hist and 'completed' in hist and 'started' in hist, hist.replace('\n', ' | ')[:180])

    # 4. Shortage: a second order larger than what is free.
    o2 = make_order(150)
    pg.goto(f"{WEB}/sales-orders?id={o2['id']}"); pg.wait_for_timeout(2000)
    pg.locator('section', has_text='Move order').get_by_role('button', name='Confirmed', exact=True).click(); pg.wait_for_timeout(2000)
    t2 = api(f"/agents/tasks?entityType=order&entityId={o2['id']}")
    kinds = sorted((x['kind'], x['status']) for x in t2)
    check('Shortage → nothing reserved; Sales review handed over', any(x['result'] and x['result'].get('outcome') == 'shortage' for x in t2) and ('sales.stock_shortage_review', 'COMPLETED') in kinds, json.dumps(kinds))
    pg.locator('section', has_text='Move order').get_by_role('button', name='Processing', exact=True).click(); pg.wait_for_timeout(1500)
    pg.locator('section', has_text='Move order').get_by_role('button', name='Ready to dispatch', exact=True).click(); pg.wait_for_timeout(1500)
    msg = pg.get_by_role('status').first.inner_text()
    check('"Ready to dispatch" refused by the server while stock is not reserved', 'Stock is not reserved' in msg and api(f"/textile/orders/{o2['id']}")['status'] == 'processing', msg[:160])
    pg.goto(f"{WEB}/agents?view=runtime"); pg.wait_for_timeout(2000)
    pg.get_by_role('tab', name=re.compile('Team tasks')).click(); pg.wait_for_timeout(1500)
    ex = pg.locator('section', has_text=f"Stock short for {o2['number']}")
    check('Team tasks: shortage exception for the order', ex.count() >= 1)
    ex.first.get_by_role('button', name='Done').click(); pg.wait_for_timeout(1200)
    check('Exception cannot be closed without a decision', 'Record the decision' in pg.get_by_role('status').first.inner_text())

    # 5. Stock arrives; reserve from Operations → Fulfilment.
    api(f"/operations/inventory/{prod['id']}/receive", {'quantity': 100, 'reference': f'GRN2-{run}', 'clientKey': f'rcv2-{run}-abcd'})
    pg.goto(f"{WEB}/operations"); pg.wait_for_timeout(1500)
    pg.get_by_role('tab', name='Fulfilment').click(); pg.wait_for_timeout(2000)
    card = pg.locator('section', has_text=o2['number'])
    card.get_by_role('button', name='Reserve stock now').click(); pg.wait_for_timeout(2000)
    check('After receiving: "Reserve stock now" reserves it', 'stock reserved' in pg.get_by_role('status').first.inner_text())
    inv = next(r for r in api('/operations/inventory') if r['productId'] == prod['id'])
    check('Inventory: 350 reserved of 400', inv['onHand'] == 400 and inv['reserved'] == 350, json.dumps({k: inv[k] for k in ('onHand', 'reserved')}))

    # 6. Dispatch deducts stock.
    pg.goto(f"{WEB}/sales-orders?id={o1['id']}"); pg.wait_for_timeout(1500)
    for step in ['Processing', 'Ready to dispatch', 'Dispatched']:
        pg.locator('section', has_text='Move order').get_by_role('button', name=step, exact=True).click(); pg.wait_for_timeout(1500)
    inv = next(r for r in api('/operations/inventory') if r['productId'] == prod['id'])
    check('Dispatch deducts: on hand 200, reserved 150', inv['onHand'] == 200 and inv['reserved'] == 150, json.dumps({k: inv[k] for k in ('onHand', 'reserved')}))
    pg.goto(f"{WEB}/operations"); pg.wait_for_timeout(1500); pg.get_by_role('tab', name='Stock movements').click(); pg.wait_for_timeout(1500)
    mv = pg.locator('tbody').inner_text()
    check('Stock movements page lists receive / reserve / dispatch', all(w in mv for w in ('receive', 'reserve', 'dispatch')) and f'GRN-{run}' in mv)

    # 7. Exceptional discount by a SALES user → approval queue → admin approves in Agent Centre.
    sql(f"INSERT INTO User (id, organizationId, email, name, passwordHash, role, createdAt, updatedAt) VALUES ('u_sales_ui', '{org}', '{SALES_EMAIL}', 'Sales UI', '{scrypt_hash(SALES_PW)}', 'sales', NOW(3), NOW(3)) "
        f"ON DUPLICATE KEY UPDATE passwordHash=VALUES(passwordHash), role='sales', organizationId='{org}'")  # TEST FIXTURE
    q = make_order(100, discount=3000, approve=False)  # 3000 on 15000 = 20%
    spg, sapi, serrs = session(SALES_EMAIL, SALES_PW)
    spg.goto(f"{WEB}/quotations?id={q['id']}"); spg.wait_for_timeout(2500)
    spg.get_by_role('button', name='Approve', exact=True).click(); spg.wait_for_timeout(1500)
    smsg = spg.get_by_role('status').first.inner_text()
    check('Sales user: 20% discount is held for approval (server-side)', 'approval' in smsg and sapi(f"/textile/quotations/{q['id']}")['status'] == 'draft', smsg[:160])
    try:
        sapi('/agents/approvals/list')
        ap = [a for a in sapi('/agents/approvals/list?status=pending') if a['entityId'] == q['id']][0]
        sapi(f"/agents/approvals/{ap['id']}/approve", {'note': 'self'}); denied = False
    except urllib.error.HTTPError as e:
        denied = e.code == 403
    check('Sales user cannot approve it (403 from the API, not just a hidden button)', denied)
    pg.goto(f"{WEB}/agents?view=runtime"); pg.wait_for_timeout(2000)
    pg.get_by_role('tab', name=re.compile('Approvals')).click(); pg.wait_for_timeout(1500)
    acard = pg.locator('section', has_text=q['number']).filter(has_text='Exceptional discount')
    check('Approval card shows the exact proposal', acard.get_by_text('20%').count() >= 1)
    acard.get_by_role('button', name='Approve').click(); pg.wait_for_timeout(2000)
    check('Admin approves → quotation approved, approval executed', api(f"/textile/quotations/{q['id']}")['status'] == 'approved' and any(a['entityId'] == q['id'] and a['status'] == 'executed' for a in api('/agents/approvals/list')))

    # 8. Pause / resume an agent; run a task from the Agent Centre.
    pg.goto(f"{WEB}/agents?view=runtime"); pg.wait_for_timeout(2000)
    pg.get_by_role('button', name='Pause Finance agent').click(); pg.wait_for_timeout(1500)
    check('Pause Finance agent', any(a['name'] == 'finance' and a['paused'] for a in api('/agents')))
    pg.get_by_role('button', name='Resume Finance agent').click(); pg.wait_for_timeout(1500)
    check('Resume Finance agent', not any(a['name'] == 'finance' and a['paused'] for a in api('/agents')))
    mk = pg.locator('section', has_text='Marketing agent').first
    mk.get_by_role('button', name='Run task').click()
    pg.locator('dialog[open]').get_by_role('button', name='Run').click(); pg.wait_for_timeout(2500)
    check('Run "Enquiries by source" from the Agent Centre → completed', 'Completed' in pg.get_by_role('status').first.inner_text(), pg.get_by_role('status').first.inner_text()[:140])

    # 9. Integrations are reported honestly.
    pg.get_by_role('tab', name='Integrations').click(); pg.wait_for_timeout(1000)
    integ = pg.locator('main').inner_text()
    # Meta ad spend: checked live (blocked / not checked without a token / granted-but-not-built), never "configured".
    check('Integrations: Meta ad spend not available, payments & accounting not connected', any(s in integ for s in ('Blocked (permission)', 'Not checked', 'Permission granted, not built')) and integ.count('Not connected') >= 2)

    # 10. Overview shows Operations + AI agents with real numbers.
    pg.goto(f"{WEB}/textile"); pg.wait_for_timeout(2500)
    ov = api('/textile/overview?days=30')
    check('Overview: Operations + AI agents blocks', pg.get_by_text('Orders awaiting fulfilment').is_visible() and pg.get_by_text('Tasks completed').is_visible() and ov['operations']['trackedProducts'] >= 1 and ov['agents']['tasksCompleted'] >= 3, json.dumps(ov['operations']))

    # 11. Tenant isolation over HTTP: a foreign / unknown task id is 404.
    try:
        api('/agents/tasks/not-a-real-task-id'); nf = False
    except urllib.error.HTTPError as e:
        nf = e.code == 404
    check('Unknown task id → 404', nf)

    check('No JavaScript errors in either browser', not errs and not serrs, '; '.join((errs + serrs)[:3]))
    api('/settings', {'industry': 'real_estate'}, 'PUT')
    b.close()

print(f"\n{sum(results)}/{len(results)} agent UI checks passed")
