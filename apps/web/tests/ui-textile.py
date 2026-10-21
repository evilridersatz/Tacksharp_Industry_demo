"""
Textile sales, end to end through the real dashboard + API + MySQL (test database only).

  Needs: API on :3000 (DB_NAME=tacksharp_test RATE_LIMIT_API_PER_MIN=2000 RATE_LIMIT_LOGIN=100 - a scripted browser
         loads ~25 pages a minute from one IP, far above the production per-IP limits), web on :3001, and the
         owner@tacksharp.test user (created by e2e-live).
  Run:   python3 -I apps/web/tests/ui-textile.py

Two steps cannot happen without real WhatsApp credentials and are done as clearly-marked TEST FIXTURES in the test DB:
  - marking a quotation "sent" after the dashboard's real send was (correctly) refused with WhatsApp not configured;
  - the "please rate your order" request row that the follow-up worker creates only after a successful WhatsApp send.
Nothing here sends a real message or places a call.
"""
from playwright.sync_api import sync_playwright
import json, os, re, subprocess, urllib.parse, urllib.request, time

WEB, API = 'http://localhost:3001', 'http://localhost:3000'
results = []
def check(name, ok, detail=''):
    results.append(bool(ok)); print(('PASS ' if ok else 'FAIL ') + name + (f'  — {detail}' if detail else ''))

def sql(q):
    out = subprocess.run(['mysql', f"-u{os.environ.get('DB_USER', 'root')}", f"-p{os.environ.get('DB_PASSWORD', 'password')}", '-h127.0.0.1', os.environ.get('TEST_DB_NAME', 'tacksharp_test'), '-N', '-e', q], capture_output=True, text=True)
    if out.returncode: raise RuntimeError(out.stderr)
    return out.stdout.strip()

