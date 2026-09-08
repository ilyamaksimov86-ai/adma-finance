/* @fragment 0257 */
  let globalFinanceSection = 'summary';

  async function loadFinanceCloud() {
    if (!canManageProjects()) {
      state.acts=[];state.actCosts=[];state.actPayments=[];state.waybills=[];state.waybillPayments=[];state.companyExpenses=[];
      return;
    }
    const data=await financeApi('load');
    state.acts=(data.acts||[]).map(mapAct);state.actCosts=(data.act_costs||[]).map(mapActCost);state.actPayments=(data.act_payments||[]).map(mapActPayment);
    state.waybills=(data.waybills||[]).map(mapWaybill);state.waybillPayments=(data.waybill_payments||[]).map(mapWaybillPayment);state.companyExpenses=(data.company_expenses||[]).map(mapCompanyExpense);
  }


/* @fragment 0292 */
  function expensePayload() {
    const previous = editingExpenseId ? state.expenses.find(x => x.id === editingExpenseId) : null;
    return {
      id: editingExpenseId || undefined,
      project_id: eProject.value,
      amount: Number(eAmount.value || 0),
      expense_date: eDate.value,
      category: eCategory.value,
      supplier: eSupplier.value.trim() || null,
      paid_by: ePaidBy.value,
      reimbursement_required: ePaidBy.value === 'adma' && eReimburse.checked,
      reimbursed: previous ? !!previous.reimbursed : false,
      comment: eComment.value.trim() || null,
      receipt_path: previous?.receiptPath || null,
    };
  }

  async function uploadReceiptViaXHR(file) {
    const credentials = await AdmaAuth.credentials();
    return new Promise((resolve, reject) => {
      const form = new FormData();
      for (const [key, value] of Object.entries(credentials)) form.append(key, value);
      form.append('file', file, file.name || 'receipt.jpg');

      const xhr = new XMLHttpRequest();
      xhr.open('POST', SUPABASE_FUNCTIONS + '/receipt-upload', true);
      xhr.timeout = 45000;
      xhr.onload = () => {
        let data = {};
        try { data = JSON.parse(xhr.responseText || '{}'); } catch {}
        if (xhr.status >= 200 && xhr.status < 300) return resolve(data);
        const message = data.error === 'receipt_too_large' ? 'Фото слишком большое. Выбери скриншот или другое фото.'
          : data.error === 'image_required' ? 'Этот формат изображения не поддерживается. Сделай скриншот чека.'
          : (data.error || ('upload_HTTP_' + xhr.status));
        const err = new Error(message);
        err.retryable = false;
        reject(err);
      };
      xhr.onerror = () => {
        const err = new Error('Не удалось передать фото в облако. Повторяю загрузку…');
        err.retryable = true;
        reject(err);
      };
      xhr.ontimeout = () => {
        const err = new Error('Загрузка чека заняла слишком много времени. Повторяю…');
        err.retryable = true;
        reject(err);
      };
      xhr.send(form);
    });
  }

  async function attachNewReceipt(payload) {
    if (receiptPreparation) await receiptPreparation;
    if (receiptError) throw receiptError;
    if (uploadedReceiptPath) return { ...payload, receipt_path: uploadedReceiptPath };
    if (!selectedReceiptBlob) return payload;
    banner('Загружаю чек в облако…');
    let data;
    try {
      data = await uploadReceiptViaXHR(selectedReceiptBlob);
    } catch (firstError) {
      if (!firstError?.retryable) throw firstError;
      await new Promise(resolve => setTimeout(resolve, 500));
      banner('Повторяю загрузку чека…');
      try {
        data = await uploadReceiptViaXHR(selectedReceiptBlob);
      } catch (secondError) {
        if (secondError?.retryable) {
          throw new Error('Не удалось передать именно это фото. Попробуй сделать скриншот чека и загрузить его.');
        }
        throw secondError;
      }
    }
    if (!data?.path) throw new Error('Сервер не вернул путь к чеку');
    uploadedReceiptPath = data.path;
    payload.receipt_path = data.path;
    return payload;
  }




  // PDF_EXPORT_V16
  function pendingExpensesForPdf(projectId) {
    return [...state.expenses].filter(e => pending(e) && e.projectId === projectId).sort((a, b) => {
      const pa = proj(a.projectId)?.name || '';
      const pb = proj(b.projectId)?.name || '';
      return pa.localeCompare(pb, 'ru') || a.date.localeCompare(b.date);
    });
  }

  async function requestReimbursementPdfViaXHR(expenseIds = null) {
    const credentials = await AdmaAuth.credentials();
    return new Promise((resolve, reject) => {
      const form = new FormData();
      for (const [key, value] of Object.entries(credentials)) form.append(key, value);
      if (Array.isArray(expenseIds)) form.append('expense_ids', JSON.stringify(expenseIds));
      const xhr = new XMLHttpRequest();
      xhr.open('POST', SUPABASE_FUNCTIONS + '/reimbursement-pdf', true);
      xhr.timeout = 90000;
      xhr.onload = () => {
        let data = {};
        try { data = JSON.parse(xhr.responseText || '{}'); } catch {}
        if (xhr.status >= 200 && xhr.status < 300) return resolve(data);
        const map = {
          no_pending_expenses: 'Нет неоплаченных расходов для выгрузки',
          too_many_expenses: 'Слишком много расходов для одной выгрузки',
          pdf_font_unavailable: 'Не удалось подготовить русский шрифт для PDF',
          invalid_expense_ids: 'Не удалось прочитать выбранные расходы',
        };
        reject(new Error(map[data.error] || data.error || ('pdf_HTTP_' + xhr.status)));
      };
      xhr.onerror = () => reject(new Error('Не удалось сформировать PDF. Проверь соединение и попробуй ещё раз.'));
      xhr.ontimeout = () => reject(new Error('Формирование PDF заняло слишком много времени. Попробуй ещё раз.'));
      xhr.send(form);
    });
  }

  function openPdfUrl(url) {
    if (!url) throw new Error('Сервер не вернул ссылку на PDF');
    try {
      if (tgApp?.openLink) {
        tgApp.openLink(url);
        return;
      }
    } catch (e) { console.warn('Telegram openLink failed', e); }
    const a = document.createElement('a');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function createReimbursementPdf(expenseIds = null) {
    // An empty selection must never fall back to exporting every project.
    if (!Array.isArray(expenseIds) || !expenseIds.length) {
      banner('Нет расходов к компенсации по этому объекту', 'error');
      return;
    }
    banner('Формирую PDF…');
    try {
      const data = await requestReimbursementPdfViaXHR(expenseIds);
      if (!data?.url) throw new Error('Сервер не вернул ссылку на PDF');
      const count = Number(data.count || 0);
      const total = Number(data.total || 0);
      banner(`PDF готов · ${count} расходов · ${money(total)}`, 'ok');
      openPdfUrl(data.url);
      return data;
    } catch (e) {
      banner('Не удалось сформировать PDF: ' + (e?.message || e), 'error');
      throw e;
    }
  }

  function ensurePdfDialog() {
    let dlg = document.getElementById('pdfDlg');
    if (dlg) return dlg;
    dlg = document.createElement('dialog');
    dlg.id = 'pdfDlg';
    dlg.innerHTML = `<div class="dialog-body"><div class="sheethead"><button id="closePdf" type="button">Закрыть</button><h2>Выбрать расходы</h2><span></span></div><div class="row" style="margin:4px 0 12px"><button id="pdfSelectAll" class="btn secondary grow" type="button">Выбрать все</button><button id="pdfClear" class="btn secondary grow" type="button">Снять все</button></div><div id="pdfSelectionList"></div><div class="card" style="position:sticky;bottom:0;margin:10px 0 0;box-shadow:0 -8px 22px #0001"><div class="row"><div class="grow"><div class="muted" id="pdfSelectedCount">Выбрано: 0</div><strong id="pdfSelectedTotal">0 ₽</strong></div><button id="pdfBuildSelected" class="btn primary" type="button">Создать PDF</button></div></div></div>`;
    document.body.appendChild(dlg);
    dlg.querySelector('#closePdf').onclick = () => dlg.close();
    return dlg;
  }

  function openPdfSelection(projectId) {
    const expenses = pendingExpensesForPdf(projectId);
    if (!expenses.length) {
      banner('Нет расходов к компенсации', 'error');
      return;
    }
    const dlg = ensurePdfDialog();
    dlg.querySelector('h2').textContent = 'Расходы: ' + (proj(projectId)?.name || 'Объект');
    const list = dlg.querySelector('#pdfSelectionList');
    list.innerHTML = expenses.map(e => {
      const p = proj(e.projectId);
      const title = e.supplier || e.category || 'Расход';
      return `<label class="card row" style="margin-bottom:8px;cursor:pointer"><input class="pdfExpenseCheck" type="checkbox" value="${esc(e.id)}" checked style="width:22px;height:22px;margin:0;flex:0 0 auto"><div class="grow"><strong>${esc(title)}</strong><div class="muted">${esc(p?.name || '')} · ${fmt(e.date)}${e.receiptPath ? ' · чек есть' : ''}</div></div><strong>${money(e.amount)}</strong></label>`;
    }).join('');

    const update = () => {
      const selected = [...dlg.querySelectorAll('.pdfExpenseCheck:checked')];
      const ids = new Set(selected.map(x => x.value));
      const selectedExpenses = expenses.filter(e => ids.has(String(e.id)));
      dlg.querySelector('#pdfSelectedCount').textContent = `Выбрано: ${selectedExpenses.length} из ${expenses.length}`;
      dlg.querySelector('#pdfSelectedTotal').textContent = money(sum(selectedExpenses));
      const build = dlg.querySelector('#pdfBuildSelected');
      build.disabled = !selectedExpenses.length;
      build.style.opacity = selectedExpenses.length ? '1' : '.45';
    };
    list.querySelectorAll('.pdfExpenseCheck').forEach(x => x.onchange = update);
    dlg.querySelector('#pdfSelectAll').onclick = () => { dlg.querySelectorAll('.pdfExpenseCheck').forEach(x => x.checked = true); update(); };
    dlg.querySelector('#pdfClear').onclick = () => { dlg.querySelectorAll('.pdfExpenseCheck').forEach(x => x.checked = false); update(); };
    dlg.querySelector('#pdfBuildSelected').onclick = async () => {
      const ids = [...dlg.querySelectorAll('.pdfExpenseCheck:checked')].map(x => x.value);
      if (!ids.length) return;
      const btn = dlg.querySelector('#pdfBuildSelected');
      btn.disabled = true;
      try {
        await createReimbursementPdf(ids);
        dlg.close();
      } catch {}
      finally { btn.disabled = false; update(); }
    };
    update();
    if (!dlg.open) dlg.showModal();
  }

  function renderDueCloud() {
    const arr = state.expenses.filter(pending).sort((a, b) => b.date.localeCompare(a.date));
    $('#app').innerHTML = `<section class="hero"><small>Всего к возмещению</small><div class="amount">${money(due())}</div><small>${arr.length} чеков</small></section><p class="muted">PDF для заказчика можно выгрузить в карточке объекта.</p><div id="list"></div>`;
    renderExpenses(arr, $('#list'));
  }

  // PROJECT_EDIT_ARCHIVE_V15

/* @fragment 0876 */
  const actStatusLabels={draft:'Черновик',issued:'Выставлен',signed:'Подписан',partially_paid:'Частично оплачен',paid:'Оплачен'};
  const waybillStatusLabels={created:'Создана',sent:'Отправлена',partially_paid:'Частично оплачена',paid:'Оплачена',closed:'Закрыта'};
  const companyCategoryLabels={advertising:'Реклама',services:'Сервисы / подписки',office:'Офис',transport:'Транспорт',administrative:'Административные',salaries:'Зарплаты',taxes:'Налоги',banking:'Банковские расходы',other:'Прочее'};
  const statusBadge = status => ['paid','closed'].includes(status)?'paid':['partially_paid','issued','sent'].includes(status)?'pending':'neutral';
  const fileLink = item => item.fileUrl ? `<a class="btn secondary" href="${esc(item.fileUrl)}" target="_blank" rel="noopener">Открыть файл</a>` : '';
  const financeEmpty = text => `<div class="card empty">${esc(text)}</div>`;

  async function uploadFinanceFile(file,entity){
    if(!file)return null;const credentials=await AdmaAuth.credentials();
    return new Promise((resolve,reject)=>{const form=new FormData();for(const [key,value] of Object.entries(credentials))form.append(key,value);form.append('entity',entity);form.append('file',file,file.name);const xhr=new XMLHttpRequest();xhr.open('POST',SUPABASE_FUNCTIONS+'/finance-file-upload',true);xhr.timeout=45000;xhr.onload=()=>{let data={};try{data=JSON.parse(xhr.responseText||'{}')}catch{};if(xhr.status>=200&&xhr.status<300&&data.path)return resolve(data.path);reject(new Error(data.error||`HTTP_${xhr.status}`))};xhr.onerror=()=>reject(new Error('Ошибка загрузки файла'));xhr.ontimeout=()=>reject(new Error('Загрузка файла заняла слишком много времени'));xhr.send(form)});
  }
  function dynamicDialog(id,title,body){let dlg=document.getElementById(id);if(!dlg){dlg=document.createElement('dialog');dlg.id=id;document.body.appendChild(dlg)}dlg.innerHTML=`<form class="finance-form"><div class="sheethead"><button type="button" data-close>Отмена</button><h2>${esc(title)}</h2><button class="btn primary">Сохранить</button></div>${body}</form>`;dlg.querySelector('[data-close]').onclick=()=>dlg.close();return dlg}
  async function refreshFinance(message){await loadFinanceCloud();render();banner(message,'ok')}

  function openActDialog(projectId,actId=''){
    const act=(state.acts||[]).find(x=>x.id===actId);const stages=stagesFor(projectId);
    const dlg=dynamicDialog('actDlg',act?'Редактировать акт':'Новый акт',`<div class="grid"><label>Номер<input name="number" required maxlength="100" value="${esc(act?.number||'')}"></label><label>Дата<input name="date" type="date" required value="${esc(act?.date||new Date().toISOString().slice(0,10))}"></label></div><label>Название / описание<input name="title" required maxlength="300" value="${esc(act?.title||'')}"></label><div class="grid"><label>Этап<select name="stage"><option value="">Без этапа</option>${stages.map(s=>`<option value="${esc(s.id)}" ${act?.stageId===s.id?'selected':''}>${esc(s.name)}</option>`).join('')}</select></label><label>Сумма акта, ₽<input name="amount" type="number" min="0" step="0.01" required value="${act?.amount??''}"></label></div><label>Статус<select name="status">${Object.entries(actStatusLabels).map(([value,label])=>`<option value="${value}" ${act?.status===value?'selected':''}>${label}</option>`).join('')}</select></label><label>Файл PDF / фото<input name="file" type="file" accept="application/pdf,image/jpeg,image/png,image/webp"></label>${fileLink(act||{})}<label>Комментарий<textarea name="comment" rows="3" maxlength="4000">${esc(act?.comment||'')}</textarea></label>${act?'<button type="button" class="btn danger full-button" data-delete>Удалить акт</button>':''}`);
    dlg.querySelector('form').onsubmit=async ev=>{ev.preventDefault();const form=ev.currentTarget,controls=[...form.querySelectorAll('input,select,textarea,button')];controls.forEach(x=>x.disabled=true);try{let filePath=act?.filePath||null;const file=form.elements.file.files?.[0];if(file)filePath=await uploadFinanceFile(file,'act');await financeApi('save_act',{act:{id:act?.id,project_id:projectId,stage_id:form.elements.stage.value||null,number:form.elements.number.value,act_date:form.elements.date.value,title:form.elements.title.value,amount:Number(form.elements.amount.value),status:form.elements.status.value,file_path:filePath,comment:form.elements.comment.value}});dlg.close();await refreshFinance(act?'Акт обновлён':'Акт добавлен')}catch(e){banner('Не удалось сохранить акт: '+e.message,'error')}finally{controls.forEach(x=>x.disabled=false)}};
    const del=dlg.querySelector('[data-delete]');if(del)del.onclick=async()=>{if(!confirm(`Удалить акт №${act.number}?`))return;try{await financeApi('delete_act',{id:act.id});dlg.close();await refreshFinance('Акт удалён')}catch(e){banner('Не удалось удалить акт: '+e.message,'error')}};dlg.showModal();
  }
  function openWaybillDialog(projectId,waybillId=''){
    const item=(state.waybills||[]).find(x=>x.id===waybillId);const dlg=dynamicDialog('waybillDlg',item?'Редактировать накладную':'Новая накладная',`<div class="grid"><label>Номер<input name="number" required maxlength="100" value="${esc(item?.number||'')}"></label><label>Дата<input name="date" type="date" required value="${esc(item?.date||new Date().toISOString().slice(0,10))}"></label></div><label>Поставщик<input name="supplier" required maxlength="200" value="${esc(item?.supplier||'')}"></label><label>Описание<textarea name="description" rows="2" maxlength="2000">${esc(item?.description||'')}</textarea></label><div class="grid"><label>Сумма накладной, ₽<input name="amount" type="number" min="0" step="0.01" required value="${item?.amount??''}"></label><label>Статус<select name="status">${Object.entries(waybillStatusLabels).map(([value,label])=>`<option value="${value}" ${item?.status===value?'selected':''}>${label}</option>`).join('')}</select></label></div><label>Файл PDF / фото<input name="file" type="file" accept="application/pdf,image/jpeg,image/png,image/webp"></label>${fileLink(item||{})}<label>Комментарий<textarea name="comment" rows="3" maxlength="4000">${esc(item?.comment||'')}</textarea></label>${item?'<button type="button" class="btn danger full-button" data-delete>Удалить накладную</button>':''}`);
    dlg.querySelector('form').onsubmit=async ev=>{ev.preventDefault();const form=ev.currentTarget,controls=[...form.querySelectorAll('input,select,textarea,button')];controls.forEach(x=>x.disabled=true);try{let filePath=item?.filePath||null;const file=form.elements.file.files?.[0];if(file)filePath=await uploadFinanceFile(file,'waybill');await financeApi('save_waybill',{waybill:{id:item?.id,project_id:projectId,number:form.elements.number.value,waybill_date:form.elements.date.value,supplier:form.elements.supplier.value,description:form.elements.description.value,amount:Number(form.elements.amount.value),status:form.elements.status.value,file_path:filePath,comment:form.elements.comment.value}});dlg.close();await refreshFinance(item?'Накладная обновлена':'Накладная добавлена')}catch(e){banner('Не удалось сохранить накладную: '+e.message,'error')}finally{controls.forEach(x=>x.disabled=false)}};
    const del=dlg.querySelector('[data-delete]');if(del)del.onclick=async()=>{if(!confirm(`Удалить накладную №${item.number}?`))return;try{await financeApi('delete_waybill',{id:item.id});dlg.close();await refreshFinance('Накладная удалена')}catch(e){banner('Не удалось удалить накладную: '+e.message,'error')}};dlg.showModal();
  }
  function openFinanceLineDialog(kind,parentId){
    const definitions={act_cost:['Выплата / расход по акту','add_act_cost','act_id'],act_payment:['Оплата заказчика','add_act_payment','act_id'],waybill_payment:['Оплата поставщику','add_waybill_payment','waybill_id']};const [title,action,key]=definitions[kind];
    const dlg=dynamicDialog('financeLineDlg',title,`<div class="grid"><label>Дата<input name="date" type="date" required value="${new Date().toISOString().slice(0,10)}"></label><label>Сумма, ₽<input name="amount" type="number" min="0.01" step="0.01" required></label></div><label>Комментарий<textarea name="comment" rows="3" maxlength="1000"></textarea></label>`);
    dlg.querySelector('form').onsubmit=async ev=>{ev.preventDefault();const form=ev.currentTarget,button=form.querySelector('.primary');button.disabled=true;try{await financeApi(action,{[key]:parentId,date:form.elements.date.value,amount:Number(form.elements.amount.value),comment:form.elements.comment.value});dlg.close();await refreshFinance('Операция добавлена')}catch(e){banner('Не удалось добавить операцию: '+e.message,'error')}finally{button.disabled=false}};dlg.showModal();
  }
  async function deleteFinanceLine(action,id){if(!confirm('Удалить эту операцию?'))return;try{await financeApi(action,{id});await refreshFinance('Операция удалена')}catch(e){banner('Не удалось удалить операцию: '+e.message,'error')}}

  function renderActs(projectId,content,isArchived){
    const acts=actsFor(projectId);content.innerHTML=`<div class="section"><div><h2>Акты</h2><p class="muted">Прибыль = сумма акта − выплаты мастерам и связанные расходы</p></div>${!isArchived?'<button id="addAct" class="btn primary">+ Акт</button>':''}</div><div class="finance-list">${acts.length?acts.map(a=>{const costs=actCostsFor(a.id),payments=actPaymentsFor(a.id);return `<article class="card finance-record"><div class="finance-record-head"><div><span class="badge ${statusBadge(a.status)}">${esc(actStatusLabels[a.status]||a.status)}</span><h3>Акт №${esc(a.number)} · ${esc(a.title)}</h3><p class="muted">${fmt(a.date)}${a.stageId?' · '+esc((state.stages||[]).find(s=>s.id===a.stageId)?.name||'Этап'):''}</p></div><button class="btn secondary" data-edit-act="${esc(a.id)}">Редактировать</button></div><div class="finance-values"><div><small>Сумма</small><strong>${money(a.amount)}</strong></div><div><small>Оплачено заказчиком</small><strong>${money(actPaid(a.id))}</strong></div><div><small>Выплаты / расходы</small><strong>${money(actCost(a.id))}</strong></div><div class="profit"><small>Прибыль</small><strong>${money(actProfit(a))}</strong></div></div><div class="finance-actions"><button class="btn secondary" data-act-payment="${esc(a.id)}">+ Оплата заказчика</button><button class="btn secondary" data-act-cost="${esc(a.id)}">+ Выплата / расход</button>${fileLink(a)}</div>${payments.length||costs.length?`<div class="finance-lines">${payments.map(x=>`<div><span>Оплата заказчика · ${fmt(x.date)}</span><strong>${money(x.amount)}</strong><button data-delete-act-payment="${esc(x.id)}">×</button></div>`).join('')}${costs.map(x=>`<div><span>Выплата / расход · ${fmt(x.date)}${x.description?' · '+esc(x.description):''}</span><strong>− ${money(x.amount)}</strong><button data-delete-act-cost="${esc(x.id)}">×</button></div>`).join('')}</div>`:''}</article>`}).join(''):financeEmpty('Актов по этому объекту пока нет')}</div>`;
    const add=content.querySelector('#addAct');if(add)add.onclick=()=>openActDialog(projectId);content.querySelectorAll('[data-edit-act]').forEach(b=>b.onclick=()=>openActDialog(projectId,b.dataset.editAct));content.querySelectorAll('[data-act-payment]').forEach(b=>b.onclick=()=>openFinanceLineDialog('act_payment',b.dataset.actPayment));content.querySelectorAll('[data-act-cost]').forEach(b=>b.onclick=()=>openFinanceLineDialog('act_cost',b.dataset.actCost));content.querySelectorAll('[data-delete-act-payment]').forEach(b=>b.onclick=()=>deleteFinanceLine('delete_act_payment',b.dataset.deleteActPayment));content.querySelectorAll('[data-delete-act-cost]').forEach(b=>b.onclick=()=>deleteFinanceLine('delete_act_cost',b.dataset.deleteActCost));
  }
  function renderWaybills(projectId,content,isArchived){
    const items=waybillsFor(projectId);content.innerHTML=`<div class="section"><div><h2>Накладные</h2><p class="muted">Прибыль = сумма накладной − оплаты поставщику и доставки</p></div>${!isArchived?'<button id="addWaybill" class="btn primary">+ Накладная</button>':''}</div><div class="finance-list">${items.length?items.map(w=>{const paid=waybillPaid(w.id),remaining=Math.max(0,w.amount-paid),payments=waybillPaymentsFor(w.id);return `<article class="card finance-record"><div class="finance-record-head"><div><span class="badge ${statusBadge(w.status)}">${esc(waybillStatusLabels[w.status]||w.status)}</span><h3>Накладная №${esc(w.number)} · ${esc(w.supplier)}</h3><p class="muted">${fmt(w.date)}${w.description?' · '+esc(w.description):''}</p></div><button class="btn secondary" data-edit-waybill="${esc(w.id)}">Редактировать</button></div><div class="finance-values"><div><small>Сумма</small><strong>${money(w.amount)}</strong></div><div><small>Оплачено</small><strong>${money(paid)}</strong></div><div><small>Остаток</small><strong>${money(remaining)}</strong></div><div class="profit"><small>Прибыль</small><strong>${money(waybillProfit(w))}</strong></div></div><div class="finance-actions"><button class="btn secondary" data-waybill-payment="${esc(w.id)}">+ Оплата поставщику</button>${fileLink(w)}</div>${payments.length?`<div class="finance-lines">${payments.map(x=>`<div><span>${fmt(x.date)}${x.comment?' · '+esc(x.comment):''}</span><strong>− ${money(x.amount)}</strong><button data-delete-waybill-payment="${esc(x.id)}">×</button></div>`).join('')}</div>`:''}</article>`}).join(''):financeEmpty('Накладных по этому объекту пока нет')}</div>`;
    const add=content.querySelector('#addWaybill');if(add)add.onclick=()=>openWaybillDialog(projectId);content.querySelectorAll('[data-edit-waybill]').forEach(b=>b.onclick=()=>openWaybillDialog(projectId,b.dataset.editWaybill));content.querySelectorAll('[data-waybill-payment]').forEach(b=>b.onclick=()=>openFinanceLineDialog('waybill_payment',b.dataset.waybillPayment));content.querySelectorAll('[data-delete-waybill-payment]').forEach(b=>b.onclick=()=>deleteFinanceLine('delete_waybill_payment',b.dataset.deleteWaybillPayment));
  }

  function renderProjectFinance(p) {
    const arr = [...expensesFor(p.id)].sort((a, b) => b.date.localeCompare(a.date));
    const isArchived = p.status === 'archived';
    $('#projectSection').innerHTML = `${sectionTabs(projectFinanceSections, projectFinanceSection, 'data-project-finance-section')}<div id="projectFinanceContent"></div>`;
    document.querySelectorAll('[data-project-finance-section]').forEach(button => button.onclick = () => { projectFinanceSection = button.dataset.projectFinanceSection; render(); });
    const content = document.getElementById('projectFinanceContent');
    if (projectFinanceSection === 'summary') {
      if(!canManageProjects()){content.innerHTML=`<section class="project-summary-grid"><button class="card project-summary-card" data-finance-open="checks"><small>Чеки / Разное</small><strong>${money(spent(p.id))}</strong><span>${arr.length} записей</span></button><button class="card project-summary-card featured" data-finance-open="checks"><small>К компенсации</small><strong>${money(due(p.id))}</strong><span>${arr.filter(pending).length} не закрыто</span></button></section><div class="card"><strong>Финансовая прибыль доступна владельцу и партнёру</strong><p class="muted">Прораб видит чеки и расходы назначенного объекта.</p></div>`}
      else{const t=projectFinanceTotals(p.id);content.innerHTML=`<section class="dashboard-metrics finance-summary"><button class="card dashboard-metric" data-finance-open="acts"><small>Сумма актов</small><strong>${money(t.actsAmount)}</strong><span>Прибыль ${money(t.actsProfit)}</span></button><button class="card dashboard-metric" data-finance-open="waybills"><small>Сумма накладных</small><strong>${money(t.waybillsAmount)}</strong><span>Прибыль ${money(t.waybillsProfit)}</span></button><button class="card dashboard-metric" data-finance-open="checks"><small>Чеки / Разное</small><strong>${money(t.checks)}</strong><span>К возмещению ${money(t.due)}</span></button><div class="card dashboard-metric featured"><small>Итоговая прибыль объекта</small><strong>${money(t.profit)}</strong><span>Чеки / Разное не вычитаются</span></div></section><section class="card finance-formula"><strong>Расчёт прибыли</strong><p>Прибыль актов ${money(t.actsProfit)} + прибыль накладных ${money(t.waybillsProfit)} = <b>${money(t.profit)}</b></p><p class="muted">К возмещению от заказчика показывается отдельно: ${money(t.due)}</p></section>`}
      content.querySelectorAll('[data-finance-open]').forEach(button => button.onclick = () => { projectFinanceSection = button.dataset.financeOpen; render(); });
      return;
    }
    if (projectFinanceSection === 'acts') {
      if(!canManageProjects())content.innerHTML=financeEmpty('Акты и прибыль доступны владельцу и партнёру');else renderActs(p.id,content,isArchived);
      return;
    }
    if (projectFinanceSection === 'waybills') {
      if(!canManageProjects())content.innerHTML=financeEmpty('Накладные и прибыль доступны владельцу и партнёру');else renderWaybills(p.id,content,isArchived);
      return;
    }
    content.innerHTML = `<section class="hero finance-hero"><small>К возмещению по объекту</small><div class="amount">${money(due(p.id))}</div><small>Чеки / Разное не уменьшают прибыль объекта</small></section><section class="grid"><div class="card metric"><small>Всего чеков / разного</small><strong>${money(spent(p.id))}</strong></div><div class="card metric"><small>Компенсировано</small><strong>${money(reimb(p.id))}</strong></div></section><div id="projectFinanceActions"></div><div class="section"><div><h2>Чеки / Разное</h2><p class="muted">Отдельный реестр денег к возврату от заказчика</p></div>${!isArchived ? '<button id="addExpense" class="btn primary">+ Расход</button>' : ''}</div><div class="card finance-filters"><label>С даты<input id="checkFrom" type="date"></label><label>По дату<input id="checkTo" type="date"></label><label>Категория<select id="checkCategory"><option value="">Все категории</option>${[...new Set(arr.map(x=>x.category))].map(x=>`<option>${esc(x)}</option>`).join('')}</select></label><strong id="checkFilteredTotal"></strong></div><div id="list"></div>`;
    const pdfExpenses = pendingExpensesForPdf(p.id);
    const pdfCard = document.createElement('div');
    pdfCard.className = 'card';
    pdfCard.innerHTML = `<strong>PDF для заказчика</strong><p class="muted">Только некомпенсированные расходы по этому объекту.</p>${pdfExpenses.length ? `<button id="pdfAllPending" class="btn primary full-button">Выгрузить PDF по объекту · ${pdfExpenses.length}</button><button id="pdfPickPending" class="btn secondary full-button">Выбрать расходы</button>` : '<p class="muted">Нет расходов к компенсации</p>'}`;
    $('#projectFinanceActions').appendChild(pdfCard);
    const addExpense = document.getElementById('addExpense');
    if (addExpense) addExpense.onclick = () => openExpense(p.id);
    const all = document.getElementById('pdfAllPending');
    if (all) all.onclick = async () => { all.disabled = true; try { await createReimbursementPdf(pendingExpensesForPdf(p.id).map(e => e.id)); } catch {} finally { all.disabled = false; } };
    const pick = document.getElementById('pdfPickPending');
    if (pick) pick.onclick = () => openPdfSelection(p.id);
    const renderFilteredChecks=()=>{const from=document.getElementById('checkFrom').value,to=document.getElementById('checkTo').value,category=document.getElementById('checkCategory').value;const filtered=arr.filter(x=>(!from||x.date>=from)&&(!to||x.date<=to)&&(!category||x.category===category));document.getElementById('checkFilteredTotal').textContent=`Итого: ${money(totalAmounts(filtered))}`;const list=$('#list');list.innerHTML='';renderExpenses(filtered,list)};
    ['checkFrom','checkTo','checkCategory'].forEach(id=>document.getElementById(id).onchange=renderFilteredChecks);renderFilteredChecks();
  }


/* @fragment 1387 */
  function openCompanyExpenseDialog(expenseId=''){
    const item=(state.companyExpenses||[]).find(x=>x.id===expenseId);const dlg=dynamicDialog('companyExpenseDlg',item?'Редактировать общий расход':'Новый общий расход',`<div class="grid"><label>Дата<input name="date" type="date" required value="${esc(item?.date||new Date().toISOString().slice(0,10))}"></label><label>Сумма, ₽<input name="amount" type="number" min="0.01" step="0.01" required value="${item?.amount??''}"></label></div><label>Категория<select name="category">${Object.entries(companyCategoryLabels).map(([value,label])=>`<option value="${value}" ${item?.category===value?'selected':''}>${label}</option>`).join('')}</select></label><label>Описание<input name="description" required maxlength="1000" value="${esc(item?.description||'')}"></label><label>Файл PDF / фото<input name="file" type="file" accept="application/pdf,image/jpeg,image/png,image/webp"></label>${fileLink(item||{})}<label>Комментарий<textarea name="comment" rows="3" maxlength="4000">${esc(item?.comment||'')}</textarea></label>${item?'<button type="button" class="btn danger full-button" data-delete>Удалить общий расход</button>':''}`);
    dlg.querySelector('form').onsubmit=async ev=>{ev.preventDefault();const form=ev.currentTarget,controls=[...form.querySelectorAll('input,select,textarea,button')];controls.forEach(x=>x.disabled=true);try{let filePath=item?.filePath||null;const file=form.elements.file.files?.[0];if(file)filePath=await uploadFinanceFile(file,'company-expense');await financeApi('save_company_expense',{expense:{id:item?.id,expense_date:form.elements.date.value,amount:Number(form.elements.amount.value),category:form.elements.category.value,description:form.elements.description.value,comment:form.elements.comment.value,file_path:filePath}});dlg.close();await refreshFinance(item?'Общий расход обновлён':'Общий расход добавлен')}catch(e){banner('Не удалось сохранить расход: '+e.message,'error')}finally{controls.forEach(x=>x.disabled=false)}};
    const del=dlg.querySelector('[data-delete]');if(del)del.onclick=async()=>{if(!confirm('Удалить общий расход?'))return;try{await financeApi('delete_company_expense',{id:item.id});dlg.close();await refreshFinance('Общий расход удалён')}catch(e){banner('Не удалось удалить расход: '+e.message,'error')}};dlg.showModal();
  }
  function renderCompanyExpenses(content){
    const items=[...(state.companyExpenses||[])].sort((a,b)=>b.date.localeCompare(a.date));content.innerHTML=`<div class="section"><div><h2>Общие расходы ADMA</h2><p class="muted">Не связаны с объектами и уменьшают только прибыль компании</p></div><button id="addCompanyExpense" class="btn primary">+ Расход</button></div><div class="card finance-filters"><label>С даты<input id="generalFrom" type="date"></label><label>По дату<input id="generalTo" type="date"></label><label>Категория<select id="generalCategory"><option value="">Все категории</option>${Object.entries(companyCategoryLabels).map(([value,label])=>`<option value="${value}">${label}</option>`).join('')}</select></label><strong id="generalTotal"></strong></div><div id="generalList" class="finance-list"></div>`;
    const draw=()=>{const from=content.querySelector('#generalFrom').value,to=content.querySelector('#generalTo').value,category=content.querySelector('#generalCategory').value;const filtered=items.filter(x=>(!from||x.date>=from)&&(!to||x.date<=to)&&(!category||x.category===category));content.querySelector('#generalTotal').textContent=`Итого: ${money(totalAmounts(filtered))}`;content.querySelector('#generalList').innerHTML=filtered.length?filtered.map(x=>`<button class="card finance-record compact-record" data-company-expense="${esc(x.id)}"><span><strong>${esc(x.description)}</strong><small>${fmt(x.date)} · ${esc(companyCategoryLabels[x.category]||x.category)} · ${esc(x.authorName)}</small></span><strong>${money(x.amount)}</strong></button>`).join(''):financeEmpty('За выбранный период расходов нет')};
    content.querySelector('#addCompanyExpense').onclick=()=>openCompanyExpenseDialog();['generalFrom','generalTo','generalCategory'].forEach(id=>content.querySelector('#'+id).onchange=draw);draw();content.querySelector('#generalList').onclick=e=>{const row=e.target.closest('[data-company-expense]');if(row)openCompanyExpenseDialog(row.dataset.companyExpense)};
  }

  function renderGlobalFinanceCloud() {
    const pendingExpenses = state.expenses.filter(pending).sort((a, b) => b.date.localeCompare(a.date));
    const projects = activeProjects();
    $('#app').innerHTML = `${pageHeader('ADMA · ФИНАНСЫ', 'Финансы', 'Агрегированная картина компании без дублирования финансов объектов')}${sectionTabs([['summary', 'Сводка'], ['general', 'Общие расходы']], globalFinanceSection, 'data-global-finance-section')}<div id="globalFinanceContent"></div>`;
    document.querySelectorAll('[data-global-finance-section]').forEach(button => button.onclick = () => { globalFinanceSection = button.dataset.globalFinanceSection; render(); });
    const content = document.getElementById('globalFinanceContent');
    if(!canManageProjects()){content.innerHTML=financeEmpty('Финансовая сводка ADMA доступна владельцу и партнёру');return}
    if (globalFinanceSection === 'general') {
      renderCompanyExpenses(content);
      return;
    }
    const totals=companyFinanceTotals();content.innerHTML = `<section class="dashboard-metrics"><div class="card dashboard-metric"><small>Прибыль объектов</small><strong>${money(totals.objectProfit)}</strong><span>${projects.length} активных объектов</span></div><button class="card dashboard-metric" data-open-general><small>Общие расходы ADMA</small><strong>${money(totals.general)}</strong><span>${(state.companyExpenses||[]).length} записей</span></button><div class="card dashboard-metric"><small>К возмещению</small><strong>${money(totals.due)}</strong><span>${pendingExpenses.length} незакрытых расходов</span></div><div class="card dashboard-metric featured"><small>Итоговая прибыль ADMA</small><strong>${money(totals.profit)}</strong><span>Прибыль объектов − общие расходы</span></div></section><section class="card finance-formula"><strong>Единый расчёт</strong><p>${money(totals.objectProfit)} − ${money(totals.general)} = <b>${money(totals.profit)}</b></p><p class="muted">Чеки / Разное объектов не вычитаются повторно.</p></section><section class="card panel-card global-finance-list"><div class="section compact"><div><h2>Чеки / Разное к компенсации</h2><p class="muted">PDF формируется внутри нужного объекта</p></div></div><div id="list"></div></section>`;
    const openGeneral=content.querySelector('[data-open-general]');if(openGeneral)openGeneral.onclick=()=>{globalFinanceSection='general';render()};
    renderExpenses(pendingExpenses, content.querySelector('#list'));
  }

  function installFinanceHandlers() {
    const originalOpenExpense = openExpense;
    openExpense = function(pid) {
      if (savingExpense) return;
      clearSelectedReceipt();
      const active = activeProjects();
      const requested = pid ? state.projects.find(p => p.id === pid) : null;
      if (requested?.status === 'archived') { banner('Архивный объект доступен только для просмотра', 'error'); return; }
      if (!active.length) { state.project = null; state.tab = 'projects'; render(); banner('Сначала создай активный объект', 'error'); return; }
      const all = state.projects;
      try { state.projects = active; return originalOpenExpense(pid); } finally { state.projects = all; }
    };

    const originalEditExpense = editExpense;
    editExpense = function(i) {
      if (savingExpense) return;
      clearSelectedReceipt();
      return originalEditExpense(i);
    };

    eReceipt.onchange = async () => {
      const file = eReceipt.files?.[0];
      if (!file) return;
      clearSelectedReceipt();
      const generation = receiptGeneration;
      try {
        banner('Подготавливаю фото чека…');
        receiptPreparation = prepareReceiptFile(file);
        const prepared = await receiptPreparation;
        if (generation !== receiptGeneration) return;
        selectedReceiptBlob = prepared;
        selectedReceiptPreviewUrl = URL.createObjectURL(selectedReceiptBlob);
        state.receipt = null;
        preview.src = selectedReceiptPreviewUrl;
        preview.style.display = 'block';
        banner('Чек готов к загрузке', 'ok');
      } catch (e) {
        if (generation !== receiptGeneration) return;
        receiptError = e;
        eReceipt.value = '';
        preview.style.display = 'none';
        banner(e?.message || 'Не удалось подготовить фото', 'error');
      }
    };
    expenseForm.onsubmit = async ev => {
      ev.preventDefault();
      if (!cloudReady || savingExpense) return;
      savingExpense = true;
      const controls = [...expenseForm.querySelectorAll('input,select,textarea,button')];
      const disabled = controls.map(el => el.disabled);
      controls.forEach(el => el.disabled = true);
      const expenseId = editingExpenseId;
      try {
        let payload = expensePayload();
        payload = await attachNewReceipt(payload);
        banner(editingExpenseId ? 'Сохраняю изменения…' : 'Сохраняю расход…');
        if (expenseId) await api('update_expense', { expense: payload });
        else await api('create_expense', { expense: payload });
        editingExpenseId = null;
        state.receipt = null;
        clearSelectedReceipt();
        expenseDlg.close();
        try { await loadCloud(); }
        catch { banner('Расход сохранён, но список не обновился. Перезапустите приложение.', 'error'); return; }
        banner(payload.receipt_path ? 'Сохранено в облаке вместе с чеком' : 'Сохранено в облаке', 'ok');
      } catch (e) { console.error(e); banner('Не удалось сохранить расход: ' + e.message, 'error'); }
      finally {
        savingExpense = false;
        controls.forEach((el, i) => el.disabled = disabled[i]);
      }
    };
    expenseDlg.addEventListener('cancel', ev => { if (savingExpense) ev.preventDefault(); });

    const originalDetails = details;
    details = function(i) {
      originalDetails(i);
      const ex = state.expenses.find(x => x.id === i);
      if (!ex) return;
      const paid = document.getElementById('markPaid');
      const editBtn = document.getElementById('editExpenseBtn');
      const delBtn = document.getElementById('del');
      const infoCard = document.querySelector('#detail .card');
      if (infoCard && ex.author) infoCard.insertAdjacentHTML('beforeend', `<p><small class="muted">Автор</small><br>${esc(ex.author)}</p>`);
      const actions = delBtn?.parentElement || editBtn?.parentElement;
      if (actions && delBtn) {
        const topRow = document.createElement('div');
        topRow.className = 'row';
        topRow.style.width = '100%';
        if (editBtn) {
          editBtn.style.flex = '1 1 0';
          editBtn.style.minWidth = '0';
          topRow.appendChild(editBtn);
        }
        if (paid) {
          paid.style.flex = '1 1 0';
          paid.style.minWidth = '0';
          topRow.appendChild(paid);
        }
        delBtn.textContent = 'Удалить расход';
        delBtn.style.width = '100%';
        delBtn.style.display = 'block';
        delBtn.style.flex = 'none';
        actions.className = '';
        actions.style.cssText = 'display:flex;flex-direction:column;gap:10px;margin-top:12px;width:100%';
        actions.replaceChildren(topRow, delBtn);
      }
      if (paid) paid.onclick = async () => {
        try {
          banner('Отмечаю компенсацию…');
          await api('mark_reimbursed', { id: i });
          detailDlg.close();
          await loadCloud();
          banner('Компенсация отмечена', 'ok');
        } catch (e) { banner('Ошибка: ' + e.message, 'error'); }
      };
      if (delBtn) delBtn.onclick = async () => {
        if (!confirm('Удалить расход?')) return;
        try {
          banner('Удаляю расход…');
          await api('delete_expense', { id: i });
          detailDlg.close();
          await loadCloud();
          banner('Расход и его чек удалены', 'ok');
        } catch (e) { banner('Ошибка: ' + e.message, 'error'); }
      };
    };
  }
