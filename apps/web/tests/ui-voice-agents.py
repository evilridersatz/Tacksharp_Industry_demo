"""
Voice agent demos (public), the Agent Builder (wizard, knowledge base upload and processing, test, publish) and an
outbound call request, through the real web app and API with the test database. No provider is reachable and the
server runs with DRY_RUN=true: the call request is checked end to end and recorded as dry run; nothing is placed.

  Needs: API on :3000, web on :3001 (TEST_DB_NAME for clean-up).
  Run:   TEST_DB_NAME=tacksharp_merge python3 -I apps/web/tests/ui-voice-agents.py
"""
from playwright.sync_api import sync_playwright
import atexit, os, re, subprocess, tempfile, time

WEB = 'http://localhost:3001'
SHOTS = os.environ.get('SHOTS_DIR', tempfile.gettempdir())
DB = os.environ.get('TEST_DB_NAME', '')
results = []
def check(name, ok, detail=''):
    results.append(bool(ok)); print(('PASS ' if ok else 'FAIL ') + name + (f'  — {detail}' if detail else ''))

RUN = str(int(time.time()))
def sql(q):
    if not DB: return ''
    return subprocess.run(['mysql', '-h127.0.0.1', f"-u{os.environ.get('DB_USER', 'root')}", f"-p{os.environ.get('DB_PASSWORD', '')}", DB, '-N', '-e', q], capture_output=True, text=True).stdout.strip()

CREATED = {'agents': [], 'kbs': []}
def cleanup():
    # Agents and knowledge bases created by this run (the owner's organization), and the consenting test customer.
    sql(f"DELETE FROM TelephonyCallRequest WHERE idempotencyKey LIKE 'ui-%' AND createdAt > NOW() - INTERVAL 1 DAY AND agentId IN (SELECT id FROM VoiceAgent WHERE createdBy IS NOT NULL AND name LIKE '%{RUN}%')")
    sql(f"DELETE FROM TelephonyCallRequest WHERE customerId = 'cust_ui_{RUN}'")
    for a in CREATED['agents']: sql(f"DELETE FROM VoiceAgent WHERE id = '{a}'")
    for k in CREATED['kbs']: sql(f"DELETE FROM KnowledgeBase WHERE id = '{k}'")
    sql(f"DELETE FROM VoiceAgent WHERE name LIKE '%{RUN}%'")
    sql(f"DELETE FROM KnowledgeBase WHERE name LIKE '%{RUN}%'")
    sql(f"DELETE FROM Customer WHERE name = 'UI call test {RUN}'")
atexit.register(cleanup)
ORG = sql("SELECT organizationId FROM User WHERE email = 'owner@tacksharp.test'")
sql(f"INSERT INTO Customer (id, organizationId, name, phone, callingConsent, createdAt, updatedAt) VALUES ('cust_ui_{RUN}', '{ORG}', 'UI call test {RUN}', '9198{RUN[-8:]}', 1, NOW(3), NOW(3))")

TXT = os.path.join(tempfile.gettempdir(), f'kb-{RUN}.txt')
with open(TXT, 'w') as f:
    f.write('Delivery: free home delivery within 5 km of Anna Nagar for orders above Rs 500.\nSunday timings: 6 AM to 1 PM only.\n')
BAD = os.path.join(tempfile.gettempdir(), f'kb-{RUN}.pdf')
with open(BAD, 'wb') as f:
    f.write(b'MZ\x90\x00 this is not a pdf')

