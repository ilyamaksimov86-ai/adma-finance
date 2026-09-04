(() => {
  const SUPABASE_URL = 'https://blaacuwwvyatfiyjnsrw.supabase.co';
  const SUPABASE_FUNCTIONS = `${SUPABASE_URL}/functions/v1`;
  const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_46rvPfMxc87CTWn6lXQ0Gg_VzBcPIpS';
  const tgApp = window.Telegram?.WebApp;
  const initData = tgApp?.initData || '';
  let cloudReady = false;
  let currentUser = null;
  let storageClient = null;

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

  async function attachNewReceipt(payload) {
    if (typeof state.receipt !== 'string' || !state.receipt.startsWith('data:image/')) return payload;
    banner('Готовлю чек к загрузке…');
    const compact = await compressReceipt(state.receipt);
    const blob = dataUrlToBlob(compact);
    const signedRes = await fetch(`${SUPABASE_FUNCTIONS}/adma-api`, {
      method: 'POST',
      body: JSON.stringify({ initData, action: 'sign_receipt', ext: 'jpg' }),
    });
    let signed = {};
    try { signed = await signedRes.json(); } catch {}
    if (!signedRes.ok) throw new Error(signed.error || `sign_receipt_HTTP_${signedRes.status}`);
    banner('Загружаю чек в хранилище…');
    const client = await getStorageClient();
    const { error } = await client.storage.from('receipts').uploadToSignedUrl(signed.path, signed.token, blob, {
      contentType: 'image/jpeg',
      cacheControl: '3600',
    });
    if (error) throw new Error(error.message || 'receipt_upload_failed');
    payload.receipt_path = signed.path;
    return payload;
  }

  function installCloudHandlers() {
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
      const delBtn = document.getElementById('del');
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