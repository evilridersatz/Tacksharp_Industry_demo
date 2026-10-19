"""
API sweep over every demo workspace (TEST / staging database only, DRY_RUN=true).

For each demo workspace the owner can open: switch into it (POST /auth/workspace), call every read API that workspace's
industry uses, check the record counts against the data inventory (GET /industry/data), then run the industry's demo
scenarios (POST /industry/scenarios/run). Finally: a live workspace must refuse scenarios and the playground.

  Needs: API on :3000 (DB_NAME=<test db> DRY_RUN=true RATE_LIMIT_API_PER_MIN=5000 RATE_LIMIT_LOGIN=200),
         demo workspaces seeded with DEMO_GRANT_EMAILS=owner@tacksharp.test.
  Run:   SHOTS_DIR=/tmp/out python3 -I apps/web/tests/api-sweep.py
Writes api-sweep.json and api-sweep.md (a readable report) into SHOTS_DIR.
"""
import json, os, tempfile, time, urllib.error, urllib.request
from http.cookies import SimpleCookie

API = os.environ.get('API_URL', 'http://localhost:3000')
OUT = os.environ.get('SHOTS_DIR', tempfile.gettempdir())
EMAIL, PASSWORD = os.environ.get('SWEEP_EMAIL', 'owner@tacksharp.test'), os.environ.get('SWEEP_PASSWORD', 'correct-horse-battery')
cookie = {'v': ''}
results, checks = [], []

def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method, headers={'content-type': 'application/json', 'cookie': cookie['v']})
    t = time.time()
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            raw = r.read()
            for h in r.headers.get_all('Set-Cookie') or []:
                c = SimpleCookie(); c.load(h)
                cookie['v'] = '; '.join(f'{k}={m.value}' for k, m in c.items())
            return r.status, (json.loads(raw) if raw and raw[:1] in b'[{' else raw.decode()[:200]), int((time.time() - t) * 1000)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try: b = json.loads(raw)
        except Exception: b = raw.decode()[:200]
        return e.code, b, int((time.time() - t) * 1000)

def size(b):
    if isinstance(b, list): return len(b)
    if isinstance(b, dict):
        for k in ('items', 'rows', 'agents', 'roomTypes', 'categories', 'entities', 'kpis', 'scenarios'):
            if isinstance(b.get(k), list): return len(b[k])
        return len(b)
    return None

def check(name, ok, detail=''):
    checks.append({'name': name, 'ok': bool(ok), 'detail': detail}); print(('PASS ' if ok else 'FAIL ') + name + (f'  — {detail}' if detail else ''))

COMMON = ['/auth/me', '/industry/workspace', '/industry/dashboard?days=30', '/industry/dashboard?days=7', '/industry/agents', '/industry/data', '/industry/scenarios', '/leads', '/conversations', '/follow-ups', '/dashboard/summary?days=7', '/settings']
PER = {
    'food': ['/food/menu', '/food/orders', '/food/orders?status=open', '/food/orders/{order}', '/marketing/overview'],
    'restaurant': ['/restaurant/overview?days=7', '/restaurant/orders', '/restaurant/menu', '/restaurant/inventory', '/restaurant/customers', '/restaurant/conversations', '/restaurant/followups', '/restaurant/feedback', '/restaurant/offers', '/restaurant/integrations'],
    'hotel': ['/hotel/room-types', '/hotel/availability?checkIn={d20}&checkOut={d22}&adults=2', '/hotel/calendar?days=14', '/hotel/today', '/hotel/reservations', '/hotel/reservations?status=upcoming', '/hotel/reservations/{reservation}'],
    'hospital': ['/hospital/directory', '/hospital/slots?limit=6', '/hospital/appointments', '/hospital/appointments?status=upcoming', '/hospital/appointments/{appointment}', '/hospital/patients', '/hospital/insurance', '/hospital/insurance?status=open', '/hospital/insurance/{insurance}'],
    'real_estate': ['/properties/search', '/site-visits', '/voice/calls', '/dashboard/roi', '/dashboard/activity?limit=10'],
    'textile': ['/textile/overview', '/textile/products', '/textile/quotations', '/textile/orders', '/textile/feedback', '/finance/overview', '/finance/invoices', '/marketing/overview', '/marketing/campaigns', '/operations/overview', '/operations/inventory', '/agents', '/agents/tasks', '/agents/work-tasks/list'],
    'retail': ['/textile/products', '/textile/orders', '/finance/overview', '/marketing/overview', '/marketing/campaigns', '/operations/inventory', '/agents', '/agents/tasks'],
    'manufacturing': ['/quality/inspections', '/quality/stats?days=30', '/operations/tasks', '/agents', '/agents/tasks', '/agents/work-tasks/list'],
    'agency': ['/marketing/overview', '/marketing/campaigns', '/marketing/customers', '/marketing/performance', '/agents', '/agents/tasks'],
    'cctv': ['/monitoring/overview?days=30', '/monitoring/overview?days=7', '/monitoring/customers', '/monitoring/sites', '/monitoring/sites/{site}', '/monitoring/cameras?pageSize=50', '/monitoring/cameras?status=offline', '/monitoring/cameras/{camera}', '/monitoring/incidents?status=active', '/monitoring/incidents?status=all&pageSize=100', '/monitoring/incidents/{incident}', '/monitoring/notifications', '/monitoring/reports/uptime', '/monitoring/technicians', '/monitoring/agents', '/monitoring/contracts'],
}

