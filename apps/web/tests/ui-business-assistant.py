"""
The dashboard AI assistant (business mode): a centred workspace over the dimmed dashboard, with chat through the
business's own engine (menu, prices, ordering, the customer's history) and live voice calls through Sarvam's official
web SDK to the business's own phone agent. Real web app, API and TEST database. Sarvam itself is not reachable from the
test machine, so its two network edges are MOCKED in the browser: the signed-URL answer and the agent's WebSocket
(Playwright routeWebSocket, speaking the SDK's documented message types). Everything else is real: the API's ticket,
the SDK, the microphone (Chrome's fake device), the transcript and saving the call on the customer.

  Needs: API on :3000 (TEST database, DRY_RUN=true, Sarvam calling placeholders + TELEPHONY_WEBHOOK_SECRET),
         web on :3001, owner@tacksharp.test with the demo workspaces.
  Run:   TEST_DB_NAME=<test db> python3 -I apps/web/tests/ui-business-assistant.py
"""
from playwright.sync_api import sync_playwright
import base64, json, math, os, re, struct, subprocess, tempfile, time

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

def pcm_b64(seconds=0.6, rate=22050):
    return base64.b64encode(b''.join(struct.pack('<h', int(8000 * math.sin(2 * math.pi * 240 * i / rate))) for i in range(int(seconds * rate)))).decode()

PHONE = '96' + str(int(time.time()))[-8:]
ORG = 'org_demo_restaurant'
AGENT = 'ui_ba_phone_agent'
ws_sent, saved, ws_urls = [], [], []

sql(f"DELETE FROM VoiceAgent WHERE id='{AGENT}'")
sql(f"""INSERT INTO VoiceAgent (id, organizationId, name, industry, instructions, languages, greeting, fallbackMessage, status, telephonyProvider, sarvamAppId, sarvamAppVersion, createdAt, updatedAt)
        VALUES ('{AGENT}', '{ORG}', 'GR Phone Agent', 'restaurant', 'x', '["ta","en"]', 'Vanakkam! GR Chicken pesuren.', 'x', 'active', 'sarvam', 'GR-ui-app', 3, NOW(), NOW())""")
stock_before = sql(f"SELECT id, COALESCE(stockQty, 'NULL') FROM MenuItem WHERE organizationId='{ORG}'")

def sarvam_ws(ws):
    """The Sarvam agent, as the SDK sees it: connected ack, a spoken greeting, then an answer to the caller."""
    state = {'heard': 0, 'answered': False}
    ws_urls.append(ws.url)
    def say(role, text):
        ws.send(json.dumps({'type': 'server.event.transcription', 'role': role, 'content': text}))
    def speak(text):
        say('bot', text)
        ws.send(json.dumps({'type': 'server.media.audio_chunk', 'audio_base64': pcm_b64(), 'format': 'audio/wav', 'sample_rate': 22050, 'status': 'pending'}))
        ws.send(json.dumps({'type': 'server.media.audio_chunk', 'audio_base64': '', 'format': 'audio/wav', 'status': 'completed'}))
    def on_message(m):
        msg = json.loads(m)
        ws_sent.append(msg.get('type'))
        if msg.get('type') == 'client.action.interaction_start':
            ws_sent.append(msg)
            ws.send(json.dumps({'type': 'server.action.interaction_connected', 'interaction_id': 'ui-int-' + PHONE}))
            speak('Vanakkam! GR Chicken pesuren. Enna venum?')
        elif msg.get('type') == 'client.media.audio_chunk':
            state['heard'] += 1
            if state['heard'] == 40 and not state['answered']:
                state['answered'] = True
                say('user', 'broiler price evlo?')
                speak('Broiler chicken kilo 220 rupees.')
    ws.on_message(on_message)

