"""
Live AI steering through the real dashboard + API + WhatsApp webhook + worker + AI engine + MySQL (TEST database,
DRY_RUN=true: nothing reaches Meta). A customer writes; the team switches the conversation to "Review first"; the next
AI reply is held (not sent) and shown as a draft; a person edits and sends it (saved, NOT sent in DRY_RUN, original
kept); another draft is discarded; private guidance is saved with a time limit and cleared; back to automatic.

  Needs: API on :3000 (DRY_RUN=true, RUN_WORKERS=true, WHATSAPP_PHONE_NUMBER_ID=PNID_LOCAL, no META_APP_SECRET), web :3001.
  Run:   TEST_DB_NAME=tacksharp_test python3 -I apps/web/tests/ui-steering.py
"""
from playwright.sync_api import sync_playwright
import json, os, re, subprocess, tempfile, time, urllib.request

WEB, API = 'http://localhost:3001', 'http://localhost:3000'
SHOTS = os.environ.get('SHOTS_DIR', tempfile.gettempdir())
DB = os.environ.get('TEST_DB_NAME', 'tacksharp_test')
def sql(q):
    return subprocess.run(['mysql', '-h127.0.0.1', f"-u{os.environ.get('DB_USER', 'root')}", f"-p{os.environ.get('DB_PASSWORD', '')}", DB, '-N', '-e', q], capture_output=True, text=True).stdout.strip()

results = []
def check(name, ok, detail=''):
    results.append(bool(ok)); print(('PASS ' if ok else 'FAIL ') + name + (f'  — {detail}' if detail else ''))

run = str(int(time.time()))[-6:]
PHONE = '91990' + run + '7'
def webhook(text):
    mid = f'wamid.STEER{int(time.time() * 1000)}'
    body = {'object': 'whatsapp_business_account', 'entry': [{'changes': [{'field': 'messages', 'value': {
        'metadata': {'phone_number_id': 'PNID_LOCAL'}, 'contacts': [{'wa_id': PHONE, 'profile': {'name': f'Steer Kumar {run}'}}],
        'messages': [{'from': PHONE, 'id': mid, 'type': 'text', 'text': {'body': text}, 'timestamp': str(int(time.time()))}]}}]}]}
    urllib.request.urlopen(urllib.request.Request(API + '/webhooks/whatsapp', data=json.dumps(body).encode(), method='POST', headers={'content-type': 'application/json'}))
    return mid