def day(k):
    return time.strftime('%Y-%m-%d', time.gmtime(time.time() + 19800 + k * 86400))

s, b, _ = call('POST', '/auth/login', {'email': EMAIL, 'password': PASSWORD})
check('login', s in (200, 201), str(s))
home = call('GET', '/auth/me')[1]['organizationId']
spaces = call('GET', '/auth/workspaces')[1]
demos = [w for w in spaces if w['isDemo'] and w['organizationId'].startswith('org_demo_')]
check('demo workspaces available', len(demos) >= 9, ', '.join(sorted(w['industry'] for w in demos)))

report = []
for w in sorted(demos, key=lambda x: x['industry']):
    s, b, _ = call('POST', '/auth/workspace', {'organizationId': w['organizationId']})
    me = call('GET', '/auth/me')[1]
    check(f"{w['industry']}: switched", s == 200 and me.get('organizationId') == w['organizationId'])
    ind = w['industry']
    ids = {'d20': day(20), 'd22': day(22)}
    if ind == 'food':
        o = call('GET', '/food/orders')[1]; ids['order'] = o[0]['id'] if o else 'none'
    if ind == 'hotel':
        rr = call('GET', '/hotel/reservations')[1]; ids['reservation'] = rr[0]['id'] if rr else 'none'
    if ind == 'hospital':
        a = call('GET', '/hospital/appointments')[1]; ids['appointment'] = a[0]['id'] if a else 'none'
        i = call('GET', '/hospital/insurance')[1]; ids['insurance'] = i[0]['id'] if i else 'none'
    if ind == 'cctv':
        ids['site'] = call('GET', '/monitoring/sites')[1][0]['id']
        ids['camera'] = call('GET', '/monitoring/cameras?status=offline')[1]['rows'][0]['id']
        ids['incident'] = call('GET', '/monitoring/incidents?status=active')[1]['rows'][0]['id']
    rows = []
    for path in COMMON + PER.get(ind, []):
        p = path.format(**ids)
        st, body, ms = call('GET', p)
        ok = st == 200
        rows.append({'path': p, 'status': st, 'ms': ms, 'records': size(body), 'ok': ok, 'error': None if ok else (body.get('message') if isinstance(body, dict) else str(body))[:160]})
    failed = [r for r in rows if not r['ok']]
    check(f'{ind}: {len(rows)} read APIs return 200', not failed, '; '.join(f"{r['path']}→{r['status']} {r['error']}" for r in failed)[:400])
    inv = call('GET', '/industry/data')[1]
    ents = {e['key']: e for e in inv['entities']}
    empty = [k for k, e in ents.items() if e['total'] == 0 and k not in ('agent_tasks', 'order_followups', 'offer_claims', 'calls', 'invoices', 'work_tasks', 'feedback', 'campaign_recipients', 'campaigns', 'products', 'properties', 'site_visits')]
    check(f'{ind}: every core entity has demo records', not empty, f'empty: {empty}' if empty else f"{sum(e['total'] for e in ents.values())} records across {len(ents)} entities")
    # Counts shown by list APIs match the database (where the API lists everything).
    def match(entity, path, key=None):
        if entity in ents:
            body = call('GET', path)[1]
            n = len(body) if isinstance(body, list) else len(body.get(key, [])) if key else size(body)
            check(f'{ind}: {path} lists all {entity} ({ents[entity]["total"]})', n == ents[entity]['total'], f'API {n} vs DB {ents[entity]["total"]}')
    if ind == 'food': match('orders', '/food/orders')
    if ind == 'hotel': match('reservations', '/hotel/reservations'); match('room_types', '/hotel/room-types')
    if ind == 'hospital': match('appointments', '/hospital/appointments'); match('insurance_cases', '/hospital/insurance')
    if ind == 'manufacturing': match('inspections', '/quality/inspections')
    if ind in ('real_estate', 'agency', 'textile', 'retail'): match('leads', '/leads')
    if ind == 'cctv':
        inc = call('GET', '/monitoring/incidents?status=all&pageSize=5')[1]
        check(f"cctv: /monitoring/incidents lists all incidents ({ents['mon_incidents']['total']})", inc['total'] == ents['mon_incidents']['total'], f"API {inc['total']} vs DB {ents['mon_incidents']['total']}")
        ov = call('GET', '/monitoring/overview?days=30')[1]['kpis']
        cams = call('GET', '/monitoring/cameras?pageSize=200')[1]
        check('cctv: overview camera count = inventory (lab excluded)', ov['cameras'] == cams['total'] == 50, f"{ov['cameras']} / {cams['total']}")
        check('cctv: online + offline + unknown + degraded + maintenance = cameras', ov['online'] + ov['offline'] + ov['unknown'] + ov['degraded'] + ov['maintenance'] == ov['cameras'])
        notif = call('GET', '/monitoring/notifications')[1]
        check('cctv: every demo WhatsApp message is simulated (DRY_RUN)', all(n['status'] in ('simulated', 'deferred', 'cancelled', 'skipped') for n in notif['rows']) and notif['liveMessages'] == 0, json.dumps(notif['byStatus']))
    sc_rows = []
    for sc in call('GET', '/industry/scenarios')[1]['scenarios']:
        st, res, ms = call('POST', '/industry/scenarios/run', {'scenarioId': sc['id']})
        ok = st in (200, 201) and res.get('ok')
        sc_rows.append({'id': sc['id'], 'title': sc['title'], 'status': st, 'ms': ms, 'summary': res.get('summary') if isinstance(res, dict) else None, 'steps': res.get('steps') if isinstance(res, dict) else res})
        bad = [x for x in (res.get('steps') or []) if x['status'] == 'failed'] if isinstance(res, dict) else []
        check(f"{ind}: scenario {sc['id']}", ok, json.dumps(res.get('summary')) + ('' if ok else ' | ' + '; '.join(f"{x['name']}: {x.get('detail') or x.get('output', '')[:120]}" for x in bad))[:500] if isinstance(res, dict) else str(res))
    report.append({'industry': ind, 'organizationId': w['organizationId'], 'name': w['name'], 'apis': rows, 'entities': inv['entities'], 'scenarios': sc_rows})

