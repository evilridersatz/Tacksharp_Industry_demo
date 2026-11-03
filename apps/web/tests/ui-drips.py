"""
Drip automation through the real dashboard + API + worker + MySQL (TEST database, DRY_RUN=true: nothing is sent).
Create a sequence from the industry starting template (Day 0/1/3/5 call/7), field validation, enrol by tag (opted-out
customer skipped), activate, the worker runs Day 0 within a minute and records it as simulated (message saved in the
conversation, labelled not sent), A/B variant on Day 0 (stable choice, the chosen text saved, results per variant),
automatic enrolment (creates an active Workflow Studio rule), edit re-times, stop one enrolment, pause; nav link; no
page errors.

  Run:   TEST_DB_NAME=tacksharp_test python3 -I apps/web/tests/ui-drips.py
"""
from playwright.sync_api import sync_playwright
import os, subprocess, tempfile, time

WEB, API = 'http://localhost:3001', 'http://localhost:3000'
SHOTS = os.environ.get('SHOTS_DIR', tempfile.gettempdir())
DB = os.environ.get('TEST_DB_NAME', 'tacksharp_test')
def sql(q):
    return subprocess.run(['mysql', '-h127.0.0.1', f"-u{os.environ.get('DB_USER', 'root')}", f"-p{os.environ.get('DB_PASSWORD', '')}", DB, '-N', '-e', q], capture_output=True, text=True).stdout.strip()

results = []
def check(name, ok, detail=''):
    results.append(bool(ok)); print(('PASS ' if ok else 'FAIL ') + name + (f'  — {detail}' if detail else ''))

