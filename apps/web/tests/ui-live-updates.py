"""
Live dashboard: an order or cart from ANY device or channel shows up at once on every open dashboard page (server
events over GET /live/events), with a new-order notice. The order is placed from a SECOND browser (another device:
no shared tab channel), so only the server stream can explain an update faster than the pages' 8 s poll.

  Needs: API on :3000 (TEST database, DRY_RUN=true), web on :3001, owner@tacksharp.test with the demo workspaces.
  Run:   TEST_DB_NAME=<test db> python3 -I apps/web/tests/ui-live-updates.py
"""
from playwright.sync_api import sync_playwright
import os, re, tempfile, time

WEB, API = 'http://localhost:3001', 'http://localhost:3000'
if not os.environ.get('TEST_DB_NAME') or os.environ['TEST_DB_NAME'] == 'tacksharp':
    raise SystemExit('Set TEST_DB_NAME to a TEST database (never production).')
SHOTS = os.environ.get('SHOTS_DIR', tempfile.gettempdir())
results = []
def check(name, ok, detail=''):
    results.append(bool(ok)); print(('PASS ' if ok else 'FAIL ') + name + (f'  — {detail}' if detail else ''))

PHONE = '94' + str(int(time.time()))[-8:]

def login(ctx):
    r = ctx.request.post(API + '/auth/login', data={'email': 'owner@tacksharp.test', 'password': 'correct-horse-battery'})
    assert r.ok, r.text()
    assert ctx.request.post(API + '/auth/workspace', data={'organizationId': 'org_demo_restaurant'}).ok

def wait_for(fn, secs):
    t0 = time.time()
    while time.time() - t0 < secs:
        if fn(): return time.time() - t0
        time.sleep(0.1)
    return None

with sync_playwright() as p:
    b = p.chromium.launch()
    staff = b.new_context(viewport={'width': 1440, 'height': 900}); login(staff)
    errs = []
    orders = staff.new_page(); orders.on('pageerror', lambda e: errs.append(str(e)))
    orders.goto(WEB + '/orders'); orders.get_by_role('heading', name=re.compile('orders', re.I)).first.wait_for()
    ops = staff.new_page(); ops.goto(WEB + '/activity'); ops.get_by_text('Active carts').first.wait_for()
    time.sleep(1.5)  # both pages have their live connection open

    other = b.new_context(); login(other)  # another device
    say = lambda m: other.request.post(API + '/business-assistant/chat', data={'message': m, 'phone': PHONE, 'name': 'Kavya Live'}).json()
    say('1 kg broiler curry cut'); say('pickup 6 pm'); say('cash')
    took = wait_for(lambda: ops.get_by_text('Kavya Live').count() >= 1, 4)
    check('live operations: the cart being built in the AI assistant appears within 4 s', took is not None, f'{took:.1f}s' if took else 'not shown')
    if took:
        li = ops.locator('li', has_text='Kavya Live').first
        check('live operations: the cart is labelled "AI assistant"', li.get_by_text('AI assistant').count() >= 1, li.inner_text()[:120])

    r = say('yes')
    num = (r.get('order') or {}).get('orderNumber', '')
    check('the assistant confirmed a real order', bool(num), str(r)[:120])
    t0 = time.time()
    in_list = lambda: orders.locator('main').get_by_text(num).count() >= 1  # the notice is outside main
    took = wait_for(in_list, 4)
    check('orders page: the new order appears within 4 s (no reload, no shared tab)', took is not None, f'{took:.1f}s' if took else 'not shown')
    note = orders.get_by_role('status').filter(has_text=f'New order {num}')
    check('new-order notice with channel, total and a link to the order', note.count() == 1 and 'AI assistant' in note.inner_text() and '₹' in note.inner_text() and note.get_by_role('link', name='Open').count() == 1, note.inner_text() if note.count() else '')
    orders.wait_for_timeout(300); orders.screenshot(path=os.path.join(SHOTS, 'live-new-order.png'))
    gone = wait_for(lambda: ops.locator('li', has_text='Kavya Live').count() == 0, 4)
    check('live operations: the cart leaves once it is an order', gone is not None)

    # Status change from the other device: the order's row updates at once here.
    oid = note.get_by_role('link', name='Open').get_attribute('href').rsplit('/', 1)[-1] if note.count() else ''
    other.request.patch(API + f'/restaurant/orders/{oid}', data={'status': 'confirmed'})
    took = wait_for(lambda: orders.locator('tr, li, a', has_text=num).filter(has_text=re.compile('Confirmed', re.I)).count() >= 1, 4)
    check('orders page: a status change made elsewhere shows within 4 s', took is not None, f'{took:.1f}s' if took else 'not shown')

    note.get_by_role('link', name='Open').click(); orders.wait_for_url(re.compile(r'/orders/[\w-]+$')); orders.wait_for_timeout(1500)
    check('the notice opens the order page', re.search(r'/orders/[\w-]+$', orders.url) is not None and orders.get_by_role('heading', name=re.compile(num)).count() >= 1, orders.url)
    check('no page errors', not errs, '; '.join(errs)[:200])
    b.close()

print(f"\n{sum(results)}/{len(results)} checks passed")
raise SystemExit(0 if all(results) else 1)
