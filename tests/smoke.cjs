const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(require.resolve('playwright', { paths: [process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES || process.cwd()] }));
(async () => {
  const root = path.resolve(__dirname, '..');
  const web = process.env.AUTH_MODE === 'web';
  const server = http.createServer((req, res) => {
    const name = req.url.split('?')[0] === '/' ? 'index.html' : req.url.split('?')[0].slice(1);
    if (!['index.html','app.js','auth.js','cloud.js','styles.css','manifest.webmanifest'].includes(name)) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html');
    res.end(fs.readFileSync(path.join(root,name)));
  });
  await new Promise(r => server.listen(0,'127.0.0.1',r));
  let browser;
  try {
    browser = await chromium.launch({headless:true});
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', e => errors.push(e.message));
    const requests = [], uploads = [], pdfs = [];
    const projects = [{id:'project-1',name:'Тестовый объект',status:'active'}];
    let expenses = [], failSave = false, delaySave = false;
    await page.route('https://telegram.org/**', r => r.fulfill({body:''}));
    await page.addInitScript(web => {
      window.Telegram = {WebApp:{initData:web ? '' : 'test-only',ready(){},expand(){},openLink(url){window.lastPdf=url;}}};
      const original = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = function(cb,...args) { const canvas=this; setTimeout(()=>original.call(canvas,cb,...args),200); };
      if (web) localStorage.setItem('adma.expenses', JSON.stringify([{supplier:'PRIVATE OLD CACHE',amount:999,date:'2026-09-01'}]));
    }, web);
    // No request reaches Supabase. Exercise actual browser XHR, multipart and DOM handlers.
    await page.route('https://blaacuwwvyatfiyjnsrw.supabase.co/**', async route => {
      const req=route.request(), url=req.url();
      let data = {ok:true}, status=200;
      if (url.endsWith('/receipt-upload')) {
        assert.match(req.headers()['content-type'],/^multipart\/form-data; boundary=/);
        const body=req.postDataBuffer();
        assert(body.includes(Buffer.from('name="file"; filename="receipt.jpg"')));
        assert(body.includes(Buffer.from('Content-Type: image/jpeg')));
        if(web){assert(body.includes(Buffer.from('test-token')));assert(!body.includes(Buffer.from('name="initData"')));}
        uploads.push(body); data.path='user/receipt-'+uploads.length+'.jpg';
      } else if (url.endsWith('/reimbursement-pdf')) {
        const body=req.postDataBuffer().toString(); if(web)assert(body.includes('test-token')); pdfs.push(body);
        data={ok:true,url:'https://example.test/export.pdf',count:expenses.length,total:100};
      } else {
        assert.equal(req.method(),'POST');
        assert.match(req.headers()['content-type'],/^text\/plain/);
        const body=JSON.parse(req.postData()); requests.push(body);
        if(url.endsWith('/adma-api') && web) assert.equal(body.accessToken,'test-token');
        if(url.endsWith('/telegram-auth')) data.user={id:'user',role:'owner',is_active:true};
        else if(url.endsWith('/web-auth')) {
          if(body.action==='login' && body.password!=='test-password-123') {status=401;data={error:'invalid_credentials'};}
          else if(body.action==='logout') data={ok:true};
          else data={ok:true,session:{access_token:'test-token',refresh_token:'test-refresh',expires_at:Math.floor(Date.now()/1000)+3600}};
        }
        else if(body.action==='load') data={ok:true,projects,expenses,current_user:{id:'user',role:'owner',is_active:true,web_login:web?'ilya':null}};
        else if(body.action==='create_expense') {
          if(delaySave) await new Promise(r=>setTimeout(r,200));
          if(failSave) {status=500; data={error:'test_save_failure'};failSave=false;}
          else {const e={...body.expense,id:'expense-'+(expenses.length+1)};expenses.push(e);data.expense=e;}
        } else if(body.action==='update_expense') {Object.assign(expenses.find(e=>e.id===body.expense.id),body.expense);}
        else if(body.action==='mark_reimbursed') expenses.find(e=>e.id===body.id).reimbursed=true;
        else if(body.action==='delete_expense') expenses=expenses.filter(e=>e.id!==body.id);
        else throw Error('Unexpected action '+body.action);
      }
      await route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
    });
    const until = async fn => {for(let i=0;i<100;i++){if(await fn())return;await new Promise(r=>setTimeout(r,30));}throw Error('Timed out');};
    const submit = () => page.evaluate(()=>expenseForm.requestSubmit());
    const open = async () => {await page.evaluate(()=>openExpense('project-1'));await page.fill('#eAmount','100');};
    const closed = () => until(()=>page.evaluate(()=>!expenseDlg.open && !eAmount.disabled));
    const photo = async () => {
      const png=await page.evaluate(()=>{const c=document.createElement('canvas');c.width=1600;c.height=800;c.getContext('2d').fillRect(0,0,1600,800);return c.toDataURL().split(',')[1];});
      await page.setInputFiles('#eReceipt',{name:'check.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
    };
    const pass = name => console.log('PASS '+name);
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    if(web) {
      await page.locator('#loginForm').waitFor();
      assert(!(await page.locator('#app').innerText()).includes('PRIVATE OLD CACHE'));
      await page.fill('#webLogin','ilya');await page.fill('#webPassword','wrong-password');await page.click('#loginForm button');
      await until(()=>page.locator('#loginError').innerText().then(t=>t.includes('Неверный')));pass('wrong password rejected');
      await page.fill('#webPassword','test-password-123');await page.click('#loginForm button');
    }
    await until(()=>page.evaluate(()=>document.getElementById('cloudBanner')?.textContent.includes('Облако подключено')));pass('application loads');
    await open();await submit();await closed();assert.equal(expenses.length,1);assert.equal(expenses[0].receipt_path,null);pass('create without receipt');
    await open();await photo();await submit();await closed();assert.equal(expenses.length,2);assert.equal(expenses[1].receipt_path,'user/receipt-1.jpg');pass('create with receipt while compression is pending');
    await page.evaluate(()=>editExpense('expense-2'));await page.fill('#eAmount','250');await submit();await closed();assert.equal(expenses[1].amount,250);assert.equal(expenses[1].receipt_path,'user/receipt-1.jpg');pass('edit preserves receipt');
    await page.click('[data-tab="due"]');await page.click('#pdfAllPending');await until(()=>pdfs.length===1);assert(!pdfs[0].includes('expense_ids'));pass('PDF all pending');
    await page.click('#pdfPickPending');await page.locator('.pdfExpenseCheck').first().uncheck();await page.click('#pdfBuildSelected');await until(()=>pdfs.length===2);assert(pdfs[1].includes('["expense-2"]'));await until(()=>page.evaluate(()=>!document.getElementById('pdfDlg').open));pass('PDF selected');
    await page.evaluate(()=>details('expense-1'));await page.click('#markPaid');await until(()=>expenses[0].reimbursed);await until(()=>page.evaluate(()=>!detailDlg.open));pass('mark reimbursed');
    page.on('dialog',d=>d.accept());await page.evaluate(()=>details('expense-1'));await page.click('#del');await until(()=>expenses.length===1);await until(()=>page.evaluate(()=>!detailDlg.open));pass('delete expense');
    await open();await photo();failSave=true;await submit();await until(()=>page.evaluate(()=>document.getElementById('cloudBanner')?.textContent.includes('test_save_failure')));
    const uploadCount=uploads.length;await submit();await closed();assert.equal(uploads.length,uploadCount);assert.equal(expenses.at(-1).receipt_path,'user/receipt-2.jpg');pass('failed save retries without uploading photo again');
    await open();delaySave=true;const count=requests.filter(r=>r.action==='create_expense').length;await page.evaluate(()=>{expenseForm.requestSubmit();expenseForm.requestSubmit();});await closed();assert.equal(requests.filter(r=>r.action==='create_expense').length,count+1);pass('double submit creates one expense');
    if(web) {
      await page.evaluate(()=>{const s=JSON.parse(localStorage.getItem('adma.web.session'));s.expires_at=0;localStorage.setItem('adma.web.session',JSON.stringify(s));});
      await open();await submit();await closed();assert(requests.some(r=>r.action==='refresh'));pass('expired session refreshes before save');
      await page.click('[data-tab="more"]');await page.click('#webLogout');await page.locator('#loginForm').waitFor();
      assert.equal(await page.evaluate(()=>localStorage.getItem('adma.web.session')),null);pass('logout hides financial data');
    }
    assert.deepEqual(errors,[]);pass('no uncaught browser errors');
  } finally {if(browser)await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