def wait_for(q, ok, secs=60):
    v = ''
    for _ in range(secs):
        v = sql(q)
        if ok(v): return v
        time.sleep(1)
    return v

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_context(viewport={'width': 1440, 'height': 1000}).new_page()
    errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(WEB + '/login'); pg.get_by_label('Email').fill('owner@tacksharp.test'); pg.get_by_label('Password', exact=True).fill('correct-horse-battery')
    pg.get_by_role('button', name='Log in').click(); pg.wait_for_timeout(2500)
    org = sql("SELECT organizationId FROM User WHERE email='owner@tacksharp.test'")
    conv = ''
    try:
        webhook('Hi, looking for a flat')
        conv = wait_for(f"SELECT c.id FROM Conversation c WHERE c.organizationId='{org}' AND c.channel='whatsapp' AND c.externalId='{PHONE}' AND EXISTS (SELECT 1 FROM Message m WHERE m.conversationId=c.id AND m.role='assistant')", bool)
        check('customer wrote; the AI answered automatically (auto mode)', bool(conv))
        def open_conv():
            pg.goto(WEB + '/inbox'); pg.wait_for_timeout(2000)
            pg.get_by_role('tab', name='All').first.click()
            pg.get_by_label('Search conversations').fill(PHONE[-6:]); pg.wait_for_timeout(2000)
            pg.get_by_role('list', name='Conversations').get_by_role('listitem').first.click(); pg.wait_for_timeout(2000)
        open_conv()
        st = pg.get_by_test_id('ai-steering')
        check('steering panel shown for a WhatsApp conversation the AI answers', st.count() == 1 and st.get_by_role('tab', name='Review first').count() == 1)
        st.get_by_role('tab', name='Review first').click(); pg.wait_for_timeout(1500)
        check('switched to review first', sql(f"SELECT aiMode FROM Conversation WHERE id='{conv}'") == 'review')
        held_before = sql(f"SELECT COUNT(*) FROM Message WHERE conversationId='{conv}' AND deliveryStatus='held'")
        webhook('2BHK in Porur under 60 lakhs?')
        n = wait_for(f"SELECT COUNT(*) FROM Message WHERE conversationId='{conv}' AND deliveryStatus='held'", lambda v: v not in ('', held_before))
        check('next AI reply is HELD, not sent', n == '1', n)
        wrong = sql(f"SELECT COUNT(*) FROM Message WHERE conversationId='{conv}' AND role='assistant' AND deliveryStatus='held' AND createdAt < (SELECT MIN(createdAt) FROM Message WHERE conversationId='{conv}' AND role='user' AND content='2BHK in Porur under 60 lakhs?')")
        check('the held draft is the reply to THIS message, never the earlier auto reply', wrong == '0', wrong)
        inbound = sql(f"SELECT lastError FROM InboundMessage WHERE organizationId='{org}' AND fromPhone='{PHONE}' ORDER BY receivedAt DESC LIMIT 1")
        check('the inbound message is closed as held for review (nothing sent)', 'held_for_review' in inbound, inbound)
        open_conv()
        check('list shows the "review first" badge', 'review first' in pg.get_by_role('list', name='Conversations').get_by_role('listitem').first.inner_text())
        drafts = pg.get_by_test_id('ai-drafts')
        check('draft panel: 1 AI reply waits for approval; thread says "waiting for approval"', drafts.count() == 1 and '1 AI reply waits' in drafts.inner_text() and pg.get_by_text('waiting for approval').count() >= 1)
        draft_id = sql(f"SELECT id FROM Message WHERE conversationId='{conv}' AND deliveryStatus='held'")
        original = sql(f"SELECT content FROM Message WHERE id='{draft_id}'")
        drafts.get_by_label('AI draft').fill(f'We have verified 2BHK homes in Porur under 60L. Shall I share details? ({run})')
        drafts.get_by_role('button', name='Send edited').click(); pg.wait_for_timeout(2500)
        row = sql(f"SELECT CONCAT(IFNULL(deliveryStatus,'null'),'|',content) FROM Message WHERE id='{draft_id}'")
        meta = sql(f"SELECT metadata FROM Message WHERE id='{draft_id}'").replace(' ', '')
        check('edited draft saved, NOT sent (DRY_RUN), original AI text kept', row.startswith('null|We have verified') and '"status":"edited"' in meta and '"simulated":true' in meta and 'originalAiText' in meta and pg.get_by_text(re.compile('Approved but NOT sent')).count() >= 1, row[:80])
        check('original AI text preserved exactly', original[:30].replace(' ', '') in meta)
        webhook('Any 3BHK?')
        wait_for(f"SELECT COUNT(*) FROM Message WHERE conversationId='{conv}' AND deliveryStatus='held'", lambda v: v == '1')
        open_conv()
        pg.get_by_test_id('ai-drafts').get_by_role('button', name='Discard').click(); pg.wait_for_timeout(2000)
        late = sql(f"SELECT COUNT(*) FROM Message WHERE conversationId='{conv}' AND role='assistant' AND deliveryStatus='discarded' AND createdAt < (SELECT MIN(createdAt) FROM Message WHERE conversationId='{conv}' AND role='user' AND content='Any 3BHK?')")
        check('the discarded draft is the reply to "Any 3BHK?"', late == '0', late)
        check('discarded draft: not sent, kept as "discarded (not sent)"', sql(f"SELECT COUNT(*) FROM Message WHERE conversationId='{conv}' AND deliveryStatus='discarded'") == '1' and pg.get_by_text('discarded (not sent)').count() >= 1)
        st = pg.get_by_test_id('ai-steering')
        st.get_by_label('Guidance for the AI').fill('Customer is price sensitive: lead with the lowest verified price')
        st.get_by_label('Guidance lasts').select_option('2')
        st.get_by_role('button', name='Save guidance').click(); pg.wait_for_timeout(2000)
        g = sql(f"SELECT CONCAT(aiGuidance,'|',TIMESTAMPDIFF(MINUTE, NOW(3), aiGuidanceUntil)) FROM Conversation WHERE id='{conv}'")
        check('guidance saved for 2 hours and shown as in force', g.startswith('Customer is price sensitive') and 110 <= int(g.split('|')[1]) <= 120 and 'In force until' in st.get_by_test_id('guidance-state').inner_text(), g)
        audit = sql(f"SELECT data FROM AuditEvent WHERE entityId='{conv}' AND action='inbox.updated' ORDER BY createdAt DESC LIMIT 1")
        check('the guidance text is not written to the audit trail', 'price sensitive' not in audit and 'length' in audit, audit[:120])
        pg.screenshot(path=os.path.join(SHOTS, 'inbox-steering.png'))
        st.get_by_role('button', name='Clear').click(); pg.wait_for_timeout(1500)
        check('guidance cleared', sql(f"SELECT IFNULL(aiGuidance,'none') FROM Conversation WHERE id='{conv}'") == 'none')
        st.get_by_role('tab', name='Send automatically').click(); pg.wait_for_timeout(1500)
        check('back to sending automatically', sql(f"SELECT aiMode FROM Conversation WHERE id='{conv}'") == 'auto')
        check('no page errors', not errs, '; '.join(errs)[:200])
    finally:
        cust = sql(f"SELECT id FROM Customer WHERE organizationId='{org}' AND phone='{PHONE}'")
        sql(f"DELETE FROM InboundMessage WHERE organizationId='{org}' AND fromPhone='{PHONE}'")
        if conv: sql(f"DELETE FROM Conversation WHERE id='{conv}'")
        if cust: sql(f"DELETE FROM Lead WHERE customerId='{cust}'"); sql(f"DELETE FROM FollowUp WHERE customerId='{cust}'"); sql(f"DELETE FROM Customer WHERE id='{cust}'")
    b.close()

print(f"\n{sum(results)}/{len(results)} passed")
raise SystemExit(0 if all(results) else 1)
