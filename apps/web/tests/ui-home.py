"""
Business-owner experience through the real web app and API (test database, DRY_RUN): sign up as "GR Chicken / Chicken
Shop" from the industry cards, land on Home (welcome, honest setup checklist, next action, empty-state results,
standard navigation), add the business phone, a menu category and a shop, see truthful integration status and
system health, and use it on a phone. The new organization is removed afterwards.

  Needs: API on :3000, web on :3001.
  Run:   TEST_DB_NAME=tacksharp_merge python3 -I apps/web/tests/ui-home.py
"""
from playwright.sync_api import sync_playwright
import atexit, os, re, subprocess, tempfile, time

WEB = 'http://localhost:3001'
SHOTS = os.environ.get('SHOTS_DIR', tempfile.gettempdir())
DB = os.environ.get('TEST_DB_NAME', '')
RUN = str(int(time.time()))
ORG, EMAIL = f'Ravi Chicken Centre {RUN}', f'ravi-{RUN}@example.test'
results = []
def check(name, ok, detail=''):
    results.append(bool(ok)); print(('PASS ' if ok else 'FAIL ') + name + (f'  — {detail}' if detail else ''))
def sql(q):
    if not DB: return ''
    return subprocess.run(['mysql', '-h127.0.0.1', f"-u{os.environ.get('DB_USER', 'root')}", f"-p{os.environ.get('DB_PASSWORD', '')}", DB, '-N', '-e', q], capture_output=True, text=True).stdout.strip()
def cleanup():
    oid = sql(f"SELECT id FROM Organization WHERE name = '{ORG}'")
    if oid:
        sql(f"DELETE FROM MenuItem WHERE organizationId = '{oid}'")
        sql(f"DELETE FROM Organization WHERE id = '{oid}'")
    sql(f"DELETE FROM User WHERE email = '{EMAIL}'")
atexit.register(cleanup)