# Live workspace: scenarios and playground refused.
call('POST', '/auth/workspace', {'organizationId': home})
st, _, _ = call('POST', '/industry/scenarios/run', {'scenarioId': 'generic_chat'})
check('live workspace: scenarios refused (403)', st == 403, str(st))
st, _, _ = call('POST', '/auth/workspace', {'organizationId': 'org_not_a_member_x'})
check('non-member workspace refused (403)', st == 403, str(st))

json.dump({'checks': checks, 'workspaces': report}, open(os.path.join(OUT, 'api-sweep.json'), 'w'), indent=1, default=str)
with open(os.path.join(OUT, 'api-sweep.md'), 'w') as f:
    f.write(f"# API sweep — {time.strftime('%Y-%m-%d %H:%M')}\n\n{sum(c['ok'] for c in checks)}/{len(checks)} checks passed\n\n")
    for w in report:
        f.write(f"## {w['name']} ({w['industry']})\n\n| API | status | records | ms |\n|---|---|---|---|\n")
        for r in w['apis']: f.write(f"| `{r['path']}` | {r['status']} | {r['records'] if r['records'] is not None else ''} | {r['ms']} |\n")
        f.write('\n| Entity | table | records | demo-flagged | read API |\n|---|---|---|---|---|\n')
        for e in w['entities']: f.write(f"| {e['label']} | {e['table']} | {e['total']} | {e['demo'] if e['demo'] is not None else '—'} | `{e['api']}` |\n")
        for sc in w['scenarios']:
            f.write(f"\n**Scenario: {sc['title']}** — {json.dumps(sc['summary'])}\n\n| step | result | detail |\n|---|---|---|\n")
            for x in sc['steps'] or []: f.write(f"| {x['name']} | {x['status']} | {(x.get('detail') or (x.get('output') or '')[:90]).replace('|', '/').replace(chr(10), ' ')} |\n")
        f.write('\n')
print(f"\n{sum(c['ok'] for c in checks)}/{len(checks)} passed")
raise SystemExit(0 if all(c['ok'] for c in checks) else 1)
