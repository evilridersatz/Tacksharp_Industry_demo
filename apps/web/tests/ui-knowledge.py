"""
Knowledge studio through the real dashboard + API + indexing pipeline + agent engine + MySQL (TEST database; no AI
model, so answers come from the knowledge base). Create a knowledge base, upload a file (indexed, passages viewable),
a rejected file type, an agent using the base, questions it cannot answer recorded as "Unanswered" (grouped, counted),
answer one in the studio (the agent then answers from it), edit the answer (re-indexed), try a question, ignore /
restore a question, phone layout.

  Run:   TEST_DB_NAME=tacksharp_test python3 -I apps/web/tests/ui-knowledge.py
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
KB = f'Shop facts {run}'
tmp = tempfile.mkdtemp()
menu = os.path.join(tmp, 'menu.txt'); open(menu, 'w').write('Broiler chicken costs Rs 240 per kg.\nNaatu kozhi costs Rs 520 per kg.\nThe Velachery outlet opens at 7 AM and closes at 8 PM.\n')
bad = os.path.join(tmp, 'tool.exe'); open(bad, 'wb').write(b'MZ\x90\x00binary')
kb_id = agent_id = ''
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_context(viewport={'width': 1440, 'height': 1000}).new_page()
    errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(WEB + '/login'); pg.get_by_label('Email').fill('owner@tacksharp.test'); pg.get_by_label('Password', exact=True).fill('correct-horse-battery')
    pg.get_by_role('button', name='Log in').click(); pg.wait_for_timeout(2500)
    def api(path, body=None, method=None):
        return pg.evaluate("""async ([u, b, m]) => { const r = await fetch(u, { method: m || (b ? 'POST' : 'GET'), credentials: 'include', headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; }""", [API + path, body, method])
    try:
        pg.goto(WEB + '/knowledge'); pg.get_by_role('heading', name='Knowledge studio').first.wait_for(timeout=8000)
        try: pg.get_by_role('link', name='Knowledge studio').first.wait_for(timeout=8000)
        except Exception: pass
        check('nav has "Knowledge studio" (under AI agents)', pg.get_by_role('link', name='Knowledge studio').count() >= 1)
        pg.get_by_label('New knowledge base name').fill(KB); pg.get_by_role('button', name='Add', exact=True).click(); pg.wait_for_timeout(1500)
        try: pg.get_by_role('heading', name=KB).first.wait_for(timeout=8000)
        except Exception: pass
        kb_id = sql(f"SELECT id FROM KnowledgeBase WHERE name='{KB}'")
        check('knowledge base created and selected', bool(kb_id) and pg.get_by_role('heading', name=KB).count() >= 1)
        pg.get_by_label('Upload files').set_input_files(menu)
        doc = pg.get_by_test_id('kb-doc').filter(has_text='menu.txt')
        for _ in range(20):
            if doc.count() == 1 and 'indexed' in doc.inner_text(): break
            pg.wait_for_timeout(500)
        check('file uploaded and indexed', doc.count() == 1 and 'indexed' in doc.inner_text(), doc.inner_text()[:120] if doc.count() else '')
        pg.get_by_label('Upload files').set_input_files(bad); pg.wait_for_timeout(1500)
        check('an .exe is refused with a clear message, nothing stored', pg.get_by_text(re.compile('Upload a PDF, Word')).count() >= 1 and sql(f"SELECT COUNT(*) FROM KnowledgeDocument WHERE knowledgeBaseId='{kb_id}'") == '1')
        doc.get_by_role('button', name='Passages').click(); pg.wait_for_timeout(1000)
        check('passages view shows the indexed text', pg.get_by_test_id('kb-passage').count() >= 1 and 'Rs 520' in pg.get_by_role('dialog').inner_text())
        pg.keyboard.press('Escape'); pg.wait_for_timeout(400)

        r = api('/voice-agents', {'name': f'Shop desk {run}', 'industry': 'restaurant', 'instructions': 'Answer chicken price and timing questions from the shop facts.', 'greeting': 'Vanakkam!', 'fallbackMessage': 'Let me check with the team.', 'knowledgeBaseId': kb_id})
        agent_id = (r['body'] or {}).get('id', '')
        q1 = api(f'/voice-agents/{agent_id}/test', {'message': 'Do you deliver to Tambaram?'})
        api(f'/voice-agents/{agent_id}/test', {'message': 'do you deliver to TAMBARAM'})
        api(f'/voice-agents/{agent_id}/test', {'message': 'Is there parking near the shop?'})
        api(f'/voice-agents/{agent_id}/test', {'message': 'naatu kozhi price?'})
        check('agent could not answer the delivery question (fallback)', (q1['body'] or {}).get('source') == 'fallback', str(q1['body'])[:120])
        pg.wait_for_timeout(500); pg.reload(); pg.get_by_role('button', name=re.compile(re.escape(KB))).click(); pg.wait_for_timeout(1200)
        check('base shows "2 unanswered"', pg.get_by_role('button', name=re.compile(re.escape(KB))).filter(has_text='2 unanswered').count() == 1)
        pg.get_by_role('tab', name=re.compile(r'^Unanswered \(')).click(); pg.wait_for_timeout(1200)
        gaps = pg.get_by_test_id('kb-gap')
        txt = ' | '.join(gaps.all_inner_texts())
        check('unanswered: delivery (asked 2 times, grouped) and parking; the answered price question is not there', gaps.count() == 2 and 'Asked 2 times' in gaps.filter(has_text='Tambaram').inner_text() and 'naatu' not in txt.lower(), txt[:200])
        gaps.filter(has_text='Tambaram').get_by_role('button', name='Answer').click()
        dlg = pg.get_by_role('dialog')
        check('answer dialog prefilled with the question', dlg.get_by_label('Question or title').input_value() == 'Do you deliver to Tambaram?')
        dlg.get_by_label('Answer').fill('Yes, we deliver to Tambaram every day from 11 AM to 7 PM. Delivery is free above Rs 500.')
        dlg.get_by_role('button', name='Save answer').click(); pg.wait_for_timeout(2500)
        check('question answered: gone from Unanswered, stored as answered (database)', pg.get_by_test_id('kb-gap').filter(has_text='Tambaram').count() == 0 and sql(f"SELECT status FROM KnowledgeGap WHERE knowledgeBaseId='{kb_id}' AND question LIKE '%Tambaram%'") == 'answered')
        r = api(f'/voice-agents/{agent_id}/test', {'message': 'Do you deliver to Tambaram?'})
        check('the agent now answers from the written answer', (r['body'] or {}).get('source') == 'knowledge' and 'Tambaram' in (r['body'] or {}).get('reply', ''), str(r['body'])[:160])

        gaps.filter(has_text='parking').get_by_role('button', name='Ignore').click(); pg.wait_for_timeout(1200)
        check('ignore: parking question leaves the list', pg.get_by_test_id('kb-gap').count() == 0)
        pg.get_by_role('tab', name='Ignored', exact=True).click(); pg.wait_for_timeout(1200)
        pg.get_by_test_id('kb-gap').filter(has_text='parking').get_by_role('button', name='Restore').click(); pg.wait_for_timeout(1200)
        check('restore puts it back to unanswered', sql(f"SELECT status FROM KnowledgeGap WHERE knowledgeBaseId='{kb_id}' AND question LIKE '%parking%'") == 'open')

        pg.get_by_role('tab', name=re.compile(r'^Documents \(')).click(); pg.wait_for_timeout(1000)
        ans = pg.get_by_test_id('kb-doc').filter(has_text='Written in the studio')
        check('the answer is listed as a studio document, indexed', ans.count() == 1 and 'indexed' in ans.inner_text())
        ans.get_by_role('button', name='Edit').click(); dlg = pg.get_by_role('dialog'); dlg.get_by_label('Answer').wait_for()
        check('edit opens the saved text', dlg.get_by_label('Answer').input_value().startswith('Yes, we deliver'))
        dlg.get_by_label('Answer').fill('Yes, Tambaram delivery runs from 10 AM to 9 PM. Free above Rs 400.')
        dlg.get_by_role('button', name='Save answer').click(); pg.wait_for_timeout(3000)
        r = api(f'/voice-agents/{agent_id}/test', {'message': 'tambaram delivery timing?'})
        check('edited answer re-indexed and used', '10 AM to 9 PM' in (r['body'] or {}).get('reply', ''), str(r['body'])[:160])
        check('an uploaded file has no Edit button', pg.get_by_test_id('kb-doc').filter(has_text='menu.txt').get_by_role('button', name='Edit').count() == 0)

        pg.get_by_role('tab', name='Try a question').click(); pg.wait_for_timeout(600)
        pg.get_by_label('Question', exact=True).fill('Velachery closing time'); pg.get_by_role('button', name='Search').click(); pg.wait_for_timeout(1200)
        hits = pg.get_by_test_id('kb-hit')
        check('try a question: the menu passage comes first', hits.count() >= 1 and '8 PM' in hits.first.inner_text())
        pg.get_by_label('Question', exact=True).fill('zzqx unknown'); pg.get_by_role('button', name='Search').click(); pg.wait_for_timeout(1000)
        check('no match explained', pg.get_by_role('status').filter(has_text='Nothing matches').count() == 1)
        pg.screenshot(path=os.path.join(SHOTS, 'knowledge-studio.png'), full_page=True)

        m = b.new_context(viewport={'width': 390, 'height': 844}, storage_state=pg.context.storage_state()).new_page()
        m.goto(WEB + '/knowledge'); m.get_by_role('heading', name='Knowledge studio').first.wait_for(timeout=8000); m.wait_for_timeout(1500)
        check('phone: no horizontal page scroll', m.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'))
        m.screenshot(path=os.path.join(SHOTS, 'knowledge-studio-phone.png'), full_page=True)
        check('no page errors', not errs, '; '.join(errs)[:200])
    finally:
        if agent_id: sql(f"DELETE FROM VoiceAgent WHERE id='{agent_id}'")
        if kb_id: sql(f"DELETE FROM KnowledgeBase WHERE id='{kb_id}'")
    b.close()

print(f"\n{sum(results)}/{len(results)} passed")
raise SystemExit(0 if all(results) else 1)
