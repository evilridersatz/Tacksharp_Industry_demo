"""
Visual Workflow Studio through the real dashboard + API + worker + MySQL (TEST database, DRY_RUN=true: nothing sent).
Template on the canvas (trigger, steps, Yes / No branches), add a step into a branch with the + menu, inspector edits,
validation shown on the step card, save (draft), test run on a real customer (nothing sent / changed, waits skipped),
activate, the worker starts a run for a NEW lead within a minute (WhatsApp simulated, then waiting), runs view, stop,
pause; nav link; no page errors.

  Run:   TEST_DB_NAME=tacksharp_test python3 -I apps/web/tests/ui-workflows.py
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
name = f'Welcome test {run}'
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_context(viewport={'width': 1500, 'height': 1000}).new_page()
    errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(WEB + '/login'); pg.get_by_label('Email').fill('owner@tacksharp.test'); pg.get_by_label('Password', exact=True).fill('correct-horse-battery')
    pg.get_by_role('button', name='Log in').click(); pg.wait_for_timeout(2500)
    org = sql("SELECT organizationId FROM User WHERE email='owner@tacksharp.test'")
    def api(path, body=None, method=None):
        return pg.evaluate("""async ([u, b, m]) => { const r = await fetch(u, { method: m || (b ? 'POST' : 'GET'), credentials: 'include', headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; }""", [API + path, body, method])
    t = api('/customers', {'name': f'Flow Tester {run}', 'phone': '95' + run + '71', 'messagingConsent': True, 'consentSource': 'customer_message'})['body']
    sql(f"UPDATE Customer SET lastInboundAt=NOW(3) WHERE id='{t['id']}'")  # wrote to the business: 24 h window open
    newc = None
    try:
        pg.goto(WEB + '/workflows'); pg.wait_for_timeout(2500)
        check('nav has "Workflow studio"', pg.get_by_role('link', name='Workflow studio').count() >= 1)
        pg.get_by_role('button', name='Welcome a new lead').click(); pg.wait_for_timeout(1000)
        canvas = pg.get_by_test_id('wf-canvas')
        check('template on the canvas: trigger, WhatsApp, wait, condition with Yes / No branches', 'New enquiry / lead' in pg.get_by_test_id('wf-trigger').inner_text() and canvas.get_by_text('Send WhatsApp').count() == 1 and canvas.get_by_text('Wait', exact=True).count() == 1 and canvas.locator('[data-testid$="-yes"]').count() == 1 and canvas.locator('[data-testid$="-no"]').count() == 1)
        pg.get_by_label('Workflow name').fill(name)
        pg.get_by_role('button', name='Add a step at position 1 in the no branch').click()
        pg.get_by_role('menuitem', name='Add tag').click(); pg.wait_for_timeout(300)
        pg.get_by_test_id('wf-inspector').get_by_label('Tag').fill('cold lead')
        check('step added into the No branch and edited in the inspector', 'Tag "cold lead"' in canvas.locator('[data-testid$="-no"]').inner_text())
        canvas.get_by_text('Send WhatsApp').click(); pg.wait_for_timeout(300)
        msg = pg.get_by_label('WhatsApp message').input_value()
        pg.get_by_label('WhatsApp message').fill('')
        pg.get_by_role('button', name='Save').click(); pg.wait_for_timeout(1500)
        check('validation: the empty WhatsApp step is marked on its card, nothing saved', 'Write a message' in canvas.inner_text() and sql(f"SELECT COUNT(*) FROM Workflow WHERE name='{name}'") == '0')
        pg.get_by_label('WhatsApp message').fill(msg)
        pg.get_by_role('button', name='Save').click(); pg.wait_for_timeout(2500)
        wid = sql(f"SELECT id FROM Workflow WHERE name='{name}'")
        check('saved as a draft (version 1)', bool(wid) and sql(f"SELECT CONCAT(status,'/',version) FROM Workflow WHERE id='{wid}'") == 'draft/1')
        pg.get_by_label('Find a customer').fill(f'Flow Tester {run}'); pg.wait_for_timeout(1500)
        pg.get_by_test_id('wf-test').get_by_role('button', name=re.compile(f'Flow Tester {run}')).click()
        pg.get_by_role('button', name='Run test').click(); pg.wait_for_timeout(2500)
        tlog = pg.get_by_test_id('wf-test-log').inner_text() if pg.get_by_test_id('wf-test-log').count() else ''
        check('test run: WhatsApp "would send" with the filled message, wait skipped, condition evaluated', 'would send' in tlog and f'Hi Flow, thanks for contacting' in tlog and 'skipped' in tlog and re.search(r'Condition.*\b(yes|no)\b', tlog, re.S) is not None, tlog[:300])
        check('test run changed nothing (no message, stage unchanged)', sql(f"SELECT COUNT(*) FROM Message m JOIN Conversation c ON c.id=m.conversationId WHERE c.customerId='{t['id']}'") == '0' and sql(f"SELECT IFNULL(stage,'new') FROM Customer WHERE id='{t['id']}'") == 'new')
        pg.screenshot(path=os.path.join(SHOTS, 'workflow-studio.png'), full_page=True)
        pg.get_by_role('button', name='Activate').click(); pg.wait_for_timeout(1500)
        check('activated', sql(f"SELECT status FROM Workflow WHERE id='{wid}'") == 'active')
        time.sleep(1)
        newc = api('/customers', {'name': f'Flow Lead {run}', 'phone': '95' + run + '72', 'messagingConsent': True, 'consentSource': 'customer_message'})['body']
        sql(f"UPDATE Customer SET lastInboundAt=NOW(3) WHERE id='{newc['id']}'")
        sql(f"INSERT INTO Lead (id, organizationId, customerId, status, source, createdAt, updatedAt) VALUES ('wf_lead_{run}', '{org}', '{newc['id']}', 'new', 'whatsapp', NOW(3), NOW(3))")
        st = ''
        for _ in range(45):
            st = sql(f"SELECT status FROM WorkflowRun WHERE workflowId='{wid}' AND triggerKey='lead:wf_lead_{run}'")
            if st in ('waiting', 'completed', 'failed'): break
            time.sleep(2)
        check('worker started a run for the NEW lead within a minute and it is waiting after the WhatsApp step', st == 'waiting', st)
        meta = sql(f"SELECT m.metadata FROM Message m JOIN Conversation c ON c.id=m.conversationId WHERE c.customerId='{newc['id']}' AND m.role='assistant'").replace(' ', '')
        check('WhatsApp step saved in the conversation, simulated (DRY_RUN)', '"simulated":true' in meta and wid in meta, meta[:150])
        pg.reload(); pg.wait_for_timeout(2500)
        pg.get_by_role('tab', name=re.compile('Runs')).click(); pg.wait_for_timeout(800)
        runs = pg.get_by_test_id('wf-run')
        lr = runs.filter(has_text=f'Flow Lead {run}')
        check('runs view lists the run as waiting and a test run', lr.count() == 1 and 'waiting' in lr.inner_text() and runs.filter(has_text='test').count() >= 1)
        lr.get_by_role('button', name=f'Flow Lead {run}').click(); pg.wait_for_timeout(400)
        check('run log shows the steps', 'simulated' in lr.inner_text() and 'waiting' in lr.inner_text())
        lr.get_by_role('button', name='Stop').click(); pg.wait_for_timeout(1500)
        check('stop a run', sql(f"SELECT status FROM WorkflowRun WHERE workflowId='{wid}' AND triggerKey='lead:wf_lead_{run}'") == 'stopped')
        pg.get_by_role('tab', name='Design').click(); pg.wait_for_timeout(800)
        pg.get_by_role('button', name='Pause').click(); pg.wait_for_timeout(1500)
        check('paused', sql(f"SELECT status FROM Workflow WHERE id='{wid}'") == 'paused')
        check('no page errors', not errs, '; '.join(errs)[:200])
    finally:
        sql(f"DELETE FROM Workflow WHERE name='{name}'")
        sql(f"DELETE FROM Lead WHERE id='wf_lead_{run}'")
        for c in (t, newc):
            if c and c.get('id'): sql(f"DELETE FROM Conversation WHERE customerId='{c['id']}'"); sql(f"DELETE FROM Customer WHERE id='{c['id']}'")
    b.close()

print(f"\n{sum(results)}/{len(results)} passed")
raise SystemExit(0 if all(results) else 1)
