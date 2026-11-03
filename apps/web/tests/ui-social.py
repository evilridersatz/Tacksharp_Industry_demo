"""
Instagram & Messenger through the real dashboard + API + MySQL (TEST database, DRY_RUN=true: nothing is sent to Meta).
Settings: save (secrets masked), connection test against the real Graph API (unreachable from the sandbox: must show as
failed), the passing test SEEDED in the test database, enable through the UI -> Page / Instagram account routed to the
workspace. Webhook: unsigned and wrongly signed deliveries refused (401); signed Messenger and Instagram messages land
in the Team inbox (channel filter, badges, masked id, Return to AI refused while no agent is chosen, automatic
acknowledgement marked not sent); a re-delivery is stored once; a staff reply is saved but NOT sent (DRY_RUN).
AI replies: a published agent (real knowledge base, tested and published through the API) chosen in the settings
card answers a new Messenger customer from its knowledge (DRY_RUN: recorded, not sent), a question it cannot answer
is handed to the team and shows in the Knowledge studio, the earlier conversation can now return to the AI.
Disabling stops routing.

  Run:   TEST_DB_NAME=tacksharp_test python3 -I apps/web/tests/ui-social.py
"""
from playwright.sync_api import sync_playwright
import hashlib, hmac, json, os, re, subprocess, tempfile, time, urllib.request, urllib.error

WEB, API = 'http://localhost:3001', 'http://localhost:3000'
SHOTS = os.environ.get('SHOTS_DIR', tempfile.gettempdir())
DB = os.environ.get('TEST_DB_NAME', 'tacksharp_test')
def sql(q):
    return subprocess.run(['mysql', '-h127.0.0.1', f"-u{os.environ.get('DB_USER', 'root')}", f"-p{os.environ.get('DB_PASSWORD', '')}", DB, '-N', '-e', q], capture_output=True, text=True).stdout.strip()

results = []
def check(name, ok, detail=''):
    results.append(bool(ok)); print(('PASS ' if ok else 'FAIL ') + name + (f'  — {detail}' if detail else ''))

run = str(int(time.time()))[-6:]
PAGE, IG = '8800' + run + '01', '1780' + run + '02'
TOKEN, SECRET = f'EAAuisocial{run}Qz7', f'uiappsecret{run}k9'
M_USER, I_USER, A_USER = '3100' + run + '11', '3200' + run + '22', '3300' + run + '33'
agent_id = kb_id = ''

def webhook(body, secret=SECRET, signed=True):
    raw = json.dumps(body).encode()
    headers = {'content-type': 'application/json'}
    if signed: headers['x-hub-signature-256'] = 'sha256=' + hmac.new(secret.encode(), raw, hashlib.sha256).hexdigest()
    try:
        with urllib.request.urlopen(urllib.request.Request(API + '/webhooks/meta-social', data=raw, headers=headers, method='POST'), timeout=20) as r:
            return r.status, json.loads(r.read() or b'{}')
    except urllib.error.HTTPError as e:
        return e.code, None
def event(obj, entry, frm, mid, text):
    return {'object': obj, 'entry': [{'id': entry, 'time': int(time.time() * 1000), 'messaging': [{'sender': {'id': frm}, 'recipient': {'id': entry}, 'timestamp': int(time.time() * 1000), 'message': {'mid': mid, 'text': text}}]}]}