with sync_playwright() as p:
    b = p.chromium.launch(args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'])
    ctx = b.new_context(viewport={'width': 1440, 'height': 900}, permissions=['microphone'])
    pg = ctx.new_page(); errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(WEB + '/login'); pg.get_by_label('Email').fill('owner@tacksharp.test'); pg.get_by_label('Password', exact=True).fill('correct-horse-battery')
    pg.get_by_role('button', name='Log in').click(); pg.wait_for_timeout(2500)
    def api(path, body=None):
        r = ctx.request.post(API + path, data=body) if body is not None else ctx.request.get(API + path)
        return r.json()
    home = api('/auth/me').get('organizationId')

    # A live real-estate workspace (assistant not available): the dashboard keeps Tara.
    check('live non-restaurant workspace: Tara is offered instead', pg.get_by_role('button', name=re.compile('Chat or talk with Tara')).count() == 1)

    api('/auth/workspace', {'organizationId': ORG})
    broiler = float(sql(f"SELECT price FROM MenuItem WHERE organizationId='{ORG}' AND name LIKE 'Broiler%' AND available=1 ORDER BY price LIMIT 1") or 0)
    # Sarvam's edges (see docstring). The API still issues the real ticket; the signed-URL answer and the socket are mocked.
    runtime_hits = []
    def runtime(route):
        runtime_hits.append({'url': route.request.url, 'ticket': route.request.headers.get('x-assistant-ticket', '')})
        route.fulfill(status=200, content_type='application/json', headers={'access-control-allow-origin': WEB, 'access-control-allow-credentials': 'true'}, body=json.dumps({'url': 'wss://sarvam.mock/ws?sig=1', 'reference_id': 'ref-ui'}))
    pg.route('**/business-assistant/live/runtime/**', runtime)
    pg.route_web_socket(re.compile(r'wss://sarvam\.mock/.*'), sarvam_ws)
    def transcript(route):
        saved.append(json.loads(route.request.post_data or '{}')); route.continue_()
    pg.route('**/business-assistant/live/transcript', transcript)
    pushes = []
    pg.on('request', lambda r: pushes.append(json.loads(r.post_data or '{}')) if '/business-assistant/live/lines' in r.url else None)
    # Video: this test API has no Simli key, so the presenter is switched on in the status answer and the session
    # token is mocked; the avatar is a stand-in that records the audio it is given (the real one lip-syncs it).
    def status_video(route):
        r = route.fetch(); body = r.json(); body['video'] = True
        route.fulfill(status=200, content_type='application/json', body=json.dumps(body))
    pg.route('**/business-assistant/status*', status_video)
    video_tokens = []
    def video_session(route):
        video_tokens.append(1); route.fulfill(status=200, content_type='application/json', body=json.dumps({'sessionToken': 'tok-video'}))
    pg.route('**/business-assistant/video/session', video_session)
    pg.add_init_script('''
      window.__V__ = { starts: 0, bytes: 0, cleared: 0 };
      window.__TARA_SIMLI__ = (token, video, audio) => {
        const h = {};
        return {
          on: (ev, cb) => { h[ev] = cb; },
          start: async () => { window.__V__.starts++; window.__V__.token = token; const c = document.createElement('canvas'); c.width = 64; c.height = 64; c.getContext('2d').fillRect(0, 0, 64, 64); video.srcObject = c.captureStream(5); },
          stop: async () => {},
          sendAudioData: (d) => { window.__V__.bytes += d.length; },
          ClearBuffer: () => { window.__V__.cleared++; },
        };
      };''')

    pg.goto(WEB + '/'); pg.wait_for_timeout(2500)
    pg.get_by_role('button', name='Open the AI assistant').click(); pg.wait_for_timeout(1500)
    dlg = pg.get_by_role('dialog', name=re.compile('assistant'))
    box = dlg.bounding_box()
    cx_, cy_ = box['x'] + box['width'] / 2, box['y'] + box['height'] / 2
    check('opens centred on the screen', abs(cx_ - 720) <= 2 and abs(cy_ - 450) <= 2 and box['width'] >= 1000, str(box))
    bd = pg.get_by_test_id('assistant-backdrop').bounding_box()
    check('the rest of the dashboard is dimmed behind it', bd and bd['width'] >= 1440 and bd['height'] >= 900 and pg.evaluate('getComputedStyle(document.body).overflow') == 'hidden')
    check('header names the shop and its phone agent', dlg.get_by_text(re.compile('GR Phone Agent')).count() >= 1)
    check('greeting is the phone agent\'s own opening line', dlg.get_by_text('Vanakkam! GR Chicken pesuren.').count() >= 1)
    pg.screenshot(path=os.path.join(SHOTS, 'business-assistant-open.png'))

    # Customer first.
    dlg.get_by_role('button', name='Voice call').click(); pg.wait_for_timeout(400)
    check('asks for the customer number before a call', dlg.get_by_text(re.compile('mobile number first')).count() == 1 and not runtime_hits)
    dlg.get_by_label('Customer mobile number').fill(PHONE); dlg.get_by_label('Customer name (optional)').fill('UI Tester')
    dlg.get_by_label('Customer name (optional)').press('Tab'); pg.wait_for_timeout(800)
    check('memory: a new number is a new customer', 'New customer' in dlg.get_by_test_id('assistant-memory').inner_text())

    # Chat: the business engine, grounded in the shop database, with a real order.
    def say(text, wait=3500):
        dlg.get_by_label('Message the assistant').fill(text); dlg.get_by_role('button', name='Send', exact=True).click(); pg.wait_for_timeout(wait)
        return dlg.locator('ol li').last.inner_text()
    r = say('broiler price evlo?')
    check('chat: price comes from the shop database', broiler > 0 and f'{int(broiler)}' in r, r[:120])
    # The Orders page open in another tab: it must show the new order at once (not at its next 8 s poll).
    pg2 = ctx.new_page(); pg2.goto(WEB + '/orders'); pg2.wait_for_timeout(3500)
    say('rendu kilo broiler curry cut, cash, 2 mani nerathula varen')
    say('sari', 600)
    card = dlg.get_by_test_id('assistant-order')
    num0 = re.search(r'([A-Z]+-[A-Z0-9]+)', card.first.inner_text()).group(1) if card.count() else 'none'
    t0 = time.time()
    while time.time() - t0 < 3 and pg2.get_by_text(num0).count() == 0: pg2.wait_for_timeout(200)
    check('live: the Orders page in another tab shows the new order within 3 s', pg2.get_by_text(num0).count() >= 1, f'{num0} after {time.time() - t0:.1f}s')
    pg2.close(); pg.wait_for_timeout(2500)
    check('chat: confirmed order card', card.count() == 1, card.first.inner_text() if card.count() else '')
    number = re.search(r'([A-Z]+-[A-Z0-9]+)', card.first.inner_text()).group(1) if card.count() else ''
    pg.wait_for_timeout(600)
    mem = dlg.get_by_test_id('assistant-memory').inner_text()
    check('memory: the customer now shows the order', 'UI Tester' in mem and '1 order' in mem and number in mem, mem.replace('\n', ' | '))

    # The order on its own page (like a web order), with the WhatsApp confirmation to the customer or another number.
    oid = sql(f"SELECT id FROM `Order` WHERE organizationId='{ORG}' AND orderNumber='{number}'") if number else ''
    pg3 = ctx.new_page(); pg3.goto(f'{WEB}/orders/{oid}'); pg3.wait_for_timeout(2500)
    check('order page: its own page with items, customer and total', pg3.get_by_role('heading', name=re.compile(number)).count() >= 1 and pg3.get_by_text('To cut & pack').count() == 1 and pg3.get_by_text('AI assistant').count() >= 1)
    sc = pg3.get_by_test_id('send-confirmation')
    sc.get_by_role('button', name='Send to customer').click(); pg3.wait_for_timeout(1500)
    check('order page: confirmation to the customer (test mode: simulated, recorded)', sc.get_by_role('status').count() == 1 and 'simulated' in sc.get_by_role('status').inner_text(), sc.get_by_role('status').inner_text() if sc.get_by_role('status').count() else '')
    sc.get_by_label('Another WhatsApp number').fill('9876512345'); sc.get_by_role('button', name='Send', exact=True).click(); pg3.wait_for_timeout(1500)
    check('order page: confirmation to another number', 'another number' in sc.get_by_role('status').inner_text())
    pg3.screenshot(path=os.path.join(SHOTS, 'order-page.png')); pg3.close()

    # Live voice call: the business's Sarvam phone agent through the official SDK.
    dlg.get_by_role('button', name='Voice call').click()
    pg.wait_for_timeout(6000)
    check('call: our API issued the ticket and the SDK asked for the signed URL with it', len(runtime_hits) == 1 and '/apps/GR-ui-app/url' in runtime_hits[0]['url'] and re.match(r'^\d+\.[0-9a-f]{64}$', runtime_hits[0]['ticket'] or ''), json.dumps(runtime_hits)[:200])
    wsu = ws_urls[0] if ws_urls else ''
    check('call: the agent is told who is calling (customer number, as on a phone call) and which agent version', f'user_identifier=%2B91{PHONE[-10:]}' in wsu and 'user_identifier_type=phone_number' in wsu and 'interaction_type=call' in wsu and 'version=3' in (runtime_hits[0]['url'] if runtime_hits else ''), wsu[:200])
    check('call: microphone audio streams to the agent', ws_sent.count('client.media.audio_chunk') >= 40, str(ws_sent.count('client.media.audio_chunk')))
    texts = dlg.locator('ol li').all_inner_texts()
    check('call: the spoken conversation appears as it happens', any('Enna venum' in t for t in texts) and any('broiler price evlo?' in t for t in texts[-3:]) and any('220 rupees' in t for t in texts[-2:]), ' | '.join(texts[-3:])[:200])
    # The agent places an order during the call (its tool writes it to the database; here the same customer's order is
    # created through the API): it appears in the conversation within seconds, without ending the call.
    for m in ('rendu kilo broiler curry cut, cash, 2 mani nerathula varen', 'sari'):
        ctx.request.post(API + '/business-assistant/chat', data={'phone': PHONE, 'message': m})
    t0 = time.time()
    while time.time() - t0 < 5 and dlg.get_by_text('Order saved from this call.').count() == 0: pg.wait_for_timeout(200)
    check('live: an order saved during the call appears in the conversation right away', dlg.get_by_text('Order saved from this call.').count() == 1 and dlg.get_by_test_id('assistant-order').count() == 2, f'after {time.time() - t0:.1f}s')
    state = dlg.get_by_test_id('call-state').inner_text()
    check('call: the caller\'s words reach our server during the call (the order tools read them)', any(any('broiler price evlo?' in (l.get('content') or '') for l in p.get('lines', [])) for p in pushes) and all(p.get('interactionId') for p in pushes), f'{len(pushes)} pushes')
    check('call: live state and timer shown', re.search(r'(Listening|Speaking) · 00:[01]\d', state) is not None, state)
    pg.screenshot(path=os.path.join(SHOTS, 'business-assistant-call.png'))
    dlg.get_by_role('button', name='End call').click(); pg.wait_for_timeout(2000)
    check('end call: the call and its transcript are saved on the customer', len(saved) == 1 and saved[0].get('phone') == PHONE and len(saved[0].get('lines', [])) >= 3)
    row = sql(f"SELECT COUNT(*) FROM `Call` WHERE organizationId='{ORG}' AND fromNumber='91{PHONE[-10:]}' AND provider='sarvam'")
    check('end call: it is in AI voice calls', row == '1', row)
    check('end call: memory now lists the voice channel', 'voice' in dlg.get_by_test_id('assistant-memory').inner_text())
    # Video call: the same live phone agent; its voice drives the avatar.
    dlg.get_by_role('button', name='Video call').click(); pg.wait_for_timeout(5000)
    v = pg.evaluate('window.__V__')
    check('video: our server minted the avatar session for this business', len(video_tokens) == 1 and v.get('token') == 'tok-video', json.dumps(v))
    check('video: the phone agent\'s audio drives the avatar (PCM 16 kHz)', v.get('bytes', 0) > 1000 and 'output_sample_rate=16000' in (ws_urls[-1] if ws_urls else ''), f"{v.get('bytes')} bytes; {(ws_urls[-1] if ws_urls else '')[-60:]}")
    vb = dlg.get_by_label(re.compile('video assistant')).bounding_box()
    check('video: the avatar is shown square (768 x 768 stream, not squashed)', vb and abs(vb['width'] - vb['height']) <= 2, str(vb))
    pg.screenshot(path=os.path.join(SHOTS, 'business-assistant-video.png'))
    bubbles = dlg.locator('ol li').all_inner_texts()
    check('video: the order card stays its own message (the next call\'s words never join it)', not any('Order GR-' in b and 'Enna venum' in b for b in bubbles), ' | '.join(b[:40] for b in bubbles[-4:]))
    dlg.get_by_role('button', name='End call').click(); pg.wait_for_timeout(1500)

    # Tacksharp help: product questions, separate from the customer conversation.
    n_shop = len(dlg.locator('ol li').all())
    dlg.get_by_role('tab', name='Tacksharp help').click(); pg.wait_for_timeout(1200)
    dlg.get_by_label('Message the assistant').fill('What does it cost?'); dlg.get_by_role('button', name='Send', exact=True).click(); pg.wait_for_timeout(2500)
    items = dlg.locator('ol li').all_inner_texts()
    check('help tab: answers product questions in its own conversation', len(items) >= 3 and 'What does it cost?' in items[-2] and len(items[-1]) > 20 and dlg.get_by_test_id('assistant-customer').count() == 0, (items[-1] if items else '')[:120])
    dlg.get_by_role('tab', name=re.compile('assistant')).click(); pg.wait_for_timeout(500)
    check('back on the shop tab: the customer conversation is still there', len(dlg.locator('ol li').all()) == n_shop and dlg.get_by_test_id('assistant-order').count() >= 2, f"{len(dlg.locator('ol li').all())} vs {n_shop}")

    check('no page errors', not errs, '; '.join(errs)[:200])
    pg.get_by_role('button', name='Close assistant').click(); pg.wait_for_timeout(400)
    check('closing restores the dashboard', pg.get_by_role('dialog').count() == 0 and pg.evaluate('getComputedStyle(document.body).overflow') != 'hidden')

    # Clean up this run (TEST database only).
    cust = sql(f"SELECT id FROM Customer WHERE organizationId='{ORG}' AND phone='91{PHONE[-10:]}'")
    if cust:
        sql(f"DELETE oi FROM OrderItem oi JOIN `Order` o ON o.id=oi.orderId WHERE o.organizationId='{ORG}' AND o.customerId='{cust}'")
        sql(f"DELETE FROM `Order` WHERE organizationId='{ORG}' AND customerId='{cust}'")
        sql(f"DELETE FROM `Call` WHERE organizationId='{ORG}' AND customerId='{cust}'")
    for line in stock_before.splitlines():
        item, qty = line.split('\t')
        sql(f"UPDATE MenuItem SET stockQty={qty} WHERE id='{item}' AND organizationId='{ORG}'")
    sql(f"DELETE FROM VoiceAgent WHERE id='{AGENT}'")
    api('/auth/workspace', {'organizationId': home})
    b.close()

print(f"\n{sum(results)}/{len(results)} passed")
raise SystemExit(0 if all(results) else 1)
