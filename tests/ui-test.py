from playwright.sync_api import sync_playwright
import sys
KEY='ui-test-admin-key-1'; BASE='http://127.0.0.1:3456'
errs=[]; fails=[]
def check(c,m):
    print(('  PASS  ' if c else '  FAIL  ')+m)
    if not c: fails.append(m)
with sync_playwright() as p:
    b=p.chromium.launch(); ctx=b.new_context(viewport={'width':1400,'height':900},bypass_csp=True); pg=ctx.new_page()
    pg.on('console',lambda m: errs.append(m.text) if m.type=='error' else None)
    pg.on('pageerror',lambda e: errs.append('PAGEERROR '+str(e)))
    pg.goto(BASE+'/'); pg.wait_for_selector('#login:not([hidden])')
    pg.fill('#key','wrong-key-wrong'); pg.click('#go'); pg.wait_for_function("document.getElementById('lerr').textContent.length>0")
    check('Wrong' in pg.inner_text('#lerr'),'wrong key is rejected')
    pg.fill('#key',KEY); pg.click('#go'); pg.wait_for_selector('#app:not([hidden])'); pg.wait_for_selector('main h2')
    check('Dashboard' in pg.inner_text('main h2'),'login works and the dashboard opens')
    check('DRY-RUN' in pg.inner_text('main'),'dry-run banner is shown')
    for tab in ['dashboard','needs','chat','monitor','autopilot','skills','newpost','business','catalogue','reviews','leads','orders','groups','settings','history']:
        pg.goto(BASE+'/#'+tab); pg.wait_for_function("document.querySelector('main h2')!==null && !document.querySelector('main').innerText.includes('Something went wrong')", timeout=8000)
        t=pg.inner_text('main'); check('Something went wrong' not in t, 'tab renders: '+tab)
    # Catalogue: add product + upload photos
    pg.goto(BASE+'/#catalogue'); pg.wait_for_selector('text=Add product'); pg.click('button:has-text("Add product") >> nth=0')
    pg.wait_for_selector('h3:has-text("Add a product")')
    labels={'Name':'Oak Wardrobe','Price £':'399','Category':'Wardrobes'}
    for l,v in labels.items(): pg.locator(f'label:text-is("{l}") + input').first.fill(v)
    pg.locator('label:text-is("Description") + textarea').fill('Three door oak wardrobe')
    pg.click('button:has-text("Add product") >> nth=-1'); pg.wait_for_selector('td:has-text("Oak Wardrobe")')
    check(True,'product added from the catalogue screen')
    pg.locator('tr:has-text("Oak Wardrobe") button:has-text("Edit")').click(); pg.wait_for_selector('h3:has-text("Photos")')
    pg.set_input_files('input[type=file]',['/tmp/sofa1.jpg','/tmp/sofa2.jpg']); pg.click('button:has-text("Upload photos")'); pg.wait_for_selector('.thumbs img', timeout=8000); pg.wait_for_timeout(600)
    n=pg.locator('.thumbs img').count(); check(n==2,f'2 photos uploaded and shown ({n})')
    ok=pg.evaluate("fetch(document.querySelector('.thumbs img').src).then(r=>r.status)"); check(ok==200,'uploaded photo is served')
    # test message -> needs me -> answer + remember -> reused
    pg.goto(BASE+'/#chat'); pg.wait_for_selector('summary:has-text("Try a test message")'); pg.click('summary:has-text("Try a test message")')
    pg.locator('label:text-is("Message") + textarea').fill('Do you do fitting?'); pg.click('button:text-is("Test")'); pg.wait_for_selector('text=asked me')
    check(True,'unclear test message is sent to "needs my help"')
    pg.goto(BASE+'/#needs'); pg.wait_for_selector('.box.q'); t=pg.inner_text('main')
    check('Do you do fitting?' in t and 'What I need from you' in t,'question shows the message, context and what is needed')
    nav=pg.inner_text('nav'); check('Needs me' in nav,'needs-me badge present in the navigation')
    pg.locator('label:text-is("Reply to send to the customer") + textarea').fill('We do not offer fitting, but our team will bring it to your room.')
    pg.locator('input[type=checkbox]').first.check(); pg.screenshot(path='/tmp/shot-needs.png')
    pg.click('button:has-text("Send and save")'); pg.wait_for_selector('text=Nothing needs your help', timeout=8000)
    check(True,'answer saved and the question closed')
    pg.goto(BASE+'/#skills'); pg.wait_for_selector('.box textarea'); check('fitting' in pg.inner_text('main').lower(),'saved knowledge is listed with its keywords')
    pg.goto(BASE+'/#chat'); pg.wait_for_selector('summary:has-text("Try a test message")'); pg.click('summary:has-text("Try a test message")')
    pg.locator('label:text-is("Customer name") + input').fill('Someone Else'); pg.locator('label:text-is("Message") + textarea').fill('do you offer fitting please'); pg.click('button:text-is("Test")'); pg.wait_for_selector('.ctx >> text=Decision')
    t=pg.inner_text('details .ctx'); check('fitting' in t.lower() and 'asked me' not in t,'similar message is answered from approved knowledge (no new question)')
    # chat customer panel + postcode validation
    pg.locator('.cust').first.click(); pg.wait_for_selector('label:text-is("UK postcode")')
    pg.locator('label:text-is("UK postcode") + input').fill('NOT A CODE'); pg.click('button:has-text("Save customer")'); pg.wait_for_selector('#toast:visible'); check('valid UK postcode' in pg.inner_text('#toast'),'invalid postcode is rejected with a clear message')
    pg.locator('label:text-is("UK postcode") + input').fill('m145tq'); pg.locator('label:text-is("Address line 1") + input').fill('14 Oak Road'); pg.click('button:has-text("Save customer")'); pg.wait_for_timeout(500)
    pg.locator('.cust').first.click(); pg.wait_for_timeout(500); v=pg.locator('label:text-is("UK postcode") + input').input_value(); check(v=='M14 5TQ','postcode is normalised and saved (M14 5TQ)')
    pg.screenshot(path='/tmp/shot-chat.png')
    # live mode needs confirmation
    pg.goto(BASE+'/#autopilot'); pg.wait_for_selector('button:has-text("Go live")')
    pg.once('dialog',lambda d: d.dismiss()); pg.click('button:has-text("Go live")'); pg.wait_for_timeout(500); check('DRY-RUN' in pg.inner_text('main'),'going live asks for confirmation and stays in dry-run when cancelled')
    pg.goto(BASE+'/#monitor'); pg.wait_for_selector('h3:has-text("Configuration")'); check('GRAPH_VERSION' in pg.inner_text('main'),'monitor shows real configuration status')
    pg.set_viewport_size({'width':390,'height':800}); pg.goto(BASE+'/#dashboard'); pg.wait_for_selector('main h2'); check(pg.evaluate('document.documentElement.scrollWidth')<=400,'mobile layout does not overflow sideways')
    b.close()
real=[e for e in errs if 'favicon' not in e and '401' not in e and 'status of 400' not in e]
check(len(real)==0,'no browser console or script errors'+(' -> '+'; '.join(real[:3]) if real else ''))
print('\nUI: '+('ALL PASSED' if not fails else str(len(fails))+' FAILED'))
sys.exit(1 if fails else 0)
