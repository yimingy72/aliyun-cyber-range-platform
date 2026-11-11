import base64, hashlib, http.cookiejar, json, secrets
from html.parser import HTMLParser
from urllib.error import HTTPError
from urllib.parse import parse_qs, urlencode, urljoin, urlsplit
from urllib.request import build_opener, Request, ProxyHandler, HTTPCookieProcessor, HTTPRedirectHandler

kc = 'http://127.0.0.1:13463'
issuer = kc + '/realms/cyber-range'
web = mcp = kc
api = kc + '/api'
password='fixture-only-2026-strong'
cid='bc0e793f-4d21-4c8c-8d49-16d664b2ec50'
def verifier(): return secrets.token_urlsafe(48)
def challenge(s): return base64.urlsafe_b64encode(hashlib.sha256(s.encode()).digest()).decode().rstrip('=')

class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args): return None
class Login(HTMLParser):
    active=False
    action=None
    def __init__(self): super().__init__(); self.fields={}
    def handle_starttag(self,tag,attrs):
        a=dict(attrs)
        if tag=='form' and a.get('id')=='kc-form-login':
            self.action=a['action']; self.active=True
        if self.active and tag=='input' and a.get('type')=='hidden' and a.get('name'):
            self.fields[a['name']]=a.get('value','')
    def handle_endtag(self,tag):
        if tag=='form': self.active=False
class Approval(HTMLParser):
    value=None
    def handle_starttag(self,tag,attrs):
        a=dict(attrs)
        if tag=='input' and a.get('name')=='handle': self.value=a.get('value')
        if tag=='a' and a.get('rel')=='noreferrer': self.value=a.get('href')
def browser(): return build_opener(ProxyHandler({}), HTTPCookieProcessor(http.cookiejar.CookieJar(policy=http.cookiejar.DefaultCookiePolicy(secure_protocols=('https','wss','http')))), NoRedirect())

def req(client,url,method=None,data=None,form=False,headers=None,expect=200):
    assert urlsplit(url).hostname == '127.0.0.1' and urlsplit(url).port == 13463
    headers=dict(headers or {})
    if data is not None:
        headers['Content-Type']='application/x-www-form-urlencoded' if form else 'application/json'
        data=(urlencode(data) if form else json.dumps(data)).encode()
    try: r=client.open(Request(url,method=method,data=data,headers=headers),timeout=10)
    except HTTPError as e: r=e
    with r:
        b=r.read().decode()
        assert r.code in ([expect] if isinstance(expect,int) else expect), (urlsplit(url).path,r.code,b[:350])
        return b,r.headers

def login(browser_client, auth_url, username):
    html,_=req(browser_client,auth_url)
    assert 'data-platform-theme="cel"' in html and '/js/platform-theme.js?v=1' in html
    assert '/css/styles.css?v=platform-themes-v4' in html
    form=Login(); form.feed(html)
    assert form.action
    _, headers=req(browser_client,form.action,data={**form.fields,'username':username,'password':password},form=True,expect=(302,303))
    return headers['Location']

def web_token(username):
    b=browser(); v=verifier(); cb=web+'/admin/callback'
    url=issuer+'/protocol/openid-connect/auth?'+urlencode(dict(client_id='cyber-range',redirect_uri=cb,response_type='code',scope='openid web-access',state='web-test',code_challenge_method='S256',code_challenge=challenge(v)))
    location=login(b,url,username)
    params=parse_qs(urlsplit(location).query)
    assert params['state']==['web-test']
    data=dict(grant_type='authorization_code',code=params['code'][0],redirect_uri=cb,code_verifier=v)
    req(b,web+'/auth/oidc/token',data=data,form=True,headers={'Origin':'http://127.0.0.1:13461'},expect=403)
    payload,_=req(b,web+'/auth/oidc/token',data=data,form=True,headers={'Origin':web})
    token=json.loads(payload)['access_token']
    claims=token.split('.')[1]
    assert 'kc-admin-api' not in json.loads(base64.urlsafe_b64decode(claims+'='*(-len(claims)%4))).get('scope','').split()
    return token

