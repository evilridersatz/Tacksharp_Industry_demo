"""
Advanced agent builder through the real dashboard + API + agent engine + MySQL (TEST database; no AI model in the test
environment, so answers come from the template's knowledge base). Saved test cases (add multi-check tests, run all,
pass / fail per check with the agent's actual reply), "tests must pass" publish gate (refused with the failing test
named), publish with a version note, a second version, compare a version with the current configuration, restore it.

  Run:   TEST_DB_NAME=tacksharp_test python3 -I apps/web/tests/ui-agent-builder.py
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
agent_id = kb = ''
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_context(viewport={'width': 1440, 'height': 1000}).new_page()
    errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(WEB + '/login'); pg.get_by_label('Email').fill('owner@tacksharp.test'); pg.get_by_label('Password', exact=True).fill('correct-horse-battery')
    pg.get_by_role('button', name='Log in').click(); pg.wait_for_timeout(2500)
    def api(path, body=None, method=None):
        return pg.evaluate("""async ([u, b, m]) => { const r = await fetch(u, { method: m || (b ? 'POST' : 'GET'), credentials: 'include', headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; }""", [API + path, body, method])
    try:
        created = api('/voice-agents', {'templateKey': 'retail', 'name': f'Store desk {run}'})
        agent_id = (created['body'] or {}).get('id', '')
        check('agent created from the retail template (sample knowledge indexed)', created['status'] == 201 and bool(agent_id), str(created['body'])[:160])
        kb = sql(f"SELECT knowledgeBaseId FROM VoiceAgent WHERE id='{agent_id}'")
        pg.goto(WEB + f'/voice-agents/{agent_id}'); pg.get_by_role('list', name='Setup steps').wait_for(timeout=8000)
        pg.get_by_role('list', name='Setup steps').get_by_role('button', name=re.compile('Test')).click(); pg.wait_for_timeout(1500)
        suite = pg.get_by_test_id('test-suite')
        check('Test step has the saved test cases section', suite.count() == 1)

        def add_test(name, turns):
            suite.get_by_role('button', name='Add test').click()
            form = suite.get_by_test_id('test-form')
            form.get_by_label('Test name').fill(name)
            for i, t in enumerate(turns, 1):
                if i > 1: form.get_by_role('button', name='Next customer message').click()
                form.get_by_label(f'Customer message {i}').fill(t['message'])
                if t.get('contains'): form.get_by_label(f'Reply must mention {i}').fill(t['contains'])
                if t.get('not'): form.get_by_label(f'Reply must not mention {i}').fill(t['not'])
                if t.get('handover'): form.get_by_label(f'Hand over {i}').select_option(t['handover'])
                if t.get('source'): form.get_by_label(f'Answer source {i}').select_option(t['source'])
            form.get_by_role('button', name='Save test').click(); pg.wait_for_timeout(1500)
        add_test('Sunday timings', [{'message': 'What are your Sunday timings?', 'contains': '2 PM', 'handover': 'no', 'source': 'knowledge'}])
        add_test('Complaint then price', [{'message': 'I want to talk to the manager', 'handover': 'yes'}, {'message': 'Tawa price?', 'contains': '899', 'not': 'out of stock'}])
        add_test('Wrong on purpose', [{'message': 'Pressure cooker price?', 'contains': '9999'}])
        check('three test cases saved (one multi-message)', sql(f"SELECT COUNT(*) FROM AgentTestCase WHERE agentId='{agent_id}'") == '3' and suite.get_by_test_id('test-case').count() == 3)
        suite.get_by_role('button', name='Run all').click(); pg.wait_for_timeout(3000)
        check('run all: 2 of 3 pass, badge says so', '2/3 passed' in suite.inner_text() and pg.get_by_text(re.compile('2 of 3 test')).count() >= 1, suite.inner_text()[:200])
        bad = suite.get_by_test_id('test-case').filter(has_text='Wrong on purpose')
        bad.get_by_role('button', name='Wrong on purpose', exact=True).click(); pg.wait_for_timeout(400)
        check('failing test shows the agent\'s actual reply and the failed check', '✗ mentions "9999"' in bad.inner_text() and '2,150' in bad.inner_text(), bad.inner_text()[:200])
        good = suite.get_by_test_id('test-case').filter(has_text='Complaint then price')
        good.get_by_role('button', name='Complaint then price', exact=True).click(); pg.wait_for_timeout(400)
        check('multi-message test: hand-over then a knowledge answer, every check passed', '✓ hands over to a person' in good.inner_text() and '✓ mentions "899"' in good.inner_text())
        check('a full run counts as testing the agent', sql(f"SELECT lastTestedAt IS NOT NULL FROM VoiceAgent WHERE id='{agent_id}'") == '1')

        pg.get_by_role('list', name='Setup steps').get_by_role('button', name=re.compile('Launch')).click(); pg.wait_for_timeout(1500)
        pg.get_by_label(re.compile('Require the saved test cases to pass')).check(); pg.wait_for_timeout(1200)
        check('"tests must pass" switched on', sql(f"SELECT requireTestsToPublish FROM VoiceAgent WHERE id='{agent_id}'") == '1')
        verdict = pg.get_by_test_id('launch-verdict').inner_text()
        ui_publish = 'ready to launch' in verdict
        def publish(note):
            if ui_publish:
                pg.get_by_label('Version note').fill(note)
                pg.get_by_role('button', name=re.compile('Publish agent|Re-publish')).click(); pg.wait_for_timeout(3000)
                return None
            return api(f'/voice-agents/{agent_id}/publish', {'note': note})
        r = publish('Should be refused')
        refused = (r is None and pg.get_by_role('alert').filter(has_text='Wrong on purpose').count() == 1) or (r is not None and r['status'] == 400 and 'Wrong on purpose' in str(r['body']))
        check(f'publish refused while a test fails, naming it ({"UI button" if ui_publish else "API, launch checks block the button here"})', refused and sql(f"SELECT COUNT(*) FROM AgentVersion WHERE agentId='{agent_id}'") == '0', verdict[:80])
        tid = sql(f"SELECT id FROM AgentTestCase WHERE agentId='{agent_id}' AND name='Wrong on purpose'")
        api(f'/voice-agents/{agent_id}/tests/{tid}', None, 'DELETE')
        publish('Launch: store timings and prices')
        v = sql(f"SELECT CONCAT(version,'|',note,'|',JSON_EXTRACT(testSummary,'$.passed'),'/',JSON_EXTRACT(testSummary,'$.total')) FROM AgentVersion WHERE agentId='{agent_id}'")
        check('published as version 1 with the note and the test summary (2/2)', v == '1|Launch: store timings and prices|2/2', v)
        api(f'/voice-agents/{agent_id}', {'greeting': f'Vanakkam! Store desk {run}. How can I help?'}, 'PATCH')
        api(f'/voice-agents/{agent_id}/test', {'message': 'hi'})
        api(f'/voice-agents/{agent_id}/publish', {'note': 'New greeting'})
        pg.reload(); pg.get_by_role('list', name='Setup steps').get_by_role('button', name=re.compile('Launch')).click(); pg.wait_for_timeout(1500)
        vers = pg.get_by_test_id('agent-versions')
        check('versions list shows v2 and v1 with notes and test results', vers.get_by_test_id('agent-version').count() == 2 and 'New greeting' in vers.inner_text() and '2/2 tests' in vers.inner_text())
        vers.get_by_test_id('agent-version').filter(has_text='v1').get_by_role('button', name='Compare').click(); pg.wait_for_timeout(1200)
        d = pg.get_by_test_id('agent-diff').inner_text()
        check('compare v1 with the current configuration: the greeting change is shown', 'Greeting' in d and f'Store desk {run}' in d, d[:200])
        pg.screenshot(path=os.path.join(SHOTS, 'agent-builder-versions.png'), full_page=True)
        vers.get_by_test_id('agent-version').filter(has_text='v1').get_by_role('button', name='Restore').click(); pg.wait_for_timeout(2500)
        g = sql(f"SELECT CONCAT(greeting,'|',IFNULL(lastTestedAt,'untested')) FROM VoiceAgent WHERE id='{agent_id}'")
        check('restore v1: greeting back, the agent must be tested again', 'untested' in g and f'Store desk {run}' not in g, g[:120])
        check('no page errors', not errs, '; '.join(errs)[:200])
    finally:
        if agent_id: sql(f"DELETE FROM VoiceAgent WHERE id='{agent_id}'")
        if kb: sql(f"DELETE FROM KnowledgeBase WHERE id='{kb}'")
    b.close()

print(f"\n{sum(results)}/{len(results)} passed")
raise SystemExit(0 if all(results) else 1)
