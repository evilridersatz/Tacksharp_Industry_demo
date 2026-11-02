"""
Unified inbox indicators for multimodal WhatsApp messages (voice note, image, document, AI voice reply), through the
real dashboard + API + MySQL (TEST database only). The messages are inserted as the worker stores them (metadata.media);
nothing reaches WhatsApp or Sarvam.

  Needs: API on :3000 and web on :3001 against the test DB; owner@tacksharp.test.
  Run:   TEST_DB_NAME=tacksharp_test python3 -I apps/web/tests/ui-multimodal.py
"""
from playwright.sync_api import sync_playwright
import json, os, re, subprocess, tempfile, time, uuid

WEB, API = 'http://localhost:3001', 'http://localhost:3000'
SHOTS = os.environ.get('SHOTS_DIR', tempfile.gettempdir())
DB = os.environ.get('TEST_DB_NAME', 'tacksharp_test')
def sql(q):
    return subprocess.run(['mysql', '-h127.0.0.1', f"-u{os.environ.get('DB_USER', 'root')}", f"-p{os.environ.get('DB_PASSWORD', '')}", DB, '-N', '-e', q], capture_output=True, text=True).stdout.strip()
def esc(s): return s.replace('\\', '\\\\').replace("'", "\\'")

results = []
def check(name, ok, detail=''):
    results.append(bool(ok)); print(('PASS ' if ok else 'FAIL ') + name + (f'  — {detail}' if detail else ''))

run = str(int(time.time()))[-6:]
conv = f'mm-ui-{run}'
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page(viewport={'width': 1440, 'height': 950})
    errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(WEB + '/login'); pg.get_by_label('Email').fill('owner@tacksharp.test'); pg.get_by_label('Password', exact=True).fill('correct-horse-battery')
    pg.get_by_role('button', name='Log in').click(); pg.wait_for_timeout(2500)
    org = pg.evaluate("async (u) => (await (await fetch(u, { credentials: 'include' })).json()).organizationId", API + '/auth/me')
    phone = '9195' + run + '11'
    sql(f"INSERT INTO Conversation (id, organizationId, channel, externalId, status, updatedAt) VALUES ('{conv}', '{org}', 'whatsapp', '{phone}', 'active', NOW(3))")
    msgs = [
        ('user', 'rendu kilo broiler curry cut venum', {'waMessageId': 'w1', 'viaVoiceNote': True, 'media': {'messageType': 'voice', 'mimeType': 'audio/ogg', 'sizeBytes': 9000, 'processing': 'ok', 'transcription': 'rendu kilo broiler curry cut venum', 'durationSec': 4.2}}),
        ('assistant', 'Payment eppadi pannuveenga?', {'path': 'rules'}),
        ('assistant', 'Payment eppadi pannuveenga?', {'media': {'messageType': 'voice', 'generated': True, 'provider': 'sarvam', 'processing': 'ok'}}),
        ('user', '[Image] idhu irukka?', {'media': {'messageType': 'image', 'mimeType': 'image/jpeg', 'processing': 'weak', 'reason': 'low_confidence', 'vision': {'kind': 'food_photo', 'confidence': 0.42, 'description': 'A plate of fried chicken'}}}),
        ('user', '[Document] bill', {'media': {'messageType': 'document', 'mimeType': 'application/pdf', 'processing': 'ok'}}),
        ('user', 'plain text message', None),
    ]
    for i, (role, content, meta) in enumerate(msgs):
        m = 'NULL' if meta is None else f"'{esc(json.dumps(meta))}'"
        sql(f"INSERT INTO Message (id, organizationId, conversationId, role, content, metadata, createdAt) VALUES ('{conv}-{i}', '{org}', '{conv}', '{role}', '{esc(content)}', {m}, DATE_ADD(NOW(3), INTERVAL {i} SECOND))")
    try:
        pg.goto(WEB + '/conversations'); pg.wait_for_timeout(3000)
        row = pg.get_by_role('button', name=re.compile(re.escape(phone[-4:])))
        if row.count() == 0: row = pg.get_by_role('button', name=re.compile('plain text message'))
        check('the multimodal conversation is listed in the inbox', row.count() >= 1, pg.locator('main').inner_text()[:300])
        if row.count(): row.first.click(); pg.wait_for_timeout(2500)
        v = pg.get_by_test_id('media-voice')
        check('voice note: badge "Voice note · transcribed", understood, duration', v.count() == 1 and 'Voice note' in v.inner_text() and 'understood' in v.inner_text() and '4 s' in v.inner_text(), v.inner_text() if v.count() else '')
        r = pg.get_by_test_id('media-voice-reply')
        check('AI voice reply: badge shown', r.count() == 1 and 'AI voice reply' in r.inner_text())
        im = pg.get_by_test_id('media-image')
        check('image: badge with kind, "unsure" and confidence', im.count() == 1 and 'food photo' in im.inner_text() and 'unsure' in im.inner_text() and '42% sure' in im.inner_text(), im.inner_text() if im.count() else '')
        d = pg.get_by_test_id('media-document')
        check('document: badge shown', d.count() == 1 and 'Document' in d.inner_text())
        check('plain text has no media badge (exactly 4 badges)', pg.locator('[data-testid^="media-"]').count() == 4)
        pg.screenshot(path=os.path.join(SHOTS, 'inbox-multimodal.png'), full_page=False)
        check('no page errors', not errs, '; '.join(errs)[:200])
    finally:
        sql(f"DELETE FROM Message WHERE conversationId='{conv}'"); sql(f"DELETE FROM Conversation WHERE id='{conv}'")
    b.close()

print(f"\n{sum(results)}/{len(results)} passed")
raise SystemExit(0 if all(results) else 1)
