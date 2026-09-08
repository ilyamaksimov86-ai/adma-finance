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
    const projects = [{id:'project-1',name:'Тестовый объект',status:'in_progress',address:'Москва, ул. Тестовая, 1',area_sqm:86.5,client_name:'Иван Петров',client_phone:'+7 900 000-00-00',start_date:'2026-09-01',planned_end_date:'2027-02-15',contract_number:'АДМА-17'}, {id:'project-2',name:'Другой объект',status:'active'}, {id:'project-3',name:'Пустой объект',status:'preparation'}];
    let stages = [{id:'stage-1',project_id:'project-1',name:'Подготовка',position:0,progress:100,status:'completed',planned_start:'2026-08-20',planned_end:'2026-08-31',actual_start:'2026-08-20',actual_end:'2026-08-30',work_cost:50000},{id:'stage-2',project_id:'project-1',name:'Электрика',position:10,progress:40,status:'delayed',planned_start:'2026-09-01',planned_end:'2026-09-05',actual_start:'2026-09-02',comment:'Черновой монтаж'}];
    let expenses = [], acts = [], actCosts = [], actPayments = [], waybills = [], waybillPayments = [], companyExpenses = [], masters = [], masterAssignments = [], failSave = false, delaySave = false;
    const projectResponsibles=[{project_id:'project-1',user_id:'foreman-1',role:'member',user:{id:'foreman-1',first_name:'Дмитрий',role:'foreman',is_active:true,telegram_username:'foreman'}}];
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
        if((url.endsWith('/adma-api')||url.endsWith('/finance-api')||url.endsWith('/masters-api')) && web) assert.equal(body.accessToken,'test-token');
        if(url.endsWith('/telegram-auth')) data.user={id:'user',role:'owner',is_active:true};
        else if(url.endsWith('/web-auth')) {
          if(body.action==='login' && body.password!=='test-password-123') {status=401;data={error:'invalid_credentials'};}
          else if(body.action==='logout') data={ok:true};
          else data={ok:true,session:{access_token:'test-token',refresh_token:'test-refresh',expires_at:Math.floor(Date.now()/1000)+3600}};
        }
        else if(url.endsWith('/masters-api')&&body.action==='load') data={ok:true,masters,assignments:masterAssignments,project_responsibles:projectResponsibles};
        else if(url.endsWith('/masters-api')&&body.action==='save_master'){const value={...body.master,primary_specialty:body.master.primary_specialty,additional_skills:body.master.additional_skills||[],price_level:body.master.price_level,is_active:true};if(body.master.id)Object.assign(masters.find(x=>x.id===body.master.id),value);else masters.push({...value,id:'master-'+(masters.length+1)});}
        else if(url.endsWith('/masters-api')&&body.action==='set_master_archived'){masters.find(x=>x.id===body.id).is_active=!body.archived;}
        else if(url.endsWith('/masters-api')&&body.action==='save_assignment'){
          const a=body.assignment,other=masterAssignments.find(x=>x.master_id===a.master_id&&x.project_id!==a.project_id&&['planned','active'].includes(x.status)&&x.start_date<=(a.planned_end_date||'9999-12-31')&&(!x.planned_end_date||x.planned_end_date>=a.start_date));
          if(other&&!body.allow_conflict){status=409;data={error:'assignment_conflict'};}
          else {const value={...a,master_id:a.master_id,project_id:a.project_id,stage_id:a.stage_id,start_date:a.start_date,planned_end_date:a.planned_end_date,actual_end_date:a.actual_end_date};if(a.id)Object.assign(masterAssignments.find(x=>x.id===a.id),value);else masterAssignments.push({...value,id:'assignment-'+(masterAssignments.length+1)});}
        }
        else if(url.endsWith('/masters-api')&&body.action==='cancel_assignment')masterAssignments.find(x=>x.id===body.id).status='cancelled';
        else if(url.endsWith('/finance-api')&&body.action==='load') data={ok:true,acts,act_costs:actCosts,act_payments:actPayments,waybills,waybill_payments:waybillPayments,company_expenses:companyExpenses};
        else if(url.endsWith('/finance-api')&&body.action==='save_act'){if(body.act.id)Object.assign(acts.find(x=>x.id===body.act.id),body.act);else acts.push({...body.act,id:'act-'+(acts.length+1)});}
        else if(url.endsWith('/finance-api')&&body.action==='delete_act')acts=acts.filter(x=>x.id!==body.id);
        else if(url.endsWith('/finance-api')&&body.action==='add_act_cost')actCosts.push({id:'act-cost-'+(actCosts.length+1),act_id:body.act_id,cost_date:body.date,amount:body.amount,description:body.comment});
        else if(url.endsWith('/finance-api')&&body.action==='add_act_payment')actPayments.push({id:'act-payment-'+(actPayments.length+1),act_id:body.act_id,payment_date:body.date,amount:body.amount,comment:body.comment});
        else if(url.endsWith('/finance-api')&&body.action==='delete_act_cost')actCosts=actCosts.filter(x=>x.id!==body.id);
        else if(url.endsWith('/finance-api')&&body.action==='delete_act_payment')actPayments=actPayments.filter(x=>x.id!==body.id);
        else if(url.endsWith('/finance-api')&&body.action==='save_waybill'){if(body.waybill.id)Object.assign(waybills.find(x=>x.id===body.waybill.id),body.waybill);else waybills.push({...body.waybill,id:'waybill-'+(waybills.length+1)});}
        else if(url.endsWith('/finance-api')&&body.action==='delete_waybill')waybills=waybills.filter(x=>x.id!==body.id);
        else if(url.endsWith('/finance-api')&&body.action==='add_waybill_payment')waybillPayments.push({id:'waybill-payment-'+(waybillPayments.length+1),waybill_id:body.waybill_id,payment_date:body.date,amount:body.amount,comment:body.comment});
        else if(url.endsWith('/finance-api')&&body.action==='delete_waybill_payment')waybillPayments=waybillPayments.filter(x=>x.id!==body.id);
        else if(url.endsWith('/finance-api')&&body.action==='save_company_expense'){if(body.expense.id)Object.assign(companyExpenses.find(x=>x.id===body.expense.id),body.expense);else companyExpenses.push({...body.expense,id:'company-'+(companyExpenses.length+1),author:{first_name:'Илья'}});}
        else if(url.endsWith('/finance-api')&&body.action==='delete_company_expense')companyExpenses=companyExpenses.filter(x=>x.id!==body.id);
        else if(body.action==='load') data={ok:true,projects,expenses,stages,current_user:{id:'user',role:'owner',is_active:true,web_login:web?'ilya':null}};
        else if(body.action==='create_project') {const p={...body.project,id:'project-'+(projects.length+1)};projects.push(p);data.project=p;}
        else if(body.action==='update_project') {const p=projects.find(p=>p.id===body.project.id);Object.assign(p,body.project);data.project=p;}
        else if(body.action==='create_stage') {const s={...body.stage,id:'stage-'+(stages.length+1),created_at:new Date().toISOString()};stages.push(s);data.stage=s;}
        else if(body.action==='update_stage') {const s=stages.find(s=>s.id===body.stage.id);Object.assign(s,body.stage);data.stage=s;}
        else if(body.action==='delete_stage') stages=stages.filter(s=>s.id!==body.id);
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
    const switchTab = async name => {const side=page.locator(`[data-side-tab="${name}"]`);if(await side.isVisible())await side.click();else await page.click(`[data-tab="${name}"]`);};
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
    assert.equal(await page.locator('.sidebar').isVisible(),true);assert.match(await page.locator('#app').innerText(),/Требует внимания/);assert.match(await page.locator('.brand').innerText(),/ADMA/);
    assert.deepEqual(await page.locator('.side-nav [data-side-tab] b').allTextContents(),['Главная','Объекты','Финансы','Заявки','Дизайнеры','Мастера']);pass('desktop dashboard matches the approved application shell');
    await switchTab('finance');assert.match(page.url(),/#\/finance$/);assert.equal(await page.locator('[data-global-finance-section]').count(),2);await page.click('[data-global-finance-section="general"]');assert.match(await page.locator('#app').innerText(),/Не связаны с объектами/);
    for(const [tab,label] of [['leads','Заявки'],['designers','Дизайнеры'],['masters','Мастера']]){await switchTab(tab);assert.match(page.url(),new RegExp('#/'+tab+'$'));assert.match(await page.locator('#app').innerText(),new RegExp(label));}pass('all primary routes open');
    await switchTab('masters');await page.click('#addMaster');await page.fill('#masterEditDlg [name="name"]','Иван Мастер');await page.fill('#masterEditDlg [name="phone"]','+7 900 111-22-33');await page.fill('#masterEditDlg [name="telegram"]','@ivanmaster');await page.selectOption('#masterEditDlg [name="specialty"]','electrical');await page.selectOption('#masterEditDlg [name="skills"]',['rough','universal']);await page.fill('#masterEditDlg [name="rating"]','4.7');await page.selectOption('#masterEditDlg [name="price"]','high');await page.locator('#masterEditDlg form').evaluate(f=>f.requestSubmit());await until(()=>masters.length===1);await until(()=>page.locator('[data-master-id]').count().then(n=>n===1));
    await page.fill('#masterSearch','Иван');assert.equal(await page.locator('[data-master-id]').count(),1);await page.fill('#masterSearch','Нет такого');assert.equal(await page.locator('[data-master-id]').count(),0);await page.fill('#masterSearch','');await page.selectOption('#masterSpecialty','electrical');assert.equal(await page.locator('[data-master-id]').count(),1);await page.selectOption('#masterSpecialty','tile');assert.equal(await page.locator('[data-master-id]').count(),0);await page.selectOption('#masterSpecialty','');pass('master create, search and specialty filter');
    await page.locator('[data-master-id]').click();assert.match(await page.locator('#masterDetailsDlg').innerText(),/Свободен/);await page.click('#masterDetailsDlg [data-edit]');await page.fill('#masterEditDlg [name="phone"]','+7 900 444-55-66');await page.locator('#masterEditDlg form').evaluate(f=>f.requestSubmit());await until(()=>masters[0].phone.includes('444'));pass('master card and edit');
    await switchTab('projects');await page.locator('.project-list-card').filter({hasText:'Тестовый объект'}).click();await page.click('[data-project-section="team"]');assert.match(await page.locator('#app').innerText(),/Дмитрий/);await page.click('#addMasterAssignment');await page.selectOption('#assignmentDlg [name="stage"]','stage-2');await page.fill('#assignmentDlg [name="start"]','2026-09-10');await page.fill('#assignmentDlg [name="plannedEnd"]','2026-09-20');await page.selectOption('#assignmentDlg [name="status"]','active');await page.locator('#assignmentDlg form').evaluate(f=>f.requestSubmit());await until(()=>masterAssignments.length===1);assert.equal(masters.length,1);assert.match(await page.locator('#app').innerText(),/Иван Мастер/);assert.match(await page.locator('#app').innerText(),/Электрика/);pass('master assigned to project and stage without duplication');
    await page.click('[data-project-section="schedule"]');assert.match(await page.locator('[data-stage-id="stage-2"]').innerText(),/Иван Мастер/);pass('schedule shows linked master');
    await switchTab('projects');await page.locator('.project-list-card').filter({hasText:'Другой объект'}).click();await page.click('[data-project-section="team"]');assert.equal(await page.locator('[data-assignment]').count(),0);await page.click('#addMasterAssignment');await page.fill('#assignmentDlg [name="start"]','2026-09-15');await page.fill('#assignmentDlg [name="plannedEnd"]','2026-09-25');await page.selectOption('#assignmentDlg [name="status"]','active');let warned=false;page.once('dialog',d=>{warned=true;d.accept()});await page.locator('#assignmentDlg form').evaluate(f=>f.requestSubmit());await until(()=>masterAssignments.length===2);assert.equal(warned,true);pass('overlapping assignment warns before save');
    await page.click('[data-assignment]');page.once('dialog',d=>d.accept());await page.click('#assignmentDlg [data-cancel]');await until(()=>masterAssignments[1].status==='cancelled');await switchTab('projects');await page.locator('.project-list-card').filter({hasText:'Тестовый объект'}).click();await page.click('[data-project-section="team"]');await page.click('[data-assignment]');await page.selectOption('#assignmentDlg [name="status"]','completed');await page.fill('#assignmentDlg [name="actualEnd"]','2026-09-19');await page.locator('#assignmentDlg form').evaluate(f=>f.requestSubmit());await until(()=>masterAssignments[0].status==='completed');await switchTab('masters');assert.match(await page.locator('[data-master-id]').innerText(),/Свободен/);await page.locator('[data-master-id]').click();assert.match(await page.locator('#masterDetailsDlg').innerText(),/Тестовый объект/);assert.match(await page.locator('#masterDetailsDlg').innerText(),/Электрика/);await page.click('#masterDetailsDlg [data-close]');pass('completed assignment frees master and history remains');
    await switchTab('home');
    await open();await submit();await closed();assert.equal(expenses.length,1);assert.equal(expenses[0].receipt_path,null);pass('create without receipt');
    await open();await photo();await submit();await closed();assert.equal(expenses.length,2);assert.equal(expenses[1].receipt_path,'user/receipt-1.jpg');pass('create with receipt while compression is pending');
    await page.evaluate(()=>editExpense('expense-2'));await page.fill('#eAmount','250');await submit();await closed();assert.equal(expenses[1].amount,250);assert.equal(expenses[1].receipt_path,'user/receipt-1.jpg');pass('edit preserves receipt');
    await page.evaluate(()=>state.expenses.push(
      {...state.expenses[0],id:'other-project-expense',projectId:'project-2'},
      {...state.expenses[0],id:'already-reimbursed',reimbursed:true},
      {...state.expenses[0],id:'paid-by-client',paidBy:'client'}
    ));
    await switchTab('finance');assert.equal(await page.locator('#pdfAllPending').count(),0);
    await switchTab('projects');await page.locator('.project-list-card').filter({hasText:'Тестовый объект'}).click();
    assert.equal(await page.locator('.project-tabs [data-project-section]').count(),7);
    assert.match(await page.locator('#app').innerText(),/86[,.]5 м²/);
    assert.match(await page.locator('#app').innerText(),/Иван Петров/);
    assert.match(await page.locator('#app').innerText(),/Электрика/);
    await page.click('#editProjectCloud');assert.equal(await page.inputValue('#pArea'),'86.5');assert.equal(await page.inputValue('#pContract'),'АДМА-17');await page.evaluate(()=>projectDlg.close());
    await page.click('[data-project-section="schedule"]');assert.equal(await page.locator('[data-stage-id]').count(),2);assert.match(await page.locator('#app').innerText(),/70%/);
    await page.click('#addStage');await page.fill('#sName','Чистовые работы');await page.fill('#sProgress','0');await page.fill('#sPlannedStart','2026-09-21');await page.fill('#sPlannedEnd','2026-10-15');await page.evaluate(()=>stageForm.requestSubmit());await until(()=>page.evaluate(()=>!stageDlg.open));assert.equal(stages.length,3);
    await page.locator('[data-stage-id="stage-3"]').click();await page.fill('#sProgress','25');await page.selectOption('#sStatus','in_progress');await page.evaluate(()=>stageForm.requestSubmit());await until(()=>page.evaluate(()=>!stageDlg.open));assert.equal(stages[2].progress,25);assert.equal(stages[2].status,'in_progress');
    await page.locator('[data-stage-id="stage-3"]').click();page.once('dialog',d=>d.accept());await page.click('#deleteStage');await until(()=>stages.length===2);await until(()=>page.evaluate(()=>!stageDlg.open));pass('create, edit and delete schedule stage');
    await page.click('[data-project-section="finance"]');assert.equal(await page.locator('[data-project-finance-section]').count(),4);
    await page.click('[data-project-finance-section="acts"]');await page.click('#addAct');await page.fill('#actDlg [name="number"]','A-1');await page.fill('#actDlg [name="title"]','Монтаж');await page.fill('#actDlg [name="amount"]','100000');await page.locator('#actDlg form').evaluate(f=>f.requestSubmit());await until(()=>acts.length===1);assert.equal(acts[0].project_id,'project-1');
    await page.click('[data-act-cost]');await page.fill('#financeLineDlg [name="amount"]','30000');await page.locator('#financeLineDlg form').evaluate(f=>f.requestSubmit());await until(()=>page.locator('.finance-record').innerText().then(t=>/70\s*000/.test(t)));assert.match(await page.locator('.finance-record').innerText(),/70\s*000/);
    await page.click('[data-act-payment]');await page.fill('#financeLineDlg [name="amount"]','40000');await page.locator('#financeLineDlg form').evaluate(f=>f.requestSubmit());await until(()=>page.locator('.finance-record').innerText().then(t=>/40\s*000/.test(t)));pass('act CRUD and profit use costs, not customer payments');
    await page.click('[data-project-finance-section="waybills"]');await page.click('#addWaybill');await page.fill('#waybillDlg [name="number"]','N-1');await page.fill('#waybillDlg [name="supplier"]','Поставщик');await page.fill('#waybillDlg [name="amount"]','80000');await page.locator('#waybillDlg form').evaluate(f=>f.requestSubmit());await until(()=>page.locator('[data-waybill-payment]').count().then(n=>n===1));assert.equal(waybills[0].project_id,'project-1');await page.click('[data-waybill-payment]');await page.fill('#financeLineDlg [name="amount"]','50000');await page.locator('#financeLineDlg form').evaluate(f=>f.requestSubmit());await until(()=>page.locator('.finance-record').innerText().then(t=>/30\s*000/.test(t)));assert.match(await page.locator('.finance-record').innerText(),/30\s*000/);pass('waybill CRUD calculates remaining amount and profit');
    await page.click('[data-project-finance-section="summary"]');assert.match(await page.locator('#projectFinanceContent').innerText(),/Итоговая прибыль объекта/);assert.match(await page.locator('#projectFinanceContent').innerText(),/100\s*000/);pass('checks do not reduce object profit');
    await page.click('[data-project-finance-section="checks"]');
    await page.click('#pdfAllPending');await until(()=>pdfs.length===1);
    assert(pdfs[0].includes('["expense-1","expense-2"]'));
    assert(!pdfs[0].includes('other-project-expense'));assert(!pdfs[0].includes('already-reimbursed'));assert(!pdfs[0].includes('paid-by-client'));
    pass('PDF includes only pending expenses of the opened project');
    await page.click('#pdfPickPending');await page.locator('.pdfExpenseCheck').first().uncheck();await page.click('#pdfBuildSelected');await until(()=>pdfs.length===2);assert(pdfs[1].includes('["expense-2"]'));await until(()=>page.evaluate(()=>!document.getElementById('pdfDlg').open));pass('PDF selected');
    await page.click('#pdfPickPending');assert.equal(await page.locator('.pdfExpenseCheck').count(),2);await page.click('#pdfClear');assert.equal(await page.locator('#pdfBuildSelected').isDisabled(),true);await page.click('#closePdf');pass('empty selection cannot export all projects');
    await switchTab('finance');await page.click('[data-global-finance-section="general"]');await page.click('#addCompanyExpense');await page.fill('#companyExpenseDlg [name="amount"]','10000');await page.fill('#companyExpenseDlg [name="description"]','Сервис');await page.locator('#companyExpenseDlg form').evaluate(f=>f.requestSubmit());await until(()=>page.locator('#generalTotal').innerText().then(t=>/10\s*000/.test(t)));assert.match(await page.locator('#generalTotal').innerText(),/10\s*000/);await page.click('[data-company-expense]');await page.fill('#companyExpenseDlg [name="amount"]','12000');await page.locator('#companyExpenseDlg form').evaluate(f=>f.requestSubmit());await until(()=>page.locator('#generalTotal').innerText().then(t=>/12\s*000/.test(t)));page.once('dialog',d=>d.accept());await page.click('[data-company-expense]');await page.click('#companyExpenseDlg [data-delete]');await until(()=>page.locator('[data-company-expense]').count().then(n=>n===0));pass('general expense CRUD requires no project');
    await page.click('[data-global-finance-section="summary"]');assert.match(await page.locator('#globalFinanceContent').innerText(),/Итоговая прибыль ADMA/);pass('global finance aggregates object profit once');
    await switchTab('projects');
    await page.locator('.project-list-card').filter({hasText:'Пустой объект'}).click();await page.click('[data-project-section="finance"]');await page.click('[data-project-finance-section="checks"]');assert.equal(await page.locator('#pdfAllPending').count(),0);pass('empty project does not offer a global PDF');
    await page.evaluate(()=>details('expense-1'));await page.click('#markPaid');await until(()=>expenses[0].reimbursed);await until(()=>page.evaluate(()=>!detailDlg.open));pass('mark reimbursed');
    page.on('dialog',d=>d.accept());await page.evaluate(()=>details('expense-1'));await page.click('#del');await until(()=>expenses.length===1);await until(()=>page.evaluate(()=>!detailDlg.open));pass('delete expense');
    await open();await photo();failSave=true;await submit();await until(()=>page.evaluate(()=>document.getElementById('cloudBanner')?.textContent.includes('test_save_failure')));
    const uploadCount=uploads.length;await submit();await closed();assert.equal(uploads.length,uploadCount);assert.equal(expenses.at(-1).receipt_path,'user/receipt-2.jpg');pass('failed save retries without uploading photo again');
    await open();delaySave=true;const count=requests.filter(r=>r.action==='create_expense').length;await page.evaluate(()=>{expenseForm.requestSubmit();expenseForm.requestSubmit();});await closed();assert.equal(requests.filter(r=>r.action==='create_expense').length,count+1);pass('double submit creates one expense');
    await page.setViewportSize({width:390,height:844});await switchTab('more');assert.equal(await page.locator('[data-mobile-route]').count(),3);await switchTab('projects');await page.locator('.project-list-card').filter({hasText:'Тестовый объект'}).click();
    assert.equal(await page.locator('.project-tabs [data-project-section]').count(),7);assert.equal(await page.locator('#app').evaluate(el=>el.scrollWidth<=el.clientWidth+1),true);pass('mobile object card has no page overflow');
    if(web) {
      await page.evaluate(()=>{const s=JSON.parse(localStorage.getItem('adma.web.session'));s.expires_at=0;localStorage.setItem('adma.web.session',JSON.stringify(s));});
      await open();await submit();await closed();assert(requests.some(r=>r.action==='refresh'));pass('expired session refreshes before save');
      await switchTab('more');await page.click('#webLogout');await page.locator('#loginForm').waitFor();
      assert.equal(await page.evaluate(()=>localStorage.getItem('adma.web.session')),null);pass('logout hides financial data');
    }
    assert.deepEqual(errors,[]);pass('no uncaught browser errors');
  } finally {if(browser)await browser.close();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
