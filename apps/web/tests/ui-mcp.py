"""
MCP server through the real dashboard + API + MySQL (TEST database). Settings card -> MCP page; create a read key
(shown once, never again; only a hash stored); the key works over real HTTP (initialize, tools/list without write
tools, a read tool), a write tool is refused; a write key adds a real note; revoking makes the key fail (401); a
foreign Origin is refused; last used shown; no page errors.

  Run:   TEST_DB_NAME=tacksharp_test python3 -I apps/web/tests/ui-mcp.py
"""
from playwright.sync_api import sync_playwright
import hashlib, json, os, subprocess, tempfile, time, urllib.request, urllib.error

WEB, API = 'http://localhost:3001', 'http://localhost:3000'
SHOTS = os.environ.get('SHOTS_DIR', tempfile.gettempdir())
DB = os.environ.get('TEST_DB_NAME', 'tacksharp_test')
def sql(q):
    return subprocess.run(['mysql', '-h127.0.0.1', f"-u{os.environ.get('DB_USER', 'root')}", f"-p{os.environ.get('DB_PASSWORD', '')}", DB, '-N', '-e', q], capture_output=True, text=True).stdout.strip()

results = []
def check(name, ok, detail=''):
    results.append(bool(ok)); print(('PASS ' if ok else 'FAIL ') + name + (f'  — {detail}' if detail else ''))

def mcp(key, method, params=None, origin=None):
    body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params or {}}).encode()
    h = {'content-type': 'application/json', 'accept': 'application/json, text/event-stream', 'authorization': f'Bearer {key}'}
    if origin: h['origin'] = origin
    try:
        with urllib.request.urlopen(urllib.request.Request(API + '/mcp', data=body, headers=h, method='POST'), timeout=20) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, None

run = str(int(time.time()))[-6:]
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_context(viewport={'width': 1440, 'height': 950}).new_page()
    errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(WEB + '/login'); pg.get_by_label('Email').fill('owner@tacksharp.test'); pg.get_by_label('Password', exact=True).fill('correct-horse-battery')
    pg.get_by_role('button', name='Log in').click(); pg.wait_for_timeout(2500)
    org = sql("SELECT organizationId FROM User WHERE email='owner@tacksharp.test'")
    cid = f'mcp_ui_cust_{run}'
    sql(f"INSERT INTO Customer (id, organizationId, name, phone, createdAt, updatedAt) VALUES ('{cid}', '{org}', 'Mcp Ui {run}', '9188{run}91', NOW(3), NOW(3))")
    try:
        pg.goto(WEB + '/settings/integrations'); pg.wait_for_timeout(2500)
        pg.get_by_test_id('integration-mcp').click(); pg.wait_for_timeout(2500)
        check('MCP page from the integrations card, with the endpoint and the tool list', '/settings/integrations/mcp' in pg.url and pg.get_by_test_id('mcp-endpoint').inner_text().endswith('/mcp') and pg.get_by_test_id('mcp-tools').get_by_text('Search customers').count() == 1)
        pg.get_by_label('Key name').fill(f'UI read {run}')
        pg.get_by_role('button', name='Create key').click(); pg.wait_for_timeout(2000)
        key = pg.get_by_test_id('mcp-new-key').locator('code').inner_text().strip()
        check('read key shown once after creation', key.startswith('tsk_mcp_') and len(key) > 30)
        hashed = hashlib.sha256(key.encode()).hexdigest()
        check('only the SHA-256 hash is stored', sql(f"SELECT COUNT(*) FROM McpAccessKey WHERE keyHash='{hashed}'") == '1' and sql(f"SELECT COUNT(*) FROM McpAccessKey WHERE keyHash='{key}' OR prefix='{key}'") == '0')
        pg.reload(); pg.wait_for_timeout(2000)
        check('after reload the key is not shown again (prefix only)', key not in pg.content() and pg.get_by_test_id('mcp-key').filter(has_text=f'UI read {run}').count() == 1)
        st, r = mcp(key, 'initialize', {'protocolVersion': '2025-06-18', 'capabilities': {}, 'clientInfo': {'name': 'ui-test', 'version': '1'}})
        check('the key works over HTTP: initialize', st == 200 and r['result']['serverInfo']['name'] == 'tacksharp' and r['result']['protocolVersion'] == '2025-06-18', st)
        st, r = mcp(key, 'tools/list')
        names = [t['name'] for t in r['result']['tools']]
        check('read key: tools/list has no write tools', 'search_customers' in names and 'add_customer_note' not in names, names)
        st, r = mcp(key, 'tools/call', {'name': 'search_customers', 'arguments': {'query': f'Mcp Ui {run}'}})
        items = r['result']['structuredContent']['items']
        check('read tool returns the customer with the phone masked', len(items) == 1 and items[0]['phone'] == f'••••{run[-2:]}91' and f'9188{run}91' not in json.dumps(r), items)
        st, r = mcp(key, 'tools/call', {'name': 'add_customer_note', 'arguments': {'customerId': cid, 'note': 'x'}})
        check('write tool refused for a read key', r['result']['isError'] is True and 'write access' in r['result']['content'][0]['text'])
        st, _ = mcp(key, 'ping', origin='https://evil.example')
        check('a foreign browser Origin is refused (403)', st == 403, st)
        pg.get_by_label('Key name').fill(f'UI write {run}'); pg.get_by_label('Access').select_option('write')
        pg.get_by_role('button', name='Create key').click(); pg.wait_for_timeout(2000)
        wkey = pg.get_by_test_id('mcp-new-key').locator('code').inner_text().strip()
        st, r = mcp(wkey, 'tools/call', {'name': 'add_customer_note', 'arguments': {'customerId': cid, 'note': f'From the assistant {run}'}})
        check('write key adds a real note (author = the key)', r['result']['isError'] is False and sql(f"SELECT authorName FROM CustomerNote WHERE customerId='{cid}' AND body='From the assistant {run}'") == f'AI assistant (UI write {run})')
        pg.reload(); pg.wait_for_timeout(2000)
        row = pg.get_by_test_id('mcp-key').filter(has_text=f'UI read {run}')
        check('last used is shown', 'never' not in row.inner_text())
        row.get_by_role('button', name='Revoke').click(); pg.wait_for_timeout(1500)
        st, _ = mcp(key, 'ping')
        check('revoked key refused (401)', st == 401 and 'revoked' in row.inner_text(), st)
        pg.screenshot(path=os.path.join(SHOTS, 'mcp.png'), full_page=True)
        check('no page errors', not errs, '; '.join(errs)[:200])
    finally:
        sql(f"DELETE FROM McpAccessKey WHERE organizationId='{org}' AND name IN ('UI read {run}', 'UI write {run}')")
        sql(f"DELETE FROM Customer WHERE id='{cid}'")
    b.close()

print(f"\n{sum(results)}/{len(results)} passed")
raise SystemExit(0 if all(results) else 1)