def mcp_token(username,scope=None,decision='yes'):
    b=browser(); v=verifier()
    redirect='http://127.0.0.1:13465/oauth-fixture'
    register,_=req(b,mcp+'/mcp/oauth/register',data={'redirect_uris':[redirect]},expect=201)
    client=json.loads(register)['client_id']
    query=dict(client_id=client,redirect_uri=redirect,response_type='code',state='mcp-test',code_challenge_method='S256',code_challenge=challenge(v),resource=mcp+'/mcp')
    if scope: query['scope']=scope
    _,headers=req(b,mcp+'/mcp/oauth/authorize?'+urlencode(query),expect=302)
    location=login(b,headers['Location'],username)
    consent,headers=req(b,location)
    assert 'data-platform-theme="cel"' in consent and '授权工具访问靶场' in consent
    assert headers['Cache-Control']=='no-store' and "frame-ancestors 'none'" in headers['Content-Security-Policy']
    assert "form-action 'self'" in headers['Content-Security-Policy']
    if scope: assert '申请范围：'+scope in consent
    approval=Approval(); approval.feed(consent); assert approval.value
    complete,headers=req(b,mcp+'/mcp/oauth/approve',data={'handle':approval.value,'decision':decision},form=True,headers={'Origin':mcp})
    assert 'data-platform-theme="cel"' in complete and 'http-equiv="refresh"' in complete
    assert headers['Cache-Control']=='no-store' and headers['Referrer-Policy']=='no-referrer'
    assert "form-action 'none'" in headers['Content-Security-Policy']
    destination=Approval(); destination.feed(complete); assert destination.value
    assert destination.value.startswith(redirect+'?')
    params=parse_qs(urlsplit(destination.value).query)
    assert params['state']==['mcp-test']
    if decision=='no':
        assert params['error']==['access_denied'] and 'code' not in params
        return None,client
    data=dict(grant_type='authorization_code',client_id=client,redirect_uri=redirect,code=params['code'][0],code_verifier=v,resource=mcp+'/mcp')
    req(b,mcp+'/mcp/oauth/token',data={**data,'code_verifier':verifier()},form=True,expect=400)
    payload,_=req(b,mcp+'/mcp/oauth/token',data=data,form=True)
    req(b,mcp+'/mcp/oauth/token',data=data,form=True,expect=400)
    return json.loads(payload),client

def use_api(token,path,expect=200,workspace=None):
    headers={'Authorization':'Bearer '+token}
    if workspace: headers['x-cloud-workspace-id']=workspace
    body,_=req(browser(),api+path,headers=headers,expect=expect)
    return json.loads(body)
def use_mcp(token,method='tools/list',params=None,expect=200,workspace=None):
    headers={'Authorization':'Bearer '+token,'Accept':'application/json, text/event-stream'}
    if workspace: headers['x-cloud-workspace-id']=workspace
    b,_=req(browser(),mcp+'/mcp',data={'jsonrpc':'2.0','id':1,'method':method,'params':params or {}},headers=headers,expect=expect)
    return json.loads(next((s[5:].strip() for s in b.splitlines() if s.startswith('data:')),b))

owner=web_token('fixture-owner')
assert use_api(owner,'/admin/session')['id']=='fixture-legacy-owner'
assert any(row['id']=='fixture-template-private' for row in use_api(owner,'/admin/scenarios?view=mine'))
use_api(owner,'/admin/scenarios',expect=403,workspace='fixture-beta')
unassigned=web_token('fixture-unassigned')
use_api(unassigned,'/admin/session',expect=403)
operator=web_token('fixture-super')
assert use_api(operator,'/admin/session')['isPlatformManager']
beta = [r['id'] for r in use_api(operator,'/admin/scenarios?view=platform',workspace='fixture-beta')]
assert beta == ['fixture-template-beta'], beta
admin=web_token('fixture-admin')
assert use_api(admin,'/admin/session')['role']=='admin'
assert use_api(admin,'/admin/session')['isPlatformManager']
assert [r['id'] for r in use_api(admin,'/admin/scenarios?view=platform',workspace='fixture-beta')]==['fixture-template-beta']
use_api(admin,'/admin/users',expect=404)
assert any(r['id']=='fixture-legacy-owner' for r in use_api(admin,'/admin/billing/workspace-members',workspace='fixture-alpha'))
use_api(owner,'/admin/billing/workspace-members',expect=403)
use_mcp(admin,expect=401)

