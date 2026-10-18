"""
Pilot completion features end to end through the real dashboard + API + MySQL (TEST database only), DRY_RUN=true:
Finance collections / expenses / unit costs / statement matching, Operations dispatch with tracking, Marketing AI
drafts with revision history, the campaign-attributed overview card and the Agent Centre integrations.

  Needs: API on :3000 (DB_NAME=<test db> DRY_RUN=true RATE_LIMIT_API_PER_MIN=2000 RATE_LIMIT_LOGIN=100), web on :3001,
         the owner@tacksharp.test admin.
  Run:   TEST_DB_NAME=tacksharp_test python3 -I apps/web/tests/ui-pilot.py   (DB_USER / DB_PASSWORD from the env)

TEST FIXTURES (test database only): quotation marked "sent" and an invoice due date moved into the past with SQL.
No message is sent, no call placed, no money moved.
"""
from playwright.sync_api import sync_playwright
import json, os, re, subprocess, tempfile, time, urllib.request

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

run = str(int(time.time()))[-6:]

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 1440, 'height': 950}); pg = ctx.new_page()
    errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(WEB + '/login'); pg.get_by_label('Email').fill('owner@tacksharp.test'); pg.get_by_label('Password').fill('correct-horse-battery')
    pg.get_by_role('button', name='Log in').click(); pg.wait_for_timeout(2500)
    cookie = lambda: '; '.join(f"{c['name']}={c['value']}" for c in ctx.cookies(API))
    def api(path, body=None, method=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(API + path, data=data, method=method or ('POST' if data is not None else 'GET'), headers={'cookie': cookie(), 'content-type': 'application/json'})
        return json.load(urllib.request.urlopen(req))

    original = api('/settings')['settings']
    api('/settings', {'industry': 'textile', 'textile': {'notifyOrderStatus': True}, 'finance': {'autoDraftInvoice': True, 'dispatchPaymentRule': 'none', 'paymentTermsDays': 15}}, 'PUT')
    prod = api('/textile/products', {'sku': f'PIL-{run}', 'name': f'Pilot Silk {run}', 'fabricCategory': 'silk saree', 'colour': 'maroon', 'priceUnit': 'piece', 'price': 9000, 'priceApproved': True, 'stockStatus': 'in_stock'})
    api(f"/operations/inventory/{prod['id']}/track", {'lowStockAt': 2})
    api(f"/operations/inventory/{prod['id']}/receive", {'quantity': 10, 'reference': f'GRN-{run}', 'clientKey': f'grn-pilot-{run}'})

    def make_order(qty):
        lead = api('/ai/chat', {'phone': '9194' + str(int(time.time() * 1000))[-8:], 'name': f'Pilot Buyer {run}', 'message': 'hello'})['leadId']
        q = api('/textile/quotations', {'leadId': lead, 'items': [{'productId': prod['id'], 'quantity': qty}], 'taxPercent': 5})
        api(f"/textile/quotations/{q['id']}/status", {'status': 'approved'})
        sql(f"UPDATE Quotation SET status='sent', sentAt=NOW() WHERE id='{q['id']}'")  # TEST FIXTURE
        api(f"/textile/quotations/{q['id']}/status", {'status': 'accepted'})
        o = api(f"/textile/quotations/{q['id']}/convert", {})['order']
        api(f"/textile/orders/{o['id']}/status", {'status': 'confirmed'})
        return o

    try:
        # ---- Finance: collections on an issued, overdue invoice
        o = make_order(1)
        inv = api(f"/finance/invoices?orderId={o['id']}")[0]
        api(f"/finance/invoices/{inv['id']}/status", {'status': 'approved'})
        api(f"/finance/invoices/{inv['id']}/status", {'status': 'issued'})
        sql(f"UPDATE Invoice SET dueDate=DATE_SUB(NOW(), INTERVAL 5 DAY) WHERE id='{inv['id']}'")  # TEST FIXTURE: overdue
        pg.goto(f"{WEB}/finance?invoice={inv['id']}"); pg.wait_for_timeout(2500)
        check('invoice shows the Collections panel', pg.get_by_role('heading', name='Collections').count() > 0)
        pg.get_by_role('button', name='Payment promise').click(); pg.wait_for_timeout(500)
        d = pg.locator('dialog[open]')
        d.get_by_label('Amount promised (₹)').fill('4000'); d.get_by_label('Promised date').fill(time.strftime('%Y-%m-%d', time.localtime(time.time() + 3 * 86400))); d.get_by_label('Note').fill('Customer will pay on Monday')
        d.get_by_role('button', name='Save').click(); pg.wait_for_timeout(1800)
        check('promise recorded and shown as open', pg.get_by_text(re.compile(r'Payment promise: ₹4,000')).count() > 0)
        check('reminder blocked while a promise is open (reason shown)', 'No reminder now: customer promised' in pg.locator('body').inner_text())
        pg.screenshot(path=os.path.join(SHOTS, 'pilot-collections.png'))

        # ---- Finance: expenses, unit cost, margin
        pg.goto(f"{WEB}/finance?tab=expenses"); pg.wait_for_timeout(2500)
        pg.get_by_role('tab', name='Expenses & margin').click(); pg.wait_for_timeout(1500)
        pg.get_by_role('button', name='Record expense').click(); pg.wait_for_timeout(500)
        d = pg.locator('dialog[open]')
        d.get_by_label('Category').select_option('freight'); d.get_by_label('Amount (₹)').fill('1500'); d.get_by_label('Vendor').fill('Pilot Transport'); d.get_by_label('Bill / reference no.').fill(f'BILL-{run}')
        d.get_by_role('button', name='Save').click(); pg.wait_for_timeout(1800)
        check('expense recorded and listed', pg.get_by_text('Pilot Transport').count() > 0)
        row = pg.locator('tr', has_text=f'Pilot Silk {run}')
        row.locator('input[type=number]').fill('6000'); row.get_by_role('button', name='Save').click(); pg.wait_for_timeout(1800)
        check('unit cost saved (Finance only)', sql(f"SELECT unitCost FROM TextileProduct WHERE id='{prod['id']}'") == '6000.00')
        check('margin card distinguishes revenue, verified cash and margin', all(t in pg.locator('body').inner_text() for t in ['Revenue (invoiced)', 'Cash collected (verified)', 'Gross margin']))
        pg.screenshot(path=os.path.join(SHOTS, 'pilot-expenses.png'))

        # ---- Finance: statement matching (read-only)
        api('/finance/payments', {'invoiceId': inv['id'], 'amount': 4000, 'method': 'upi', 'reference': f'UTR{run}77'})
        stmt = os.path.join(tempfile.mkdtemp(), 'stmt.csv')
        with open(stmt, 'w') as f:
            f.write(f"Date,Narration,Credit\n{time.strftime('%Y-%m-%d')},UPI/UTR{run}77/PILOT,4000\n{time.strftime('%Y-%m-%d')},UPI/55554444{run}/UNKNOWN,999\n")
        pg.goto(f"{WEB}/finance?tab=verify"); pg.wait_for_timeout(2000)
        pg.get_by_role('tab', name=re.compile('Verify payments')).click(); pg.wait_for_timeout(1200)
        card = pg.locator('section', has_text='Match a bank statement')
        card.locator('input[type=file]').set_input_files(stmt); card.get_by_role('button', name='Match').click(); pg.wait_for_timeout(2500)
        txt = card.inner_text()
        check('statement matched the recorded payment and flagged unknown money', 'Matched to a recorded payment' in txt and 'Money in the bank with no payment recorded' in txt and '999' in txt, txt[:200])
        check('matching verified nothing', sql(f"SELECT status FROM Payment WHERE invoiceId='{inv['id']}' ORDER BY createdAt DESC LIMIT 1") == 'pending_verification')

        # ---- Operations: dispatch with courier + tracking
        o2 = make_order(1)
        api(f"/textile/orders/{o2['id']}/status", {'status': 'processing'}); api(f"/textile/orders/{o2['id']}/status", {'status': 'ready_to_dispatch'})
        pg.goto(f"{WEB}/operations"); pg.wait_for_timeout(2000)
        pg.get_by_role('tab', name='Fulfilment').click(); pg.wait_for_timeout(2000)
        pg.locator('section', has_text=o2['number']).get_by_role('button', name='Dispatch').click(); pg.wait_for_timeout(500)
        d = pg.locator('dialog[open]')
        d.get_by_label('Courier / transporter').fill('ST Courier'); d.get_by_label('Tracking / LR number (optional)').fill(f'ST{run}')
        d.get_by_role('button', name='Dispatch').click(); pg.wait_for_timeout(2500)
        got = api(f"/textile/orders/{o2['id']}")
        check('dispatched with courier and tracking recorded', got['status'] == 'dispatched' and got['trackingRef'] == f'ST{run}', f"{got['status']} {got.get('trackingRef')}")
        check('stock deducted once on dispatch', sql(f"SELECT COUNT(*) FROM StockMovement WHERE orderId='{o2['id']}' AND type='dispatch'") == '1')

        # ---- Marketing: AI draft (template when no model) with revision history
        pg.goto(f"{WEB}/marketing?tab=content"); pg.wait_for_timeout(2500)
        pg.get_by_role('tab', name='Content calendar').click(); pg.wait_for_timeout(1500)
        pg.get_by_role('button', name='AI draft').click(); pg.wait_for_timeout(1000)
        d = pg.locator('dialog[open]')
        d.get_by_role('button', name=f'Pilot Silk {run}').click()
        d.get_by_label('Language').select_option('tanglish')
        d.get_by_role('button', name='Draft').click(); pg.wait_for_timeout(2500)
        status = pg.get_by_role('status').first.inner_text()
        check('draft saved and labelled (template when no model is configured)', re.search(r'(AI|Template) draft saved', status) is not None, status[:160])
        item = sql(f"SELECT c.id FROM ContentItem c JOIN ContentRevision r ON r.contentItemId=c.id WHERE c.body LIKE '%Pilot Silk {run}%' ORDER BY c.createdAt DESC LIMIT 1")
        check('revision recorded for the draft', bool(item) and sql(f"SELECT COUNT(*) FROM ContentRevision WHERE contentItemId='{item}'") == '1')
        check('draft uses the approved price only', '9000' in sql(f"SELECT body FROM ContentItem WHERE id='{item}'"))

        # ---- Overview + Agent Centre
        pg.goto(f"{WEB}/textile"); pg.wait_for_timeout(2500)
        check('business overview shows campaign-attributed results', pg.get_by_text('Campaign-attributed').count() > 0)
        pg.goto(f"{WEB}/agents?view=runtime"); pg.wait_for_timeout(2000)
        pg.get_by_role('tab', name='Integrations').click(); pg.wait_for_timeout(1500)
        body = pg.locator('body').inner_text()
        check('integrations list the AI model, Meta ad spend status and social publishing honestly', 'AI model' in body and 'Meta Marketing API' in body and 'Social publishing' in body)
        check('agent registry no longer lists finance reminders as not built', 'Payment reminders: prepared by the agent' in json.dumps(api('/agents')))
        check('no page errors', not errs, '; '.join(errs)[:300])
    finally:
        api('/settings', {'industry': original.get('industry', 'real_estate'), 'textile': original.get('textile', {}), 'finance': original.get('finance', {})}, 'PUT')
        b.close()

print(f"\n{sum(results)}/{len(results)} passed")
raise SystemExit(0 if all(results) else 1)
