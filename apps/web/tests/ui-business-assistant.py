"""
The dashboard assistant in business mode (sidebar chat, voice call, video call), through the real web app, API and
TEST database. The business's own engine answers (here the demo GR Chicken shop: menu, prices and ordering from its
database), for the customer whose mobile number is entered, with that customer's history. Speech provider calls
(/business-assistant/stt and /tts) are MOCKED at the browser's network layer (Sarvam is not reachable from the test
machine); the browser side is real (fake microphone -> recorder -> WAV upload -> transcript -> engine -> spoken reply).

  Needs: API on :3000 (TEST database, DRY_RUN=true), web on :3001, owner@tacksharp.test with the demo workspaces.
  Run:   TEST_DB_NAME=<test db> python3 -I apps/web/tests/ui-business-assistant.py
"""
from playwright.sync_api import sync_playwright
import base64, io, json, math, os, re, struct, subprocess, tempfile, time, wave

WEB, API = 'http://localhost:3001', 'http://localhost:3000'
DB = os.environ.get('TEST_DB_NAME', '')
SHOTS = os.environ.get('SHOTS_DIR', tempfile.gettempdir())
if not DB or DB in ('tacksharp',):
    raise SystemExit('Set TEST_DB_NAME to a TEST database (never production).')
results = []
def check(name, ok, detail=''):
    results.append(bool(ok)); print(('PASS ' if ok else 'FAIL ') + name + (f'  — {detail}' if detail else ''))

def sql(q):
    out = subprocess.run(['mysql', f"-u{os.environ.get('DB_USER', 'root')}", f"-p{os.environ.get('DB_PASSWORD', 'password')}", '-h127.0.0.1', DB, '-N', '-e', q], capture_output=True, text=True)
    if out.returncode: raise RuntimeError(out.stderr)
    return out.stdout.strip()

def tone_wav(seconds=1.0, rate=22050):
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate)
        w.writeframes(b''.join(struct.pack('<h', int(9000 * math.sin(2 * math.pi * 220 * i / rate))) for i in range(int(seconds * rate))))
    return base64.b64encode(buf.getvalue()).decode()

TTS = tone_wav()
PHONE = '96' + str(int(time.time()))[-8:]
ORG = 'org_demo_restaurant'
chats, tts_requests, stt_uploads = [], [], []

