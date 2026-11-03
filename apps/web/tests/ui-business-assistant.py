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
    say('rendu kilo broiler curry cut, cash, 2 mani nerathula varen')
    say('sari', 4000)
    card = dlg.get_by_test_id('assistant-order')
    check('chat: confirmed order card', card.count() == 1, card.first.inner_text() if card.count() else '')
    number = re.search(r'([A-Z]+-[A-Z0-9]+)', card.first.inner_text()).group(1) if card.count() else ''
    pg.wait_for_timeout(600)
    mem = dlg.get_by_test_id('assistant-memory').inner_text()
    check('memory: the customer now shows the order', 'UI Tester' in mem and '1 order' in mem and number in mem, mem.replace('\n', ' | '))

    # Live voice call: the business's Sarvam phone agent through the official SDK.
    dlg.get_by_role('button', name='Voice call').click()
    pg.wait_for_timeout(6000)
    check('call: our API issued the ticket and the SDK asked for the signed URL with it', len(runtime_hits) == 1 and '/apps/GR-ui-app/url' in runtime_hits[0]['url'] and re.match(r'^\d+\.[0-9a-f]{64}$', runtime_hits[0]['ticket'] or ''), json.dumps(runtime_hits)[:200])
    wsu = ws_urls[0] if ws_urls else ''
    check('call: the agent is told who is calling (customer number, as on a phone call) and which agent version', f'user_identifier=%2B91{PHONE[-10:]}' in wsu and 'user_identifier_type=phone_number' in wsu and 'interaction_type=call' in wsu and 'version=3' in (runtime_hits[0]['url'] if runtime_hits else ''), wsu[:200])
    check('call: microphone audio streams to the agent', ws_sent.count('client.media.audio_chunk') >= 40, str(ws_sent.count('client.media.audio_chunk')))
    texts = dlg.locator('ol li').all_inner_texts()
    check('call: the spoken conversation appears as it happens', any('Enna venum' in t for t in texts) and any('broiler price evlo?' in t for t in texts[-3:]) and any('220 rupees' in t for t in texts[-2:]), ' | '.join(texts[-3:])[:200])
    state = dlg.get_by_test_id('call-state').inner_text()
    check('call: live state and timer shown', re.search(r'(Listening|Speaking) · 00:0\d', state) is not None, state)
    pg.screenshot(path=os.path.join(SHOTS, 'business-assistant-call.png'))
    dlg.get_by_role('button', name='End call').click(); pg.wait_for_timeout(2000)
    check('end call: the call and its transcript are saved on the customer', len(saved) == 1 and saved[0].get('phone') == PHONE and len(saved[0].get('lines', [])) >= 3)
    row = sql(f"SELECT COUNT(*) FROM `Call` WHERE organizationId='{ORG}' AND fromNumber='91{PHONE[-10:]}' AND provider='sarvam'")
    check('end call: it is in AI voice calls', row == '1', row)
    check('end call: memory now lists the voice channel', 'voice' in dlg.get_by_test_id('assistant-memory').inner_text())
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
