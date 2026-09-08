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
  let masterSearch = '';
  let masterSpecialtyFilter = '';
  let masterAvailabilityFilter = '';
  let showArchivedMasters = false;
  let documentCategoryFilter = '';
  let photoStageFilter = '';
  let taskView = 'overdue';
  let designerSearch = '';
  let designerStatusFilter = '';
  let designerResponsibleFilter = '';
  let designerContactFilter = '';
  let designerView = 'list';
  let showArchivedDesigners = false;
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
  const masterSpecialtyLabels = {demolition:'Демонтаж',rough:'Черновые работы',plaster:'Штукатурка',painting:'Малярные работы',tile:'Плитка',plumbing:'Сантехника',electrical:'Электрика',drywall:'ГКЛ',flooring:'Напольные покрытия',carpentry:'Столярные работы',universal:'Универсал',other:'Другое'};
  const masterPriceLabels = {low:'Ниже среднего',medium:'Средний',high:'Выше среднего',premium:'Премиум'};
  const assignmentStatusLabels = {planned:'Запланирован',active:'Работает',completed:'Завершён',cancelled:'Отменён'};
  const documentCategoryLabels = {contract:'Договор',estimate:'Смета',addendum:'Дополнительные соглашения',design:'Дизайн-проект',technical:'Техническая документация',other:'Прочее'};
  const taskStatusLabels = {new:'Новая',in_progress:'В работе',completed:'Выполнена',cancelled:'Отменена'};
  const taskPriorityLabels = {low:'Низкий',normal:'Обычный',high:'Высокий',urgent:'Срочный'};
  const designerStatusLabels = {found:'Найден',first_contact:'Первый контакт',replied:'Ответил',meeting:'Встреча',partner:'Партнёр',referred_lead:'Передал заявку',has_project:'Есть объект',inactive:'Неактивен'};
  const designerPriorityLabels = {low:'Низкий',normal:'Обычный',high:'Высокий'};
  const designerInteractionLabels = {message:'Сообщение',call:'Звонок',meeting:'Встреча',note:'Заметка',other:'Другое'};

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

  async function mastersApi(action, extra = {}) {
    return post('masters-api', { ...await AdmaAuth.credentials(), action, ...extra });
  }

  async function operationsApi(action, extra = {}) {
    return post('project-operations-api', { ...await AdmaAuth.credentials(), action, ...extra });
  }

  async function designersApi(action, extra = {}) {
    return post('designers-api', { ...await AdmaAuth.credentials(), action, ...extra });
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
      designerId: p.designer_id || '',
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
  const mapMaster = x => ({...x, primarySpecialty:x.primary_specialty||'other', additionalSkills:Array.isArray(x.additional_skills)?x.additional_skills:[], priceLevel:x.price_level||'', isActive:x.is_active!==false});
  const mapMasterAssignment = x => ({...x, masterId:x.master_id, projectId:x.project_id, stageId:x.stage_id||'', startDate:x.start_date, plannedEndDate:x.planned_end_date||'', actualEndDate:x.actual_end_date||''});
  const authorName=x=>x?.author?([x.author.first_name,x.author.last_name].filter(Boolean).join(' ')||x.author.web_login||x.author.telegram_username||'ADMA'):'ADMA';
  const mapProjectDocument=x=>({...x,projectId:x.project_id,filePath:x.storage_path,fileUrl:x.file_url||'',documentDate:x.document_date||'',createdAt:x.created_at,authorName:authorName(x)});
  const mapProjectTask=x=>({...x,projectId:x.project_id,stageId:x.stage_id||'',actId:x.act_id||'',waybillId:x.waybill_id||'',assigneeUserId:x.assignee_user_id||'',assigneeMasterId:x.assignee_master_id||'',createdAt:x.created_at,authorName:authorName(x)});
  const mapProjectPhoto=x=>({...x,projectId:x.project_id,stageId:x.stage_id||'',filePath:x.storage_path,fileUrl:x.file_url||'',shotDate:x.shot_date||'',createdAt:x.created_at,authorName:authorName(x)});
  const mapDesigner=x=>({...x,fullName:x.full_name, responsibleUserId:x.responsible_user_id||'', lastContactAt:x.last_contact_at||'', nextContactAt:x.next_contact_at||'', nextAction:x.next_action||'', portfolioUrl:x.portfolio_url||'', isArchived:!!x.is_archived});
  const mapDesignerInteraction=x=>({...x,designerId:x.designer_id,occurredAt:x.occurred_at,type:x.interaction_type,authorName:authorName(x)});

  async function loadFinanceCloud() {
    if (!canManageProjects()) {
      state.acts=[];state.actCosts=[];state.actPayments=[];state.waybills=[];state.waybillPayments=[];state.companyExpenses=[];
      return;
    }
    const data=await financeApi('load');
    state.acts=(data.acts||[]).map(mapAct);state.actCosts=(data.act_costs||[]).map(mapActCost);state.actPayments=(data.act_payments||[]).map(mapActPayment);
    state.waybills=(data.waybills||[]).map(mapWaybill);state.waybillPayments=(data.waybill_payments||[]).map(mapWaybillPayment);state.companyExpenses=(data.company_expenses||[]).map(mapCompanyExpense);
  }

  async function loadMastersCloud() {
    const data=await mastersApi('load');
    state.masters=(data.masters||[]).map(mapMaster);
    state.masterAssignments=(data.assignments||[]).map(mapMasterAssignment);
    state.projectResponsibles=data.project_responsibles||[];
  }

  async function loadProjectOperationsCloud(){const data=await operationsApi('load');state.projectDocuments=(data.documents||[]).map(mapProjectDocument);state.projectTasks=(data.tasks||[]).map(mapProjectTask);state.projectPhotos=(data.photos||[]).map(mapProjectPhoto)}
  async function loadDesignersCloud(){if(!canManageProjects()){state.designers=[];state.designerInteractions=[];state.designerUsers=[];return}const data=await designersApi('load');state.designers=(data.designers||[]).map(mapDesigner);state.designerInteractions=(data.interactions||[]).map(mapDesignerInteraction);state.designerUsers=data.users||[];if(data.projects)state.projects=(data.projects||[]).map(p=>{const existing=state.projects.find(x=>x.id===p.id);return existing?{...existing,designerId:p.designer_id||''}:mapProject(p)})}

  async function loadCloud() {
    const data = await api('load');
    state.projects = (data.projects || []).map(mapProject);
    state.expenses = (data.expenses || []).map(mapExpense);
    state.stages = (data.stages || []).map(mapStage);
    await Promise.all([loadFinanceCloud(),loadMastersCloud(),loadProjectOperationsCloud(),loadDesignersCloud()]);
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
    pDesigner.innerHTML='<option value="">Не назначен</option>'+(state.designers||[]).filter(d=>!d.isArchived).map(d=>`<option value="${esc(d.id)}">${esc(designerName(d))}${d.studio?' · '+esc(d.studio):''}</option>`).join('');
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
    pDesigner.innerHTML='<option value="">Не назначен</option>'+(state.designers||[]).filter(d=>!d.isArchived||d.id===p.designerId).map(d=>`<option value="${esc(d.id)}">${esc(designerName(d))}${d.studio?' · '+esc(d.studio):''}</option>`).join('');
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
    pDesigner.value = p.designerId || '';
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
    else list.innerHTML = summary.stages.map(stage => {const assigned=(state.masterAssignments||[]).filter(x=>x.stageId===stage.id&&!['cancelled'].includes(x.status)).map(x=>(state.masters||[]).find(m=>m.id===x.masterId)?.name).filter(Boolean);return `<button class="card stage-card" data-stage-id="${esc(stage.id)}"><div class="stage-card-head"><span class="stage-card-title"><strong>${esc(stage.name)}</strong><span>${esc(stage.comment || 'Без комментария')}</span>${assigned.length?`<span class="stage-masters">◎ ${esc(assigned.join(', '))}</span>`:''}</span><span class="stage-status ${esc(stage.status)}">${esc(stageStatuses[stage.status] || stage.status)}</span></div><div class="stage-progress-row"><div class="progress-track"><div class="progress-fill ${stage.status === 'delayed' ? 'warn' : ''}" style="width:${stage.progress}%"></div></div><strong>${stage.progress}%</strong></div><div class="stage-card-meta"><div><small>План</small><strong>${esc(stage.plannedStart ? projectDate(stage.plannedStart) : '—')} — ${esc(stage.plannedEnd ? projectDate(stage.plannedEnd) : '—')}</strong></div><div><small>Факт</small><strong>${esc(stage.actualStart ? projectDate(stage.actualStart) : '—')} — ${esc(stage.actualEnd ? projectDate(stage.actualEnd) : '—')}</strong></div><div><small>Стоимость работ</small><strong>${stage.workCost == null ? '—' : money(stage.workCost)}</strong></div></div></button>`}).join('');
    const add = document.getElementById('addStage') || document.getElementById('emptyAddStage'); if (add) add.onclick = () => openStageDialog(p.id);
    list.querySelectorAll('[data-stage-id]').forEach(button => button.onclick = () => openStageDialog(p.id, button.dataset.stageId));
  }

  function assignmentBlocksAvailability(item,today=new Date().toISOString().slice(0,10)){return ['planned','active'].includes(item.status)&&!item.actualEndDate&&(!item.plannedEndDate||item.plannedEndDate>=today)}
  function masterAvailability(masterId){
    const today=new Date().toISOString().slice(0,10),items=(state.masterAssignments||[]).filter(x=>x.masterId===masterId&&assignmentBlocksAvailability(x,today)).sort((a,b)=>(a.status==='active'?-1:1)-(b.status==='active'?-1:1)||a.startDate.localeCompare(b.startDate));
    if(!items.length)return {key:'free',label:'Свободен',className:'free',current:null,release:''};
    const dated=items.filter(x=>x.plannedEndDate);const release=dated.length===items.length?dated.map(x=>x.plannedEndDate).sort().at(-1):'';
    return {key:release?'releasing':'busy',label:release?`Освободится ${projectDate(release)}`:'Занят',className:release?'releasing':'busy',current:items[0],release};
  }
  const masterContact=m=>m.phone||m.telegram||'Контакт не указан';
  const assignmentPeriod=x=>`${projectDate(x.startDate)} — ${x.actualEndDate?projectDate(x.actualEndDate):x.plannedEndDate?projectDate(x.plannedEndDate):'без даты'}`;
  const assignmentProject=x=>proj(x.projectId);
  const assignmentStage=x=>(state.stages||[]).find(s=>s.id===x.stageId);
  function responsibleName(user){return [user?.first_name,user?.last_name].filter(Boolean).join(' ')||user?.web_login||user?.telegram_username||'Сотрудник'}

  async function refreshMasters(message){await loadMastersCloud();render();if(message)banner(message,'ok')}
  function masterFormOptions(selected=[]){return Object.entries(masterSpecialtyLabels).map(([value,label])=>`<option value="${value}" ${selected.includes(value)?'selected':''}>${label}</option>`).join('')}
  function openMasterDialog(masterId=''){
    if(!canManageProjects())return;const master=(state.masters||[]).find(x=>x.id===masterId);
    const dlg=dynamicDialog('masterEditDlg',master?'Редактировать мастера':'Новый мастер',`<label>Имя<input name="name" required maxlength="160" value="${esc(master?.name||'')}"></label><div class="grid"><label>Телефон<input name="phone" maxlength="80" value="${esc(master?.phone||'')}"></label><label>Telegram<input name="telegram" maxlength="100" placeholder="@username" value="${esc(master?.telegram||'')}"></label></div><label>Основная специализация<select name="specialty">${masterFormOptions([master?.primarySpecialty||'other'])}</select></label><label>Дополнительные навыки<select name="skills" multiple size="6">${masterFormOptions(master?.additionalSkills||[])}</select><small class="muted">Можно выбрать несколько</small></label><div class="grid"><label>Внутренний рейтинг<input name="rating" type="number" min="1" max="5" step="0.1" value="${master?.rating??''}"></label><label>Уровень цен<select name="price"><option value="">Не указан</option>${Object.entries(masterPriceLabels).map(([value,label])=>`<option value="${value}" ${master?.priceLevel===value?'selected':''}>${label}</option>`).join('')}</select></label></div><label>Заметки<textarea name="notes" rows="4" maxlength="4000">${esc(master?.notes||'')}</textarea></label>${master?`<button type="button" class="btn ${master.isActive?'danger':'secondary'} full-button" data-archive>${master.isActive?'Архивировать мастера':'Вернуть из архива'}</button>`:''}`);
    dlg.querySelector('form').onsubmit=async ev=>{ev.preventDefault();const form=ev.currentTarget,button=form.querySelector('.primary');button.disabled=true;try{await mastersApi('save_master',{master:{id:master?.id,name:form.elements.name.value,phone:form.elements.phone.value,telegram:form.elements.telegram.value,primary_specialty:form.elements.specialty.value,additional_skills:[...form.elements.skills.selectedOptions].map(x=>x.value),rating:form.elements.rating.value||null,price_level:form.elements.price.value||null,notes:form.elements.notes.value}});dlg.close();await refreshMasters(master?'Мастер обновлён':'Мастер добавлен')}catch(e){banner('Не удалось сохранить мастера: '+e.message,'error')}finally{button.disabled=false}};
    const archive=dlg.querySelector('[data-archive]');if(archive)archive.onclick=async()=>{const active=(state.masterAssignments||[]).filter(x=>x.masterId===master.id&&assignmentBlocksAvailability(x)).length;if(!confirm(master.isActive?`Архивировать мастера?${active?' Активные назначения сохранятся.':''}`:'Вернуть мастера из архива?'))return;try{await mastersApi('set_master_archived',{id:master.id,archived:master.isActive});dlg.close();await refreshMasters(master.isActive?'Мастер архивирован':'Мастер восстановлен')}catch(e){banner('Не удалось изменить статус: '+e.message,'error')}};
    dlg.showModal();
  }

  function openMasterDetails(masterId){
    const master=(state.masters||[]).find(x=>x.id===masterId);if(!master)return;const availability=masterAvailability(master.id);const current=availability.current;const history=(state.masterAssignments||[]).filter(x=>x.masterId===master.id).sort((a,b)=>b.startDate.localeCompare(a.startDate));
    let dlg=document.getElementById('masterDetailsDlg');if(!dlg){dlg=document.createElement('dialog');dlg.id='masterDetailsDlg';document.body.appendChild(dlg)}
    dlg.innerHTML=`<div class="dialog-body"><div class="sheethead"><button type="button" data-close>Закрыть</button><h2>${esc(master.name)}</h2>${canManageProjects()?'<button class="btn secondary" data-edit>Изменить</button>':'<span></span>'}</div><div class="master-profile"><div><span class="availability ${availability.className}">${esc(availability.label)}</span><h3>${esc(masterSpecialtyLabels[master.primarySpecialty]||'Другое')}</h3><p>${esc(masterContact(master))}</p></div><dl class="object-details"><div><dt>Telegram</dt><dd>${esc(master.telegram||'—')}</dd></div><div><dt>Рейтинг</dt><dd>${master.rating?esc(master.rating+' / 5'):'—'}</dd></div><div><dt>Уровень цен</dt><dd>${esc(masterPriceLabels[master.priceLevel]||'—')}</dd></div><div><dt>Навыки</dt><dd>${esc(master.additionalSkills.map(x=>masterSpecialtyLabels[x]||x).join(', ')||'—')}</dd></div></dl>${master.notes?`<div class="master-notes">${esc(master.notes)}</div>`:''}</div>${current?`<section class="card master-current"><small>Текущее назначение</small><strong>${esc(assignmentProject(current)?.name||'Объект')}</strong><span>${esc(assignmentStage(current)?.name||'Без этапа')} · ${esc(assignmentPeriod(current))}</span></section>`:''}<div class="section compact"><h3>История объектов</h3></div><div class="assignment-history">${history.length?history.map(x=>`<div class="card"><span><strong>${esc(assignmentProject(x)?.name||'Объект')}</strong><small>${esc(assignmentStage(x)?.name||'Без этапа')} · ${esc(assignmentPeriod(x))}</small></span><span class="badge ${x.status==='completed'?'paid':x.status==='cancelled'?'neutral':'pending'}">${esc(assignmentStatusLabels[x.status]||x.status)}</span></div>`).join(''):'<div class="empty">Назначений пока нет</div>'}</div></div>`;
    dlg.querySelector('[data-close]').onclick=()=>dlg.close();const edit=dlg.querySelector('[data-edit]');if(edit)edit.onclick=()=>{dlg.close();openMasterDialog(master.id)};dlg.showModal();
  }

  function openAssignmentDialog(projectId,assignmentId=''){
    if(!canManageProjects())return;const item=(state.masterAssignments||[]).find(x=>x.id===assignmentId);const masters=(state.masters||[]).filter(x=>x.isActive||x.id===item?.masterId);const stages=stagesFor(projectId);
    if(!masters.length){if(confirm('В базе пока нет активных мастеров. Перейти к созданию мастера?'))navigateGlobal('masters');return}
    const dlg=dynamicDialog('assignmentDlg',item?'Редактировать назначение':'Добавить мастера',`<label>Мастер<select name="master" required>${masters.map(m=>`<option value="${esc(m.id)}" ${item?.masterId===m.id?'selected':''}>${esc(m.name)} · ${esc(masterSpecialtyLabels[m.primarySpecialty]||'Другое')}</option>`).join('')}</select></label><label>Этап<select name="stage"><option value="">На объект в целом</option>${stages.map(s=>`<option value="${esc(s.id)}" ${item?.stageId===s.id?'selected':''}>${esc(s.name)}</option>`).join('')}</select></label><div class="grid"><label>Дата начала<input name="start" type="date" required value="${esc(item?.startDate||new Date().toISOString().slice(0,10))}"></label><label>Плановое окончание<input name="plannedEnd" type="date" value="${esc(item?.plannedEndDate||'')}"></label></div><div class="grid"><label>Статус<select name="status">${Object.entries(assignmentStatusLabels).map(([value,label])=>`<option value="${value}" ${item?.status===value?'selected':''}>${label}</option>`).join('')}</select></label><label>Фактическое окончание<input name="actualEnd" type="date" value="${esc(item?.actualEndDate||'')}"></label></div><label>Комментарий<textarea name="comment" rows="3" maxlength="2000">${esc(item?.comment||'')}</textarea></label>${item&&item.status!=='cancelled'?'<button type="button" class="btn danger full-button" data-cancel>Отменить назначение</button>':''}<button type="button" class="btn secondary full-button" data-create-master>Создать нового мастера в общей базе</button>`);
    const saveAssignment=async(form,allowConflict=false)=>mastersApi('save_assignment',{allow_conflict:allowConflict,assignment:{id:item?.id,master_id:form.elements.master.value,project_id:projectId,stage_id:form.elements.stage.value||null,start_date:form.elements.start.value,planned_end_date:form.elements.plannedEnd.value||null,actual_end_date:form.elements.actualEnd.value||null,status:form.elements.status.value,comment:form.elements.comment.value}});
    dlg.querySelector('form').onsubmit=async ev=>{ev.preventDefault();const form=ev.currentTarget,button=form.querySelector('.primary');button.disabled=true;try{try{await saveAssignment(form)}catch(e){if(e.message!=='assignment_conflict')throw e;if(!confirm('Мастер уже назначен на другой объект в этот период. Всё равно сохранить назначение?'))return;await saveAssignment(form,true)}dlg.close();await refreshMasters(item?'Назначение обновлено':'Мастер назначен')}catch(e){banner('Не удалось сохранить назначение: '+e.message,'error')}finally{button.disabled=false}};
    const cancel=dlg.querySelector('[data-cancel]');if(cancel)cancel.onclick=async()=>{if(!confirm('Отменить назначение? Оно останется в истории мастера.'))return;try{await mastersApi('cancel_assignment',{id:item.id});dlg.close();await refreshMasters('Назначение отменено')}catch(e){banner('Не удалось отменить назначение: '+e.message,'error')}};
    dlg.querySelector('[data-create-master]').onclick=()=>{dlg.close();navigateGlobal('masters');setTimeout(()=>openMasterDialog(),0)};dlg.showModal();
  }

  function renderProjectTeam(p){
    const assignments=(state.masterAssignments||[]).filter(x=>x.projectId===p.id&&x.status!=='cancelled').sort((a,b)=>a.startDate.localeCompare(b.startDate));const responsibles=(state.projectResponsibles||[]).filter(x=>x.project_id===p.id&&x.user?.is_active!==false),designer=(state.designers||[]).find(x=>x.id===p.designerId);
    $('#projectSection').innerHTML=`<div class="page-title-row"><div><h2>Команда объекта</h2><p>Ответственные и мастера, назначенные из общей базы</p></div>${canManageProjects()&&p.status!=='archived'?'<button id="addMasterAssignment" class="btn primary">+ Добавить мастера</button>':''}</div><div class="section compact"><h3>Ответственные</h3></div><section class="responsible-grid">${responsibles.length?responsibles.map(x=>`<div class="card responsible-card"><span class="master-avatar">${esc(responsibleName(x.user).slice(0,2).toUpperCase())}</span><div><small>${esc(roleLabel(x.user?.role||'foreman'))}</small><strong>${esc(responsibleName(x.user))}</strong><span>${esc(x.user?.telegram_username?'@'+String(x.user.telegram_username).replace(/^@/,''):'Контакт в профиле')}</span></div></div>`).join(''):'<div class="card empty">Ответственные пока не назначены</div>'}<button class="card responsible-card muted-card" ${designer?'data-project-designer="'+esc(designer.id)+'"':''}><span class="master-avatar">✦</span><div><small>Дизайнер</small><strong>${esc(designer?designerName(designer):'Не назначен')}</strong><span>${esc(designer?(designer.studio||designer.telegram||designer.phone||'Открыть карточку'):'Назначается в настройках объекта')}</span></div></button></section><div class="section compact"><div><h3>Мастера</h3><p class="muted">${assignments.length} назначений</p></div></div><div class="project-team-list">${assignments.length?assignments.map(x=>{const m=(state.masters||[]).find(y=>y.id===x.masterId);return `<button class="card team-master-card" data-assignment="${esc(x.id)}"><span class="master-avatar">${esc((m?.name||'М').slice(0,2).toUpperCase())}</span><span class="grow"><strong>${esc(m?.name||'Мастер')}</strong><small>${esc(masterSpecialtyLabels[m?.primarySpecialty]||'Другое')} · ${esc(assignmentStage(x)?.name||'Объект целиком')}</small><small>${esc(assignmentPeriod(x))} · ${esc(masterContact(m||{}))}</small></span><span class="badge ${x.status==='completed'?'paid':'pending'}">${esc(assignmentStatusLabels[x.status]||x.status)}</span></button>`}).join(''):'<div class="card empty">На объект пока не назначены мастера</div>'}</div>`;
    const add=document.getElementById('addMasterAssignment');if(add)add.onclick=()=>openAssignmentDialog(p.id);const designerButton=document.querySelector('[data-project-designer]');if(designerButton)designerButton.onclick=()=>openDesignerDetails(designerButton.dataset.projectDesigner);document.querySelectorAll('[data-assignment]').forEach(button=>button.onclick=()=>canManageProjects()?openAssignmentDialog(p.id,button.dataset.assignment):openMasterDetails((state.masterAssignments||[]).find(x=>x.id===button.dataset.assignment)?.masterId));
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

  async function uploadProjectFile(file, fields) {
    const credentials = await AdmaAuth.credentials();
    return new Promise((resolve, reject) => {
      const form = new FormData();
      Object.entries(credentials).forEach(([key, value]) => form.append(key, value));
      Object.entries(fields).forEach(([key, value]) => { if (value != null) form.append(key, String(value)); });
      form.append('file', file, file.name);
      const xhr = new XMLHttpRequest();
      xhr.open('POST', SUPABASE_FUNCTIONS + '/project-file-upload', true);
      xhr.timeout = 60000;
      xhr.onload = () => {
        let data = {};
        try { data = JSON.parse(xhr.responseText || '{}'); } catch {}
        if (xhr.status >= 200 && xhr.status < 300 && data.ok) resolve(data);
        else reject(new Error(data.error || `HTTP_${xhr.status}`));
      };
      xhr.onerror = () => reject(new Error('Ошибка загрузки файла'));
      xhr.ontimeout = () => reject(new Error('Загрузка файла заняла слишком много времени'));
      xhr.send(form);
    });
  }

  async function refreshOperations(message) {
    await loadProjectOperationsCloud();
    render();
    if (message) banner(message, 'ok');
  }

  const bytesLabel = value => value == null ? '' : value < 1024 * 1024
    ? `${Math.max(1, Math.round(value / 1024))} КБ`
    : `${(value / 1024 / 1024).toFixed(1)} МБ`;

  function openDocumentDialog(projectId, documentId = '') {
    const item = (state.projectDocuments || []).find(value => value.id === documentId);
    const dlg = dynamicDialog('projectDocumentDlg', item ? 'Редактировать документ' : 'Новый документ', `
      <label>Название<input name="title" required maxlength="240" value="${esc(item?.title || '')}"></label>
      <div class="grid">
        <label>Категория<select name="category">${Object.entries(documentCategoryLabels).map(([value, label]) => `<option value="${value}" ${item?.category === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
        <label>Дата документа<input name="documentDate" type="date" value="${esc(item?.documentDate || '')}"></label>
      </div>
      ${item
        ? (item.fileUrl ? `<a class="btn secondary" href="${esc(item.fileUrl)}" target="_blank" rel="noopener">Открыть файл</a>` : '<div class="empty">Файл временно недоступен</div>')
        : '<label>Файл<input name="file" type="file" required accept="application/pdf,.doc,.docx,.xls,.xlsx,image/jpeg,image/png,image/webp"></label>'}
      <label>Комментарий / описание<textarea name="description" rows="4" maxlength="4000">${esc(item?.description || '')}</textarea></label>
      ${item ? '<button type="button" class="btn danger full-button" data-delete>Удалить документ</button>' : ''}`);
    dlg.querySelector('form').onsubmit = async event => {
      event.preventDefault();
      const form = event.currentTarget;
      const controls = [...form.querySelectorAll('input,select,textarea,button')];
      controls.forEach(control => { control.disabled = true; });
      try {
        if (item) {
          await operationsApi('save_document', { document: {
            id: item.id,
            title: form.elements.title.value,
            category: form.elements.category.value,
            document_date: form.elements.documentDate.value || null,
            description: form.elements.description.value,
          }});
        } else {
          await uploadProjectFile(form.elements.file.files[0], {
            kind: 'document', project_id: projectId,
            title: form.elements.title.value,
            category: form.elements.category.value,
            document_date: form.elements.documentDate.value,
            description: form.elements.description.value,
          });
        }
        dlg.close();
        await refreshOperations(item ? 'Документ обновлён' : 'Документ загружен');
      } catch (error) {
        banner('Не удалось сохранить документ: ' + error.message, 'error');
      } finally {
        controls.forEach(control => { control.disabled = false; });
      }
    };
    const remove = dlg.querySelector('[data-delete]');
    if (remove) remove.onclick = async () => {
      if (!confirm(`Удалить документ «${item.title}» и его файл?`)) return;
      try {
        await operationsApi('delete_document', { id: item.id });
        dlg.close();
        await refreshOperations('Документ удалён');
      } catch (error) { banner('Не удалось удалить документ: ' + error.message, 'error'); }
    };
    dlg.showModal();
  }

  function renderProjectDocuments(project) {
    const all = (state.projectDocuments || []).filter(item => item.projectId === project.id);
    const items = all.filter(item => !documentCategoryFilter || item.category === documentCategoryFilter)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    $('#projectSection').innerHTML = `
      <div class="page-title-row"><div><h2>Документы</h2><p>Файлы этого объекта в защищённом хранилище</p></div>${project.status !== 'archived' ? '<button id="addProjectDocument" class="btn primary">+ Документ</button>' : ''}</div>
      <section class="card operation-filter"><label>Категория<select id="documentCategoryFilter"><option value="">Все категории</option>${Object.entries(documentCategoryLabels).map(([value, label]) => `<option value="${value}" ${documentCategoryFilter === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label><span>${items.length} файлов</span></section>
      <div class="finance-links card"><div><strong>Финансовые документы</strong><small>Акты и Накладные хранятся в Финансах без дублирования</small></div><button class="btn secondary" data-finance-link="acts">Акты →</button><button class="btn secondary" data-finance-link="waybills">Накладные →</button></div>
      <div class="document-list">${items.length ? items.map(item => `<button class="card document-card" data-document-id="${esc(item.id)}"><span class="file-icon">${item.mime_type?.startsWith('image/') ? 'IMG' : 'DOC'}</span><span class="grow"><strong>${esc(item.title)}</strong><small>${esc(documentCategoryLabels[item.category] || item.category)} · ${esc(item.original_name || 'Файл')}</small><small>${esc(projectDate((item.documentDate || item.createdAt).slice(0, 10)))} · ${esc(item.authorName)}${item.size_bytes != null ? ' · ' + bytesLabel(item.size_bytes) : ''}</small></span><span class="badge ${item.fileUrl ? 'paid' : 'pending'}">${item.fileUrl ? 'Доступен' : 'Недоступен'}</span></button>`).join('') : '<div class="card empty">Документов в этой категории пока нет</div>'}</div>`;
    document.getElementById('addProjectDocument')?.addEventListener('click', () => openDocumentDialog(project.id));
    document.getElementById('documentCategoryFilter').onchange = event => { documentCategoryFilter = event.target.value; renderProjectDocuments(project); };
    document.querySelectorAll('[data-document-id]').forEach(button => button.onclick = () => openDocumentDialog(project.id, button.dataset.documentId));
    document.querySelectorAll('[data-finance-link]').forEach(button => button.onclick = () => navigateProject(project.id, 'finance', button.dataset.financeLink));
  }

  function taskAssigneeOptions(projectId, task) {
    const users = [currentUser, ...(state.projectResponsibles || []).filter(item => item.project_id === projectId).map(item => item.user)].filter(Boolean);
    const uniqueUsers = [...new Map(users.map(user => [user.id, user])).values()];
    const masterIds = new Set((state.masterAssignments || []).filter(item => item.projectId === projectId && item.status !== 'cancelled').map(item => item.masterId));
    const masters = (state.masters || []).filter(master => masterIds.has(master.id));
    return `<option value="">Не назначен</option>${uniqueUsers.map(user => `<option value="user:${esc(user.id)}" ${task?.assigneeUserId === user.id ? 'selected' : ''}>${esc(responsibleName(user))} · ${esc(roleLabel(user.role || 'foreman'))}</option>`).join('')}${masters.map(master => `<option value="master:${esc(master.id)}" ${task?.assigneeMasterId === master.id ? 'selected' : ''}>${esc(master.name)} · мастер</option>`).join('')}`;
  }

  function taskAssigneeLabel(task) {
    if (task.assigneeUserId) {
      const users = [currentUser, ...(state.projectResponsibles || []).map(item => item.user)].filter(Boolean);
      return responsibleName(users.find(user => user.id === task.assigneeUserId));
    }
    if (task.assigneeMasterId) return (state.masters || []).find(master => master.id === task.assigneeMasterId)?.name || 'Мастер';
    return 'Не назначен';
  }

  function taskBucket(task, today = new Date().toISOString().slice(0, 10)) {
    if (['completed', 'cancelled'].includes(task.status)) return 'completed';
    if (task.deadline && task.deadline < today) return 'overdue';
    if (task.deadline === today) return 'today';
    return 'upcoming';
  }

  function taskPayload(item, overrides = {}) {
    return {
      id: item.id, project_id: item.projectId, title: item.title, description: item.description,
      assignee_user_id: item.assigneeUserId || null, assignee_master_id: item.assigneeMasterId || null,
      deadline: item.deadline || null, priority: item.priority, status: item.status,
      stage_id: item.stageId || null, act_id: item.actId || null, waybill_id: item.waybillId || null,
      ...overrides,
    };
  }

  function openProjectTaskDialog(projectId, taskId = '') {
    const item = (state.projectTasks || []).find(value => value.id === taskId);
    const stages = stagesFor(projectId);
    const acts = (state.acts || []).filter(value => value.projectId === projectId);
    const waybills = (state.waybills || []).filter(value => value.projectId === projectId);
    const dlg = dynamicDialog('projectTaskDlg', item ? 'Редактировать задачу' : 'Новая задача', `
      <label>Название<input name="title" required maxlength="240" value="${esc(item?.title || '')}"></label>
      <label>Описание<textarea name="description" rows="3" maxlength="4000">${esc(item?.description || '')}</textarea></label>
      <div class="grid"><label>Ответственный<select name="assignee">${taskAssigneeOptions(projectId, item)}</select></label><label>Дедлайн<input name="deadline" type="date" value="${esc(item?.deadline || '')}"></label></div>
      <div class="grid"><label>Приоритет<select name="priority">${Object.entries(taskPriorityLabels).map(([value, label]) => `<option value="${value}" ${item?.priority === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label><label>Статус<select name="status">${Object.entries(taskStatusLabels).map(([value, label]) => `<option value="${value}" ${item?.status === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label></div>
      <label>Этап<select name="stage"><option value="">Без этапа</option>${stages.map(stage => `<option value="${esc(stage.id)}" ${item?.stageId === stage.id ? 'selected' : ''}>${esc(stage.name)}</option>`).join('')}</select></label>
      ${canManageProjects() ? `<div class="grid"><label>Акт<select name="act"><option value="">Без акта</option>${acts.map(act => `<option value="${esc(act.id)}" ${item?.actId === act.id ? 'selected' : ''}>№${esc(act.number)} · ${esc(act.title)}</option>`).join('')}</select></label><label>Накладная<select name="waybill"><option value="">Без накладной</option>${waybills.map(waybill => `<option value="${esc(waybill.id)}" ${item?.waybillId === waybill.id ? 'selected' : ''}>№${esc(waybill.number)} · ${esc(waybill.supplier)}</option>`).join('')}</select></label></div>` : ''}
      ${item ? '<button type="button" class="btn danger full-button" data-delete>Удалить задачу</button>' : ''}`);
    dlg.querySelector('form').onsubmit = async event => {
      event.preventDefault();
      const form = event.currentTarget;
      const [kind, assigneeId] = form.elements.assignee.value.split(':');
      try {
        await operationsApi('save_task', { task: {
          id: item?.id, project_id: projectId, title: form.elements.title.value,
          description: form.elements.description.value,
          assignee_user_id: kind === 'user' ? assigneeId : null,
          assignee_master_id: kind === 'master' ? assigneeId : null,
          deadline: form.elements.deadline.value || null, priority: form.elements.priority.value,
          status: form.elements.status.value, stage_id: form.elements.stage.value || null,
          act_id: form.elements.act?.value || null, waybill_id: form.elements.waybill?.value || null,
        }});
        dlg.close();
        await refreshOperations(item ? 'Задача обновлена' : 'Задача добавлена');
      } catch (error) { banner('Не удалось сохранить задачу: ' + error.message, 'error'); }
    };
    const remove = dlg.querySelector('[data-delete]');
    if (remove) remove.onclick = async () => {
      if (!confirm(`Удалить задачу «${item.title}»?`)) return;
      try {
        await operationsApi('delete_task', { id: item.id });
        dlg.close();
        await refreshOperations('Задача удалена');
      } catch (error) { banner('Не удалось удалить задачу: ' + error.message, 'error'); }
    };
    dlg.showModal();
  }

  function renderProjectTasks(project) {
    const all = (state.projectTasks || []).filter(item => item.projectId === project.id);
    const counts = { overdue: 0, today: 0, upcoming: 0, completed: 0 };
    all.forEach(item => { counts[taskBucket(item)] += 1; });
    const items = all.filter(item => taskBucket(item) === taskView).sort((a, b) => (a.deadline || '9999').localeCompare(b.deadline || '9999'));
    $('#projectSection').innerHTML = `
      <div class="page-title-row"><div><h2>Задачи</h2><p>Операционные задачи только этого объекта</p></div>${project.status !== 'archived' ? '<button id="addProjectTask" class="btn primary">+ Задача</button>' : ''}</div>
      ${sectionTabs([['overdue', `Просрочено · ${counts.overdue}`], ['today', `Сегодня · ${counts.today}`], ['upcoming', `Предстоящие · ${counts.upcoming}`], ['completed', `Выполнено · ${counts.completed}`]], taskView, 'data-task-view')}
      <div class="task-list">${items.length ? items.map(item => {
        const overdue = taskBucket(item) === 'overdue';
        const stage = assignmentStage({ stageId: item.stageId });
        return `<div class="card task-card ${overdue ? 'overdue' : ''}"><button class="task-main" data-edit-task="${esc(item.id)}"><span class="priority-dot ${esc(item.priority)}"></span><span class="grow"><strong>${esc(item.title)}</strong><small>${esc(taskAssigneeLabel(item))}${stage ? ' · ' + esc(stage.name) : ''}</small><small>${item.deadline ? esc(projectDate(item.deadline)) : 'Без дедлайна'} · ${esc(taskPriorityLabels[item.priority] || item.priority)}</small></span><span class="badge ${item.status === 'completed' ? 'paid' : overdue ? 'danger' : 'neutral'}">${overdue ? 'Просрочена' : esc(taskStatusLabels[item.status] || item.status)}</span></button>${!['completed', 'cancelled'].includes(item.status) ? `<button class="btn secondary" data-complete-task="${esc(item.id)}">Выполнено</button>` : ''}</div>`;
      }).join('') : '<div class="card empty">В этом разделе задач нет</div>'}</div>`;
    document.getElementById('addProjectTask')?.addEventListener('click', () => openProjectTaskDialog(project.id));
    document.querySelectorAll('[data-task-view]').forEach(button => button.onclick = () => { taskView = button.dataset.taskView; renderProjectTasks(project); });
    document.querySelectorAll('[data-edit-task]').forEach(button => button.onclick = () => openProjectTaskDialog(project.id, button.dataset.editTask));
    document.querySelectorAll('[data-complete-task]').forEach(button => button.onclick = async () => {
      const item = all.find(value => value.id === button.dataset.completeTask);
      try {
        await operationsApi('save_task', { task: taskPayload(item, { status: 'completed' }) });
        await refreshOperations('Задача выполнена');
      } catch (error) { banner('Не удалось завершить задачу: ' + error.message, 'error'); }
    });
  }

  async function photoUploadFile(file) {
    const compressed = await prepareReceiptFile(file);
    const baseName = String(file.name || 'photo').replace(/\.[^.]+$/, '') || 'photo';
    return new File([compressed], `${baseName}.jpg`, { type: 'image/jpeg' });
  }

  function openProjectPhotoDialog(projectId, photoId = '') {
    const item = (state.projectPhotos || []).find(value => value.id === photoId);
    const stages = stagesFor(projectId);
    const dlg = dynamicDialog('projectPhotoDlg', item ? 'Фото объекта' : 'Добавить фото', `
      ${item && item.fileUrl ? `<img class="photo-dialog-preview" src="${esc(item.fileUrl)}" alt="${esc(item.caption || 'Фото объекта')}">` : ''}
      ${item ? '' : '<label>Фотографии<input name="files" type="file" accept="image/*" multiple required></label>'}
      <label>Этап<select name="stage"><option value="">Без этапа</option>${stages.map(stage => `<option value="${esc(stage.id)}" ${item?.stageId === stage.id ? 'selected' : ''}>${esc(stage.name)}</option>`).join('')}</select></label>
      <label>Дата съёмки<input name="shotDate" type="date" value="${esc(item?.shotDate || '')}"></label>
      <label>Подпись / комментарий<textarea name="caption" rows="3" maxlength="2000">${esc(item?.caption || '')}</textarea></label>
      ${item ? '<button type="button" class="btn danger full-button" data-delete>Удалить фотографию</button>' : ''}`);
    dlg.querySelector('form').onsubmit = async event => {
      event.preventDefault();
      const form = event.currentTarget;
      const submit = form.querySelector('.primary');
      submit.disabled = true;
      try {
        if (item) {
          await operationsApi('save_photo', { photo: {
            id: item.id, stage_id: form.elements.stage.value || null,
            shot_date: form.elements.shotDate.value || null, caption: form.elements.caption.value,
          }});
        } else {
          const files = [...form.elements.files.files];
          for (let index = 0; index < files.length; index += 1) {
            banner(`Загружаю фото ${index + 1} из ${files.length}…`);
            const prepared = await photoUploadFile(files[index]);
            await uploadProjectFile(prepared, {
              kind: 'photo', project_id: projectId, stage_id: form.elements.stage.value,
              shot_date: form.elements.shotDate.value, caption: form.elements.caption.value,
            });
          }
        }
        dlg.close();
        await refreshOperations(item ? 'Фото обновлено' : 'Фото загружены');
      } catch (error) { banner('Не удалось сохранить фото: ' + error.message, 'error'); }
      finally { submit.disabled = false; }
    };
    const remove = dlg.querySelector('[data-delete]');
    if (remove) remove.onclick = async () => {
      if (!confirm('Удалить фотографию из объекта и хранилища?')) return;
      try {
        await operationsApi('delete_photo', { id: item.id });
        dlg.close();
        await refreshOperations('Фото удалено');
      } catch (error) { banner('Не удалось удалить фото: ' + error.message, 'error'); }
    };
    dlg.showModal();
  }

  function openPhotoViewer(photo) {
    let dlg = document.getElementById('photoViewerDlg');
    if (!dlg) { dlg = document.createElement('dialog'); dlg.id = 'photoViewerDlg'; document.body.appendChild(dlg); }
    dlg.innerHTML = `<div class="photo-viewer"><button type="button" data-close>Закрыть</button>${photo.fileUrl ? `<img src="${esc(photo.fileUrl)}" alt="${esc(photo.caption || 'Фото объекта')}">` : '<div class="empty">Фото временно недоступно</div>'}<div><strong>${esc(photo.caption || 'Без подписи')}</strong><small>${esc(assignmentStage({ stageId: photo.stageId })?.name || 'Без этапа')} · ${esc(photo.authorName)}</small></div></div>`;
    dlg.querySelector('[data-close]').onclick = () => dlg.close();
    dlg.querySelector('img')?.addEventListener('click', () => dlg.close());
    dlg.showModal();
  }

  function renderProjectPhotos(project) {
    const stages = stagesFor(project.id);
    if (photoStageFilter && !stages.some(stage => stage.id === photoStageFilter)) photoStageFilter = '';
    const all = (state.projectPhotos || []).filter(item => item.projectId === project.id);
    const items = all.filter(item => !photoStageFilter || item.stageId === photoStageFilter).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    $('#projectSection').innerHTML = `
      <div class="page-title-row"><div><h2>Фото объекта</h2><p>Галерея объекта с привязкой к этапам</p></div>${project.status !== 'archived' ? '<button id="addProjectPhoto" class="btn primary">+ Фото</button>' : ''}</div>
      <section class="card operation-filter"><label>Этап<select id="photoStageFilter"><option value="">Все этапы</option>${stages.map(stage => `<option value="${esc(stage.id)}" ${photoStageFilter === stage.id ? 'selected' : ''}>${esc(stage.name)}</option>`).join('')}</select></label><span>${items.length} фото</span></section>
      <div class="photo-grid">${items.length ? items.map(item => `<article class="card photo-card"><button data-view-photo="${esc(item.id)}">${item.fileUrl ? `<img src="${esc(item.fileUrl)}" alt="${esc(item.caption || 'Фото объекта')}" loading="lazy">` : '<span class="photo-missing">Фото недоступно</span>'}</button><div><strong>${esc(item.caption || 'Без подписи')}</strong><small>${esc(assignmentStage({ stageId: item.stageId })?.name || 'Без этапа')} · ${esc(projectDate((item.shotDate || item.createdAt).slice(0, 10)))}</small><button class="btn secondary" data-edit-photo="${esc(item.id)}">Изменить</button></div></article>`).join('') : '<div class="card empty">Фотографий по выбранному этапу пока нет</div>'}</div>`;
    document.getElementById('addProjectPhoto')?.addEventListener('click', () => openProjectPhotoDialog(project.id));
    document.getElementById('photoStageFilter').onchange = event => { photoStageFilter = event.target.value; renderProjectPhotos(project); };
    document.querySelectorAll('[data-view-photo]').forEach(button => button.onclick = () => openPhotoViewer(all.find(item => item.id === button.dataset.viewPhoto)));
    document.querySelectorAll('[data-edit-photo]').forEach(button => button.onclick = () => openProjectPhotoDialog(project.id, button.dataset.editPhoto));
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
    else if (projectSection === 'team') renderProjectTeam(p);
    else if (projectSection === 'documents') renderProjectDocuments(p);
    else if (projectSection === 'tasks') renderProjectTasks(p);
    else if (projectSection === 'photos') renderProjectPhotos(p);
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

  function renderMastersCloud(){
    if(!canManageProjects()){$('#app').innerHTML=`${pageHeader('ADMA · МАСТЕРА','Мастера','Глобальная база доступна владельцу и партнёру')}${moduleScreen('◎','Доступ ограничен','Назначенных на ваши объекты мастеров можно посмотреть в разделе «Команда» нужного объекта.','Объект → Команда')}`;return}
    const all=(state.masters||[]).filter(m=>showArchivedMasters?!m.isActive:m.isActive);const filtered=all.filter(m=>{const availability=masterAvailability(m.id);const haystack=[m.name,m.phone,m.telegram,masterSpecialtyLabels[m.primarySpecialty],...m.additionalSkills.map(x=>masterSpecialtyLabels[x]||x)].join(' ').toLowerCase();return(!masterSearch||haystack.includes(masterSearch.toLowerCase()))&&(!masterSpecialtyFilter||m.primarySpecialty===masterSpecialtyFilter||m.additionalSkills.includes(masterSpecialtyFilter))&&(!masterAvailabilityFilter||availability.key===masterAvailabilityFilter)});
    $('#app').innerHTML=`${pageHeader('ADMA · КОМАНДА','Мастера','Единая база специалистов и занятость по объектам','<button id="addMaster" class="btn primary">+ Мастер</button>')}<section class="card master-filters"><label>Поиск<input id="masterSearch" type="search" placeholder="Имя, телефон, Telegram" value="${esc(masterSearch)}"></label><label>Специализация<select id="masterSpecialty"><option value="">Все специализации</option>${Object.entries(masterSpecialtyLabels).map(([value,label])=>`<option value="${value}" ${masterSpecialtyFilter===value?'selected':''}>${label}</option>`).join('')}</select></label><label>Занятость<select id="masterAvailability"><option value="">Любая</option><option value="free" ${masterAvailabilityFilter==='free'?'selected':''}>Свободен</option><option value="releasing" ${masterAvailabilityFilter==='releasing'?'selected':''}>Есть дата освобождения</option><option value="busy" ${masterAvailabilityFilter==='busy'?'selected':''}>Занят без даты</option></select></label><button id="toggleArchivedMasters" class="btn secondary">${showArchivedMasters?'Активные':'Архив'}</button></section><div class="master-list">${filtered.length?filtered.map(m=>{const a=masterAvailability(m.id),current=a.current;return `<button class="card master-list-card" data-master-id="${esc(m.id)}"><span class="master-avatar">${esc(m.name.slice(0,2).toUpperCase())}</span><span class="grow"><strong>${esc(m.name)}</strong><small>${esc(masterSpecialtyLabels[m.primarySpecialty]||'Другое')}${m.additionalSkills.length?' · +'+m.additionalSkills.length+' навыка':''}</small><small>${esc(masterContact(m))}${current?' · '+esc(assignmentProject(current)?.name||'Объект'):''}</small></span><span class="availability ${a.className}">${esc(m.isActive?a.label:'В архиве')}</span></button>`}).join(''):`<div class="card empty">${showArchivedMasters?'Архив пуст':'Мастера по фильтру не найдены'}</div>`}</div>`;
    document.getElementById('addMaster').onclick=()=>openMasterDialog();document.getElementById('masterSearch').oninput=e=>{masterSearch=e.target.value;renderMastersCloud()};document.getElementById('masterSpecialty').onchange=e=>{masterSpecialtyFilter=e.target.value;renderMastersCloud()};document.getElementById('masterAvailability').onchange=e=>{masterAvailabilityFilter=e.target.value;renderMastersCloud()};document.getElementById('toggleArchivedMasters').onclick=()=>{showArchivedMasters=!showArchivedMasters;renderMastersCloud()};document.querySelectorAll('[data-master-id]').forEach(button=>button.onclick=()=>openMasterDetails(button.dataset.masterId));
  }

  const designerName=d=>d?.fullName||'Дизайнер';
  const designerResponsible=d=>responsibleName((state.designerUsers||[]).find(x=>x.id===d.responsibleUserId));
  const designerProjects=id=>(state.projects||[]).filter(p=>p.designerId===id);
  const designerContactDate=value=>value?new Intl.DateTimeFormat('ru-RU',{dateStyle:'medium',timeStyle:'short'}).format(new Date(value)):'—';
  const localDateTime=value=>{if(!value)return'';const d=new Date(value);return Number.isNaN(d.getTime())?'':new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16)};
  const designerOverdue=d=>!!d.nextContactAt&&d.status!=='inactive'&&new Date(d.nextContactAt).getTime()<Date.now();
  const safeContactLink=(kind,value)=>{const raw=String(value||'').trim();if(!raw)return'';let href=raw,label=raw;if(kind==='instagram'){const handle=raw.replace(/^https?:\/\/(www\.)?instagram\.com\//i,'').replace(/^@/,'').replace(/\/$/,'');href=`https://instagram.com/${encodeURIComponent(handle)}`;label='Instagram'}else if(kind==='telegram'){const handle=raw.replace(/^https?:\/\/t\.me\//i,'').replace(/^@/,'').replace(/\/$/,'');href=`https://t.me/${encodeURIComponent(handle)}`;label='Telegram'}else if(kind==='phone'){href='tel:'+raw.replace(/[^+\d]/g,'');label=raw}else if(kind==='email'){href='mailto:'+raw;label=raw}else if(!/^https?:\/\//i.test(href))href='https://'+href;return `<a class="btn secondary" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>`};
  async function refreshDesigners(message){await loadDesignersCloud();render();if(message)banner(message,'ok')}

  function openDesignerDialog(designerId=''){
    if(!canManageProjects())return;const d=(state.designers||[]).find(x=>x.id===designerId);const users=state.designerUsers||[];
    const dlg=dynamicDialog('designerEditDlg',d?'Редактировать дизайнера':'Новый дизайнер',`<label>Имя и фамилия<input name="fullName" required maxlength="200" value="${esc(d?.fullName||'')}"></label><div class="grid"><label>Студия<input name="studio" maxlength="200" value="${esc(d?.studio||'')}"></label><label>Город<input name="city" maxlength="160" value="${esc(d?.city||'')}"></label></div><div class="grid"><label>Instagram<input name="instagram" maxlength="300" placeholder="@username" value="${esc(d?.instagram||'')}"></label><label>Telegram<input name="telegram" maxlength="200" placeholder="@username" value="${esc(d?.telegram||'')}"></label></div><div class="grid"><label>Телефон<input name="phone" type="tel" maxlength="80" value="${esc(d?.phone||'')}"></label><label>Email<input name="email" type="email" maxlength="240" value="${esc(d?.email||'')}"></label></div><div class="grid"><label>Сайт<input name="website" maxlength="500" value="${esc(d?.website||'')}"></label><label>Портфолио<input name="portfolio" maxlength="500" value="${esc(d?.portfolioUrl||'')}"></label></div><div class="grid"><label>Статус<select name="status">${Object.entries(designerStatusLabels).map(([v,l])=>`<option value="${v}" ${d?.status===v?'selected':''}>${l}</option>`).join('')}</select></label><label>Приоритет<select name="priority">${Object.entries(designerPriorityLabels).map(([v,l])=>`<option value="${v}" ${(d?.priority||'normal')===v?'selected':''}>${l}</option>`).join('')}</select></label></div><label>Ответственный<select name="responsible"><option value="">Не назначен</option>${users.map(u=>`<option value="${esc(u.id)}" ${d?.responsibleUserId===u.id?'selected':''}>${esc(responsibleName(u))}</option>`).join('')}</select></label><div class="grid"><label>Следующий контакт<input name="nextContact" type="datetime-local" value="${esc(localDateTime(d?.nextContactAt))}"></label><label>Следующее действие<input name="nextAction" maxlength="1000" value="${esc(d?.nextAction||'')}"></label></div><div class="grid"><label>Источник<input name="source" maxlength="200" value="${esc(d?.source||'')}"></label><label>Теги<input name="tags" maxlength="500" placeholder="премиум, Москва" value="${esc((d?.tags||[]).join(', '))}"></label></div><label>Заметки<textarea name="notes" rows="4" maxlength="5000">${esc(d?.notes||'')}</textarea></label>${d?`<button type="button" class="btn ${d.isArchived?'secondary':'danger'} full-button" data-designer-archive>${d.isArchived?'Вернуть в работу':'Архивировать'}</button>`:''}`);
    const payload=form=>({id:d?.id,full_name:form.elements.fullName.value,studio:form.elements.studio.value,city:form.elements.city.value,instagram:form.elements.instagram.value,telegram:form.elements.telegram.value,phone:form.elements.phone.value,email:form.elements.email.value,website:form.elements.website.value,portfolio_url:form.elements.portfolio.value,status:form.elements.status.value,priority:form.elements.priority.value,responsible_user_id:form.elements.responsible.value||null,next_contact_at:form.elements.nextContact.value?new Date(form.elements.nextContact.value).toISOString():null,next_action:form.elements.nextAction.value,source:form.elements.source.value,tags:form.elements.tags.value.split(',').map(x=>x.trim()).filter(Boolean),notes:form.elements.notes.value});
    dlg.querySelector('form').onsubmit=async ev=>{ev.preventDefault();const form=ev.currentTarget,button=form.querySelector('.primary');button.disabled=true;try{try{await designersApi('save_designer',{designer:payload(form)})}catch(e){if(e.message!=='possible_duplicate')throw e;if(!confirm('Похожий дизайнер уже есть в базе. Всё равно сохранить отдельную карточку?'))return;await designersApi('save_designer',{designer:payload(form),allow_duplicate:true})}dlg.close();await refreshDesigners(d?'Дизайнер обновлён':'Дизайнер добавлен')}catch(e){banner('Не удалось сохранить дизайнера: '+e.message,'error')}finally{button.disabled=false}};
    const archive=dlg.querySelector('[data-designer-archive]');if(archive)archive.onclick=async()=>{if(!confirm(d.isArchived?'Вернуть дизайнера в работу?':'Архивировать дизайнера? Связи с объектами и история сохранятся.'))return;try{await designersApi('archive_designer',{id:d.id,archived:!d.isArchived});dlg.close();await refreshDesigners(d.isArchived?'Дизайнер восстановлен':'Дизайнер архивирован')}catch(e){banner('Не удалось изменить статус: '+e.message,'error')}};dlg.showModal();
  }

  function openDesignerInteractionDialog(designerId){
    const dlg=dynamicDialog('designerInteractionDlg','Добавить взаимодействие',`<div class="grid"><label>Тип<select name="type">${Object.entries(designerInteractionLabels).map(([v,l])=>`<option value="${v}">${l}</option>`).join('')}</select></label><label>Дата и время<input name="occurred" type="datetime-local" required value="${esc(localDateTime(new Date().toISOString()))}"></label></div><label>Направление<select name="direction"><option value="">Не указано</option><option value="outgoing">Исходящее</option><option value="incoming">Входящее</option></select></label><label>Комментарий<textarea name="comment" rows="4" required maxlength="3000"></textarea></label><label>Результат<input name="result" maxlength="1000"></label>`);dlg.querySelector('form').onsubmit=async ev=>{ev.preventDefault();const form=ev.currentTarget,button=form.querySelector('.primary');button.disabled=true;try{await designersApi('add_interaction',{interaction:{designer_id:designerId,interaction_type:form.elements.type.value,occurred_at:new Date(form.elements.occurred.value).toISOString(),direction:form.elements.direction.value||null,comment:form.elements.comment.value,result:form.elements.result.value}});dlg.close();await refreshDesigners('Взаимодействие добавлено');openDesignerDetails(designerId)}catch(e){banner('Не удалось добавить взаимодействие: '+e.message,'error')}finally{button.disabled=false}};dlg.showModal();
  }

  function openDesignerDetails(designerId){
    const d=(state.designers||[]).find(x=>x.id===designerId);if(!d)return;const interactions=(state.designerInteractions||[]).filter(x=>x.designerId===d.id).sort((a,b)=>b.occurredAt.localeCompare(a.occurredAt)),projects=designerProjects(d.id);let dlg=document.getElementById('designerDetailsDlg');if(!dlg){dlg=document.createElement('dialog');dlg.id='designerDetailsDlg';document.body.appendChild(dlg)}
    const links=[safeContactLink('instagram',d.instagram),safeContactLink('telegram',d.telegram),safeContactLink('phone',d.phone),safeContactLink('email',d.email),safeContactLink('website',d.website||d.portfolioUrl)].filter(Boolean).join('');
    dlg.innerHTML=`<div class="dialog-body"><div class="sheethead"><button type="button" data-close>Закрыть</button><h2>${esc(designerName(d))}</h2><button class="btn secondary" data-edit>Изменить</button></div><div class="designer-profile"><div><span class="badge ${designerOverdue(d)?'danger':d.status==='partner'||d.status==='has_project'?'paid':'pending'}">${esc(designerStatusLabels[d.status]||d.status)}</span><h3>${esc(d.studio||'Без студии')}</h3><p>${esc([d.city,d.source].filter(Boolean).join(' · ')||'Контактные данные')}</p></div><div class="designer-contact-links">${links||'<span class="muted">Контакты не указаны</span>'}</div><dl class="object-details"><div><dt>Ответственный</dt><dd>${esc(d.responsibleUserId?designerResponsible(d):'Не назначен')}</dd></div><div><dt>Последний контакт</dt><dd>${esc(designerContactDate(d.lastContactAt))}</dd></div><div><dt>Следующий контакт</dt><dd class="${designerOverdue(d)?'danger-text':''}">${esc(designerContactDate(d.nextContactAt))}</dd></div><div><dt>Следующее действие</dt><dd>${esc(d.nextAction||'—')}</dd></div></dl>${d.notes?`<div class="master-notes">${esc(d.notes)}</div>`:''}</div><div class="section compact"><h3>Объекты</h3></div><div class="designer-projects">${projects.length?projects.map(p=>`<button class="card" data-designer-project="${esc(p.id)}"><strong>${esc(p.name)}</strong><small>${esc(projectStatusLabel(p.status))}</small></button>`).join(''):'<div class="empty">Связанных объектов пока нет</div>'}</div><div class="section compact"><h3>История взаимодействий</h3><button class="btn primary" data-add-interaction>+ Запись</button></div><div class="designer-history">${interactions.length?interactions.map(x=>`<div class="card"><span class="designer-history-icon">${x.type==='call'?'☎':x.type==='meeting'?'◎':x.type==='message'?'✉':'•'}</span><span class="grow"><strong>${esc(designerInteractionLabels[x.type]||x.type)}</strong><small>${esc(designerContactDate(x.occurredAt))} · ${esc(x.authorName)}</small><p>${esc(x.comment)}</p>${x.result?`<small>Результат: ${esc(x.result)}</small>`:''}</span></div>`).join(''):'<div class="empty">История пока пуста</div>'}</div></div>`;
    dlg.querySelector('[data-close]').onclick=()=>dlg.close();dlg.querySelector('[data-edit]').onclick=()=>{dlg.close();openDesignerDialog(d.id)};dlg.querySelector('[data-add-interaction]').onclick=()=>{dlg.close();openDesignerInteractionDialog(d.id)};dlg.querySelectorAll('[data-designer-project]').forEach(b=>b.onclick=()=>{dlg.close();navigateProject(b.dataset.designerProject)});dlg.showModal();
  }

  function renderDesignersCloud(){
    if(!canManageProjects()){$('#app').innerHTML=`${pageHeader('ADMA · ДИЗАЙНЕРЫ','Дизайнеры','CRM доступна владельцу и партнёру')}${moduleScreen('✦','Доступ ограничен','Работа с партнёрской базой доступна владельцу и партнёру.','Дизайнер → Объект')}`;return}
    const today=new Date().toISOString().slice(0,10),all=(state.designers||[]).filter(d=>showArchivedDesigners?d.isArchived:!d.isArchived);const filtered=all.filter(d=>{const search=[d.fullName,d.studio,d.instagram,d.telegram,d.phone,d.email,d.city,...(d.tags||[])].join(' ').toLowerCase();const day=d.nextContactAt?d.nextContactAt.slice(0,10):'';const contactOk=!designerContactFilter||(designerContactFilter==='overdue'?designerOverdue(d):designerContactFilter==='today'?day===today:designerContactFilter==='planned'?day>=today:false);return(!designerSearch||search.includes(designerSearch.toLowerCase()))&&(!designerStatusFilter||d.status===designerStatusFilter)&&(!designerResponsibleFilter||d.responsibleUserId===designerResponsibleFilter)&&contactOk});
    const card=d=>`<button class="card designer-card ${designerOverdue(d)?'overdue':''}" data-designer-id="${esc(d.id)}"><span class="master-avatar">${esc(designerName(d).slice(0,2).toUpperCase())}</span><span class="grow"><strong>${esc(designerName(d))}</strong><small>${esc(d.studio||d.city||'Без студии')} · ${esc(d.instagram||d.telegram||d.phone||'контакт не указан')}</small><small>${esc(d.nextAction||'Следующее действие не задано')}</small></span><span><span class="badge ${designerOverdue(d)?'danger':d.status==='partner'||d.status==='has_project'?'paid':'pending'}">${esc(designerStatusLabels[d.status]||d.status)}</span><small class="designer-next ${designerOverdue(d)?'danger-text':''}">${esc(d.nextContactAt?designerContactDate(d.nextContactAt):'Без даты')}</small></span></button>`;
    $('#app').innerHTML=`${pageHeader('ADMA · ПАРТНЁРЫ','Дизайнеры','Единая CRM контактов, договорённостей и связанных объектов','<button id="addDesigner" class="btn primary">+ Дизайнер</button>')}<section class="card designer-filters"><label>Поиск<input id="designerSearch" type="search" placeholder="Имя, студия, контакт" value="${esc(designerSearch)}"></label><label>Статус<select id="designerStatus"><option value="">Все статусы</option>${Object.entries(designerStatusLabels).map(([v,l])=>`<option value="${v}" ${designerStatusFilter===v?'selected':''}>${l}</option>`).join('')}</select></label><label>Ответственный<select id="designerResponsible"><option value="">Все ответственные</option>${(state.designerUsers||[]).map(u=>`<option value="${esc(u.id)}" ${designerResponsibleFilter===u.id?'selected':''}>${esc(responsibleName(u))}</option>`).join('')}</select></label><label>Контакт<select id="designerContact"><option value="">Любая дата</option><option value="overdue" ${designerContactFilter==='overdue'?'selected':''}>Просрочен</option><option value="today" ${designerContactFilter==='today'?'selected':''}>Сегодня</option><option value="planned" ${designerContactFilter==='planned'?'selected':''}>Запланирован</option></select></label><div class="designer-view-buttons"><button id="designerListView" class="btn ${designerView==='list'?'primary':'secondary'}">Список</button><button id="designerFunnelView" class="btn ${designerView==='funnel'?'primary':'secondary'}">Воронка</button><button id="toggleArchivedDesigners" class="btn secondary">${showArchivedDesigners?'Активные':'Архив'}</button></div></section>${designerView==='funnel'?`<div class="designer-funnel">${Object.entries(designerStatusLabels).filter(([v])=>v!=='inactive').map(([v,l])=>{const items=filtered.filter(d=>d.status===v);return `<section class="designer-column"><div class="section compact"><h3>${esc(l)}</h3><span class="badge neutral">${items.length}</span></div>${items.map(card).join('')||'<div class="empty">Пусто</div>'}</section>`}).join('')}</div>`:`<div class="designer-list">${filtered.map(card).join('')||'<div class="card empty">Дизайнеры по фильтру не найдены</div>'}</div>`}`;
    document.getElementById('addDesigner').onclick=()=>openDesignerDialog();document.getElementById('designerSearch').oninput=e=>{designerSearch=e.target.value;renderDesignersCloud()};document.getElementById('designerStatus').onchange=e=>{designerStatusFilter=e.target.value;renderDesignersCloud()};document.getElementById('designerResponsible').onchange=e=>{designerResponsibleFilter=e.target.value;renderDesignersCloud()};document.getElementById('designerContact').onchange=e=>{designerContactFilter=e.target.value;renderDesignersCloud()};document.getElementById('designerListView').onclick=()=>{designerView='list';renderDesignersCloud()};document.getElementById('designerFunnelView').onclick=()=>{designerView='funnel';renderDesignersCloud()};document.getElementById('toggleArchivedDesigners').onclick=()=>{showArchivedDesigners=!showArchivedDesigners;renderDesignersCloud()};document.querySelectorAll('[data-designer-id]').forEach(b=>b.onclick=()=>openDesignerDetails(b.dataset.designerId));
  }

  function renderFallbackCloud() {
    if (state.tab === 'finance') return renderGlobalFinanceCloud();
    if (state.tab === 'masters') return renderMastersCloud();
    if (state.tab === 'designers') return renderDesignersCloud();
    if (state.tab === 'leads') return renderFutureModuleCloud(state.tab);
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
          designer_id: optionalValue(pDesigner.value),
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
      await Promise.all([loadFinanceCloud(),loadMastersCloud(),loadProjectOperationsCloud(),loadDesignersCloud()]);
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
