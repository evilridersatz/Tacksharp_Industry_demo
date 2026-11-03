"""
Enterprise subscriptions through the real dashboard + API + MySQL (TEST database). Tacksharp staff (platform admin):
contracts (validation shown per field), assign a plan with a contract and a limit override from the organization page,
issue an invoice (GST total), record its payment with a reference, refused duplicate invoice / early renewal. The
organization: "Plan & billing" before (no plan, no limits) and after (plan, usage bars, limit reached, invoices), a
creation refused by the plan with a clear message, the platform billing API refused to non-staff, phone layout.
No payment gateway exists: nothing is charged anywhere.

  Needs: API on :3000, web on :3001 (test DB), owner@tacksharp.test and staff@tacksharp.test (platform admin) in the
         same test organization, which must have no subscription yet (cleaned up afterwards).
  Run:   TEST_DB_NAME=tacksharp_test python3 -I apps/web/tests/ui-billing.py
"""
from playwright.sync_api import sync_playwright
import os, re, subprocess, tempfile, time

WEB, API = 'http://localhost:3001', 'http://localhost:3000'
SHOTS = os.environ.get('SHOTS_DIR', tempfile.gettempdir())
DB = os.environ.get('TEST_DB_NAME', 'tacksharp_test')
def sql(q):
    return subprocess.run(['mysql', '-h127.0.0.1', f"-u{os.environ.get('DB_USER', 'root')}", f"-p{os.environ.get('DB_PASSWORD', '')}", DB, '-N', '-e', q], capture_output=True, text=True).stdout.strip()

results = []
def check(name, ok, detail=''):
    results.append(bool(ok)); print(('PASS ' if ok else 'FAIL ') + name + (f'  — {detail}' if detail else ''))

run = str(int(time.time()))[-6:]
ORG = sql("SELECT organizationId FROM User WHERE email='owner@tacksharp.test'")
CONTRACT = f'Realty group {run}'
if sql(f"SELECT COUNT(*) FROM Subscription WHERE organizationId='{ORG}'") != '0':
    raise SystemExit(f'{ORG} already has a subscription; this test needs an organization without one.')

def login(b, email, password, viewport=None):
    ctx = b.new_context(viewport=viewport or {'width': 1440, 'height': 1000}); pg = ctx.new_page()
    errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(WEB + '/login'); pg.get_by_label('Email').fill(email); pg.get_by_label('Password', exact=True).fill(password)
    pg.get_by_role('button', name='Log in').click(); pg.wait_for_timeout(2500)
    def api(path, body=None, method=None):
        return pg.evaluate("""async ([u, b, m]) => { const r = await fetch(u, { method: m || (b ? 'POST' : 'GET'), credentials: 'include', headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; }""", [API + path, body, method])
    return ctx, pg, api, errs

