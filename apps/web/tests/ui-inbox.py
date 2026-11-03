"""
Team inbox + human hand-over through the real dashboard + API + MySQL (TEST database only, DRY_RUN=true: a staff reply
is recorded as "not sent", nothing reaches WhatsApp). Search, open, take over (AI off), internal note, label, priority,
saved reply inserted into the reply box, reply recorded with the author, resolve, return to AI; a read-only analyst
sees the inbox but cannot reply; phone layout.

  Needs: API on :3000, web on :3001 against the test DB; owner@tacksharp.test.
  Run:   TEST_DB_NAME=tacksharp_test python3 -I apps/web/tests/ui-inbox.py
"""
from playwright.sync_api import sync_playwright
import json, os, re, subprocess, tempfile, time

WEB, API = 'http://localhost:3001', 'http://localhost:3000'
SHOTS = os.environ.get('SHOTS_DIR', tempfile.gettempdir())
DB = os.environ.get('TEST_DB_NAME', 'tacksharp_test')
def sql(q):
    return subprocess.run(['mysql', '-h127.0.0.1', f"-u{os.environ.get('DB_USER', 'root')}", f"-p{os.environ.get('DB_PASSWORD', '')}", DB, '-N', '-e', q], capture_output=True, text=True).stdout.strip()

results = []
def check(name, ok, detail=''):
    results.append(bool(ok)); print(('PASS ' if ok else 'FAIL ') + name + (f'  — {detail}' if detail else ''))

