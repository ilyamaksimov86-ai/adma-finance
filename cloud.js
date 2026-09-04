(() => {
  const SUPABASE_URL = 'https://blaacuwwvyatfiyjnsrw.supabase.co';
  const SUPABASE_FUNCTIONS = `${SUPABASE_URL}/functions/v1`;
  const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_46rvPfMxc87CTWn6lXQ0Gg_VzBcPIpS';
  const tgApp = window.Telegram?.WebApp;
  const initData = tgApp?.initData || '';
  let cloudReady = false;
  let currentUser = null;
  let storageClient = null;
  let receiptUploadTicket = null;
  let selectedReceiptBlob = null;
  let selectedReceiptPreviewUrl = null;

  function clearSelectedReceipt() {
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

  async function post(path, body) {
    const res = await fetch(`${SUPABASE_FUNCTIONS}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let data = {};
    try { data = await res.json(); } catch {}
    if (!res.ok) {
      const err = new Error(data.error || `HTTP_${res.status}`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  async function api(action, extra = {}) {
    return post('adma-api', { initData, action, ...extra });
  }

  async function primeReceiptUpload(silent = true) {
    try {
      const ticket = await api('sign_receipt', { ext: 'jpg' });
      if (ticket?.path && ticket?.token) {
        receiptUploadTicket = { path: ticket.path, token: ticket.token, createdAt: Date.now() };
        return receiptUploadTicket;
      }
      throw new Error('receipt_ticket_invalid');
    } catch (e) {
      console.warn('Receipt upload ticket preload failed', e);
      if (!silent) throw e;
      return null;
    }
  }

  function loadSupabaseSdk() {
    if (window.supabase?.createClient) return Promise.resolve(window.supabase);
    return new Promise((resolve, reject) => {
      const existing = document.getElementById('supabaseSdk');
      if (existing) {
        existing.addEventListener('load', () => resolve(window.supabase), { once: true });
        existing.addEventListener('error', () => reject(new Error('supabase_sdk_failed')), { once: true });
        return;
      }
      const s = document.createElement('script');
      s.id = 'supabaseSdk';
      s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';
      s.onload = () => resolve(window.supabase);
      s.onerror = () => reject(new Error('supabase_sdk_failed'));
      document.head.appendChild(s);
    });
  }

  async function getStorageClient() {
    if (storageClient) return storageClient;
    const sdk = await loadSupabaseSdk();
    storageClient = sdk.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    return storageClient;
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

  function compressReceipt(dataUrl) {
    return new Promise(resolve => {
      if (!dataUrl || !dataUrl.startsWith('data:image/')) return resolve(dataUrl);
      const img = new Image();
      img.onload = () => {
        try {
          const max = 1000;
          const scale = Math.min(1, max / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          canvas.getContext('2d').drawImage(img, 0, 0, w, h);
          resolve(canvas.toDataURL('image/jpeg', 0.58));
        } catch { resolve(dataUrl); }
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  function dataUrlToBlob(dataUrl) {
    const [meta, base64] = dataUrl.split(',');
    const mime = (meta.match(/^data:([^;]+);base64$/) || [])[1] || 'image/jpeg';
    const bin = atob(base64 || '');
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime });
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
    payload.receipt_path = data.path;
    return payload;
  }

  function installCloudHandlers() {
    const originalOpenExpense = openExpense;
    openExpense = function(pid) {
      clearSelectedReceipt();
      return originalOpenExpense(pid);
    };

    const originalEditExpense = editExpense;
    editExpense = function(i) {
      clearSelectedReceipt();
      return originalEditExpense(i);
    };

    eReceipt.onchange = async () => {
      const file = eReceipt.files?.[0];
      if (!file) return;
      clearSelectedReceipt();
      try {
        banner('Подготавливаю фото чека…');
        selectedReceiptBlob = await prepareReceiptFile(file);
        selectedReceiptPreviewUrl = URL.createObjectURL(selectedReceiptBlob);
        state.receipt = null;
        preview.src = selectedReceiptPreviewUrl;
        preview.style.display = 'block';
        banner('Чек готов к загрузке', 'ok');
      } catch (e) {
        eReceipt.value = '';
        preview.style.display = 'none';
        banner(e?.message || 'Не удалось подготовить фото', 'error');
      }
    };
    projectForm.onsubmit = async ev => {
      ev.preventDefault();
      if (!cloudReady) return;
      try {
        banner('Сохраняю объект…');
        await api('create_project', { project: {
          name: pName.value.trim(), address: pAddress.value.trim() || null,
          client_name: pClient.value.trim() || null, comment: pComment.value.trim() || null,
        }});
        projectDlg.close();
        await loadCloud();
        banner('Объект сохранён в облаке', 'ok');
      } catch (e) { console.error(e); banner('Не удалось сохранить объект: ' + e.message, 'error'); }
    };

    expenseForm.onsubmit = async ev => {
      ev.preventDefault();
      if (!cloudReady) return;
      try {
        let payload = expensePayload();
        payload = await attachNewReceipt(payload);
        banner(editingExpenseId ? 'Сохраняю изменения…' : 'Сохраняю расход…');
        if (editingExpenseId) await api('update_expense', { expense: payload });
        else await api('create_expense', { expense: payload });
        editingExpenseId = null;
        state.receipt = null;
        clearSelectedReceipt();
        expenseDlg.close();
        await loadCloud();
        banner(payload.receipt_path ? 'Сохранено в облаке вместе с чеком' : 'Сохранено в облаке', 'ok');
      } catch (e) { console.error(e); banner('Не удалось сохранить расход: ' + e.message, 'error'); }
    };

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