with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_context(viewport={'width': 1440, 'height': 950}).new_page()
    errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(WEB + '/login'); pg.get_by_label('Email').fill('owner@tacksharp.test'); pg.get_by_label('Password', exact=True).fill('correct-horse-battery')
    pg.get_by_role('button', name='Log in').click(); pg.wait_for_timeout(2500)
    org = sql("SELECT organizationId FROM User WHERE email='owner@tacksharp.test'")
    sql(f"DELETE FROM IntegrationCredential WHERE organizationId='{org}' AND provider='meta_social'")
    sql(f"DELETE FROM OrganizationChannel WHERE organizationId='{org}' AND kind IN ('messenger_page_id','instagram_account_id')")
    try:
        pg.goto(WEB + '/settings/integrations'); pg.wait_for_timeout(2500)
        check('integrations list has an "Instagram & Messenger" card', pg.get_by_test_id('integration-meta_social').count() == 1)
        pg.goto(WEB + '/settings/integrations/meta-social'); pg.wait_for_timeout(2500)
        pg.get_by_label('Page access token', exact=True).fill(TOKEN)
        pg.get_by_label('App secret', exact=True).fill(SECRET)
        pg.get_by_label('Facebook Page ID').fill(PAGE)
        pg.get_by_label('Instagram account ID').fill(IG)
        pg.get_by_label('Automatic acknowledgement').fill('Thanks! Our team will reply shortly.')
        pg.get_by_role('button', name='Save').first.click(); pg.wait_for_timeout(2000)
        check('saved; token and app secret never shown again', TOKEN not in pg.content() and SECRET not in pg.content() and sql(f"SELECT status FROM IntegrationCredential WHERE organizationId='{org}' AND provider='meta_social'") == 'untested')
        check('webhook setup card shows the callback URL', '/webhooks/meta-social' in pg.get_by_test_id('social-setup').inner_text())
        pg.get_by_role('button', name='Test connection').click(); pg.wait_for_timeout(15000)
        check('connection test against the real Graph API (unreachable here) is reported as failed', sql(f"SELECT status FROM IntegrationCredential WHERE organizationId='{org}' AND provider='meta_social'") == 'failed')
        # Meta is unreachable from the sandbox: seed the passing test (TEST DATABASE ONLY).
        sql(f"UPDATE IntegrationCredential SET status='ok', lastError=NULL WHERE organizationId='{org}' AND provider='meta_social'")
        pg.reload(); pg.wait_for_timeout(2500)
        pg.get_by_role('button', name='Enable integration').click(); pg.wait_for_timeout(2000)
        routed = sql(f"SELECT GROUP_CONCAT(kind ORDER BY kind) FROM OrganizationChannel WHERE organizationId='{org}' AND kind IN ('messenger_page_id','instagram_account_id')")
        check('enabling routes the Page and the Instagram account to this workspace', routed == 'instagram_account_id,messenger_page_id', routed)
        time.sleep(1)

        st, _ = webhook(event('page', PAGE, M_USER, f'm.ui.{run}.0', 'hi'), signed=False)
        check('unsigned delivery refused (401)', st == 401, st)
        st, _ = webhook(event('page', PAGE, M_USER, f'm.ui.{run}.0', 'hi'), secret='wrong-secret')
        check('wrongly signed delivery refused (401)', st == 401, st)
        st, r = webhook(event('page', PAGE, M_USER, f'm.ui.{run}.1', f'Velachery 2BHK details please {run}'))
        st2, r2 = webhook(event('page', PAGE, M_USER, f'm.ui.{run}.1', f'Velachery 2BHK details please {run}'))
        check('signed Messenger message stored once (re-delivery ignored)', st == 200 and r.get('stored') == 1 and r2.get('stored') == 0, f'{r} {r2}')
        st, r = webhook(event('instagram', IG, I_USER, f'm.ui.{run}.ig', f'Price list? {run}'))
        check('signed Instagram message stored', st == 200 and r.get('stored') == 1, r)

        pg.goto(WEB + '/inbox'); pg.wait_for_timeout(2500)
        pg.get_by_label('Channel').select_option('messenger'); pg.get_by_label('Search conversations').fill(run); pg.wait_for_timeout(2500)
        items = pg.get_by_role('list', name='Conversations').get_by_role('listitem')
        check('Messenger filter shows the conversation with a "Messenger" badge and "AI off"', items.count() == 1 and 'Messenger' in items.first.inner_text() and 'AI off' in items.first.inner_text(), items.first.inner_text() if items.count() else '')
        items.first.click(); pg.wait_for_timeout(2000)
        check('header: masked Meta id and channel', f'Messenger id ••{M_USER[-4:]}' in pg.get_by_test_id('contact-line').inner_text())
        pg.get_by_role('button', name='Return to AI').click(); pg.wait_for_timeout(1500)
        check('Return to AI refused while no agent answers Instagram / Messenger', pg.get_by_text(re.compile('No AI agent answers Instagram')).count() >= 1 and sql(f"SELECT aiEnabled FROM Conversation WHERE organizationId='{org}' AND externalId='{M_USER}'") == '0')
        check('thread: customer message and the automatic acknowledgement marked not sent', pg.get_by_text(f'Velachery 2BHK details please {run}').count() >= 1 and pg.get_by_text('Thanks! Our team will reply shortly.').count() >= 1 and pg.get_by_text(re.compile('not sent \\(test mode\\)')).count() >= 1)
        pg.get_by_role('tab', name='Reply to customer').click()
        pg.get_by_label('Reply message').fill(f'Sharing the brochure now {run}'); pg.get_by_role('button', name='Send').click(); pg.wait_for_timeout(2500)
        meta = sql(f"SELECT metadata FROM Message WHERE content='Sharing the brochure now {run}'").replace(' ', '')
        check('staff reply recorded with the author; DRY_RUN: saved but NOT sent', '"author":"staff"' in meta and '"simulated":true' in meta and pg.get_by_text(re.compile('Saved but NOT sent')).count() >= 1, meta[:150])
        pg.screenshot(path=os.path.join(SHOTS, 'inbox-messenger.png'))
        pg.get_by_label('Channel').select_option('instagram'); pg.wait_for_timeout(2500)
        check('Instagram filter shows the Instagram conversation', items.count() == 1 and 'Instagram' in items.first.inner_text())

        # ---------------------------------------------------------------- photos and Instagram comments
        img = f'https://scontent.cdninstagram.com/v/t51/{run}.jpg'
        st, r = webhook({'object': 'instagram', 'entry': [{'id': IG, 'time': int(time.time() * 1000), 'messaging': [{'sender': {'id': I_USER}, 'recipient': {'id': IG}, 'timestamp': int(time.time() * 1000), 'message': {'mid': f'm.ui.{run}.img', 'attachments': [{'type': 'image', 'payload': {'url': img}}]}}]}]})
        cid = '179' + run + '77'
        st2, r2 = webhook({'object': 'instagram', 'entry': [{'id': IG, 'time': int(time.time() * 1000), 'field': 'comments', 'value': {'id': cid, 'text': f'Price of the combo? {run}', 'from': {'id': A_USER, 'username': f'kavya{run}'}, 'media': {'id': '555', 'media_product_type': 'FEED'}}}]})
        check('signed Instagram photo and comment stored', st == 200 and r.get('stored') == 1 and st2 == 200 and r2.get('stored') == 1, f'{r} {r2}')
        pg.goto(WEB + '/inbox'); pg.wait_for_timeout(2000)
        pg.get_by_label('Channel').select_option('instagram'); pg.get_by_label('Search conversations').fill(run); pg.wait_for_timeout(2500)
        pg.get_by_role('list', name='Conversations').get_by_role('listitem').first.click(); pg.wait_for_timeout(1500)
        photo = pg.get_by_role('img', name='Photo sent by the customer')
        check('the photo shows in the thread from Meta\'s CDN (not stored by us), no referrer', photo.count() == 1 and photo.get_attribute('src') == img and photo.get_attribute('referrerpolicy') == 'no-referrer')
        webhook({'object': 'instagram', 'entry': [{'id': IG, 'time': int(time.time() * 1000), 'messaging': [{'sender': {'id': I_USER}, 'recipient': {'id': IG}, 'timestamp': int(time.time() * 1000), 'reaction': {'mid': f'm.ui.{run}.img', 'action': 'react', 'reaction': 'love', 'emoji': '\u2764\ufe0f'}}]}]})
        pg.reload(); pg.wait_for_timeout(2000); pg.get_by_label('Channel').select_option('instagram'); pg.get_by_label('Search conversations').fill(run); pg.wait_for_timeout(2500)
        pg.get_by_role('list', name='Conversations').get_by_role('listitem').first.click(); pg.wait_for_timeout(1500)
        check('a customer reaction shows under the message it reacts to', pg.get_by_test_id('reaction').count() == 1 and '\u2764' in pg.get_by_test_id('reaction').inner_text())
        pg.get_by_label('Channel').select_option('instagram_comment'); pg.wait_for_timeout(2500)
        items = pg.get_by_role('list', name='Conversations').get_by_role('listitem')
        check('"Instagram comment" filter shows the comment from @username', items.count() == 1 and f'@kavya{run}' in items.first.inner_text(), items.first.inner_text() if items.count() else '')
        items.first.click(); pg.wait_for_timeout(1500)
        check('comment view: public-reply note, both reply buttons, no Return to AI (the AI never answers comments)', pg.get_by_test_id('comment-note').count() == 1 and pg.get_by_role('button', name='Reply publicly').count() == 1 and pg.get_by_role('button', name='Send as private message').count() == 1 and pg.get_by_role('button', name='Return to AI').count() == 0)
        pg.get_by_role('tab', name='Reply to customer').click()
        pg.get_by_label('Reply message').fill(f'Rs 299 today {run}'); pg.get_by_role('button', name='Reply publicly').click(); pg.wait_for_timeout(2000)
        pg.get_by_label('Reply message').fill(f'Sending the menu privately {run}'); pg.get_by_role('button', name='Send as private message').click(); pg.wait_for_timeout(2000)
        pub = sql(f"SELECT metadata FROM Message WHERE content='Rs 299 today {run}'").replace(' ', '')
        prv = sql(f"SELECT metadata FROM Message WHERE content='Sending the menu privately {run}'").replace(' ', '')
        check('public reply and private message recorded; DRY_RUN: not sent', '"publicReply":true' in pub and '"privateReply":true' in prv and '"simulated":true' in pub and '"simulated":true' in prv and pg.get_by_text('public reply', exact=False).count() >= 1, (pub + prv)[:200])
        pg.screenshot(path=os.path.join(SHOTS, 'inbox-instagram-comment.png'))

        # ---------------------------------------------------------------- AI replies
        def api(path, body=None, method=None):
            return pg.evaluate("""async ([u, b, m]) => { const r = await fetch(u, { method: m || (b ? 'POST' : 'GET'), credentials: 'include', headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; }""", [API + path, body, method])
        kb_id = (api('/knowledge-bases', {'name': f'Social facts {run}'})['body'] or {}).get('id', '')
        up = pg.evaluate("""async ([u]) => { const f = new FormData(); f.append('file', new Blob(['Broiler chicken costs Rs 240 per kg.\\nThe Velachery outlet closes at 8 PM.\\n'], { type: 'text/plain' }), 'facts.txt'); const r = await fetch(u, { method: 'POST', body: f, credentials: 'include' }); return r.status; }""", [f'{API}/knowledge-bases/{kb_id}/documents'])
        for _ in range(20):
            if sql(f"SELECT status FROM KnowledgeDocument WHERE knowledgeBaseId='{kb_id}'") == 'indexed': break
            time.sleep(0.5)
        a = api('/voice-agents', {'name': f'Chat desk {run}', 'industry': 'restaurant', 'instructions': 'Answer chicken price and timing questions from the facts.', 'greeting': 'Vanakkam!', 'fallbackMessage': 'Let me check with the team.', 'knowledgeBaseId': kb_id})
        agent_id = (a['body'] or {}).get('id', '')
        api(f'/voice-agents/{agent_id}/test', {'message': 'broiler price?'})
        pub = api(f'/voice-agents/{agent_id}/publish', {'note': 'Social launch'})
        check('agent with an indexed knowledge base tested and published (real API)', up == 201 and pub['status'] in (200, 201) and sql(f"SELECT status FROM VoiceAgent WHERE id='{agent_id}'") == 'active', str(pub['body'])[:200])
        pg.goto(WEB + '/settings/integrations/meta-social'); card = pg.get_by_test_id('social-ai'); card.wait_for(timeout=8000); pg.wait_for_timeout(800)
        check('settings: "AI replies" card, team only', 'Team only' in card.inner_text())
        card.get_by_label('Agent').select_option(agent_id); card.get_by_role('button', name='Save').click(); pg.wait_for_timeout(1800)
        check('agent chosen: card says "AI answering" and the choice is stored', 'AI answering' in card.inner_text() and agent_id in sql(f"SELECT config FROM IntegrationCredential WHERE organizationId='{org}' AND provider='meta_social'"))
        time.sleep(1)
        st, r = webhook(event('page', PAGE, A_USER, f'm.ui.{run}.ai1', 'What is the broiler price per kg?'))
        ai_msg = sql(f"SELECT CONCAT(m.content,'|',JSON_EXTRACT(m.metadata,'$.ai.source'),'|',JSON_EXTRACT(m.metadata,'$.simulated')) FROM Message m JOIN Conversation c ON c.id=m.conversationId WHERE c.organizationId='{org}' AND c.externalId='{A_USER}' AND m.role='assistant'")
        check('new Messenger customer answered by the agent from its knowledge (DRY_RUN: recorded, not sent)', st == 200 and '240' in ai_msg and '"knowledge"' in ai_msg and ai_msg.endswith('|true'), ai_msg)
        webhook(event('page', PAGE, A_USER, f'm.ui.{run}.ai2', 'Do you deliver to Tambaram?'))
        conv = sql(f"SELECT CONCAT(aiEnabled,'|',status) FROM Conversation WHERE organizationId='{org}' AND externalId='{A_USER}'")
        check('a question it cannot answer: fallback sent, conversation handed to the team', conv == '0|human_handoff', conv)
        pg.goto(WEB + '/knowledge'); pg.get_by_role('button', name=re.compile(f'Social facts {run}')).click(); pg.wait_for_timeout(1200)
        pg.get_by_role('tab', name=re.compile(r'^Unanswered \(')).click(); pg.wait_for_timeout(1200)
        gap = pg.get_by_test_id('kb-gap').filter(has_text='Tambaram')
        check('the question shows in the Knowledge studio, from Instagram / Messenger', gap.count() == 1 and 'on Instagram / Messenger' in gap.inner_text())
        pg.goto(WEB + '/inbox'); pg.wait_for_timeout(2000)
        pg.get_by_label('Channel').select_option('messenger'); pg.get_by_label('Search conversations').fill(run); pg.wait_for_timeout(2500)
        items = pg.get_by_role('list', name='Conversations').get_by_role('listitem')
        items.filter(has_text=M_USER[-4:]).first.click(); pg.wait_for_timeout(1500)
        pg.get_by_role('button', name='Return to AI').click(); pg.wait_for_timeout(1500)
        check('the earlier conversation can now return to the AI; steering offers review mode', sql(f"SELECT aiEnabled FROM Conversation WHERE organizationId='{org}' AND externalId='{M_USER}'") == '1' and pg.get_by_test_id('ai-steering').count() == 1 and pg.get_by_role('button', name='Take over').count() == 1)
        pg.screenshot(path=os.path.join(SHOTS, 'inbox-messenger-ai.png'))

        pg.goto(WEB + '/settings/integrations/meta-social'); pg.wait_for_timeout(2500)
        pg.get_by_role('button', name='Disable integration').click(); pg.wait_for_timeout(2000)
        check('disabling removes the routing', sql(f"SELECT COUNT(*) FROM OrganizationChannel WHERE organizationId='{org}' AND kind IN ('messenger_page_id','instagram_account_id')") == '0')
        time.sleep(1)
        check('no page errors', not errs, '; '.join(errs)[:200])
    finally:
        cust = sql(f"SELECT GROUP_CONCAT(CONCAT('''', customerId, '''')) FROM SocialIdentity WHERE organizationId='{org}' AND externalUserId IN ('{M_USER}','{I_USER}','{A_USER}')")
        sql(f"DELETE FROM Conversation WHERE organizationId='{org}' AND (externalId IN ('{M_USER}','{I_USER}','{A_USER}') OR (channel='instagram_comment' AND externalId LIKE '179{run}%'))")
        if agent_id: sql(f"DELETE FROM VoiceAgent WHERE id='{agent_id}'")
        if kb_id: sql(f"DELETE FROM KnowledgeBase WHERE id='{kb_id}'")
        if cust: sql(f"DELETE FROM Customer WHERE id IN ({cust})")
        sql(f"DELETE FROM OrganizationChannel WHERE organizationId='{org}' AND kind IN ('messenger_page_id','instagram_account_id')")
        sql(f"DELETE FROM IntegrationCredential WHERE organizationId='{org}' AND provider='meta_social'")
    b.close()

print(f"\n{sum(results)}/{len(results)} passed")
raise SystemExit(0 if all(results) else 1)