run = str(int(time.time()))[-6:]
conv, cust = f'inbox-ui-{run}', f'inbox-cust-{run}'
phone = '9194' + run + '22'
with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 1440, 'height': 950}); pg = ctx.new_page()
    errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(WEB + '/login'); pg.get_by_label('Email').fill('owner@tacksharp.test'); pg.get_by_label('Password', exact=True).fill('correct-horse-battery')
    pg.get_by_role('button', name='Log in').click(); pg.wait_for_timeout(2500)
    def api(path, body=None, method=None):
        return pg.evaluate("""async ([u, b, m]) => { const r = await fetch(u, { method: m || (b ? 'POST' : 'GET'), credentials: 'include', headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; }""", [API + path, body, method])
    org = api('/auth/me')['body']['organizationId']
    sql(f"INSERT INTO Customer (id, organizationId, phone, name, messagingConsent, lastInboundAt, createdAt, updatedAt) VALUES ('{cust}', '{org}', '{phone}', 'Inbox Kavya {run}', 1, NOW(3), NOW(3), NOW(3))")
    sql(f"INSERT INTO Conversation (id, organizationId, customerId, channel, externalId, status, updatedAt) VALUES ('{conv}', '{org}', '{cust}', 'whatsapp', '{phone}', 'human_handoff', NOW(3))")
    for i, (role, content) in enumerate([('user', 'Order late aachu, manager kitta pesanum'), ('assistant', 'Sorry! Namma team ungala contact pannuvanga.')]):
        sql(f"INSERT INTO Message (id, organizationId, conversationId, role, content, createdAt) VALUES ('{conv}-{i}', '{org}', '{conv}', '{role}', '{content}', DATE_ADD(NOW(3), INTERVAL {i} SECOND))")
    saved = api('/inbox/saved-replies', {'title': f'Apology {run}', 'body': 'Sorry for the delay! Ungal order ippo ready.'})['body']
    try:
        pg.goto(WEB + '/inbox'); pg.wait_for_timeout(2500)
        check('nav: "Team inbox" in the sidebar', pg.get_by_role('link', name='Team inbox').count() >= 1)
        pg.get_by_label('Search conversations').fill(run); pg.wait_for_timeout(1500)
        row = pg.get_by_role('list', name='Conversations').get_by_role('button', name=re.compile(f'Inbox Kavya {run}'))
        check('search finds the conversation; list shows "needs a person"', row.count() == 1 and 'needs a person' in row.inner_text())
        row.click(); pg.wait_for_timeout(2000)
        check('hand-over summary shows what the customer said', pg.get_by_test_id('handoff-summary').count() == 1 and 'manager kitta pesanum' in pg.get_by_test_id('handoff-summary').inner_text())
        pg.get_by_role('button', name='Take over').click(); pg.wait_for_timeout(1500)
        check('take over: AI is silent, banner says the team is handling it', 'team is handling' in pg.get_by_test_id('ai-state').inner_text())
        check('take over: saved on the server (aiEnabled false)', sql(f"SELECT aiEnabled FROM Conversation WHERE id='{conv}'") == '0')
        pg.get_by_role('tab', name='Internal note').click()
        pg.get_by_label('Internal note').fill('Called the shop: order leaves in 10 min.'); pg.get_by_role('button', name='Add note').click(); pg.wait_for_timeout(1500)
        check('internal note shown in the side panel, saved, never sent', 'order leaves in 10 min' in pg.get_by_test_id('notes').inner_text() and sql(f"SELECT COUNT(*) FROM ConversationNote WHERE conversationId='{conv}'") == '1')
        pg.get_by_label('New label').fill('complaint'); pg.get_by_role('button', name='Add', exact=True).click(); pg.wait_for_timeout(1200)
        pg.get_by_label('Priority').select_option('urgent'); pg.wait_for_timeout(1200)
        stored = sql(f"SELECT CONCAT(priority, '|', labels) FROM Conversation WHERE id='{conv}'")
        check('label and priority saved', stored.startswith('urgent|') and 'complaint' in stored, stored)
        pg.get_by_role('tab', name='Reply to customer').click()
        pg.get_by_label('Insert a saved reply').select_option(saved['id']); pg.wait_for_timeout(300)
        check('saved reply inserted into the reply box', pg.get_by_label('Reply message').input_value() == 'Sorry for the delay! Ungal order ippo ready.')
        pg.get_by_role('button', name='Send').click(); pg.wait_for_timeout(2000)
        meta = sql(f"SELECT metadata FROM Message WHERE conversationId='{conv}' AND content='Sorry for the delay! Ungal order ippo ready.'")
        check('reply recorded with the author; DRY_RUN: marked not sent', '"author":"staff"' in meta.replace(' ', '') and '"simulated":true' in meta.replace(' ', ''), meta[:160])
        check('toast says the reply was saved but NOT sent (DRY_RUN)', pg.get_by_text(re.compile('Saved but NOT sent')).count() >= 1)
        check('thread shows the author and "not sent (test mode)"', pg.get_by_text(re.compile('not sent \\(test mode\\)')).count() >= 1)
        pg.screenshot(path=os.path.join(SHOTS, 'inbox-takeover.png'))
        pg.get_by_role('button', name='Resolve').click(); pg.wait_for_timeout(1500)
        check('resolve: status resolved, "needs a person" cleared', sql(f"SELECT CONCAT(inboxStatus, '|', status) FROM Conversation WHERE id='{conv}'") == 'resolved|active')
        pg.get_by_label('Search conversations').fill(run); pg.get_by_role('tab', name='All').click(); pg.wait_for_timeout(1500)
        pg.get_by_role('list', name='Conversations').get_by_role('button', name=re.compile(f'Inbox Kavya {run}')).click(); pg.wait_for_timeout(1500)
        pg.get_by_role('button', name='Return to AI').click(); pg.wait_for_timeout(1500)
        check('return to AI: banner and database say the AI answers again', 'AI is answering' in pg.get_by_test_id('ai-state').inner_text() and sql(f"SELECT aiEnabled FROM Conversation WHERE id='{conv}'") == '1')
        audit = sql(f"SELECT GROUP_CONCAT(action ORDER BY createdAt) FROM AuditEvent WHERE entityId='{conv}'")
        check('every action audited', all(a in audit for a in ('inbox.taken_over', 'inbox.note_added', 'inbox.updated', 'inbox.replied', 'inbox.returned_to_ai')), audit)

        # Read-only analyst: sees the inbox, cannot reply (server refuses too).
        inv = api('/team/invitations', {'email': f'analyst-{run}@example.test', 'role': 'analyst'})['body']
        c2 = b.new_context(viewport={'width': 1440, 'height': 950}); p2 = c2.new_page(); p2.goto(WEB + '/welcome')
        def api2(path, body=None, method=None):
            return p2.evaluate("""async ([u, b, m]) => { const r = await fetch(u, { method: m || (b ? 'POST' : 'GET'), credentials: 'include', headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; }""", [API + path, body, method])
        acc = api2('/team/links/accept', {'token': inv['token'], 'name': 'Analyst', 'password': 'analyst passphrase for test'})
        got = api2(f'/inbox/conversations/{conv}')['status']
        put = api2(f'/inbox/conversations/{conv}/reply', {'text': 'x'})['status']
        check('analyst: can read the inbox, cannot reply (403)', acc['status'] in (200, 201) and got == 200 and put == 403, f'accept={acc["status"]} get={got} reply={put}')
        c2.close()

        # Phone layout
        m = b.new_context(viewport={'width': 390, 'height': 844}, storage_state=ctx.storage_state()); mp = m.new_page(); mp.goto(WEB + '/inbox'); mp.wait_for_timeout(2500)
        check('phone: no horizontal scroll', mp.evaluate('document.scrollingElement.scrollWidth - window.innerWidth') <= 1)
        m.close()
        check('no page errors', not errs, '; '.join(errs)[:200])
    finally:
        api(f"/inbox/saved-replies/{saved['id']}", None, 'DELETE') if saved and saved.get('id') else None
        sql(f"DELETE FROM ConversationNote WHERE conversationId='{conv}'"); sql(f"DELETE FROM Message WHERE conversationId='{conv}'"); sql(f"DELETE FROM Conversation WHERE id='{conv}'"); sql(f"DELETE FROM Customer WHERE id='{cust}'")
    b.close()

print(f"\n{sum(results)}/{len(results)} passed")
raise SystemExit(0 if all(results) else 1)
