(() => {
  const SUPABASE_URL = 'https://blaacuwwvyatfiyjnsrw.supabase.co';
  const SUPABASE_FUNCTIONS = `${SUPABASE_URL}/functions/v1`;
  const tgApp = window.Telegram?.WebApp;
  const initData = tgApp?.initData || '';
  let cloudReady = false;
  let currentUser = null;
  let selectedReceiptBlob = null;
  let selectedReceiptPreviewUrl = null;
  let receiptPreparation = null;
  let receiptGeneration = 0;
  let uploadedReceiptPath = null;
  let receiptError = null;
  let savingExpense = false;
  let projectSection = 'overview';
  let projectFinanceSection = 'summary';
  let globalFinanceSection = 'summary';
  const globalTabs = new Set(['home', 'projects', 'finance', 'leads', 'designers', 'masters', 'more']);
  const globalTabLabels = {
    home: 'Главная', projects: 'Объекты', finance: 'Финансы',
    leads: 'Заявки', designers: 'Дизайнеры', masters: 'Мастера', more: 'Ещё',
  };
  const projectStatuses = {
    active: 'В работе', preparation: 'Подготовка', in_progress: 'В работе',
    paused: 'Приостановлен', handover: 'Сдача', warranty: 'Гарантия', archived: 'Архив',
  };
  const projectSections = [
    ['overview', 'Обзор'], ['schedule', 'График'], ['finance', 'Финансы'],
    ['team', 'Команда'], ['documents', 'Документы'], ['tasks', 'Задачи'], ['photos', 'Фото'],
  ];
  const projectFinanceSections = [
    ['summary', 'Сводка'], ['acts', 'Акты'], ['waybills', 'Накладные'], ['checks', 'Чеки / Разное'],
  ];
  const stageStatuses = {
    planned: 'Запланирован', in_progress: 'В работе', completed: 'Выполнен',
    delayed: 'Задерживается', paused: 'Приостановлен',
  };

  const optionalValue = value => String(value || '').trim() || null;
  const projectStatusLabel = status => projectStatuses[status] || projectStatuses.active;
  const projectStatusClass = status => ['paused'].includes(status) ? 'pending' : ['archived'].includes(status) ? 'neutral' : 'paid';
  const projectDate = value => value ? fmt(value) : 'Не указана';

  function clearSelectedReceipt() {
    receiptGeneration++;
    receiptPreparation = null;
    uploadedReceiptPath = null;
    receiptError = null;
    selectedReceiptBlob = null;
    if (selectedReceiptPreviewUrl && selectedReceiptPreviewUrl.startsWith('blob:')) {
      try { URL.revokeObjectURL(selectedReceiptPreviewUrl); } catch {}
    }
    selectedReceiptPreviewUrl = null;
  }

  function prepareReceiptFile(file) {
    return new Promise((resolve, reject) => {
      if (!file) return reject(new Error('Файл не выбран'));
      const type = String(file.type || '').toLowerCase();
      if (!type.startsWith('image/')) return reject(new Error('Нужна фотография чека'));

      const sourceUrl = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        try {
          const maxSide = 1400;
          const scale = Math.min(1, maxSide / Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height));
          const w = Math.max(1, Math.round((img.naturalWidth || img.width) * scale));
          const h = Math.max(1, Math.round((img.naturalHeight || img.height) * scale));
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, w, h);
          canvas.toBlob(blob => {
            URL.revokeObjectURL(sourceUrl);
            if (!blob) return reject(new Error('Не удалось подготовить фото'));
            resolve(new File([blob], 'receipt.jpg', { type: 'image/jpeg' }));
          }, 'image/jpeg', 0.72);
        } catch (e) {
          URL.revokeObjectURL(sourceUrl);
          reject(e);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(sourceUrl);
        if (file.size <= 8 * 1024 * 1024) resolve(file);
        else reject(new Error('Это фото не удалось сжать. Сделай скриншот чека и выбери его.'));
      };
      img.src = sourceUrl;
    });
  }

  function banner(text, kind = 'info') {
    let el = document.getElementById('cloudBanner');
    if (!el) {
      el = document.createElement('div');
      el.id = 'cloudBanner';
      el.style.cssText = 'position:fixed;left:12px;right:12px;top:calc(8px + env(safe-area-inset-top));z-index:50;padding:10px 14px;border-radius:14px;font:600 13px -apple-system,BlinkMacSystemFont,sans-serif;box-shadow:0 8px 24px #0002;text-align:center;';
      document.body.appendChild(el);
    }
    el.style.background = kind === 'error' ? '#fff0f0' : kind === 'ok' ? '#e8f6ee' : '#fff';
    el.style.color = kind === 'error' ? '#a92f2f' : kind === 'ok' ? '#246f4b' : '#333';
    el.textContent = text;
    if (kind === 'ok') setTimeout(() => el.remove(), 2200);
  }

  function post(path, body) {
    // The Edge Functions parse JSON via req.json(), regardless of Content-Type.
    // A safelisted text body avoids a second preflight after the photo upload.
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${SUPABASE_FUNCTIONS}/${path}`, true);
      xhr.timeout = 45000;
      xhr.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');
      xhr.onload = () => {
        let data;
        try { data = JSON.parse(xhr.responseText); }
        catch { return reject(new Error('Некорректный ответ сервера')); }
        if (xhr.status >= 200 && xhr.status < 300 && data.ok !== false && !data.error) return resolve(data);
        reject(new Error(data.error || `HTTP_${xhr.status}`));
      };
      xhr.onerror = () => reject(new Error('Ошибка соединения с облаком. Данные формы сохранены.'));
      xhr.ontimeout = () => reject(new Error('Сервер не ответил вовремя. Проверьте список расходов перед повторным сохранением.'));
      xhr.send(JSON.stringify(body));
    });
  }

  AdmaAuth.init(post, initData);
  async function api(action, extra = {}) {
    return post('adma-api', { ...await AdmaAuth.credentials(), action, ...extra });
  }

  async function financeApi(action, extra = {}) {
    return post('finance-api', { ...await AdmaAuth.credentials(), action, ...extra });
  }

  function mapProject(p) {
    return {
      id: p.id,
      name: p.name,
      address: p.address || '',
      client: p.client_name || '',
      comment: p.comment || '',
      status: p.status || 'active',
      area: p.area_sqm == null ? null : Number(p.area_sqm),
      clientPhone: p.client_phone || '',
      startDate: p.start_date || '',
      plannedEndDate: p.planned_end_date || '',
      actualEndDate: p.actual_end_date || '',
      contractNumber: p.contract_number || '',
      warrantyUntil: p.warranty_until || '',
    };
  }

  function mapStage(s) {
    return {
      id: s.id, projectId: s.project_id, name: s.name, position: Number(s.position || 0),
      plannedStart: s.planned_start || '', plannedEnd: s.planned_end || '',
      actualStart: s.actual_start || '', actualEnd: s.actual_end || '',
      progress: Number(s.progress || 0), status: s.status || 'planned',
      responsibleUserId: s.responsible_user_id || '', workCost: s.work_cost == null ? null : Number(s.work_cost),
      comment: s.comment || '', createdAt: s.created_at || '',
    };
  }

  function mapExpense(e) {
    return {
      id: e.id,
      projectId: e.project_id,
      amount: Number(e.amount || 0),
      date: e.expense_date,
      category: e.category || 'Прочее',
      supplier: e.supplier || '',
      paidBy: e.paid_by || 'adma',
      reimburse: !!e.reimbursement_required,
      reimbursed: !!e.reimbursed,
      comment: e.comment || '',
      receipt: e.receipt_url || null,
      receiptPath: e.receipt_path || null,
      author: e.author ? ([e.author.first_name,e.author.last_name].filter(Boolean).join(' ') || e.author.web_login || e.author.telegram_username || 'ADMA') : 'ADMA',
    };
  }

  const numeric = value => Number(value || 0);
  const mapAct = a => ({...a, projectId:a.project_id, stageId:a.stage_id||'', date:a.act_date, amount:numeric(a.amount), filePath:a.file_path||'', fileUrl:a.file_url||''});
  const mapActCost = x => ({...x, actId:x.act_id, date:x.cost_date, amount:numeric(x.amount)});
  const mapActPayment = x => ({...x, actId:x.act_id, date:x.payment_date, amount:numeric(x.amount)});
  const mapWaybill = w => ({...w, projectId:w.project_id, date:w.waybill_date, amount:numeric(w.amount), filePath:w.file_path||'', fileUrl:w.file_url||''});
  const mapWaybillPayment = x => ({...x, waybillId:x.waybill_id, date:x.payment_date, amount:numeric(x.amount)});
  const mapCompanyExpense = x => ({...x, date:x.expense_date, amount:numeric(x.amount), filePath:x.file_path||'', fileUrl:x.file_url||'', authorName:x.author?([x.author.first_name,x.author.last_name].filter(Boolean).join(' ')||x.author.web_login||x.author.telegram_username||'ADMA'):'ADMA'});

  async function loadFinanceCloud() {
    if (!canManageProjects()) {
      state.acts=[];state.actCosts=[];state.actPayments=[];state.waybills=[];state.waybillPayments=[];state.companyExpenses=[];
      return;
    }
    const data=await financeApi('load');
    state.acts=(data.acts||[]).map(mapAct);state.actCosts=(data.act_costs||[]).map(mapActCost);state.actPayments=(data.act_payments||[]).map(mapActPayment);
    state.waybills=(data.waybills||[]).map(mapWaybill);state.waybillPayments=(data.waybill_payments||[]).map(mapWaybillPayment);state.companyExpenses=(data.company_expenses||[]).map(mapCompanyExpense);
  }

  async function loadCloud() {
    const data = await api('load');
    state.projects = (data.projects || []).map(mapProject);
    state.expenses = (data.expenses || []).map(mapExpense);
    state.stages = (data.stages || []).map(mapStage);
    await loadFinanceCloud();
    save();
    render();
    return data;
  }

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
  let editingProjectId = null;
  let showArchivedProjects = false;

  function canManageProjects() {
    return currentUser?.role === 'owner' || currentUser?.role === 'partner';
  }

  const actsFor = projectId => (state.acts || []).filter(x => x.projectId === projectId);
  const waybillsFor = projectId => (state.waybills || []).filter(x => x.projectId === projectId);
  const actCostsFor = actId => (state.actCosts || []).filter(x => x.actId === actId);
  const actPaymentsFor = actId => (state.actPayments || []).filter(x => x.actId === actId);
  const waybillPaymentsFor = waybillId => (state.waybillPayments || []).filter(x => x.waybillId === waybillId);
  const totalAmounts = items => items.reduce((total, item) => total + numeric(item.amount), 0);
  const actCost = actId => totalAmounts(actCostsFor(actId));
  const actPaid = actId => totalAmounts(actPaymentsFor(actId));
  const actProfit = act => numeric(act.amount) - actCost(act.id);
  const waybillPaid = waybillId => totalAmounts(waybillPaymentsFor(waybillId));
  const waybillProfit = waybill => numeric(waybill.amount) - waybillPaid(waybill.id);
  function projectFinanceTotals(projectId) {
    const acts=actsFor(projectId),waybills=waybillsFor(projectId);
    const actsAmount=totalAmounts(acts),actsProfit=acts.reduce((s,x)=>s+actProfit(x),0);
    const waybillsAmount=totalAmounts(waybills),waybillsProfit=waybills.reduce((s,x)=>s+waybillProfit(x),0);
    return {actsAmount,actsProfit,waybillsAmount,waybillsProfit,checks:spent(projectId),due:due(projectId),profit:actsProfit+waybillsProfit};
  }
  function companyFinanceTotals() {
    const objectProfit=(state.projects||[]).reduce((s,p)=>s+projectFinanceTotals(p.id).profit,0);
    const general=totalAmounts(state.companyExpenses||[]);
    return {objectProfit,general,due:due(),profit:objectProfit-general};
  }

  function activeProjects() {
    return state.projects.filter(p => p.status !== 'archived');
  }

  function archivedProjects() {
    return state.projects.filter(p => p.status === 'archived');
  }

  function stagesFor(projectId) {
    return (state.stages || []).filter(s => s.projectId === projectId).sort((a, b) => a.position - b.position || String(a.plannedStart).localeCompare(String(b.plannedStart)) || String(a.createdAt).localeCompare(String(b.createdAt)));
  }

  function daysBetween(from, to) {
    if (!from || !to) return 0;
    return Math.round((new Date(to + 'T12:00:00') - new Date(from + 'T12:00:00')) / 86400000);
  }

  function scheduleSummary(projectId) {
    const stages = stagesFor(projectId);
    if (!stages.length) return { stages, progress: 0, plannedProgress: null, current: null, next: null, delay: 0, delayed: [] };
    const progress = Math.round(stages.reduce((total, stage) => total + stage.progress, 0) / stages.length);
    const today = new Date().toISOString().slice(0, 10);
    const dated = stages.filter(stage => stage.plannedStart && stage.plannedEnd);
    const plannedProgress = dated.length ? Math.round(dated.reduce((total, stage) => {
      if (today <= stage.plannedStart) return total;
      if (today >= stage.plannedEnd) return total + 100;
      const duration = Math.max(1, daysBetween(stage.plannedStart, stage.plannedEnd));
      return total + Math.max(0, Math.min(100, daysBetween(stage.plannedStart, today) / duration * 100));
    }, 0) / dated.length) : null;
    const delayed = stages.filter(stage => stage.status !== 'completed' && stage.progress < 100 && stage.plannedEnd && stage.plannedEnd < today);
    const explicitDelayed = stages.filter(stage => stage.status === 'delayed' && !delayed.includes(stage));
    delayed.push(...explicitDelayed);
    const delay = delayed.reduce((max, stage) => Math.max(max, stage.plannedEnd ? daysBetween(stage.plannedEnd, today) : 1), 0);
    const current = stages.find(stage => ['in_progress', 'delayed', 'paused'].includes(stage.status)) || stages.find(stage => stage.progress > 0 && stage.progress < 100) || null;
    const currentIndex = current ? stages.indexOf(current) : -1;
    const next = stages.slice(Math.max(0, currentIndex + 1)).find(stage => stage.status === 'planned') || null;
    return { stages, progress, plannedProgress, current, next, delay, delayed };
  }

  function delayLabel(summary) {
    if (!summary.stages.length) return 'График не заполнен';
    if (summary.delay > 0) return `Отставание ${summary.delay} дн.`;
    return 'По плану';
  }

  function pageHeader(kicker, title, description, action = '') {
    return `<div class="page-kicker">${esc(kicker)}</div><div class="page-title-row"><div><h2>${esc(title)}</h2><p>${esc(description)}</p></div>${action}</div>`;
  }

  function sectionTabs(items, active, attribute) {
    return `<nav class="section-tabs" aria-label="Разделы">${items.map(([id, label]) => `<button class="section-tab ${active === id ? 'active' : ''}" ${attribute}="${id}">${label}</button>`).join('')}</nav>`;
  }

  function moduleScreen(icon, title, description, relation = '') {
    return `<section class="card module-screen"><span class="module-screen-icon">${icon}</span><h2>${esc(title)}</h2><p>${esc(description)}</p>${relation ? `<div class="module-relation">${esc(relation)}</div>` : ''}</section>`;
  }

  function navigateGlobal(tab) {
    state.project = null;
    state.tab = globalTabs.has(tab) ? tab : 'home';
    render();
  }

  function navigateProject(projectId, section = 'overview', financeSection = null) {
    state.project = projectId;
    state.tab = 'projects';
    projectSection = projectSections.some(([id]) => id === section) ? section : 'overview';
    if (financeSection && projectFinanceSections.some(([id]) => id === financeSection)) projectFinanceSection = financeSection;
    render();
  }

  function routeHash() {
    if (state.project) {
      const finance = projectSection === 'finance' ? `/${projectFinanceSection}` : '';
      return `#/projects/${encodeURIComponent(state.project)}/${projectSection}${finance}`;
    }
    return `#/${globalTabs.has(state.tab) ? state.tab : 'home'}`;
  }

  function applyHashRoute() {
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
    if (parts[0] === 'projects' && parts[1] && state.projects.some(project => project.id === parts[1])) {
      state.project = parts[1];
      state.tab = 'projects';
      projectSection = projectSections.some(([id]) => id === parts[2]) ? parts[2] : 'overview';
      if (projectSection === 'finance' && projectFinanceSections.some(([id]) => id === parts[3])) projectFinanceSection = parts[3];
      return;
    }
    state.project = null;
    state.tab = globalTabs.has(parts[0]) ? parts[0] : 'home';
  }

  function syncRouteHash() {
    const hash = routeHash();
    if (location.hash !== hash) history.replaceState(null, '', hash);
  }

  function syncAppChrome() {
    const projects = activeProjects();
    document.getElementById('title').textContent = state.project ? (proj(state.project)?.name || 'Объект') : (globalTabLabels[state.tab] || 'Главная');
    document.querySelectorAll('[data-side-tab]').forEach(button => {
      button.classList.toggle('active', state.project ? button.dataset.sideTab === 'projects' : button.dataset.sideTab === state.tab);
      button.onclick = () => navigateGlobal(button.dataset.sideTab);
    });
    document.querySelectorAll('.tabs [data-tab]').forEach(button => {
      const mobileTab = ['leads', 'designers', 'masters'].includes(state.tab) ? 'more' : state.tab;
      button.classList.toggle('active', state.project ? button.dataset.tab === 'projects' : button.dataset.tab === mobileTab);
      button.onclick = () => navigateGlobal(button.dataset.tab);
    });
    const count = document.getElementById('sideProjectCount');
    if (count) count.textContent = projects.length;
    const name = [currentUser?.first_name, currentUser?.last_name].filter(Boolean).join(' ') || currentUser?.web_login || roleLabel(currentUser?.role || 'foreman');
    const nameEl = document.getElementById('headerName');
    const avatar = document.getElementById('headerAvatar');
    if (nameEl) nameEl.textContent = name;
    if (avatar) avatar.textContent = name.trim().slice(0, 2).toUpperCase() || 'A';
    const list = document.getElementById('sideProjects');
    if (!list) return;
    list.innerHTML = projects.map(project => {
      const summary = scheduleSummary(project.id);
      return `<button class="side-project ${state.project === project.id ? 'active' : ''}" data-side-project="${esc(project.id)}"><strong>${esc(project.name)}</strong><span>${esc(summary.current?.name || delayLabel(summary))}</span></button>`;
    }).join('') || '<span class="muted" style="padding:8px 14px;font-size:12px">Нет активных объектов</span>';
    list.querySelectorAll('[data-side-project]').forEach(button => button.onclick = () => navigateProject(button.dataset.sideProject));
  }

  function openProjectCreateCloud() {
    if (!canManageProjects()) return;
    editingProjectId = null;
    projectForm.reset();
    pStatus.value = 'preparation';
    const title = projectDlg.querySelector('.sheethead h2');
    if (title) title.textContent = 'Новый объект';
    projectDlg.showModal();
  }

  function openProjectEditCloud(id) {
    if (!canManageProjects()) return;
    const p = state.projects.find(x => x.id === id);
    if (!p) return;
    editingProjectId = id;
    projectForm.reset();
    pName.value = p.name || '';
    pAddress.value = p.address || '';
    pClient.value = p.client || '';
    pComment.value = p.comment || '';
    pStatus.value = p.status === 'active' ? 'in_progress' : p.status;
    pArea.value = p.area ?? '';
    pClientPhone.value = p.clientPhone || '';
    pStartDate.value = p.startDate || '';
    pPlannedEndDate.value = p.plannedEndDate || '';
    pActualEndDate.value = p.actualEndDate || '';
    pContract.value = p.contractNumber || '';
    pWarrantyUntil.value = p.warrantyUntil || '';
    const title = projectDlg.querySelector('.sheethead h2');
    if (title) title.textContent = 'Редактировать объект';
    projectDlg.showModal();
  }

  async function setProjectArchivedCloud(id, archived) {
    if (!canManageProjects()) return;
    const p = state.projects.find(x => x.id === id);
    if (!p) return;
    if (archived && !confirm(`Перенести «${p.name}» в архив? Расходы и чеки сохранятся.`)) return;
    try {
      banner(archived ? 'Переношу объект в архив…' : 'Возвращаю объект в работу…');
      await api('update_project', { project: { id, status: archived ? 'archived' : 'in_progress' } });
      if (state.project === id) state.project = null;
      state.tab = 'projects';
      showArchivedProjects = archived;
      await loadCloud();
      banner(archived ? 'Объект перенесён в архив' : 'Объект снова активен', 'ok');
    } catch (e) {
      banner('Не удалось изменить статус объекта: ' + e.message, 'error');
    }
  }

  function renderHomeCloud() {
    const m = new Date().toISOString().slice(0, 7);
    const month = sum(state.expenses.filter(e => e.date.startsWith(m)));
    const recent = [...state.expenses].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 6);
    const projects = activeProjects();
    const delayed = projects.flatMap(project => scheduleSummary(project.id).delayed.map(stage => ({ project, stage })));
    const pendingItems = state.expenses.filter(pending).slice(0, 4);
    const attention = [
      ...delayed.map(({project, stage}) => `<button class="attention-item" data-open-project="${esc(project.id)}" data-section="schedule"><span class="attention-icon">!</span><span class="grow"><strong>${esc(project.name)} · ${esc(stage.name)}</strong><span>${esc(delayLabel(scheduleSummary(project.id)))}</span></span></button>`),
      ...pendingItems.map(expense => `<button class="attention-item" data-open-project="${esc(expense.projectId)}" data-section="finance"><span class="attention-icon">₽</span><span class="grow"><strong>Компенсировать · ${money(expense.amount)}</strong><span>${esc(proj(expense.projectId)?.name || '')} · ${esc(expense.supplier || expense.category)}</span></span></button>`),
    ];
    $('#app').innerHTML = `${pageHeader('ADMA · ОБЗОР', 'Главная', 'Состояние объектов и вопросы, которые требуют внимания', canManageProjects() ? '<button id="homeAddProject" class="btn primary">+ Объект</button>' : '')}<section class="dashboard-metrics"><button class="card dashboard-metric" data-home-tab="projects"><small>Активные объекты</small><strong>${projects.length}</strong><span>${projects.filter(p => scheduleSummary(p.id).current).length} сейчас в работе</span></button><div class="card dashboard-metric"><small>Расходы за месяц</small><strong>${money(month)}</strong><span>Чеки / разное</span></div><div class="card dashboard-metric"><small>Компенсировано</small><strong>${money(reimb())}</strong><span>Возвращено заказчиками</span></div><button class="card dashboard-metric featured" data-home-tab="finance"><small>К компенсации</small><strong>${money(due())}</strong><span>${state.expenses.filter(pending).length} незакрытых расходов</span></button></section><section class="dashboard-columns"><div class="card panel-card"><div class="section compact"><h2>Объекты</h2><button class="btn secondary" data-home-tab="projects">Все объекты →</button></div><div class="activity-list">${projects.length ? projects.map(project => { const summary = scheduleSummary(project.id); return `<button class="activity-item" data-open-project="${esc(project.id)}"><span class="status-dot ${summary.delay ? 'critical' : summary.stages.length ? '' : 'warn'}"></span><span class="grow"><strong>${esc(project.name)} · ${summary.progress}%</strong><span>${esc(summary.current?.name || delayLabel(summary))}</span></span><strong>${esc(summary.delay ? `−${summary.delay} дн.` : summary.stages.length ? 'По плану' : 'Нет графика')}</strong></button>`; }).join('') : '<div class="empty">Активных объектов пока нет</div>'}</div></div><div class="card panel-card"><div class="section compact"><h2>Требует внимания</h2><span class="badge ${attention.length ? 'pending' : 'paid'}">${attention.length}</span></div><div class="attention-list">${attention.length ? attention.join('') : '<div class="empty">Сейчас всё спокойно</div>'}</div></div></section><section class="card panel-card"><div class="section compact"><h2>Последние операции</h2></div><div id="list"></div></section>`;
    renderExpenses(recent, $('#list'));
    const add = document.getElementById('homeAddProject'); if (add) add.onclick = openProjectCreateCloud;
    document.querySelectorAll('[data-home-tab]').forEach(button => button.onclick = () => navigateGlobal(button.dataset.homeTab));
    document.querySelectorAll('[data-open-project]').forEach(button => button.onclick = () => navigateProject(button.dataset.openProject, button.dataset.section || 'overview', button.dataset.section === 'finance' ? 'checks' : null));
  }

  function renderProjectsCloud() {
    const active = activeProjects();
    const archived = archivedProjects();
    const list = showArchivedProjects ? archived : active;
    const heading = showArchivedProjects ? 'Архив' : 'Активные объекты';
    $('#app').innerHTML = `<div class="section"><div><h2>${heading}</h2><div class="muted project-list-subtitle">Карточки объектов и их текущее состояние</div></div>${!showArchivedProjects && canManageProjects() ? '<button id="addProject" class="btn primary">+ Объект</button>' : ''}</div>${showArchivedProjects ? '<button id="showActive" class="btn secondary project-list-toggle">‹ Активные объекты</button>' : (archived.length ? `<button id="showArchive" class="btn secondary project-list-toggle">Архив · ${archived.length}</button>` : '')}<div id="plist" class="project-list-grid"></div>`;
    const add = document.getElementById('addProject');
    if (add) add.onclick = openProjectCreateCloud;
    const archiveBtn = document.getElementById('showArchive');
    if (archiveBtn) archiveBtn.onclick = () => { showArchivedProjects = true; render(); };
    const activeBtn = document.getElementById('showActive');
    if (activeBtn) activeBtn.onclick = () => { showArchivedProjects = false; render(); };
    const l = $('#plist');
    if (!list.length) {
      l.innerHTML = `<div class="empty">${showArchivedProjects ? 'Архив пока пуст' : (canManageProjects() ? 'Создай первый объект' : 'Нет доступных объектов')}</div>`;
      return;
    }
    list.forEach(p => {
      const b = document.createElement('button');
      b.className = 'card project-list-card';
      const meta = [p.address, p.area ? `${p.area} м²` : ''].filter(Boolean).join(' · ');
      const summary = scheduleSummary(p.id);
      b.innerHTML = `<div class="row project-card-title"><strong>${esc(p.name)}</strong><span class="badge ${projectStatusClass(p.status)}">${projectStatusLabel(p.status)}</span></div><div class="muted project-card-address">${esc(meta || 'Адрес и площадь не указаны')}</div><div class="project-card-data"><div><small class="muted">Заказчик</small><strong>${esc(p.client || 'Не указан')}</strong></div><div><small class="muted">Плановая сдача</small><strong>${esc(projectDate(p.plannedEndDate))}</strong></div><div><small class="muted">Текущий этап</small><strong>${esc(summary.current?.name || (summary.stages.length ? 'Ожидает начала' : 'График не заполнен'))}</strong></div><div><small class="muted">Готовность</small><strong>${summary.stages.length ? summary.progress + '%' : '—'}</strong></div></div>${summary.stages.length ? `<div class="progress-track"><div class="progress-fill ${summary.delay ? 'warn' : ''}" style="width:${summary.progress}%"></div></div>` : ''}<div class="project-card-footer"><span>${esc(delayLabel(summary))} · ${money(due(p.id))} к компенсации</span><strong>Открыть объект ›</strong></div>`;
      b.onclick = () => navigateProject(p.id);
      l.appendChild(b);
    });
  }

  function projectHeader(p) {
    const summary = scheduleSummary(p.id);
    const meta = [p.address, p.area ? `${p.area} м²` : ''].filter(Boolean).join(' · ');
    return `<div class="object-breadcrumb"><button id="back" class="breadcrumb-button"><strong>Объекты</strong></button> / ${esc(p.name)}</div><section class="card object-head"><div class="row"><div class="grow"><div class="row object-title-row"><h2>${esc(p.name)}</h2><span class="badge ${projectStatusClass(p.status)}">${projectStatusLabel(p.status)}</span></div><div class="muted">${esc(meta || 'Адрес и площадь не указаны')}</div><div class="muted object-meta">${esc(p.client ? `Заказчик: ${p.client}` : 'Заказчик не указан')}</div></div><div class="object-actions">${p.status !== 'archived' ? '<button id="objectOperation" class="btn primary">+ Операция</button>' : ''}${canManageProjects() ? `<button id="editProjectCloud" class="btn secondary">Редактировать</button><button id="archiveProjectCloud" class="btn ${p.status === 'archived' ? 'primary' : 'danger'}">${p.status === 'archived' ? 'Вернуть в работу' : 'В архив'}</button>` : ''}</div></div><div class="object-schedule"><div><small>Готовность</small><strong>${summary.stages.length ? summary.progress + '%' : '—'}</strong></div><div><small>Текущий этап</small><strong>${esc(summary.current?.name || (summary.stages.length ? 'Ожидает начала' : 'График не заполнен'))}</strong></div><div><small>Начало</small><strong>${esc(projectDate(p.startDate))}</strong></div><div><small>Отклонение</small><strong>${esc(delayLabel(summary))}</strong></div></div></section><nav class="project-tabs" aria-label="Разделы объекта">${projectSections.map(([id, label]) => `<button class="project-tab ${projectSection === id ? 'active' : ''}" data-project-section="${id}">${label}</button>`).join('')}</nav><div id="projectSection"></div>`;
  }

  function renderProjectOverview(p) {
    const summary = scheduleSummary(p.id);
    const notes = p.comment ? `<div class="card"><strong>Примечания</strong><p>${esc(p.comment)}</p></div>` : '';
    const attention = summary.delayed.map(stage => `<button class="attention-item" data-project-section="schedule"><span class="attention-icon">!</span><span class="grow"><strong>${esc(stage.name)} задерживается</strong><span>${esc(stage.plannedEnd ? `Плановое окончание ${projectDate(stage.plannedEnd)}` : 'Проверьте статус этапа')}</span></span></button>`);
    const pendingCount = state.expenses.filter(e => e.projectId === p.id && pending(e)).length;
    const finance = projectFinanceTotals(p.id);
    if (pendingCount) attention.push(`<button class="attention-item" data-project-section="finance"><span class="attention-icon">₽</span><span class="grow"><strong>К компенсации ${money(due(p.id))}</strong><span>${pendingCount} незакрытых расходов</span></span></button>`);
    $('#projectSection').innerHTML = `<section class="project-summary-grid"><div class="card project-summary-card disabled-summary"><small>Акты</small><strong>—</strong><span>Подключим на этапе 4</span></div><div class="card project-summary-card disabled-summary"><small>Накладные</small><strong>—</strong><span>Подключим на этапе 4</span></div><button class="card project-summary-card" data-project-section="finance"><small>Чеки / Разное</small><strong>${money(spent(p.id))}</strong><span>${expensesFor(p.id).length} записей</span></button><button class="card project-summary-card featured" data-project-section="finance"><small>К компенсации</small><strong>${money(due(p.id))}</strong><span>${pendingCount} не закрыто</span></button></section><section class="object-overview-grid"><div class="card overview-progress-card"><div class="overview-progress-head"><div><small>Ход работ</small><strong>${summary.stages.length ? summary.progress + '%' : 'График не заполнен'}</strong></div><span class="badge ${summary.delay ? 'pending' : summary.stages.length ? 'paid' : 'neutral'}">${esc(delayLabel(summary))}</span></div><div class="progress-track"><div class="progress-fill ${summary.delay ? 'warn' : ''}" style="width:${summary.progress}%"></div></div><div class="overview-progress-labels"><span>${esc(summary.current ? `Сейчас: ${summary.current.name}` : 'Текущий этап не выбран')}</span><span>${esc(summary.next ? `Далее: ${summary.next.name}` : '')}</span></div><button class="btn secondary" data-project-section="schedule" style="margin-top:18px">Открыть график →</button></div><div class="card"><div class="section compact"><h2>Требует внимания</h2><span class="badge ${attention.length ? 'pending' : 'paid'}">${attention.length}</span></div><div class="attention-list">${attention.length ? attention.join('') : '<div class="empty">Сейчас всё спокойно</div>'}</div></div><div class="card"><div class="section compact"><h2>Информация</h2></div><dl class="object-details"><div><dt>Заказчик</dt><dd>${esc(p.client || 'Не указан')}</dd></div><div><dt>Телефон</dt><dd>${esc(p.clientPhone || 'Не указан')}</dd></div><div><dt>Договор</dt><dd>${esc(p.contractNumber || 'Не указан')}</dd></div><div><dt>Плановая сдача</dt><dd>${esc(projectDate(p.plannedEndDate))}</dd></div><div><dt>Гарантия до</dt><dd>${esc(projectDate(p.warrantyUntil))}</dd></div></dl></div></section>${notes}`;
    const progressLabels = document.querySelector('.overview-progress-labels');
    if (canManageProjects()) {
      const summaryCards = document.querySelectorAll('.project-summary-card');
      if (summaryCards[0]) { summaryCards[0].classList.remove('disabled-summary'); summaryCards[0].querySelector('strong').textContent=money(finance.actsAmount); summaryCards[0].querySelector('span').textContent=`Прибыль ${money(finance.actsProfit)}`; }
      if (summaryCards[1]) { summaryCards[1].classList.remove('disabled-summary'); summaryCards[1].querySelector('strong').textContent=money(finance.waybillsAmount); summaryCards[1].querySelector('span').textContent=`Прибыль ${money(finance.waybillsProfit)}`; }
    }
    if (progressLabels && summary.plannedProgress != null) progressLabels.insertAdjacentHTML('afterbegin', `<span>План: ${summary.plannedProgress}% · Факт: ${summary.progress}%</span>`);
  }

  function renderProjectSchedule(p) {
    const summary = scheduleSummary(p.id);
    const isArchived = p.status === 'archived';
    $('#projectSection').innerHTML = `<div class="page-title-row"><div><h2>График работ</h2><p>Этапы, сроки и фактическая готовность объекта</p></div>${canManageProjects() && !isArchived ? '<button id="addStage" class="btn primary">+ Этап</button>' : ''}</div><section class="schedule-summary"><div class="card dashboard-metric"><small>Общая готовность</small><strong>${summary.stages.length ? summary.progress + '%' : '—'}</strong><span>${summary.stages.length} этапов</span></div><div class="card dashboard-metric"><small>Текущий этап</small><strong>${esc(summary.current?.name || '—')}</strong><span>${summary.current ? summary.current.progress + '% готово' : 'Не выбран'}</span></div><div class="card dashboard-metric"><small>Следующий этап</small><strong>${esc(summary.next?.name || '—')}</strong><span>${summary.next?.plannedStart ? projectDate(summary.next.plannedStart) : 'Не запланирован'}</span></div><div class="card dashboard-metric ${summary.delay ? 'featured' : ''}"><small>Отклонение</small><strong>${esc(delayLabel(summary))}</strong><span>${summary.delayed.length ? summary.delayed.length + ' этапов требуют внимания' : 'Задержек нет'}</span></div></section><div id="stageList" class="schedule-stage-list"></div>`;
    const firstMetricNote = document.querySelector('.schedule-summary .dashboard-metric span');
    if (firstMetricNote && summary.plannedProgress != null) firstMetricNote.textContent = `Плановая готовность ${summary.plannedProgress}% · ${summary.stages.length} этапов`;
    const list = document.getElementById('stageList');
    if (!summary.stages.length) list.innerHTML = `<div class="card schedule-empty"><h3>График пока пуст</h3><p class="muted">Добавьте этапы работ — система автоматически рассчитает готовность и задержки.</p>${canManageProjects() && !isArchived ? '<button id="emptyAddStage" class="btn primary">Добавить первый этап</button>' : ''}</div>`;
    else list.innerHTML = summary.stages.map(stage => `<button class="card stage-card" data-stage-id="${esc(stage.id)}"><div class="stage-card-head"><span class="stage-card-title"><strong>${esc(stage.name)}</strong><span>${esc(stage.comment || 'Без комментария')}</span></span><span class="stage-status ${esc(stage.status)}">${esc(stageStatuses[stage.status] || stage.status)}</span></div><div class="stage-progress-row"><div class="progress-track"><div class="progress-fill ${stage.status === 'delayed' ? 'warn' : ''}" style="width:${stage.progress}%"></div></div><strong>${stage.progress}%</strong></div><div class="stage-card-meta"><div><small>План</small><strong>${esc(stage.plannedStart ? projectDate(stage.plannedStart) : '—')} — ${esc(stage.plannedEnd ? projectDate(stage.plannedEnd) : '—')}</strong></div><div><small>Факт</small><strong>${esc(stage.actualStart ? projectDate(stage.actualStart) : '—')} — ${esc(stage.actualEnd ? projectDate(stage.actualEnd) : '—')}</strong></div><div><small>Стоимость работ</small><strong>${stage.workCost == null ? '—' : money(stage.workCost)}</strong></div></div></button>`).join('');
    const add = document.getElementById('addStage') || document.getElementById('emptyAddStage'); if (add) add.onclick = () => openStageDialog(p.id);
    list.querySelectorAll('[data-stage-id]').forEach(button => button.onclick = () => openStageDialog(p.id, button.dataset.stageId));
  }

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

  function renderProjectPlaceholder(section) {
    const copy = {
      schedule: ['График работ', 'Этапы, сроки, готовность и отклонения добавим на этапе 3.'],
      team: ['Команда объекта', 'Прораб, дизайнер и мастера появятся на этапе 5.'],
      documents: ['Документы', 'Договоры, сметы и технические файлы появятся на этапе 6.'],
      tasks: ['Задачи', 'Операционные задачи объекта появятся на этапе 6.'],
      photos: ['Фото объекта', 'Фотографии по этапам появятся на этапе 6.'],
    }[section];
    $('#projectSection').innerHTML = `<div class="card module-placeholder"><span>Раздел подготовлен</span><h2>${copy[0]}</h2><p class="muted">${copy[1]}</p></div>`;
  }

  function openStageDialog(projectId, stageId = null) {
    if (!canManageProjects()) return;
    const stage = stageId ? (state.stages || []).find(item => item.id === stageId && item.projectId === projectId) : null;
    if (stageId && !stage) return;
    stageForm.reset();
    sId.value = stage?.id || '';
    sName.value = stage?.name || '';
    sStatus.value = stage?.status || 'planned';
    sProgress.value = stage?.progress ?? 0;
    sPlannedStart.value = stage?.plannedStart || '';
    sPlannedEnd.value = stage?.plannedEnd || '';
    sActualStart.value = stage?.actualStart || '';
    sActualEnd.value = stage?.actualEnd || '';
    sWorkCost.value = stage?.workCost ?? '';
    sComment.value = stage?.comment || '';
    deleteStage.hidden = !stage;
    stageDlg.querySelector('.sheethead h2').textContent = stage ? 'Редактировать этап' : 'Новый этап';
    stageDlg.dataset.projectId = projectId;
    stageDlg.showModal();
  }

  async function removeStage(id) {
    const stage = (state.stages || []).find(item => item.id === id);
    if (!stage || !canManageProjects() || !confirm(`Удалить этап «${stage.name}»?`)) return;
    try {
      banner('Удаляю этап…');
      await api('delete_stage', { id });
      stageDlg.close();
      await loadCloud();
      banner('Этап удалён', 'ok');
    } catch (e) { banner('Не удалось удалить этап: ' + e.message, 'error'); }
  }

  function renderProjectCloud() {
    const p = proj(state.project);
    if (!p) {
      state.project = null;
      state.tab = 'projects';
      render();
      return;
    }
    const isArchived = p.status === 'archived';
    $('#app').innerHTML = projectHeader(p);
    $('#back').onclick = () => { showArchivedProjects = isArchived; navigateGlobal('projects'); };
    const edit = document.getElementById('editProjectCloud');
    if (edit) edit.onclick = () => openProjectEditCloud(p.id);
    const archive = document.getElementById('archiveProjectCloud');
    if (archive) archive.onclick = () => setProjectArchivedCloud(p.id, !isArchived);
    const operation = document.getElementById('objectOperation');
    if (operation) operation.onclick = () => openExpense(p.id);
    if (projectSection === 'overview') renderProjectOverview(p);
    else if (projectSection === 'schedule') renderProjectSchedule(p);
    else if (projectSection === 'finance') renderProjectFinance(p);
    else renderProjectPlaceholder(projectSection);
    document.querySelectorAll('[data-project-section]').forEach(button => button.onclick = () => navigateProject(p.id, button.dataset.projectSection));
  }

  // TEAM_ACCESS_V13
  function roleLabel(role) {
    return role === 'owner' ? 'Владелец' : role === 'partner' ? 'Партнёр' : 'Прораб';
  }

  function ensureTeamDialog() {
    let dlg = document.getElementById('teamDlg');
    if (dlg) return dlg;
    dlg = document.createElement('dialog');
    dlg.id = 'teamDlg';
    dlg.innerHTML = `<div class="dialog-body"><div class="sheethead"><button id="closeTeam" type="button">Закрыть</button><h2>Команда и доступ</h2><span></span></div><div id="teamList"></div></div>`;
    document.body.appendChild(dlg);
    dlg.querySelector('#closeTeam').onclick = () => dlg.close();
    return dlg;
  }

  async function openTeamAccess() {
    const dlg = ensureTeamDialog();
    const list = dlg.querySelector('#teamList');
    list.innerHTML = '<div class="empty">Загружаю команду…</div>';
    if (!dlg.open) dlg.showModal();
    try {
      const data = await api('list_users');
      const users = data.users || [];
      if (!users.length) {
        list.innerHTML = '<div class="empty">Пользователей пока нет</div>';
        return;
      }
      list.innerHTML = '<button id="createWebUser" class="btn primary" style="width:100%;margin-bottom:14px">+ Сотрудник без Telegram</button>' + users.map(u => {
        const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || 'Пользователь Telegram';
        const username = u.web_login ? 'Логин: ' + u.web_login : u.telegram_username ? '@' + u.telegram_username : 'Telegram ID ' + u.telegram_user_id;
        const self = currentUser && u.id === currentUser.id;
        const projects = state.projects.filter(p => p.status !== 'archived').map(p => `<label class="switch" style="margin:7px 0"><span>${esc(p.name)}</span><input class="teamProject" type="checkbox" value="${p.id}" ${(u.project_ids || []).includes(p.id) ? 'checked' : ''}></label>`).join('');
        return `<div class="card teamUser" data-user="${u.id}">
          <div class="row"><div class="grow"><strong>${esc(name)}</strong><div class="muted">${esc(username)}</div></div>${!u.is_active ? '<span class="badge pending">Ожидает доступа</span>' : '<span class="badge paid">Активен</span>'}</div>
          <label>Роль<select class="teamRole" ${self ? 'disabled' : ''}>
            <option value="owner" ${u.role === 'owner' ? 'selected' : ''}>Владелец</option>
            <option value="partner" ${u.role === 'partner' ? 'selected' : ''}>Партнёр</option>
            <option value="foreman" ${u.role === 'foreman' ? 'selected' : ''}>Прораб</option>
          </select></label>
          <label class="switch"><span>Доступ включён</span><input class="teamActive" type="checkbox" ${u.is_active ? 'checked' : ''} ${self ? 'disabled' : ''}></label>
          ${!self ? '<button type="button" class="btn secondary teamCredentials">Логин и пароль</button>' : ''}
          <div class="teamProjects" style="display:${u.role === 'foreman' ? 'block' : 'none'}"><div class="muted" style="margin:12px 0 7px">Объекты, доступные прорабу</div>${projects || '<div class="muted">Сначала создайте объект</div>'}</div>
          ${self ? '<div class="muted" style="margin-top:12px">Свой доступ владельца нельзя отключить здесь.</div>' : '<button class="btn primary teamSave" style="width:100%;margin-top:12px">Сохранить доступ</button>'}
        </div>`;
      }).join('');

      list.querySelector('#createWebUser').onclick = () => openWebCredentials(null);
      list.querySelectorAll('.teamUser').forEach(card => {
        const credentialsBtn = card.querySelector('.teamCredentials');
        if (credentialsBtn) credentialsBtn.onclick = () => openWebCredentials(users.find(u => u.id === card.dataset.user));
        const role = card.querySelector('.teamRole');
        const projects = card.querySelector('.teamProjects');
        if (role && !role.disabled) role.onchange = () => { projects.style.display = role.value === 'foreman' ? 'block' : 'none'; };
        const saveBtn = card.querySelector('.teamSave');
        if (saveBtn) saveBtn.onclick = async () => {
          saveBtn.disabled = true;
          const userId = card.dataset.user;
          const roleValue = card.querySelector('.teamRole').value;
          const active = card.querySelector('.teamActive').checked;
          const projectIds = roleValue === 'foreman' ? [...card.querySelectorAll('.teamProject:checked')].map(x => x.value) : [];
          try {
            banner('Сохраняю доступ…');
            await api('update_user_access', { user_id: userId, role: roleValue, is_active: active });
            await api('set_project_members', { user_id: userId, project_ids: projectIds });
            banner('Доступ обновлён', 'ok');
            await openTeamAccess();
          } catch (e) {
            banner('Не удалось изменить доступ: ' + e.message, 'error');
            saveBtn.disabled = false;
          }
        };
      });
    } catch (e) {
      list.innerHTML = `<div class="card"><strong>Не удалось загрузить команду</strong><p class="muted">${esc(e.message)}</p></div>`;
    }
  }

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

  function renderFutureModuleCloud(tab) {
    const modules = {
      leads: ['◇', 'Заявки', 'Базовый экран и маршрут готовы. Воронка и превращение заявки в объект будут реализованы на отдельном этапе.', 'Дизайнер → Заявка → Объект'],
      designers: ['✦', 'Дизайнеры', 'Базовый экран CRM готов. Контакты, воронка и история взаимодействий появятся на отдельном этапе.', 'Дизайнер → Заявки / Объекты'],
      masters: ['◎', 'Мастера', 'Базовый экран общей базы готов. Специализации, занятость и назначения появятся на отдельном этапе.', 'Мастер → Объект / Этап'],
    };
    const [icon, title, description, relation] = modules[tab];
    $('#app').innerHTML = `${pageHeader(`ADMA · ${title.toUpperCase()}`, title, 'Раздел встроен в единую структуру приложения')}${moduleScreen(icon, title, description, relation)}`;
  }

  function renderFallbackCloud() {
    if (state.tab === 'finance') return renderGlobalFinanceCloud();
    if (['leads', 'designers', 'masters'].includes(state.tab)) return renderFutureModuleCloud(state.tab);
    return renderMoreCloud();
  }

  function renderMoreCloud() {
    const role = currentUser?.role || 'foreman';
    const name = [currentUser?.first_name, currentUser?.last_name].filter(Boolean).join(' ');
    $('#app').innerHTML = `${pageHeader('ADMA · ПРОФИЛЬ', 'Ещё', 'Разделы приложения и настройки доступа')}<div class="mobile-module-links"><button class="card mobile-module-link" data-mobile-route="leads"><span>◇</span><strong>Заявки</strong><small>Воронка обращений</small></button><button class="card mobile-module-link" data-mobile-route="designers"><span>✦</span><strong>Дизайнеры</strong><small>Партнёрская CRM</small></button><button class="card mobile-module-link" data-mobile-route="masters"><span>◎</span><strong>Мастера</strong><small>Команда и занятость</small></button></div><div class="card"><strong>Облачная синхронизация включена</strong><p class="muted">Объекты, расходы и чеки хранятся в защищённом облаке Supabase и доступны на ваших устройствах.</p></div>
      <div class="card"><small class="muted">Ваш доступ</small><strong style="display:block;margin-top:6px">${roleLabel(role)}</strong>${name ? `<div class="muted" style="margin-top:4px">${esc(name)}</div>` : ''}</div>
      ${role === 'owner' ? '<div class="card"><strong>Команда</strong><p class="muted">Новые сотрудники сначала открывают Mini App через @Admafinance_bot. После этого они появятся здесь и будут ждать подтверждения.</p><button id="teamAccess" class="btn primary" style="width:100%">Команда и доступ</button></div>' : ''}
      <div class="card"><strong>Вход в браузере</strong><p class="muted">${currentUser?.web_login ? 'Ваш логин: ' + esc(currentUser.web_login) : 'Настройте логин и пароль для входа без Telegram.'}</p><button id="webCredentials" class="btn secondary">${currentUser?.web_login ? 'Изменить пароль' : 'Настроить вход'}</button>${!initData ? '<button id="webLogout" class="btn danger" style="margin-left:8px">Выйти</button>' : ''}</div>
      <div class="card"><strong>ADMA Dashboard</strong><p class="muted">Единое рабочее пространство · frontend-основа v22</p></div>`;
    document.querySelectorAll('[data-mobile-route]').forEach(button => button.onclick = () => navigateGlobal(button.dataset.mobileRoute));
    const teamBtn = document.getElementById('teamAccess');
    if (teamBtn) teamBtn.onclick = openTeamAccess;
    document.getElementById('webCredentials').onclick = () => openWebCredentials(currentUser);
    const logout = document.getElementById('webLogout');
    if (logout) logout.onclick = async () => { logout.disabled = true; try { await AdmaAuth.logout(); } finally { location.reload(); } };
  }

  function installCloudHandlers() {
    renderMore = renderFallbackCloud;
    renderHome = renderHomeCloud;
    renderProjects = renderProjectsCloud;
    renderProject = renderProjectCloud;
    renderDue = renderDueCloud;
    const baseRender = render;
    render = function() { baseRender(); syncAppChrome(); syncRouteHash(); };
    window.addEventListener('hashchange', () => { applyHashRoute(); render(); });
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
    projectForm.onsubmit = async ev => {
      ev.preventDefault();
      if (!cloudReady || !canManageProjects()) return;
      try {
        const project = {
          name: pName.value.trim(), address: pAddress.value.trim() || null,
          client_name: pClient.value.trim() || null, comment: pComment.value.trim() || null,
          status: pStatus.value,
          area_sqm: pArea.value ? Number(pArea.value) : null,
          client_phone: optionalValue(pClientPhone.value),
          start_date: optionalValue(pStartDate.value),
          planned_end_date: optionalValue(pPlannedEndDate.value),
          actual_end_date: optionalValue(pActualEndDate.value),
          contract_number: optionalValue(pContract.value),
          warranty_until: optionalValue(pWarrantyUntil.value),
        };
        banner(editingProjectId ? 'Сохраняю изменения объекта…' : 'Сохраняю объект…');
        if (editingProjectId) await api('update_project', { project: { id: editingProjectId, ...project } });
        else await api('create_project', { project });
        const wasEditing = !!editingProjectId;
        editingProjectId = null;
        projectDlg.close();
        await loadCloud();
        banner(wasEditing ? 'Объект обновлён' : 'Объект сохранён в облаке', 'ok');
      } catch (e) { console.error(e); banner('Не удалось сохранить объект: ' + e.message, 'error'); }
    };

    cancelStage.onclick = () => stageDlg.close();
    deleteStage.onclick = () => removeStage(sId.value);
    stageForm.onsubmit = async ev => {
      ev.preventDefault();
      if (!cloudReady || !canManageProjects()) return;
      const projectId = stageDlg.dataset.projectId;
      const existing = sId.value ? (state.stages || []).find(stage => stage.id === sId.value) : null;
      const positions = stagesFor(projectId).map(stage => stage.position);
      const stage = {
        project_id: projectId,
        name: sName.value.trim(), status: sStatus.value, progress: Number(sProgress.value || 0),
        position: existing?.position ?? (positions.length ? Math.max(...positions) + 10 : 0),
        planned_start: optionalValue(sPlannedStart.value), planned_end: optionalValue(sPlannedEnd.value),
        actual_start: optionalValue(sActualStart.value), actual_end: optionalValue(sActualEnd.value),
        work_cost: sWorkCost.value ? Number(sWorkCost.value) : null,
        comment: optionalValue(sComment.value), responsible_user_id: existing?.responsibleUserId || null,
      };
      const controls = [...stageForm.querySelectorAll('input,select,textarea,button')];
      controls.forEach(control => control.disabled = true);
      try {
        banner(existing ? 'Сохраняю этап…' : 'Добавляю этап…');
        if (existing) await api('update_stage', { stage: { id: existing.id, ...stage } });
        else await api('create_stage', { stage });
        stageDlg.close();
        await loadCloud();
        banner(existing ? 'Этап обновлён' : 'Этап добавлен', 'ok');
      } catch (e) { banner('Не удалось сохранить этап: ' + e.message, 'error'); }
      finally { controls.forEach(control => control.disabled = false); }
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

  function authErrorMessage(e) {
    const messages = {
      invalid_credentials: 'Неверный логин или пароль',
      invalid_session: 'Войдите снова — сессия завершилась',
      session_required: 'Введите логин и пароль',
      not_approved: 'Доступ отключён. Обратитесь к владельцу.',
      not_registered: 'Для этого аккаунта ещё не настроен доступ',
      invalid_login: 'Логин: 3–40 символов, латинские буквы, цифры, точка, дефис или подчёркивание',
      weak_password: 'Пароль должен содержать от 10 до 128 символов',
      login_taken: 'Этот логин уже занят',
      current_password_invalid: 'Текущий пароль неверен',
      account_create_failed: 'Не удалось настроить аккаунт. Повторите через «Команда и доступ».',
      account_link_failed: 'Пароль обновлён, но логин не сохранён. Проверьте логин в команде.',
      forbidden: 'Недостаточно прав',
      auth_unavailable: 'Сервис входа временно недоступен. Попробуйте ещё раз.',
    };
    return messages[e.message] || 'Не удалось выполнить запрос. Попробуйте ещё раз.';
  }

  function renderLogin(message = '') {
    document.body.dataset.locked = 'login';
    cloudReady = false;
    state.projects = []; state.expenses = [];
    $('#app').innerHTML = `<section class="card login-card"><h2>Вход в ADMA Finance</h2><p class="muted">Объекты, расходы и чеки — в одном месте.</p><form id="loginForm"><label>Логин<input id="webLogin" autocomplete="username" autocapitalize="none" spellcheck="false" required minlength="3" maxlength="40"></label><label>Пароль<input id="webPassword" type="password" autocomplete="current-password" required maxlength="128"></label><p id="loginError" role="alert">${esc(message)}</p><button class="btn primary" style="width:100%">Войти</button></form><p class="muted">Первый вход? Настройте логин и пароль в Telegram: «Ещё → Вход в браузере». Сотрудникам доступ выдаёт владелец.</p></section>`;
    document.getElementById('loginForm').onsubmit = async ev => {
      ev.preventDefault();
      const form = ev.currentTarget, btn = form.querySelector('button');
      if (btn.disabled) return;
      btn.disabled = true;
      document.getElementById('loginError').textContent = '';
      try {
        await AdmaAuth.login(document.getElementById('webLogin').value.trim(), document.getElementById('webPassword').value);
        document.getElementById('webPassword').value = '';
        await start();
      } catch(e) { document.getElementById('loginError').textContent = authErrorMessage(e); }
      finally { btn.disabled = false; }
    };
  }

  function openWebCredentials(user) {
    let dlg = document.getElementById('accountDlg');
    if (!dlg) { dlg = document.createElement('dialog'); dlg.id = 'accountDlg'; document.body.appendChild(dlg); }
    const isSelf = user?.id === currentUser.id;
    dlg.innerHTML = `<form id="accountForm"><div class="sheethead"><button type="button" id="closeAccount">Отмена</button><h2>${user ? 'Логин и пароль' : 'Новый сотрудник'}</h2><button class="btn primary">Сохранить</button></div>${!user ? '<label>Имя<input id="accountName" required maxlength="100"></label><label>Роль<select id="accountRole"><option value="foreman">Прораб</option><option value="partner">Партнёр</option></select></label>' : ''}<label>Логин<input id="accountLogin" value="${esc(user?.web_login||'')}" required pattern="[A-Za-z0-9._-]{3,40}" maxlength="40" autocomplete="username" autocapitalize="none" spellcheck="false"></label>${isSelf && !initData ? '<label>Текущий пароль<input id="accountCurrentPassword" type="password" autocomplete="current-password" required></label>' : ''}<label>Новый пароль<input id="accountPassword" type="password" autocomplete="new-password" required minlength="10" maxlength="128"></label><label>Повторите пароль<input id="accountPasswordRepeat" type="password" autocomplete="new-password" required minlength="10" maxlength="128"></label><p class="muted">Пароль от 10 символов. Логин — латинские буквы и цифры, точка, дефис или подчёркивание.</p><p id="accountMessage" role="alert"></p></form>`;
    dlg.querySelector('#closeAccount').onclick = () => dlg.close();
    dlg.querySelector('#accountForm').onsubmit = async ev => {
      ev.preventDefault();
      const form = ev.currentTarget, controls = [...form.querySelectorAll('input,select,button')];
      if (controls.some(el => el.disabled)) return;
      const password = dlg.querySelector('#accountPassword').value;
      const msg = dlg.querySelector('#accountMessage');
      if (password !== dlg.querySelector('#accountPasswordRepeat').value) { msg.textContent = 'Пароли не совпадают'; return; }
      const payload = {action:user ? 'set_credentials' : 'create_user',user_id:user?.id,login:dlg.querySelector('#accountLogin').value.trim(),password,currentPassword:dlg.querySelector('#accountCurrentPassword')?.value,name:dlg.querySelector('#accountName')?.value,role:dlg.querySelector('#accountRole')?.value};
      controls.forEach(el => el.disabled = true);
      try {
        const data = await post('account-admin', { ...await AdmaAuth.credentials(), ...payload });
        form.reset(); dlg.close();
        if (isSelf) { currentUser.web_login = data.login; render(); }
        else await openTeamAccess();
        banner('Вход настроен. Логин: ' + data.login, 'ok');
      } catch(e) { msg.textContent = authErrorMessage(e); }
      finally { controls.forEach(el => el.disabled = false); }
    };
    dlg.showModal();
  }

  async function start() {
    if (!initData && !AdmaAuth.hasSession()) { renderLogin(); return; }
    banner('Подключаю облако…');
    try {
      if (initData) {
        const auth = await post('telegram-auth', { initData });
        if (!auth.user?.is_active) throw new Error('not_approved');
      }
      const cloud = await api('load');
      currentUser = cloud.current_user;
      state.projects = (cloud.projects || []).map(mapProject);
      state.expenses = (cloud.expenses || []).map(mapExpense);
      state.stages = (cloud.stages || []).map(mapStage);
      await loadFinanceCloud();
      state.project = null;
      // Web accounts never auto-import another user's local cache.
      save();
      cloudReady = true;
      installCloudHandlers();
      delete document.body.dataset.locked;
      applyHashRoute();
      render();
      banner('Облако подключено · ' + roleLabel(currentUser.role), 'ok');
    } catch (e) {
      if (!initData) {
        if (['invalid_session','session_required','not_approved','not_registered'].includes(e.message)) AdmaAuth.forget();
        renderLogin(authErrorMessage(e));
      } else {
        document.body.dataset.locked = 'login';
        $('#app').innerHTML = '<div class="card">Не удалось подключиться. Закройте Mini App и откройте снова.</div>';
        banner(authErrorMessage(e), 'error');
      }
    }
  }

  setTimeout(start, 0);
})();