run = str(int(time.time()))[-6:]
name = f'Drip test {run}'
tag = f'drip{run}'
with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 1440, 'height': 950}); pg = ctx.new_page()
    errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(WEB + '/login'); pg.get_by_label('Email').fill('owner@tacksharp.test'); pg.get_by_label('Password', exact=True).fill('correct-horse-battery')
    pg.get_by_role('button', name='Log in').click(); pg.wait_for_timeout(2500)
    def api(path, body=None, method=None):
        return pg.evaluate("""async ([u, b, m]) => { const r = await fetch(u, { method: m || (b ? 'POST' : 'GET'), credentials: 'include', headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, body: await r.json().catch(() => null) }; }""", [API + path, body, method])
    a = api('/customers', {'name': f'Drip Kavya {run}', 'phone': '97' + run + '51', 'messagingConsent': True, 'consentSource': 'customer_message'})['body']
    o = api('/customers', {'name': f'Drip Out {run}', 'phone': '97' + run + '52', 'messagingConsent': True, 'consentSource': 'customer_message'})['body']
    sql(f"""UPDATE Customer SET tags='["{tag}"]', lastInboundAt=NOW(3) - INTERVAL 1 HOUR WHERE id IN ('{a['id']}','{o['id']}')""")
    sql(f"UPDATE Customer SET optedOutAt=NOW(3) WHERE id='{o['id']}'")
    try:
        pg.goto(WEB + '/drips'); pg.wait_for_timeout(2500)
        check('nav has "Drip sequences"', pg.get_by_role('link', name='Drip sequences').count() >= 1)
        pg.get_by_role('button', name='New sequence').click(); pg.wait_for_timeout(1500)
        ed = pg.get_by_test_id('drip-editor')
        days = [ed.get_by_label(f'Step {i} day').input_value() for i in range(1, 6)]
        chans = [ed.get_by_label(f'Step {i} channel').input_value() for i in range(1, 6)]
        check('starting template: Day 0/1/3/5/7 with an AI call on Day 5', days == ['0', '1', '3', '5', '7'] and chans[3] == 'voice', f'{days} {chans}')
        ed.get_by_label('Sequence name').fill(name)
        ed.get_by_label('Send from hour').fill('0'); ed.get_by_label('Send until hour').fill('24')
        first = ed.get_by_label('Step 1 message').input_value()
        ed.get_by_label('Step 1 message').fill('')
        ed.get_by_role('button', name='Save draft').click(); pg.wait_for_timeout(1500)
        check('validation: a WhatsApp step without a message or template is refused with the reason', 'needs a message' in ed.inner_text() and sql(f"SELECT COUNT(*) FROM DripSequence WHERE name='{name}'") == '0')
        ed.get_by_label('Step 1 message').fill(first)
        ed.get_by_label('Step 1 variant B').fill(f'Variant B hello {run}')
        ed.get_by_role('button', name='Save draft').click(); pg.wait_for_timeout(2500)
        sid = sql(f"SELECT id FROM DripSequence WHERE name='{name}'")
        check('saved as a draft and selected', bool(sid) and sql(f"SELECT status FROM DripSequence WHERE id='{sid}'") == 'draft' and pg.get_by_test_id('drip-detail').count() == 1)
        enrol = pg.get_by_test_id('drip-enrol')
        enrol.get_by_label('Enrol by').select_option('tag'); enrol.get_by_label('Tag').fill(tag)
        enrol.get_by_role('button', name='Enrol').click(); pg.wait_for_timeout(2000)
        txt = enrol.get_by_test_id('enrol-result').inner_text() if enrol.get_by_test_id('enrol-result').count() else ''
        check('enrol by tag: 1 of 2, opted-out customer skipped, reminder to activate', 'Enrolled 1 of 2' in txt and '1 opted out' in txt and 'Activate' in txt, txt)
        check('one enrolment row in the database', sql(f"SELECT COUNT(*) FROM DripEnrollment WHERE sequenceId='{sid}'") == '1')
        pg.get_by_role('button', name='Activate').click(); pg.wait_for_timeout(1500)
        check('activated', sql(f"SELECT status FROM DripSequence WHERE id='{sid}'") == 'active')
        # The worker ticks every minute.
        st = ''
        for _ in range(45):
            st = sql(f"SELECT r.status FROM DripStepRun r JOIN DripEnrollment e ON e.id=r.enrollmentId WHERE e.sequenceId='{sid}' AND r.stepIndex=0")
            if st: break
            time.sleep(2)
        check('worker ran Day 0 within a minute: recorded as simulated (DRY_RUN), nothing sent', st == 'simulated', st)
        meta = sql(f"SELECT m.metadata FROM Message m JOIN Conversation c ON c.id=m.conversationId WHERE c.customerId='{a['id']}' ORDER BY m.createdAt DESC LIMIT 1").replace(' ', '')
        check('message saved in the customer conversation, labelled simulated', '"simulated":true' in meta and sid in meta, meta[:160])
        check('enrolment moved to step 2', sql(f"SELECT stepIndex FROM DripEnrollment WHERE sequenceId='{sid}'") == '1')
        pg.reload(); pg.wait_for_timeout(2500)
        rows = pg.get_by_test_id('drip-enrollment')
        check('enrolments table shows the customer and "1: simulated"', rows.count() == 1 and f'Drip Kavya {run}' in rows.first.inner_text() and '1: simulated' in rows.first.inner_text(), rows.first.inner_text() if rows.count() else '')
        check('step stats on the timeline', '1 simulated' in pg.get_by_test_id('drip-timeline').inner_text())
        variant = sql(f"SELECT r.variant FROM DripStepRun r JOIN DripEnrollment e ON e.id=r.enrollmentId WHERE e.sequenceId='{sid}' AND r.stepIndex=0")
        sent_text = sql(f"SELECT m.content FROM Message m JOIN Conversation c ON c.id=m.conversationId WHERE c.customerId='{a['id']}' AND m.role='assistant' ORDER BY m.createdAt DESC LIMIT 1")
        check('A/B: the run records its variant and the customer got that text', variant in ('A', 'B') and ((variant == 'B') == sent_text.startswith(f'Variant B hello {run}')), f'{variant} {sent_text[:60]}')
        ab = pg.get_by_test_id('ab-0')
        check('A/B results table on Day 0: one delivered in the chosen variant', ab.count() == 1 and ab.get_by_role('row').filter(has_text=variant).first.inner_text().split()[1] == '1', ab.inner_text() if ab.count() else '')
        auto = pg.get_by_test_id('drip-auto')
        auto.get_by_label('Start when').select_option('stage_reached'); auto.get_by_label('Trigger stage').select_option('qualified')
        auto.get_by_role('button', name='Turn on').click(); pg.wait_for_timeout(2500)
        wf = sql(f"SELECT CONCAT(status,'|',JSON_UNQUOTE(JSON_EXTRACT(graph,'$.trigger.type')),'|',JSON_UNQUOTE(JSON_EXTRACT(graph,'$.steps[0].sequenceId'))) FROM Workflow WHERE name LIKE 'Enrol in {name}%'")
        check('automatic enrolment: an active workflow "stage reached qualified -> enrol in this sequence"', wf == f'active|stage_reached|{sid}' and auto.get_by_test_id('drip-auto-rule').count() == 1 and 'qualified' in auto.inner_text(), wf)
        pg.screenshot(path=os.path.join(SHOTS, 'drips.png'), full_page=True)
        pg.get_by_test_id('drip-detail').get_by_role('button', name='Edit').click(); pg.wait_for_timeout(800)
        pg.get_by_label('Step 2 day').fill('2'); pg.get_by_role('button', name='Save', exact=True).click(); pg.wait_for_timeout(2000)
        gap = sql(f"SELECT ROUND(TIMESTAMPDIFF(HOUR, enrolledAt, nextRunAt)/24) FROM DripEnrollment WHERE sequenceId='{sid}'")
        check('edit saved and the running enrolment re-timed to Day 2', 'Day 2' in pg.get_by_test_id('drip-timeline').inner_text() and gap == '2', gap)
        rows.first.get_by_role('button', name='Stop').click(); pg.wait_for_timeout(2000)
        check('stop one enrolment: stopped by a person', sql(f"SELECT CONCAT(status,'/',stopReason) FROM DripEnrollment WHERE sequenceId='{sid}'") == 'stopped/stopped_by_user' and 'Stopped by a person' in rows.first.inner_text())
        pg.get_by_role('button', name='Pause').click(); pg.wait_for_timeout(1500)
        check('paused', sql(f"SELECT status FROM DripSequence WHERE id='{sid}'") == 'paused')
        check('list shows the sequence with its counts', f'{name}' in pg.get_by_test_id('drip-list').inner_text() and '1 stopped' in pg.get_by_test_id('drip-list').inner_text())
        check('no page errors', not errs, '; '.join(errs)[:200])
    finally:
        sql(f"DELETE FROM Workflow WHERE name LIKE 'Enrol in {name}%'")
        sql(f"DELETE FROM DripSequence WHERE name='{name}'")
        for c in (a, o):
            if c and c.get('id'): sql(f"DELETE FROM Customer WHERE id='{c['id']}'")
    b.close()

print(f"\n{sum(results)}/{len(results)} passed")
raise SystemExit(0 if all(results) else 1)
