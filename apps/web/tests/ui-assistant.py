"""
Tara, the website / dashboard assistant, through the real web app and API (chat answers come from the API's
website FAQ when no model key is set). Speech provider calls (/assistant/stt, /assistant/tts) are MOCKED at the
browser's network layer because Sarvam is not reachable from the test machine; the browser side is real: Chrome's
fake microphone feeds the recorder, the silence detector ends the turn, the WAV encoder builds the upload, and the
returned audio is decoded and played through the analyser that moves the avatar's mouth.

  Needs: API on :3000, web on :3001.
  Run:   python3 -I apps/web/tests/ui-assistant.py
"""
from playwright.sync_api import sync_playwright
import base64, io, json, math, os, re, struct, tempfile, wave

WEB = 'http://localhost:3001'
SHOTS = os.environ.get('SHOTS_DIR', tempfile.gettempdir())
results = []
def check(name, ok, detail=''):
    results.append(bool(ok)); print(('PASS ' if ok else 'FAIL ') + name + (f'  — {detail}' if detail else ''))

def tone_wav(seconds=1.2, rate=22050):
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate)
        w.writeframes(b''.join(struct.pack('<h', int(9000 * math.sin(2 * math.pi * 220 * i / rate) * (0.5 + 0.5 * math.sin(2 * math.pi * 3 * i / rate)))) for i in range(int(seconds * rate))))
    return base64.b64encode(buf.getvalue()).decode()

TTS = tone_wav()
stt_uploads, tts_requests = [], []