with sync_playwright() as p:
    b = p.chromium.launch()
    try:
        _, o, oapi, oerrs = login(b, 'owner@tacksharp.test', 'correct-horse-battery')
        o.goto(WEB + '/settings/billing'); o.get_by_role('heading', name='Plan & billing').first.wait_for(timeout=8000); o.wait_for_timeout(1200)
        txt = o.inner_text('main')
        check('organization, before: "No plan assigned", every resource unlimited', 'No plan assigned' in txt and 'no limits' in txt and o.get_by_test_id('usage-row').count() == 5 and txt.count('unlimited') >= 5, txt[:200])
        check('nav has "Plan & billing"', o.get_by_role('link', name='Plan & billing').count() >= 1)
        r = oapi('/platform/billing')
        check('organization admin is refused the platform billing API (403)', r['status'] == 403, str(r['status']))

        _, s, sapi, serrs = login(b, 'staff@tacksharp.test', 'platform staff test pass')
        s.goto(WEB + '/platform/billing'); s.get_by_test_id('kpi-subs').wait_for(timeout=8000)
        check('platform: Billing tab with the no-gateway note', s.get_by_role('link', name='Billing').count() >= 1 and 'No payment gateway is connected' in s.inner_text('main'))
        s.get_by_label('Contract name').fill(CONTRACT); s.get_by_label('GSTIN').fill('BAD'); s.get_by_role('button', name='Add contract').click(); s.wait_for_timeout(1200)
        check('contract: a bad GSTIN is shown next to the field, nothing saved', s.get_by_text(re.compile('GSTIN: 15 characters')).count() == 1 and sql(f"SELECT COUNT(*) FROM BillingContract WHERE name='{CONTRACT}'") == '0')
        s.get_by_label('GSTIN').fill('33abcde1234f1z5'); s.get_by_label('Billing email').fill('accounts@realty.example'); s.get_by_role('button', name='Add contract').click(); s.wait_for_timeout(1500)
        check('contract added (GSTIN normalised)', sql(f"SELECT gstin FROM BillingContract WHERE name='{CONTRACT}'") == '33ABCDE1234F1Z5' and s.get_by_test_id('contract-row').filter(has_text=CONTRACT).count() == 1)

        agents_now = int(sql(f"SELECT COUNT(*) FROM VoiceAgent WHERE organizationId='{ORG}' AND status<>'archived'") or 0)
        s.goto(WEB + f'/platform/organizations/{ORG}'); card = s.get_by_test_id('subscription-admin'); card.wait_for(timeout=8000); s.wait_for_timeout(800)
        check('organization page: "Subscription & invoices", no plan yet', 'No plan assigned' in card.inner_text())
        card.get_by_label('Plan').select_option('pilot')
        card.get_by_label('Price per cycle (₹, before GST)').fill('4999')
        card.get_by_label('Enterprise contract').select_option(label=CONTRACT)
        limit = agents_now + 1
        card.get_by_label('Override Voice agents').fill(str(limit))
        card.get_by_role('button', name='Assign plan').click(); s.wait_for_timeout(2000)
        row = sql(f"SELECT CONCAT(planCode,'|',status,'|',price,'|',JSON_EXTRACT(limitsOverride,'$.voiceAgents')) FROM Subscription WHERE organizationId='{ORG}'")
        check('plan assigned: pilot, active, ₹4999, voice agents override (database)', row == f'pilot|active|4999.00|{limit}', row)
        check('card shows the plan, status and contract', 'Pilot · monthly' in card.inner_text() and CONTRACT in card.inner_text())

        body = lambda n: {'name': n, 'industry': 'real_estate', 'instructions': 'Answer property questions politely.', 'greeting': 'Hello!', 'fallbackMessage': 'Let me check.'}
        ok = oapi('/voice-agents', body(f'Within limit {run}'))
        check('organization: one more voice agent fits the plan', ok['status'] == 201, str(ok['status']))
        r = oapi('/voice-agents', {'name': f'Over limit {run}', 'industry': 'real_estate', 'instructions': 'Answer property questions politely.', 'greeting': 'Hello!', 'fallbackMessage': 'Let me check.'})
        check('organization: creating one more voice agent is refused with the plan message', r['status'] == 403 and (r['body'] or {}).get('code') == 'plan_limit' and f'Pilot plan allows {limit} voice agents and {limit} are in use' in (r['body'] or {}).get('message', ''), str(r['body'])[:160])
        check('nothing was created', sql(f"SELECT COUNT(*) FROM VoiceAgent WHERE name='Over limit {run}'") == '0')

        card.get_by_role('button', name='Issue invoice for this period').click(); s.wait_for_timeout(1800)
        inv = card.get_by_test_id('invoice-row')
        check('invoice issued: ₹4,999 + 18% GST = ₹5,898.82, status issued', inv.count() == 1 and '₹5,898.82' in inv.inner_text() and 'issued' in inv.inner_text(), inv.inner_text()[:160] if inv.count() else '')
        card.get_by_role('button', name='Issue invoice for this period').click(); s.wait_for_timeout(1500)
        check('a second invoice for the same period is refused', sql(f"SELECT COUNT(*) FROM PlatformInvoice WHERE organizationId='{ORG}'") == '1' and s.get_by_text(re.compile('already issued')).count() >= 1)
        card.get_by_role('button', name='Renew period').click(); s.wait_for_timeout(1500)
        check('early renewal refused', s.get_by_text(re.compile('more than 7 days')).count() >= 1)
        card.get_by_role('button', name='Payment link').click(); s.wait_for_timeout(1500)
        check('payment link refused with the reason (no Razorpay keys on this server), nothing stored', s.get_by_text(re.compile('Online payment is not set up')).count() >= 1 and sql(f"SELECT IFNULL(paymentLinkId,'none') FROM PlatformInvoice WHERE organizationId='{ORG}'") == 'none')
        card.get_by_role('button', name='Mark paid').click(); dlg = s.get_by_role('dialog')
        check('record payment: button disabled until a reference is typed', dlg.get_by_role('button', name='Record payment').is_disabled())
        dlg.get_by_label('Payment reference').fill(f'UTR{run}'); dlg.get_by_role('button', name='Record payment').click(); s.wait_for_timeout(1800)
        check('payment recorded with its reference (database + table)', sql(f"SELECT CONCAT(status,'|',paymentReference) FROM PlatformInvoice WHERE organizationId='{ORG}'") == f'paid|UTR{run}' and f'ref UTR{run}' in card.inner_text())
        s.screenshot(path=os.path.join(SHOTS, 'billing-platform-org.png'), full_page=True)

        o.reload(); o.get_by_role('heading', name='Plan & billing').first.wait_for(timeout=8000); o.wait_for_timeout(1500)
        txt = o.inner_text('main')
        check('organization, after: Pilot plan, contract, price with GST', 'Pilot plan' in txt and CONTRACT in txt and '₹4,999 + 18% GST' in txt, txt[:240])
        va = o.get_by_test_id('usage-row').filter(has_text='Voice agents').inner_text()
        check('usage: voice agents at the limit is flagged', f'{limit} of {limit}' in va and 'limit reached' in va, va)
        check('organization sees the paid invoice', o.get_by_test_id('invoice-row').count() == 1 and 'paid' in o.get_by_test_id('invoice-row').inner_text())
        o.screenshot(path=os.path.join(SHOTS, 'billing-org.png'), full_page=True)
        number = sql(f"SELECT number FROM PlatformInvoice WHERE organizationId='{ORG}'")
        o.get_by_role('link', name=f'View invoice {number}').click(); doc = o.get_by_test_id('invoice-doc'); doc.wait_for(timeout=8000); o.wait_for_timeout(800)
        dt = doc.inner_text()
        check('printable invoice: number, buyer contract, GST lines, total, paid reference', number in dt and CONTRACT in dt and 'GSTIN 33ABCDE1234F1Z5' in dt and o.get_by_test_id('invoice-total').inner_text() == '₹5,898.82' and f'UTR{run}' in dt, dt[:200])
        check('honest note: not a tax invoice while seller details are not configured', 'not a tax invoice' in o.get_by_test_id('invoice-note').inner_text() or 'not a GST e-invoice' in o.get_by_test_id('invoice-note').inner_text())
        o.emulate_media(media='print')
        check('print view: sidebar and buttons hidden', not o.locator('aside').first.is_visible() and not o.get_by_role('button', name=re.compile('Print')).is_visible())
        o.screenshot(path=os.path.join(SHOTS, 'invoice-print.png'), full_page=True)
        o.emulate_media(media='screen')
        oo = oapi(f"/billing/invoices/{sql(f'SELECT id FROM PlatformInvoice WHERE organizationId=' + chr(39) + ORG + chr(39))}")
        check('organization API returns its own invoice', oo['status'] == 200 and oo['body']['invoice']['number'] == number)

        _, m, _, merrs = login(b, 'owner@tacksharp.test', 'correct-horse-battery', {'width': 390, 'height': 844})
        m.goto(WEB + '/settings/billing'); m.get_by_role('heading', name='Plan & billing').first.wait_for(timeout=8000); m.wait_for_timeout(1500)
        check('phone: no horizontal page scroll', m.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'))
        m.screenshot(path=os.path.join(SHOTS, 'billing-org-phone.png'), full_page=True)
        audit = sql(f"SELECT GROUP_CONCAT(DISTINCT action ORDER BY action) FROM AuditEvent WHERE organizationId='{ORG}' AND actor LIKE 'platform:%' AND entityType IN ('subscription','platform_invoice') AND createdAt > NOW() - INTERVAL 10 MINUTE")
        check('audited: subscription.created, invoice.issued, invoice.paid', all(a in audit for a in ('subscription.created', 'invoice.issued', 'invoice.paid')), audit)
        check('no page errors', not (oerrs or serrs or merrs), '; '.join(oerrs + serrs + merrs)[:200])
    finally:
        sql(f"DELETE FROM VoiceAgent WHERE organizationId='{ORG}' AND name='Within limit {run}'")
        sql(f"DELETE FROM PlatformInvoice WHERE organizationId='{ORG}'")
        sql(f"DELETE FROM Subscription WHERE organizationId='{ORG}'")
        sql(f"DELETE FROM BillingContract WHERE name='{CONTRACT}'")
        sql(f"DELETE FROM AuditEvent WHERE organizationId='{ORG}' AND entityType IN ('subscription','platform_invoice')")
    b.close()

print(f"\n{sum(results)}/{len(results)} passed")
raise SystemExit(0 if all(results) else 1)