narrow,client=mcp_token('fixture-member','templates:read')
assert mcp_token('fixture-member','templates:read',decision='no')[0] is None
access=narrow['access_token']
tools=[t['name'] for t in use_mcp(access)['result']['tools']]
assert 'range_template_list' in tools and 'platform_image_list' not in tools and not any(t.startswith('admin_user_') for t in tools)
use_api(access,'/admin/session',expect=401)
req(browser(),mcp+'/mcp/oauth/token',data={'grant_type':'refresh_token','client_id':client,'refresh_token':narrow['refresh_token'],'scope':'images:read'},form=True,expect=400)
renewed,_=req(browser(),mcp+'/mcp/oauth/token',data={'grant_type':'refresh_token','client_id':client,'refresh_token':narrow['refresh_token'],'scope':'templates:read'},form=True)
use_mcp(access,expect=401)
assert 'range_template_list' in [t['name'] for t in use_mcp(json.loads(renewed)['access_token'])['result']['tools']]

session,_=mcp_token('fixture-admin')
gateway=session['access_token']
assert any(t['name'].startswith('billing_') for t in use_mcp(gateway)['result']['tools'])
assert not use_mcp(gateway,method='tools/call',params={'name':'range_template_list','arguments':{'view':'platform'}},workspace='fixture-beta')['result'].get('isError')
root,_=req(browser(),kc+'/realms/master/protocol/openid-connect/token',data={'grant_type':'password','client_id':'admin-cli','username':'fixture-admin-root','password':password},form=True)
headers={'Authorization':'Bearer '+json.loads(root)['access_token']}
registered=json.loads(req(browser(),kc+'/admin/realms/cyber-range/clients',headers=headers)[0])
assert {r['clientId'] for r in registered} == {'account','account-console','admin-cli','broker','realm-management','security-admin-console','cyber-range'}
role_url=f'{kc}/admin/realms/cyber-range/clients/{cid}/roles/'
roles={r:json.loads(req(browser(),role_url+r,headers=headers)[0]) for r in ('user','admin')}
assert {r['name'] for r in json.loads(req(browser(),f'{kc}/admin/realms/cyber-range/clients/{cid}/roles',headers=headers)[0])}=={'user','admin'}
user_url=f'{kc}/admin/realms/cyber-range/users/bc0e793f-4d21-4c8c-8d49-16d664b2ec63'
path=f'{user_url}/role-mappings/clients/{cid}'
req(browser(),path,method='POST',data=[roles['user']],headers=headers,expect=204)
req(browser(),path,method='DELETE',data=[roles['admin']],headers=headers,expect=204)
try:
    downgraded=use_api(admin,'/admin/session')
    assert downgraded['role']=='user' and not downgraded['isPlatformManager']
    use_api(admin,'/admin/scenarios',expect=403,workspace='fixture-beta')
    use_mcp(gateway,expect=403,workspace='fixture-beta')
    assert not any(t['name'].startswith('billing_') for t in use_mcp(gateway)['result']['tools'])
    req(browser(),user_url,method='PUT',data={'enabled':False},headers=headers,expect=204)
    use_api(admin,'/admin/session',expect=401)
    use_mcp(gateway,expect=401)
finally:
    req(browser(),user_url,method='PUT',data={'enabled':True},headers=headers,expect=204)
    req(browser(),path,method='POST',data=[roles['admin']],headers=headers,expect=204)
    req(browser(),path,method='DELETE',data=[roles['user']],headers=headers,expect=204)

print('Verified real Web code exchange, stable owner, new user, workspace isolation and unified administrator permissions, MCP scope narrowing/refresh, audience separation, immediate downgrade and disable.')
