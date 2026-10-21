"""
Finance agent end to end through the real dashboard + API + MySQL (test database only).

  Needs: API on :3000 (DB_NAME=tacksharp_test RATE_LIMIT_API_PER_MIN=2000 RATE_LIMIT_LOGIN=100), web on :3001,
         the owner@tacksharp.test admin (created by e2e-live).
  Run:   python3 -I apps/web/tests/ui-finance.py

TEST FIXTURES (test database only): a `sales` role user inserted with SQL; quotations marked "sent" with SQL
(the real WhatsApp send is refused without credentials). No message, call or payment is made.
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

def scrypt_hash(pw):
    salt = os.urandom(16)
    return f"scrypt${base64.b64encode(salt).decode()}${base64.b64encode(hashlib.scrypt(pw.encode(), salt=salt, n=16384, r=8, p=1, dklen=64)).decode()}"

run = str(int(time.time()))[-6:]
UTR = f'UTR{run}77'

with sync_playwright() as p:
    b = p.chromium.launch()
    def session(email, pw):
        ctx = b.new_context(viewport={'width': 1440, 'height': 950}); pg = ctx.new_page()
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        pg.goto(WEB + '/login'); pg.get_by_label('Email').fill(email); pg.get_by_label('Password').fill(pw)
        pg.get_by_role('button', name='Log in').click(); pg.wait_for_timeout(2500)
        cookie = lambda: '; '.join(f"{c['name']}={c['value']}" for c in ctx.cookies(API))
        def api(path, body=None, method=None, raw=False):
            data = json.dumps(body).encode() if body is not None else None
            req = urllib.request.Request(API + path, data=data, method=method or ('POST' if data is not None else 'GET'), headers={'cookie': cookie(), 'content-type': 'application/json'})
            r = urllib.request.urlopen(req)
            return r.read().decode() if raw else json.load(r)
        return pg, api, errs

    pg, api, errs = session('owner@tacksharp.test', 'correct-horse-battery')
    org = api('/auth/me')['organizationId']
    api('/settings', {'industry': 'textile', 'finance': {'autoDraftInvoice': True, 'dispatchPaymentRule': 'none', 'paymentTermsDays': 15}}, 'PUT')
    prod = api('/textile/products', {'sku': f'FINUI-{run}', 'name': f'Fin Twill {run}', 'fabricCategory': 'cotton twill', 'priceUnit': 'metre', 'price': 200, 'priceApproved': True})

    def make_order(qty):
        lead = api('/ai/chat', {'phone': '9196' + str(int(time.time() * 1000))[-8:], 'name': f'Fin Buyer {run}', 'message': 'hello'})['leadId']
        q = api('/textile/quotations', {'leadId': lead, 'items': [{'productId': prod['id'], 'quantity': qty}], 'taxPercent': 5})
        api(f"/textile/quotations/{q['id']}/status", {'status': 'approved'})
        sql(f"UPDATE Quotation SET status='sent', sentAt=NOW() WHERE id='{q['id']}'")  # TEST FIXTURE
        api(f"/textile/quotations/{q['id']}/status", {'status': 'accepted'})
        o = api(f"/textile/quotations/{q['id']}/convert", {})['order']
        api(f"/textile/orders/{o['id']}/status", {'status': 'confirmed'})
        return o

    # 1. Confirming an order -> Finance agent drafts the invoice.
    o = make_order(100)  # 100 x 200 = 20000 + 5% = 21000
    invs = api(f"/finance/invoices?orderId={o['id']}")
    check('Order confirmed → invoice drafted by the Finance agent (₹21,000 incl. 5% tax from the quotation)', len(invs) == 1 and invs[0]['status'] == 'draft' and float(invs[0]['total']) == 21000, json.dumps([(i['number'], i['status'], i['total']) for i in invs]))
    inv = invs[0]
    check('Agent task recorded', any(t['kind'] == 'finance.invoice_draft' and t['status'] == 'COMPLETED' for t in api(f"/agents/tasks?entityType=order&entityId={o['id']}")))

    # 2. Approve + issue in the Finance page.
    pg.reload(); pg.wait_for_timeout(1000)
    check('Menu has Finance', pg.get_by_role('link', name='Finance').is_visible())
    pg.goto(f"{WEB}/finance?invoice={inv['id']}"); pg.wait_for_timeout(2500)
    detail = pg.locator('#invoice-print')
    detail.get_by_role('button', name='Approve').click(); pg.wait_for_timeout(1500)
    detail.get_by_role('button', name='Issue', exact=True).click(); pg.wait_for_timeout(1500)
    inv = api(f"/finance/invoices/{inv['id']}")
    check('Approve → Issue: due date set from payment terms', inv['status'] == 'issued' and inv['dueDate'] is not None, f"{inv['status']} due {inv['dueDate']}")

    # 3. Record a customer's claim (partial) -> only "awaiting verification".
    detail.get_by_role('button', name='Record a payment').click()
    d = pg.locator('dialog[open]')
    d.get_by_label('Amount (₹) *').fill('8000'); d.get_by_label('UTR / cheque / receipt no.').fill(UTR); d.get_by_label('Source').select_option('customer_claim')
    d.get_by_role('button', name='Record payment').click(); pg.wait_for_timeout(1500)
    o_now = api(f"/textile/orders/{o['id']}")
    check('Customer claim recorded as "awaiting verification"; order still unpaid', o_now['paymentStatus'] == 'unpaid' and any(x['status'] == 'pending_verification' for x in api(f"/finance/payments?invoiceId={inv['id']}")))

    # 4. Verify in the queue: weak evidence refused, real evidence accepted.
    pg.goto(f"{WEB}/finance?tab=verify"); pg.wait_for_timeout(2000)
    card = pg.locator('section', has_text=inv['number']).filter(has_text='Customer claim').first
    card.get_by_label('Evidence or reason').fill('screenshot'); card.get_by_role('button', name='Verify').click(); pg.wait_for_timeout(1200)
    check('Verification without real evidence is refused', 'not proof' in pg.get_by_role('status').first.inner_text())
    card.get_by_label('Evidence or reason').fill(f'HDFC statement 16 Oct: credit 8,000 {UTR}'); card.get_by_role('button', name='Verify').click(); pg.wait_for_timeout(1800)
    inv = api(f"/finance/invoices/{inv['id']}")
    check('Verified → invoice part paid, order "partial"', inv['status'] == 'partially_paid' and float(inv['amountPaid']) == 8000 and api(f"/textile/orders/{o['id']}")['paymentStatus'] == 'partial', f"{inv['status']} {inv['amountPaid']}")

    # 5. The same UTR again: warned on entry, refused at verification, exception raised.
    api('/finance/payments', {'invoiceId': inv['id'], 'amount': 8000, 'method': 'upi', 'reference': UTR.lower()})
    pg.reload(); pg.wait_for_timeout(2000)
    card = pg.locator('section', has_text=inv['number']).filter(has_text='Staff entry').first
    card.get_by_label('Evidence or reason').fill('HDFC statement line 9 checked again'); card.get_by_role('button', name='Verify').click(); pg.wait_for_timeout(1500)
    msg = pg.get_by_role('status').first.inner_text()
    check('Duplicate UTR refused at verification with an exception', 'already a verified payment' in msg, msg[:140])
    card.get_by_label('Evidence or reason').fill('Duplicate of an already verified UTR'); card.get_by_role('button', name='Reject').click(); pg.wait_for_timeout(1500)
    pg.get_by_role('tab', name=re.compile('Exceptions')).click(); pg.wait_for_timeout(1500)
    check('Exceptions tab lists the duplicate', pg.get_by_text(re.compile('duplicate payment|already a verified payment')).count() >= 1)

    # 6. Orders page: invoice link; manual payment buttons replaced.
    pg.goto(f"{WEB}/sales-orders?id={o['id']}"); pg.wait_for_timeout(2000)
    check('Order shows its invoice; manual payment buttons hidden', pg.get_by_role('link', name=inv['number']).is_visible() and not pg.get_by_role('button', name='Paid', exact=True).is_visible())

    # 7. Dispatch rule "full": blocked until the rest is verified; then Finance hands over to Operations.
    api('/settings', {'finance': {'dispatchPaymentRule': 'full'}}, 'PUT')
    api(f"/textile/orders/{o['id']}/status", {'status': 'processing'})
    pg.reload(); pg.wait_for_timeout(1500)
    pg.locator('section', has_text='Move order').get_by_role('button', name='Ready to dispatch', exact=True).click(); pg.wait_for_timeout(1500)
    msg = pg.get_by_role('status').first.inner_text()
    check('"Ready to dispatch" refused: invoice not fully paid (server rule)', 'fully paid' in msg, msg[:140])
    rest = api('/finance/payments', {'invoiceId': inv['id'], 'amount': 13000, 'method': 'bank_transfer', 'reference': f'NEFT{run}'})['payment']
    api(f"/finance/payments/{rest['id']}/verify", {'evidence': f'SBI statement: NEFT credit 13,000 NEFT{run}'})
    t = api(f"/agents/tasks?entityType=payment&entityId={rest['id']}")
    check('Verified → Finance task hands the order to Operations', len(t) == 1 and t[0]['status'] == 'COMPLETED' and t[0]['result']['eligibleForDispatch'] is True)
    pg.locator('section', has_text='Move order').get_by_role('button', name='Ready to dispatch', exact=True).click(); pg.wait_for_timeout(1500)
    check('Now allowed: order ready to dispatch', api(f"/textile/orders/{o['id']}")['status'] == 'ready_to_dispatch')

    # 8. Sales user: may record a claim, may not verify or see finance.
    sql(f"INSERT INTO User (id, organizationId, email, name, passwordHash, role, createdAt, updatedAt) VALUES ('u_sales_fin', '{org}', 'sales-fin@tacksharp.test', 'Sales Fin', '{scrypt_hash('sales-password-456')}', 'sales', NOW(3), NOW(3)) ON DUPLICATE KEY UPDATE passwordHash=VALUES(passwordHash), role='sales', organizationId='{org}'")  # TEST FIXTURE
    spg, sapi, serrs = session('sales-fin@tacksharp.test', 'sales-password-456')
    o2 = make_order(10)
    inv2 = api(f"/finance/invoices?orderId={o2['id']}")[0]
    api(f"/finance/invoices/{inv2['id']}/status", {'status': 'approved'}); api(f"/finance/invoices/{inv2['id']}/status", {'status': 'issued'})
    claim = sapi('/finance/payments', {'invoiceId': inv2['id'], 'amount': 500, 'method': 'upi', 'reference': f'SALES{run}', 'source': 'customer_claim'})['payment']
    try:
        sapi(f"/finance/payments/{claim['id']}/verify", {'evidence': 'I saw the screenshot from customer'}); denied = False
    except urllib.error.HTTPError as e:
        denied = e.code == 403
    check('Sales user can record a claim but cannot verify it (403)', claim['status'] == 'pending_verification' and denied)
    try:
        sapi('/finance/overview'); hidden = False
    except urllib.error.HTTPError as e:
        hidden = e.code == 403
    check('Sales user cannot read finance figures (403)', hidden)
    spg.goto(f"{WEB}/finance"); spg.wait_for_timeout(2000)
    check('Finance page shows an error state for a user without access (no crash)', spg.get_by_role('alert').count() >= 1)

    # 9. Reversal by an admin: recorded as an approved correction; balances follow.
    api('/settings', {'finance': {'dispatchPaymentRule': 'none'}}, 'PUT')
    rv = api(f"/finance/payments/{rest['id']}/reverse", {'reason': 'Entered against the wrong invoice'})
    inv = api(f"/finance/invoices/{inv['id']}")
    check('Reversal (admin) → approval recorded, invoice back to part paid', rv['applied'] and inv['status'] == 'partially_paid' and float(inv['amountPaid']) == 8000, f"{inv['status']} {inv['amountPaid']}")

    # 10. Overview, receivables, CSV.
    pg.goto(f"{WEB}/finance"); pg.wait_for_timeout(2000)
    ov = api('/finance/overview?days=30')
    verified_sum = round(sum(float(x['amount']) for x in api('/finance/payments?status=verified')), 2)  # (all in this 30-day window)
    # Expenses are now recorded (amount + count, never invented); gross margin lives under "Expenses & margin".
    check('Overview: verified collections = verified payments only (pending claims excluded); expenses recorded, not invented', abs(ov['collectedVerified']['amount'] - verified_sum) < 0.01 and ov['awaitingVerification']['count'] >= 1 and isinstance(ov['expenses']['amount'], (int, float)) and pg.get_by_text('Expenses (30 days)').is_visible(), json.dumps({k: ov[k] for k in ('collectedVerified', 'awaitingVerification')}) + f' verified={verified_sum}')
    pg.get_by_role('tab', name='Receivables').click(); pg.wait_for_timeout(1500)
    check('Receivables lists the open invoice and customer balance', pg.locator('main').get_by_text(inv['number']).count() >= 1 and pg.get_by_text('Customer balances').is_visible())
    csv = api('/finance/invoices.csv', raw=True)
    check('CSV export contains the invoices', csv.startswith('number,status,order') and inv['number'] in csv)
    pg.goto(f"{WEB}/textile"); pg.wait_for_timeout(2500)
    check('Sales overview shows the Finance block', pg.get_by_text('Verified collections').first.is_visible())

    check('No JavaScript errors in either browser', not errs and not serrs, '; '.join((errs + serrs)[:3]))
    api('/settings', {'industry': 'real_estate', 'finance': {'dispatchPaymentRule': 'none'}}, 'PUT')
    b.close()

print(f"\n{sum(results)}/{len(results)} finance UI checks passed")
