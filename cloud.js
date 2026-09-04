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

  async function api(action, extra = {}) {
    return post('adma-api', { initData, action, ...extra });
  }

  function mapProject(p) {
    return {
      id: p.id,
      name: p.name,
      address: p.address || '',
      client: p.client_name || '',
      comment: p.comment || '',
      status: p.status || 'active',
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
    };
  }

  function rememberLocalBackup() {
    if (!localStorage.getItem('adma.backup.projects')) localStorage.setItem('adma.backup.projects', localStorage.getItem('adma.projects') || '[]');
    if (!localStorage.getItem('adma.backup.expenses')) localStorage.setItem('adma.backup.expenses', localStorage.getItem('adma.expenses') || '[]');
  }

  function backupData() {
    try {
      return {
        projects: JSON.parse(localStorage.getItem('adma.backup.projects') || '[]'),
        expenses: JSON.parse(localStorage.getItem('adma.backup.expenses') || '[]'),
      };
    } catch { return { projects: [], expenses: [] }; }
  }

  async function loadCloud() {
    const data = await api('load');
    state.projects = (data.projects || []).map(mapProject);
    state.expenses = (data.expenses || []).map(mapExpense);
    save();
    render();
    return data;
  }

  async function migrateLocalIfNeeded(cloud) {
    if ((cloud.projects || []).length || localStorage.getItem('adma.cloud.migrated') === '1') return false;
    const old = backupData();
    if (!old.projects.length) {
      localStorage.setItem('adma.cloud.migrated', '1');
      return false;
    }
    banner('Переношу текущие данные в облако…');
    const ids = new Map();
    for (const p of old.projects) {
      const r = await api('create_project', { project: {
        name: p.name || 'Объект', address: p.address || null, client_name: p.client || null,
        comment: p.comment || null, status: p.status === 'archived' ? 'archived' : 'active',
      }});
      ids.set(String(p.id), r.project.id);
    }
    for (const e of old.expenses) {
      const projectId = ids.get(String(e.projectId));
      if (!projectId) continue;
      await api('create_expense', { expense: {
        project_id: projectId, amount: Number(e.amount || 0), expense_date: e.date,
        category: e.category || 'Прочее', supplier: e.supplier || null,
        paid_by: e.paidBy === 'client' ? 'client' : 'adma',
        reimbursement_required: e.paidBy !== 'client' && !!e.reimburse,
        reimbursed: !!e.reimbursed, comment: e.comment || null, receipt_path: null,
      }});
    }
    localStorage.setItem('adma.cloud.migrated', '1');
    return true;
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

  function uploadReceiptViaXHR(file) {
    return new Promise((resolve, reject) => {
      const form = new FormData();
      form.append('initData', initData);
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
  function pendingExpensesForPdf() {
    return [...state.expenses].filter(pending).sort((a, b) => {
      const pa = proj(a.projectId)?.name || '';
      const pb = proj(b.projectId)?.name || '';
      return pa.localeCompare(pb, 'ru') || a.date.localeCompare(b.date);
    });
  }

  function requestReimbursementPdfViaXHR(expenseIds = null) {
    return new Promise((resolve, reject) => {
      const form = new FormData();
      form.append('initData', initData);
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

  function openPdfSelection() {
    const expenses = pendingExpensesForPdf();
    if (!expenses.length) {
      banner('Нет расходов к компенсации', 'error');
      return;
    }
    const dlg = ensurePdfDialog();
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
    const actions = arr.length ? `<div class="card"><strong>Выгрузка для заказчика</strong><p class="muted" style="margin:6px 0 12px">В PDF попадут только расходы, которые ещё не компенсированы.</p><button id="pdfAllPending" class="btn primary" style="width:100%;margin-bottom:8px">Выгрузить все в PDF · ${arr.length}</button><button id="pdfPickPending" class="btn secondary" style="width:100%">Выбрать расходы</button></div>` : '';
    $('#app').innerHTML = `<section class="hero"><small>Всего к возмещению</small><div class="amount">${money(due())}</div><small>${arr.length} чеков</small></section>${actions}<div id="list"></div>`;
    const all = document.getElementById('pdfAllPending');
    if (all) all.onclick = async () => {
      all.disabled = true;
      try { await createReimbursementPdf(null); } catch {}
      finally { all.disabled = false; }
    };
    const pick = document.getElementById('pdfPickPending');
    if (pick) pick.onclick = openPdfSelection;
    renderExpenses(arr, $('#list'));
  }

  // PROJECT_EDIT_ARCHIVE_V15
  let editingProjectId = null;
  let showArchivedProjects = false;

  function canManageProjects() {
    return currentUser?.role === 'owner' || currentUser?.role === 'partner';
  }

  function activeProjects() {
    return state.projects.filter(p => p.status !== 'archived');
  }

  function archivedProjects() {
    return state.projects.filter(p => p.status === 'archived');
  }

  function openProjectCreateCloud() {
    if (!canManageProjects()) return;
    editingProjectId = null;
    projectForm.reset();
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
      await api('update_project', { project: { id, status: archived ? 'archived' : 'active' } });
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
    $('#app').innerHTML = `<section class="hero"><small>Заказчики должны ADMA</small><div class="amount">${money(due())}</div><small>${state.expenses.filter(pending).length} расходов к возмещению</small></section><section class="grid"><div class="card metric"><small>Активные объекты</small><strong>${activeProjects().length}</strong></div><div class="card metric"><small>Расходы за месяц</small><strong>${money(month)}</strong></div><div class="card metric"><small>Всего расходов</small><strong>${money(spent())}</strong></div><div class="card metric"><small>Компенсировано</small><strong>${money(reimb())}</strong></div></section><div class="section"><h2>Последние расходы</h2></div><div id="list"></div>`;
    renderExpenses(recent, $('#list'));
  }

  function renderProjectsCloud() {
    const active = activeProjects();
    const archived = archivedProjects();
    const list = showArchivedProjects ? archived : active;
    const heading = showArchivedProjects ? 'Архив' : 'Активные объекты';
    $('#app').innerHTML = `<div class="section"><h2>${heading}</h2>${!showArchivedProjects && canManageProjects() ? '<button id="addProject" class="btn primary">+ Объект</button>' : ''}</div>${showArchivedProjects ? '<button id="showActive" class="btn secondary" style="width:100%;margin-bottom:12px">‹ Активные объекты</button>' : (archived.length ? `<button id="showArchive" class="btn secondary" style="width:100%;margin-bottom:12px">Архив · ${archived.length}</button>` : '')}<div id="plist"></div>`;
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
      b.className = 'card row';
      b.style.width = '100%';
      b.innerHTML = `<div class="grow"><div class="row" style="justify-content:flex-start"><strong>${esc(p.name)}</strong>${p.status === 'archived' ? '<span class="badge" style="background:#eee;color:#666">Архив</span>' : ''}</div><div class="muted">${expensesFor(p.id).length} расходов · ${money(spent(p.id))}</div></div><div class="right"><strong>${money(due(p.id))}</strong><div class="muted">к оплате</div></div>`;
      b.onclick = () => { state.project = p.id; render(); };
      l.appendChild(b);
    });
  }

  function renderProjectCloud() {
    const p = proj(state.project);
    if (!p) {
      state.project = null;
      state.tab = 'projects';
      render();
      return;
    }
    const arr = [...expensesFor(p.id)].sort((a, b) => b.date.localeCompare(a.date));
    const isArchived = p.status === 'archived';
    const manage = canManageProjects();
    const info = [p.address, p.client].filter(Boolean).join(' · ');
    $('#app').innerHTML = `<button id="back" class="btn secondary">‹ Назад</button>${isArchived ? '<span class="badge" style="margin-left:8px;background:#eee;color:#666">Архив</span>' : ''}<section class="hero" style="margin-top:12px"><small>К возмещению по объекту</small><div class="amount">${money(due(p.id))}</div><small>${esc(info)}</small></section><section class="grid"><div class="card metric"><small>Всего расходов</small><strong>${money(spent(p.id))}</strong></div><div class="card metric"><small>Компенсировано</small><strong>${money(reimb(p.id))}</strong></div></section>${(p.client || p.address || p.comment) ? `<div class="card"><strong>Об объекте</strong>${p.client ? `<p class="muted" style="margin-bottom:4px">Заказчик: ${esc(p.client)}</p>` : ''}${p.address ? `<p class="muted" style="margin:4px 0">Адрес: ${esc(p.address)}</p>` : ''}${p.comment ? `<p style="margin:10px 0 0">${esc(p.comment)}</p>` : ''}</div>` : ''}${manage ? `<div class="row" style="margin:12px 0"><button id="editProjectCloud" class="btn secondary grow">Редактировать</button><button id="archiveProjectCloud" class="btn ${isArchived ? 'primary' : 'danger'} grow">${isArchived ? 'Вернуть в работу' : 'В архив'}</button></div>` : ''}<div class="section"><h2>Расходы</h2>${!isArchived ? '<button id="addExpense" class="btn primary">+ Расход</button>' : ''}</div><div id="list"></div>`;
    $('#back').onclick = () => { state.project = null; state.tab = 'projects'; showArchivedProjects = isArchived; render(); };
    const edit = document.getElementById('editProjectCloud');
    if (edit) edit.onclick = () => openProjectEditCloud(p.id);
    const archive = document.getElementById('archiveProjectCloud');
    if (archive) archive.onclick = () => setProjectArchivedCloud(p.id, !isArchived);
    const addExpense = document.getElementById('addExpense');
    if (addExpense) addExpense.onclick = () => openExpense(p.id);
    renderExpenses(arr, $('#list'));
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
      list.innerHTML = users.map(u => {
        const name = [u.first_name, u.last_name].filter(Boolean).join(' ') || 'Пользователь Telegram';
        const username = u.telegram_username ? '@' + u.telegram_username : 'Telegram ID ' + u.telegram_user_id;
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
          <div class="teamProjects" style="display:${u.role === 'foreman' ? 'block' : 'none'}"><div class="muted" style="margin:12px 0 7px">Объекты, доступные прорабу</div>${projects || '<div class="muted">Сначала создайте объект</div>'}</div>
          ${self ? '<div class="muted" style="margin-top:12px">Свой доступ владельца нельзя отключить здесь.</div>' : '<button class="btn primary teamSave" style="width:100%;margin-top:12px">Сохранить доступ</button>'}
        </div>`;
      }).join('');

      list.querySelectorAll('.teamUser').forEach(card => {
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

  function renderMoreCloud() {
    const role = currentUser?.role || 'foreman';
    const name = [currentUser?.first_name, currentUser?.last_name].filter(Boolean).join(' ');
    $('#app').innerHTML = `<div class="card"><strong>Облачная синхронизация включена</strong><p class="muted">Объекты, расходы и чеки хранятся в защищённом облаке Supabase и доступны на ваших устройствах.</p></div>
      <div class="card"><small class="muted">Ваш доступ</small><strong style="display:block;margin-top:6px">${roleLabel(role)}</strong>${name ? `<div class="muted" style="margin-top:4px">${esc(name)}</div>` : ''}</div>
      ${role === 'owner' ? '<div class="card"><strong>Команда</strong><p class="muted">Новые сотрудники сначала открывают Mini App через @Admafinance_bot. После этого они появятся здесь и будут ждать подтверждения.</p><button id="teamAccess" class="btn primary" style="width:100%">Команда и доступ</button></div>' : ''}
      <div class="card"><strong>ADMA Finance</strong><p class="muted">Финансы объектов · облачная версия · v17</p></div>`;
    const teamBtn = document.getElementById('teamAccess');
    if (teamBtn) teamBtn.onclick = openTeamAccess;
  }

  function installCloudHandlers() {
    renderMore = renderMoreCloud;
    renderHome = renderHomeCloud;
    renderProjects = renderProjectsCloud;
    renderProject = renderProjectCloud;
    renderDue = renderDueCloud;
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

  async function start() {
    if (!initData) {
      banner('Облачный режим работает при запуске через Telegram', 'error');
      return;
    }
    rememberLocalBackup();
    banner('Подключаю облако…');
    try {
      const auth = await post('telegram-auth', { initData });
      currentUser = auth.user;
      if (!currentUser?.is_active) {
        banner('Ваш доступ ожидает подтверждения владельцем', 'error');
        return;
      }
      let cloud = await api('load');
      const migrated = await migrateLocalIfNeeded(cloud);
      if (migrated) cloud = await api('load');
      state.projects = (cloud.projects || []).map(mapProject);
      state.expenses = (cloud.expenses || []).map(mapExpense);
      save();
      cloudReady = true;
      installCloudHandlers();
      render();
      banner('Облако подключено · ' + (currentUser.role === 'owner' ? 'Владелец' : currentUser.role), 'ok');
    } catch (e) {
      console.error('ADMA cloud init failed', e);
      const msg = e.message === 'server_not_configured' ? 'В Supabase не найден TELEGRAM_BOT_TOKEN'
        : e.message === 'bad_signature' ? 'Telegram не подтвердил вход. Закройте Mini App и откройте снова.'
        : 'Облако пока недоступно: ' + e.message;
      banner(msg, 'error');
    }
  }

  setTimeout(start, 0);
})();