with sync_playwright() as p:
    b = p.chromium.launch(args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'])
    ctx = b.new_context(viewport={'width': 1440, 'height': 900}, permissions=['microphone'])
    pg = ctx.new_page(); errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(WEB + '/login'); pg.get_by_label('Email').fill('owner@tacksharp.test'); pg.get_by_label('Password', exact=True).fill('correct-horse-battery')
    pg.get_by_role('button', name='Log in').click(); pg.wait_for_timeout(2500)
    # Through the browser context, so a workspace switch updates the browser's session cookie too.
    def api(path, body=None):
        r = ctx.request.post(API + path, data=body) if body is not None else ctx.request.get(API + path)
        return r.json()
    home = api('/auth/me').get('organizationId')

    # A live non-restaurant workspace: the business assistant explains it runs in a demo workspace; Tara still works.
    pg.get_by_role('button', name=re.compile('Open the AI assistant')).click(); pg.wait_for_timeout(1500)
    dlg = pg.get_by_role('dialog')
    check('live real-estate workspace: business tab explains the demo-only rule', dlg.get_by_text(re.compile('demo workspace')).count() >= 1)
    dlg.get_by_role('tab', name=re.compile('Tacksharp help')).click(); pg.wait_for_timeout(600)
    check('Tacksharp help tab: Tara answers there', dlg.get_by_label('Message Tara').count() == 1)
    pg.get_by_role('button', name='Close assistant').click()

    # Switch into the demo GR Chicken shop.
    api('/auth/workspace', {'organizationId': ORG})
    stock_before = sql(f"SELECT id, COALESCE(stockQty, 'NULL') FROM MenuItem WHERE organizationId='{ORG}'")
    broiler = float(sql(f"SELECT price FROM MenuItem WHERE organizationId='{ORG}' AND name LIKE 'Broiler%' AND available=1 ORDER BY price LIMIT 1") or 0)
    def status(route):
        r = route.fetch(); body = r.json(); body['voice'] = True
        route.fulfill(status=200, content_type='application/json', body=json.dumps(body))
    def chat(route):
        chats.append(json.loads(route.request.post_data or '{}')); route.continue_()
    def stt(route):
        stt_uploads.append(len(route.request.post_data or ''))
        route.fulfill(status=200, content_type='application/json', body=json.dumps({'transcript': 'broiler price evlo?', 'language': 'ta-IN', 'style': 'tanglish'}))
    def tts(route):
        tts_requests.append(json.loads(route.request.post_data or '{}'))
        route.fulfill(status=200, content_type='application/json', body=json.dumps({'audioBase64': TTS, 'cached': False, 'language': 'ta-IN'}))
    pg.route('**/business-assistant/status*', status); pg.route('**/business-assistant/chat', chat)
    pg.route('**/business-assistant/stt', stt); pg.route('**/business-assistant/tts', tts)
    pg.goto(WEB + '/'); pg.wait_for_timeout(2500)
    pg.get_by_role('button', name=re.compile('Open the AI assistant')).click(); pg.wait_for_timeout(1800)
    dlg = pg.get_by_role('dialog', name=re.compile('assistant'))
    check('business tab selected, named after the shop', dlg.get_by_role('tab', selected=True).filter(has_text=re.compile('GR Chicken')).count() == 1)
    check('header names the shop assistant', dlg.locator('header').get_by_text(re.compile('GR Chicken.*assistant')).count() >= 1)
    box = dlg.bounding_box(); vw, vh = 1440, 900
    check('docked as a right sidebar, full height (not over the middle of the dashboard)', box and abs(box['x'] + box['width'] - vw) <= 1 and box['y'] <= 1 and box['height'] >= vh - 1 and box['width'] <= 420, str(box))
    check('the dashboard makes room for it', pg.evaluate("getComputedStyle(document.body).paddingRight") == '400px' and pg.locator('main').bounding_box()['x'] + pg.locator('main').bounding_box()['width'] <= box['x'] + 1)
    check('shows which phone voice it speaks with', dlg.get_by_test_id('assistant-voice').count() == 1 and 'pace' in dlg.get_by_test_id('assistant-voice').inner_text(), dlg.get_by_test_id('assistant-voice').inner_text() if dlg.get_by_test_id('assistant-voice').count() else '')
    # Voice replies off for the typed part (the spoken part is tested below).
    dlg.get_by_role('button', name='Mute voice replies').click()

    # No customer number yet: asked for first.
    dlg.get_by_label(re.compile('Message .*assistant')).fill('Hi'); dlg.get_by_role('button', name='Send', exact=True).click(); pg.wait_for_timeout(500)
    check('asks for the customer number before answering', dlg.get_by_text(re.compile('mobile number first')).count() == 1 and not chats)
    dlg.get_by_label('Customer mobile number').fill(PHONE); dlg.get_by_label('Customer name (optional)').fill('UI Tester')
    dlg.get_by_label('Customer name (optional)').press('Tab'); pg.wait_for_timeout(800)
    check('memory: a new number is a new customer', dlg.get_by_test_id('assistant-memory').inner_text().startswith('New customer'))

    def say(text, wait=3500):
        dlg.get_by_label(re.compile('Message .*assistant')).fill(text); dlg.get_by_role('button', name='Send', exact=True).click(); pg.wait_for_timeout(wait)
        return dlg.locator('ol li').last.inner_text()
    r = say('broiler price evlo?')
    check('price comes from the shop database', broiler > 0 and (f'{int(broiler)}' in r), f'menu {broiler}: {r[:140]}')
    r = say('rendu kilo broiler curry cut, cash, 2 mani nerathula varen')
    check('order summary with the backend total', f'{int(broiler * 2)}' in r, r[:160])
    say('sari', 4000)
    card = dlg.get_by_test_id('assistant-order')
    check('confirmed: order card shown', card.count() == 1, card.first.inner_text() if card.count() else '')
    number = re.search(r'([A-Z]+-[A-Z0-9]+)', card.first.inner_text()).group(1) if card.count() else ''
    row = sql(f"SELECT o.channel FROM `Order` o JOIN Customer c ON c.id=o.customerId WHERE o.organizationId='{ORG}' AND o.orderNumber='{number}' AND c.phone='91{PHONE[-10:]}'") if number else ''
    check('the order is in the database for this customer (test channel)', row == 'test', row)
    pg.wait_for_timeout(800)
    mem = dlg.get_by_test_id('assistant-memory').inner_text()
    check('memory: the customer now shows the order', 'UI Tester' in mem and '1 order' in mem and number in mem, mem)
    check('chat turns were sent as text (spoken: false) with the customer number', all(c.get('phone') == PHONE and c.get('spoken') is False for c in chats))
    pg.screenshot(path=os.path.join(SHOTS, 'business-assistant-chat.png'))

    # Voice call: same customer, same engine, spoken wording.
    dlg.get_by_role('button', name='Turn on voice replies').click()
    n_chats = len(chats)
    dlg.get_by_role('button', name='Voice call').click(); pg.wait_for_timeout(1000)
    check('voice: the call is listening', pg.get_by_text('Listening…').count() >= 1)
    # The fake microphone never goes quiet: end the turn with the mic button, as a caller tapping "send" would.
    stop = dlg.get_by_role('button', name=re.compile('Stop and send'))
    if stop.count(): stop.click()
    pg.wait_for_timeout(6000)
    voice_turns = chats[n_chats:]
    check('voice: the microphone recording went to the business speech endpoint', len(stt_uploads) >= 1)
    check('voice: the turn reached the business engine as spoken', any(c.get('spoken') is True and c.get('phone') == PHONE for c in voice_turns), json.dumps(voice_turns)[:160])
    check('voice: the reply was spoken through the business voice endpoint', len(tts_requests) >= 1)
    dlg.get_by_role('button', name='Chat', exact=True).click(); pg.wait_for_timeout(500)
    pg.screenshot(path=os.path.join(SHOTS, 'business-assistant-voice.png'))
    pg.get_by_role('button', name='Close assistant').click(); pg.wait_for_timeout(400)
    check('closing gives the dashboard its full width back', pg.evaluate("getComputedStyle(document.body).paddingRight") in ('0px', ''))
    check('no page errors', not errs, '; '.join(errs)[:200])

    # Clean up this run's test customer and order (TEST database only).
    if number:
        sql(f"DELETE oi FROM OrderItem oi JOIN `Order` o ON o.id=oi.orderId WHERE o.organizationId='{ORG}' AND o.orderNumber='{number}'")
        sql(f"DELETE FROM `Order` WHERE organizationId='{ORG}' AND orderNumber='{number}'")
    for line in stock_before.splitlines():
        item, qty = line.split('\t')
        sql(f"UPDATE MenuItem SET stockQty={qty} WHERE id='{item}' AND organizationId='{ORG}'")
    api('/auth/workspace', {'organizationId': home})
    b.close()

print(f"\n{sum(results)}/{len(results)} passed")
raise SystemExit(0 if all(results) else 1)