with sync_playwright() as p:
    b = p.chromium.launch()
    # ------------------------------------------------------------------ public demos (logged out)
    ctx = b.new_context(viewport={'width': 1440, 'height': 900}); pg = ctx.new_page(); errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(WEB + '/voice-demos'); pg.wait_for_timeout(1500)
    cards = pg.locator('[data-testid^="demo-"]')
    check('demos: ten industry templates listed', cards.count() == 10, str(cards.count()))
    check('demos: every business is labelled as sample data', pg.get_by_text(re.compile('^Sample:')).count() == 10)
    pg.get_by_test_id('demo-restaurant').get_by_role('button', name='Try the demo').click(); pg.wait_for_timeout(500)
    dlg = pg.get_by_role('dialog', name=re.compile('GR Chicken'))
    check('demo: GR Chicken ordering demo opens with scenario, instructions and sample knowledge', dlg.is_visible() and dlg.get_by_text('Sample knowledge base').count() == 1 and dlg.get_by_text(re.compile('Velachery outlet')).count() >= 1)
    check('demo: labelled "Simulated demo · sample data"', dlg.get_by_text('Simulated demo · sample data').count() == 1)
    dlg.get_by_label('Message the agent').fill('Country chicken Velachery-la irukka?'); dlg.get_by_role('button', name='Send').click()
    dlg.get_by_test_id('reply-meta').first.wait_for(timeout=8000)
    check('demo: outlet availability answered from the knowledge base (sold out at Velachery)', dlg.get_by_text(re.compile('sold out')).count() >= 1 and dlg.get_by_text(re.compile('restaurant-sample.txt')).count() >= 1)
    dlg.get_by_label('Message the agent').fill('I want to talk to the manager about a complaint'); dlg.get_by_role('button', name='Send').click()
    pg.wait_for_timeout(1500)
    check('demo: escalation hands off to a person (simulated, no call)', dlg.get_by_text('Handoff to a person').count() == 1 and dlg.get_by_text(re.compile('no real call')).count() == 1)
    pg.screenshot(path=os.path.join(SHOTS, 'voice-demo.png'))
    dlg.get_by_role('button', name=re.compile('Customise and publish')).click()
    pg.wait_for_url(re.compile('/signup'), timeout=8000)
    check('demo: "Customise and publish" while logged out goes to signup', '/signup' in pg.url)
    check('demos: no page errors', not errs, '; '.join(errs)[:200])
    ctx.close()

    # ------------------------------------------------------------------ Agent Builder (signed in)
    ctx = b.new_context(viewport={'width': 1440, 'height': 900}); pg = ctx.new_page(); errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(WEB + '/login'); pg.get_by_label('Email').fill('owner@tacksharp.test'); pg.get_by_label('Password', exact=True).fill('correct-horse-battery')
    pg.get_by_role('button', name='Log in').click(); pg.wait_for_timeout(2500)
    pg.goto(WEB + '/voice-demos'); pg.wait_for_timeout(1200)
    pg.get_by_test_id('demo-restaurant').get_by_role('button', name='Customise').click()
    pg.wait_for_url(re.compile(r'/voice-agents/[a-z0-9]+$'), timeout=10000)
    steps = pg.get_by_role('list', name='Setup steps'); steps.wait_for(timeout=8000)
    agent_id = pg.url.rstrip('/').split('/')[-1]
    CREATED['agents'].append(agent_id)
    CREATED['kbs'].append(sql(f"SELECT knowledgeBaseId FROM VoiceAgent WHERE id = '{agent_id}'"))
    check('builder: customise creates a draft agent from the template', pg.get_by_text('draft', exact=True).count() >= 1)
    check('builder: eight guided steps (Purpose → Launch)', [re.sub(r'\s+', '', x) for x in steps.locator('button').all_inner_texts()] == ['1Purpose', '2Business', '3Assistant', '4Knowledge', '5Channels', '6Safety', '7Test', '8Launch'], str(steps.locator('button').all_inner_texts()))
    check('step 1: purposes offered; WhatsApp updates labelled unavailable for custom agents', pg.get_by_text('What would you like your AI assistant to do?').count() == 1 and pg.get_by_label(re.compile('Send customer updates')).is_disabled())
    pg.get_by_label(re.compile('Make authorized outbound calls')).check()
    pg.get_by_role('button', name=re.compile('Next: Business')).click(); pg.get_by_text('Industry for this assistant').wait_for(timeout=10000)
    check('step 2: industry preselected from the template, business profile shown', pg.get_by_role('radio', name='Restaurant / chicken shop', checked=True).count() == 1 and pg.get_by_text('Edit business profile').count() == 1, f"{pg.get_by_role('radio', checked=True).all_inner_texts()} / {pg.get_by_text('Edit business profile').count()}")
    pg.get_by_role('button', name=re.compile('Next: Assistant')).click(); pg.wait_for_timeout(500)
    pg.get_by_label('Agent name').fill(f'GR order desk {RUN}')
    pg.get_by_text(re.compile('Advanced settings')).click()
    pg.get_by_label('Instructions and behaviour').fill('short')
    pg.get_by_role('button', name=re.compile('Next: Knowledge')).click(); pg.wait_for_timeout(800)
    check('step 3: server validation shown on the field (instructions too short)', pg.get_by_text('Between 20 and 6000 characters.').count() == 1)
    pg.get_by_label('Instructions and behaviour').fill('Take chicken orders politely, confirm the order, and answer delivery and timing questions from the knowledge base.')
    pg.get_by_label('Personality and tone').select_option('friendly')
    pg.get_by_role('button', name=re.compile('Next: Knowledge')).click(); pg.wait_for_timeout(1200)
    docs = pg.get_by_test_id('kb-doc')
    check('step 4: template sample knowledge is processed and indexed', docs.count() == 1 and docs.first.get_by_text('indexed').count() == 1)
    pg.get_by_label('New knowledge base name').fill(f'My shop facts {RUN}'); pg.get_by_role('button', name='Create').click(); pg.wait_for_timeout(1500)
    pg.locator('input[type=file]').set_input_files(BAD); pg.wait_for_timeout(1200)
    check('upload: a renamed binary is refused with a clear reason (never shown as uploaded)', pg.get_by_text(re.compile('not a valid PDF')).count() >= 1 and docs.count() == 0)
    pg.locator('input[type=file]').set_input_files(TXT)
    ok = False
    for _ in range(20):
        pg.wait_for_timeout(500)
        if docs.count() == 1 and docs.first.get_by_text('indexed').count() == 1: ok = True; break
    check('upload: TXT goes processing → indexed (status polled)', ok)
    pg.get_by_label('Test retrieval').fill('do you deliver to anna nagar'); pg.get_by_role('button', name='Find').click(); pg.wait_for_timeout(800)
    check('retrieval: the delivery passage is found with its source', pg.get_by_text(re.compile(r'kb-\d+\.txt · document')).count() >= 1)
    pg.get_by_role('button', name=re.compile('Next: Channels')).click(); pg.wait_for_timeout(800)
    check('step 5: channel cards with truthful status; outbound on from the purpose step', pg.get_by_role('list', name='Channels').count() == 1 and pg.get_by_label(re.compile('Allow outbound calls')).is_checked())
    pg.get_by_role('button', name=re.compile('Next: Safety')).click(); pg.wait_for_timeout(1200)
    check('step 6: safety checks explained (consent, calling hours, limits, live sending)', all(pg.get_by_test_id(f'check-{k}').count() == 1 for k in ('provider', 'consent', 'hours', 'limits', 'live')) and pg.get_by_text(re.compile('never redialled automatically')).count() == 1)
    pg.get_by_role('button', name=re.compile('Next: Test')).click(); pg.wait_for_timeout(1200)
    check('step 7: test console labelled "Test mode · nothing is sent"', pg.get_by_text('Test mode · nothing is sent').count() == 1)
    pg.get_by_label('Message the agent').fill('Sunday timings enna?'); pg.get_by_role('button', name='Send', exact=True).click()
    pg.get_by_test_id('reply-meta').first.wait_for(timeout=8000)
    check('test: answer grounded in the uploaded document, with attribution', pg.get_by_text(re.compile('6 AM to 1 PM')).count() >= 1 and pg.get_by_test_id('reply-meta').get_by_text(re.compile(r'kb-\d+\.txt')).count() >= 1)
    tc = pg.get_by_label('Real test call')
    check('test call: never automatic; blocked until the agent is live, else destination must be chosen and confirmed', tc.count() == 1 and (tc.get_by_text(re.compile('Not possible yet')).count() == 1 or tc.get_by_role('button', name='Place test call').is_disabled()), tc.inner_text()[:160] if tc.count() else '')
    pg.get_by_role('button', name=re.compile('Next: Launch')).click(); pg.wait_for_timeout(1500)
    verdict = pg.get_by_test_id('launch-verdict').inner_text()
    check('step 8: honest launch summary', 'ready to launch' in verdict or 'not ready yet' in verdict, verdict)
    if 'ready to launch' in verdict:
        pg.get_by_role('button', name='Publish agent').click(); pg.wait_for_timeout(1500)
        check('launch: published (active)', pg.get_by_text(re.compile('Active since')).count() == 1)
    else:
        check('launch: publish disabled while something is missing', pg.get_by_role('button', name='Publish agent').is_disabled())
    pg.screenshot(path=os.path.join(SHOTS, 'voice-agent-builder.png'))

    # ------------------------------------------------------------------ outbound call request (dry run)
    pg.goto(WEB + '/voice-agents'); pg.wait_for_timeout(1500)
    check('list: dry-run banner shown on this server', pg.get_by_text(re.compile('Dry run is on')).count() == 1)
    card = pg.locator('li', has_text=f'GR order desk {RUN}')
    check('list: the agent is active with outbound on', card.get_by_text('active').count() >= 1 and card.get_by_role('button', name='Call').count() == 1)
    card.get_by_role('button', name='Call').click(); pg.wait_for_timeout(1200)
    cd = pg.get_by_role('dialog', name=re.compile('Call with'))
    opts = cd.locator('select option').all_inner_texts()
    consent = next((o for o in opts if '(no calling consent)' not in o and 'Choose' not in o), None)
    if consent:
        cd.locator('select').select_option(label=consent)
        cd.get_by_role('checkbox').check(); cd.get_by_role('button', name='Place call').click(); pg.wait_for_timeout(1500)
        check('call: checked on the server and recorded with the reason (dry run, or outside calling hours); nothing placed', cd.get_by_role('status').filter(has_text=re.compile('dry run: not_live|rejected: outside_calling_hours')).count() == 1, cd.get_by_role('status').inner_text() if cd.get_by_role('status').count() else '')
    else:
        check('call: a customer with calling consent exists in the test workspace', False, 'none found')
    cd.get_by_role('button', name='Close', exact=True).last.click(); pg.wait_for_timeout(1200)
    check('call log: the request appears with its outcome', pg.get_by_text(re.compile('Test mode is on|blocked by your calling hours')).count() >= 1)
    check('telephony: both providers shown with verified capabilities', pg.get_by_role('radio', name=re.compile('Plivo')).count() == 1 and pg.get_by_role('radio', name=re.compile('Sarvam Voice Agents')).count() == 1)
    pg.get_by_text('Sarvam: what works (verified)').click(); pg.wait_for_timeout(300)
    check('telephony: Sarvam limitations stated (hosted agent, no webhook signing)', pg.get_by_text(re.compile('NOT pushed to Sarvam automatically')).count() == 1 and pg.get_by_text(re.compile('does not document webhook signing')).count() == 1)
    pg.screenshot(path=os.path.join(SHOTS, 'voice-agents-list.png'))
    pg.goto(WEB + '/settings/integrations/sarvam-telephony'); pg.wait_for_timeout(1500)
    check('settings: Sarvam Voice Agents credentials page (fields + test call, no fake "test connection")', pg.get_by_label('Workspace ID').count() == 1 and pg.get_by_role('button', name='Test connection').count() == 0 and pg.get_by_text('Test call through Sarvam').count() == 1)
    check('builder / list: no page errors', not errs, '; '.join(errs)[:200])

    # phone layout
    pg.set_viewport_size({'width': 390, 'height': 844}); pg.goto(WEB + '/voice-demos'); pg.wait_for_timeout(1200)
    check('phone: demos page has no horizontal scroll', pg.evaluate('document.scrollingElement.scrollWidth - window.innerWidth') <= 1)
    ctx.close()
    b.close()

print(f"\n{sum(results)}/{len(results)} passed")
raise SystemExit(0 if all(results) else 1)