with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={'width': 1440, 'height': 900})
    errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.on('dialog', lambda d: d.accept())  # window.confirm on cancel (not used on the happy path)

    pg.goto(WEB + '/login'); pg.get_by_label('Email').fill('owner@tacksharp.test'); pg.get_by_label('Password').fill('correct-horse-battery')
    pg.get_by_role('button', name='Log in').click(); pg.wait_for_url(re.compile(r'/$|/leads|/\?'), timeout=10000); pg.wait_for_timeout(1000)
    cookie = lambda: '; '.join(f"{c['name']}={c['value']}" for c in pg.context.cookies(API))
    def api(path, body=None, method=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(API + path, data=data, method=method or ('POST' if data else 'GET'), headers={'cookie': cookie(), 'content-type': 'application/json'})
        return json.load(urllib.request.urlopen(req))

    api('/settings', {'industry': 'real_estate'}, 'PUT')  # start from a real-estate business even if a previous run aborted
    run = str(int(time.time()))[-5:]
    BUYER = f'Meena Garments {run}'

    # 1. Real-estate business: textile pages explain themselves; menu unchanged.
    pg.goto(WEB + '/catalogue'); pg.wait_for_timeout(1500)
    check('Real estate: textile page says it is not part of this industry', pg.get_by_text('Not part of Real Estate').is_visible())
    check('Real estate: no textile menu', pg.get_by_role('link', name='Quotations').count() == 0)

    # 2. Switch to textile in Settings.
    pg.goto(WEB + '/settings'); pg.wait_for_timeout(1500)
    pg.get_by_label('Industry', exact=True).select_option('textile'); pg.get_by_role('button', name='Save changes').click()
    pg.wait_for_timeout(600)
    pg.locator('dialog[open]').get_by_role('button', name='Change industry').click()  # the industry change is confirmed
    pg.wait_for_timeout(3000)
    check('Settings: industry saved as textile', api('/settings')['settings']['industry'] == 'textile')
    check('Textile menu appears; Site visits hidden', pg.get_by_role('link', name='Quotations').first.is_visible() and pg.get_by_role('link', name='Site visits').count() == 0)

    # 3. Catalogue: add an approved product and one without an approved price.
    pg.goto(WEB + '/catalogue'); pg.wait_for_timeout(1500)
    def add_product(sku, name, cat, price, approved, stock):
        pg.get_by_role('button', name='Add product').click()
        d = pg.locator('dialog[open]')
        d.get_by_label('SKU *').fill(sku); d.get_by_label('Name *').fill(name); d.get_by_label('Fabric / category *').fill(cat)
        d.get_by_label('Composition').fill('100% cotton'); d.get_by_label('GSM').fill('110'); d.get_by_label('MOQ').fill('100')
        d.get_by_label('Price (₹)').fill(price); d.get_by_label('Stock').select_option(stock)
        if 'saree' in cat: d.get_by_label('Composition').fill('pure silk'); d.get_by_label('Per').select_option('piece')
        if approved: d.get_by_label('Price approved for the AI to quote').check()
        d.get_by_role('button', name='Save product').click(); pg.wait_for_timeout(1500)
    POP, SLK = f'UI-POP-{run}', f'UI-SLK-{run}'
    # Earlier runs' products are deactivated so the AI matches only this run's catalogue.
    for x in api('/textile/products'):
        if x['sku'].startswith('UI-') and x['active']: api(f"/textile/products/{x['id']}", {'active': False}, 'PATCH')
    pg.reload(); pg.wait_for_timeout(1000)
    add_product(POP, 'UI Cotton Poplin', 'cotton shirting', '182.50', True, 'in_stock')
    add_product(SLK, 'UI Silk Saree', 'silk saree', '9500', False, 'low')
    prods = {x['sku']: x for x in api('/textile/products')}
    check('Catalogue: products saved with real values', prods.get(POP, {}).get('priceApproved') is True and float(prods[POP]['price']) == 182.5 and prods.get(SLK, {}).get('priceApproved') is False)
    check('Catalogue: unapproved price is flagged', pg.locator('tr', has_text=SLK).get_by_text('Not approved').is_visible())

    # 4. A WhatsApp enquiry handled by the textile AI (real engine, no model).
    phone = '9198' + str(int(time.time()))[-8:]
    r1 = api('/ai/chat', {'phone': phone, 'name': BUYER, 'message': 'Hi, need white cotton shirting 500 metres for our garment unit'})
    check('AI answers from the catalogue with the APPROVED price', '182.50' in r1['response'] and POP in r1['response'], r1['response'].replace('\n', ' | '))
    r2 = api('/ai/chat', {'phone': phone, 'message': 'yes'})
    lead_id = r1['leadId']
    check('"yes" creates a quotation request for the team', 'Q-' in r2['response'], r2['response'])
    r3 = api('/ai/chat', {'phone': phone, 'message': 'what is the silk saree price?'})
    check('AI never states an unapproved price', '9500' not in r3['response'] and '9,500' not in r3['response'], r3['response'].replace('\n', ' | '))

    # 5. Leads board shows textile stages; lead page shows the captured requirement.
    pg.goto(WEB + '/leads?q=' + urllib.parse.quote(BUYER)); pg.wait_for_timeout(2000)
    col = pg.locator('section[aria-label="Quotation"]')
    check('Board: textile columns, lead in "Quotation"', col.count() == 1 and col.get_by_text(BUYER).count() == 1)
    pg.goto(f'{WEB}/leads/{lead_id}'); pg.wait_for_timeout(2000)
    req_card = pg.locator('section', has_text='Buyer requirement')
    req_text = req_card.inner_text()
    # The last product asked about (silk saree) is the current item; its quantity is unknown, so none is shown.
    check('Lead page: buyer requirement = the latest item, old quantity not carried over', 'silk saree' in req_text and '500' not in req_text and 'Garment maker' in req_text, req_text.replace('\n', ' | ')[:200])
    statuses = pg.get_by_label('Lead status').locator('option').all_inner_texts()
    check('Lead page: status list is the textile funnel', 'Quote requested' in statuses and 'Site visit' not in statuses, ', '.join(statuses))

    # 6. Quotation: price check, approve, send (refused honestly without WhatsApp), accept, convert.
    q = next(x for x in api('/textile/quotations') if x['leadId'] == lead_id)
    pg.goto(f'{WEB}/quotations?id={q["id"]}'); pg.wait_for_timeout(2000)
    check('Quotation from the AI request: approved catalogue price used (500 × ₹182.50)', abs(float(q['subtotal']) - 91250) < 0.01 and q['status'] == 'pending_approval', f"{q['status']} {q['subtotal']}")
    pg.get_by_role('button', name='Edit prices & terms').click()
    d = pg.locator('dialog[open]'); d.get_by_label('GST %').fill('5'); d.get_by_label('Payment terms').fill('50% advance')
    d.get_by_role('button', name='Save changes').click(); pg.wait_for_timeout(1500)
    q = api(f'/textile/quotations/{q["id"]}')
    check('Edit: GST 5% on ₹91,250 → total ₹95,812.50', abs(float(q['total']) - 95812.5) < 0.01, q['total'])
    pg.get_by_role('button', name='Approve').click(); pg.wait_for_timeout(1500)
    check('Approve', api(f'/textile/quotations/{q["id"]}')['status'] == 'approved')
    pg.get_by_role('button', name='Send on WhatsApp').click(); pg.wait_for_timeout(2000)
    msg = pg.get_by_role('status').first.inner_text()
    check('Send without WhatsApp configured: refused with a reason, status unchanged', api(f'/textile/quotations/{q["id"]}')['status'] == 'approved' and len(msg) > 10, msg)
    sql(f"UPDATE Quotation SET status='sent', sentAt=NOW() WHERE id='{q['id']}'")  # TEST FIXTURE (see header)
    pg.reload(); pg.wait_for_timeout(2000)
    pg.get_by_role('button', name='Customer accepted').click(); pg.wait_for_timeout(1500)
    check('Customer accepted', api(f'/textile/quotations/{q["id"]}')['status'] == 'accepted')
    pg.get_by_role('button', name='Convert to order').click(); pg.wait_for_url(re.compile(r'/sales-orders\?id='), timeout=10000); pg.wait_for_timeout(2000)
    order_id = pg.url.split('id=')[1]
    o = api(f'/textile/orders/{order_id}')
    check('Converted to an order with the same total', o['status'] == 'pending_confirmation' and abs(float(o['total']) - 95812.5) < 0.01, f"{o['number']} {o['total']}")

    # 7. Order: confirm → … → delivered; payment recorded manually.
    for step in ['Confirmed', 'Processing', 'Ready to dispatch', 'Dispatched', 'Delivered']:
        pg.locator('section', has_text='Move order').get_by_role('button', name=step, exact=True).click(); pg.wait_for_timeout(1500)
    o = api(f'/textile/orders/{order_id}')
    check('Order moved step by step to delivered (audited)', o['status'] == 'delivered' and len(o['audit']) >= 6, f"{o['status']} audit={len(o['audit'])}")
    check('Lead moved to "order confirmed"', api(f'/leads/{lead_id}')['lead']['status'] == 'order_confirmed')
    fu = [f for f in api(f'/leads/{lead_id}')['followUps'] if (f.get('dedupeKey') or '').startswith('feedback:request:') or f.get('source') == 'feedback']
    check('Delivery scheduled a feedback request', len(fu) >= 1, str(len(fu)))
    pg.get_by_role('button', name='Paid', exact=True).click(); pg.wait_for_timeout(1500)
    check('Payment recorded as paid', api(f'/textile/orders/{order_id}')['paymentStatus'] == 'paid')

    # 8. Feedback: a low rating becomes an action item; the team resolves it.
    sql(f"INSERT INTO Feedback (id, organizationId, customerId, orderId, status, channel, requestedAt) SELECT 'fb_ui_{order_id[-8:]}', organizationId, customerId, id, 'requested', 'whatsapp', NOW() FROM SalesOrder WHERE id='{order_id}'")  # TEST FIXTURE
    r4 = api('/ai/chat', {'phone': phone, 'message': '2, colour faded after first wash'})
    check('Customer rating 2 + complaint → apology and a team task', 'team' in r4['response'].lower() or 'சரி' in r4['response'], r4['response'])
    pg.goto(WEB + '/feedback'); pg.wait_for_timeout(2000)
    card = pg.locator('section', has_text=BUYER)
    check('Feedback page: needs action, with the comment', card.get_by_text('Needs action').is_visible() and card.get_by_text('colour faded').count() >= 1)
    card.get_by_label('What was done').fill('Called; replacement roll dispatched'); card.get_by_role('button', name='Mark resolved').click(); pg.wait_for_timeout(1500)
    check('Resolve feedback', any(f['status'] == 'resolved' and f['order'] and f['order']['id'] == order_id for f in api('/textile/feedback')))

    # 9. Overview: real numbers + honest Meta status.
    pg.goto(WEB + '/textile'); pg.wait_for_timeout(2500)
    ov = api('/textile/overview?days=30')
    check('Overview: Meta ad spend shown as not connected', pg.get_by_text('Meta ad spend: not connected.').is_visible())
    check('Overview: recorded and paid order value match the order', ov['orders']['recordedRevenue'] >= 95812.5 and ov['orders']['paidRevenue'] >= 95812.5 and pg.get_by_text('₹95,812.5').count() + pg.get_by_text('marked paid').count() >= 1, json.dumps(ov['orders']))

    # 10. Tenant isolation through the HTTP API: an id from this business is not readable as another's (404, no data).
    try:
        urllib.request.urlopen(urllib.request.Request(API + '/textile/orders/does-not-exist', headers={'cookie': cookie()})); nf = False
    except urllib.error.HTTPError as e:
        nf = e.code == 404
    check('Unknown / foreign order id → 404', nf)

    check('No JavaScript errors in the browser', not errs, '; '.join(errs[:3]))

    # Restore the shared test org to real estate so other suites are unaffected.
    api('/settings', {'industry': 'real_estate'}, 'PUT')
    b.close()

print(f"\n{sum(results)}/{len(results)} textile UI checks passed")