STANDARD = ['Home', 'AI Agents', 'Customers & Leads', 'Conversations', 'Orders & Business Activity', 'Analytics', 'Integrations', 'Settings']

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 1440, 'height': 950}); pg = ctx.new_page(); errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(WEB + '/signup'); pg.wait_for_timeout(1200)
    group = pg.get_by_role('group', name='Restaurants & Food Service')
    check('signup: industry cards grouped by category, GR Chicken / Chicken Shop under Restaurants & Food Service', group.count() == 1 and group.get_by_text('GR Chicken / Chicken Shop').count() == 1 and group.get_by_text(re.compile('AI-powered customer ordering, menu enquiries')).count() == 1)
    edu = pg.get_by_role('radio', name=re.compile('^Schools & coaching'))
    check('signup: a capability that does not exist is labelled and cannot be chosen', edu.is_disabled() and pg.get_by_text('Not available yet').count() >= 1)
    pg.get_by_label('Organization name').fill(ORG); pg.get_by_label('Your name').fill('Ravi Kumar')
    pg.get_by_label('Business email').fill(EMAIL); pg.get_by_label('Password', exact=True).fill('a long signup passphrase')
    pg.locator('input[name=industry][value=chicken_shop]').check(force=True)
    pg.get_by_role('checkbox').check()
    pg.screenshot(path=os.path.join(SHOTS, 'home-signup.png'))
    pg.get_by_role('button', name='Create organization').click()
    pg.wait_for_url(re.compile(r'/\?welcome=1'), timeout=15000)
    pg.get_by_test_id('home-overview').wait_for(timeout=15000); pg.wait_for_timeout(800)
    home = pg.get_by_test_id('home-overview')
    check('home: welcome, what Tacksharp does, business name and industry', home.get_by_text('Welcome to Tacksharp').count() == 1 and home.get_by_text('Your AI team helps your business respond to customers and follow up automatically.').count() == 1 and home.get_by_text(ORG).count() >= 1 and home.get_by_text('GR Chicken / Chicken Shop').count() >= 1)
    st = {s: pg.get_by_test_id(f'step-{s}').get_attribute('data-status') for s in ['profile', 'agent', 'channels', 'customers', 'consent', 'test', 'production']}
    check('home: setup checklist is honest for a new business (nothing green that is not done)', st['channels'] == 'action_required' and st['customers'] == 'action_required' and st['production'] == 'blocked' and st['profile'] == 'action_required', str(st))
    check('home: one prominent next action', pg.get_by_test_id('next-action').count() == 1)
    check('home: empty results say so instead of showing invented numbers', pg.get_by_test_id('metric-orders').get_by_text(re.compile('Nothing yet')).count() == 1 and pg.get_by_text('No customer activity yet').count() == 1)
    check('home: attention list explains the account review in plain English', pg.get_by_text('Account waiting for activation').count() == 1)
    nav = pg.get_by_role('navigation', name='Main')
    sections = [x.strip() for x in nav.locator(':scope > div > p').all_inner_texts()]
    check('navigation: standard sections in a fixed order', [s for s in sections if s] == [s.upper() for s in STANDARD] or [s.lower() for s in sections] == [s.lower() for s in STANDARD], str(sections))
    check('navigation: chicken-shop pages (orders, menu) are there', nav.get_by_role('link', name=re.compile('^Orders & tracking')).count() == 1 and nav.get_by_role('link', name='Menu & stock').count() == 1 and nav.get_by_role('link', name='Home').count() == 1)
    pg.screenshot(path=os.path.join(SHOTS, 'home-new-business.png'), full_page=True)

    # Business profile -> the checklist turns green for it
    pg.goto(WEB + '/settings'); pg.wait_for_timeout(1500)
    pg.get_by_label(re.compile('Business phone')).fill('91 98400 12345'); pg.get_by_role('button', name='Save profile').click(); pg.wait_for_timeout(1200)
    pg.goto(WEB + '/'); pg.get_by_test_id('step-profile').wait_for(timeout=15000)
    check('profile: saving the business phone completes that step', pg.get_by_test_id('step-profile').get_attribute('data-status') == 'complete')

    # Menu: category and shop for a brand-new chicken shop
    pg.goto(WEB + '/menu'); pg.wait_for_timeout(1500)
    check('menu: empty state guides the owner (no developer commands)', pg.get_by_text('No products yet').count() == 1 and pg.get_by_text('npm run').count() == 0)
    pg.get_by_label('Category name').fill('Chicken'); pg.get_by_role('button', name='Add category').click(); pg.wait_for_timeout(1200)
    pg.get_by_role('button', name='Add shop').click()
    pg.get_by_label('Shop name').fill('Anna Nagar'); pg.get_by_label('Area').fill('Anna Nagar'); pg.get_by_label('Address').fill('12 2nd Avenue, Anna Nagar, Chennai')
    pg.get_by_role('button', name='Save shop').click(); pg.wait_for_timeout(1500)
    check('menu: a shop is added with its hours', pg.get_by_text(re.compile('Open 07:00–21:00 IST')).count() == 1)
    pg.get_by_role('button', name='Add product').click(); pg.wait_for_timeout(500)
    check('menu: products can now be added under the new category', pg.get_by_role('button', name=re.compile('Add product')).count() >= 1 and pg.locator('select option', has_text='Chicken').count() >= 1)

    # Integrations: truthful, plain language
    pg.goto(WEB + '/settings/integrations'); pg.wait_for_timeout(2000)
    wa = pg.get_by_test_id('channel-whatsapp')
    check('integrations: WhatsApp shown as not connected with a setup action (never "Connected" without proof)', wa.get_by_text('Not connected').count() == 1 and wa.get_by_role('link', name='Complete setup').count() == 1 and pg.get_by_test_id('integration-whatsapp').get_by_text('Connected', exact=True).count() == 0)
    check('integrations: AI providers on the same page', pg.get_by_role('heading', name='AI providers').count() == 1 and pg.get_by_test_id('integration-openai').count() == 1)
    pg.screenshot(path=os.path.join(SHOTS, 'home-integrations.png'), full_page=True)

    # System health
    pg.goto(WEB + '/settings/diagnostics'); pg.wait_for_timeout(2000)
    check('health: plain-language status for application, data and background work', pg.get_by_text('Tacksharp is running.').count() == 1 and pg.get_by_text('Saved and available.').count() == 1 and pg.get_by_text(re.compile('Background work')).count() == 1)
    check('health: advanced diagnostics for the admin, no secrets', pg.get_by_text('Advanced diagnostics').count() == 1 and pg.get_by_text(re.compile('sk-|Bearer ')).count() == 0)

    # Agent setup from Home
    pg.goto(WEB + '/voice-agents'); pg.wait_for_timeout(1500)
    check('agents: new business sees an empty state and a guided start', pg.get_by_text('No voice agents yet').count() == 1 and pg.get_by_role('button', name='New agent').count() == 1)
    check('no page errors', not errs, '; '.join(errs)[:300])

    # Phone
    pg.set_viewport_size({'width': 390, 'height': 844}); pg.goto(WEB + '/'); pg.get_by_test_id('home-overview').wait_for(timeout=15000); pg.wait_for_timeout(800)
    check('phone: Home has no horizontal scroll', pg.evaluate('document.scrollingElement.scrollWidth - window.innerWidth') <= 1)
    pg.screenshot(path=os.path.join(SHOTS, 'home-phone.png'), full_page=True)
    pg.goto(WEB + '/settings/integrations'); pg.wait_for_timeout(1500)
    check('phone: Integrations has no horizontal scroll', pg.evaluate('document.scrollingElement.scrollWidth - window.innerWidth') <= 1)
    ctx.close(); b.close()

print(f"\n{sum(results)}/{len(results)} passed")
raise SystemExit(0 if all(results) else 1)