with sync_playwright() as p:
    b = p.chromium.launch(args=['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'])
    for vp, label in (({'width': 1440, 'height': 900}, 'desktop'), ({'width': 390, 'height': 844}, 'phone')):
        ctx = b.new_context(viewport=vp, permissions=['microphone'])
        pg = ctx.new_page(); errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        # Voice provider mocked (see docstring); chat goes to the real API.
        def status(route):
            r = route.fetch(); body = r.json(); body['voice'] = True
            route.fulfill(status=200, content_type='application/json', body=json.dumps(body))
        def stt(route):
            data = json.loads(route.request.post_data or '{}'); raw = base64.b64decode(data.get('audioBase64', ''))
            stt_uploads.append(raw)
            route.fulfill(status=200, content_type='application/json', body=json.dumps({'transcript': 'WhatsApp assistant epdi work aagum?', 'language': 'ta-IN', 'style': 'tanglish'}))
        def tts(route):
            tts_requests.append(json.loads(route.request.post_data or '{}'))
            route.fulfill(status=200, content_type='application/json', body=json.dumps({'audioBase64': TTS, 'cached': False, 'language': 'ta-IN'}))
        pg.route('**/assistant/status*', status); pg.route('**/assistant/stt', stt); pg.route('**/assistant/tts', tts)

        pg.goto(WEB + '/welcome'); pg.wait_for_timeout(1500)
        btn = pg.get_by_role('button', name=re.compile('Chat or talk with Tara'))
        check(f'{label}: floating "Ask Tara" button on the website', btn.is_visible())
        btn.click(); pg.wait_for_timeout(1200)
        dlg = pg.get_by_role('dialog', name=re.compile('Tara'))
        check(f'{label}: assistant opens with a greeting and quick questions', dlg.is_visible() and dlg.get_by_text(re.compile('Tara')).count() > 0 and dlg.get_by_role('button', name=re.compile('What does it cost')).count() == 1)
        if label == 'phone':
            box = dlg.bounding_box()
            check('phone: assistant fills the screen (no horizontal scroll)', box and box['width'] >= 389 and pg.evaluate('document.scrollingElement.scrollWidth - window.innerWidth') <= 1)
            ctx.close(); continue

        # Typed question in Tanglish -> Tanglish answer from the website facts, spoken sentence by sentence
        dlg.get_by_role('radio', name='Tanglish').click()
        dlg.get_by_label('Message Tara').fill('Price evlo?'); dlg.get_by_role('button', name='Send').click()
        pg.wait_for_timeout(600)
        mouth_moved = False
        for _ in range(20):
            pg.wait_for_timeout(100)
            if pg.get_by_text('Speaking…').count():
                rys = set(pg.evaluate("() => [...document.querySelectorAll('[role=dialog] header svg ellipse')].map(e => e.getAttribute('ry')).slice(-1)[0]") for _ in range(6))
                mouth_moved = mouth_moved or len(rys) > 1
        check('chat: Tanglish answer grounded in the website (plans, no invented price)', dlg.get_by_text(re.compile('Pilot, Growth, Enterprise nu')).count() == 1)
        check('voice out: the reply is spoken sentence by sentence in the Tanglish voice', len(tts_requests) >= 1 and tts_requests[0].get('style') == 'tanglish', json.dumps(tts_requests[:1])[:120])
        check('avatar: shows "Speaking…" and its mouth follows the audio', mouth_moved)
        pg.wait_for_timeout(4000)
        pg.screenshot(path=os.path.join(SHOTS, 'assistant-chat.png'))

        # Voice question: fake mic -> recorder -> silence detection -> WAV upload -> transcript -> answer
        before = len(dlg.locator('li').all())
        dlg.get_by_role('button', name='Speak your question').click()
        pg.wait_for_timeout(800)
        check('voice in: listening state shown', pg.get_by_text('Listening…').count() == 1 or len(stt_uploads) > 0)
        dlg.get_by_role('button', name=re.compile('Stop and send')).click() if dlg.get_by_role('button', name=re.compile('Stop and send')).count() else None
        pg.wait_for_timeout(3500)
        up = stt_uploads[-1] if stt_uploads else b''
        check('voice in: a 16 kHz mono WAV was uploaded for recognition', up[:4] == b'RIFF' and struct.unpack('<I', up[24:28])[0] == 16000 and struct.unpack('<H', up[22:24])[0] == 1, f'{len(up)} bytes')
        check('voice in: the recognised question appears and gets an answer', dlg.get_by_text('WhatsApp assistant epdi work aagum?').count() == 1 and len(dlg.locator('li').all()) >= before + 2)

        # Language switch and mute
        dlg.get_by_role('radio', name='தமிழ்').click(); pg.wait_for_timeout(300)
        n = len(tts_requests)
        dlg.get_by_role('button', name='Mute voice replies').click()
        dlg.get_by_label('Message Tara').fill('விலை எவ்வளவு?'); dlg.get_by_role('button', name='Send').click(); pg.wait_for_timeout(1500)
        check('Tamil: answer in Tamil script', dlg.get_by_text(re.compile('மூன்று plans')).count() == 1)
        check('mute: no speech requested while muted', len(tts_requests) == n)
        dlg.get_by_role('button', name='Close assistant').click(); pg.wait_for_timeout(300)
        check('close: the assistant closes back to the button', pg.get_by_role('button', name=re.compile('Chat or talk with Tara')).is_visible())
        check('no page errors (desktop)', not errs, '; '.join(errs)[:200])
        ctx.close()

    # Dashboard: the assistant is there for signed-in users too
    ctx = b.new_context(viewport={'width': 1440, 'height': 900}); pg = ctx.new_page()
    pg.goto(WEB + '/login'); pg.get_by_label('Email').fill('owner@tacksharp.test'); pg.get_by_label('Password', exact=True).fill('correct-horse-battery')
    pg.get_by_role('button', name='Log in').click(); pg.wait_for_timeout(3000)
    check('dashboard: Ask Tara button present for signed-in users', pg.get_by_role('button', name=re.compile('Chat or talk with Tara')).is_visible())
    ctx.close()
    b.close()

print(f"\n{sum(results)}/{len(results)} passed")
raise SystemExit(0 if all(results) else 1)
