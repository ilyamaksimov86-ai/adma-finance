(() => {
  const SUPABASE_FUNCTIONS = 'https://blaacuwwvyatfiyjnsrw.supabase.co/functions/v1';
  const tgApp = window.Telegram?.WebApp;
  const initData = tgApp?.initData || '';
  let cloudReady = false;
  let currentUser = null;

  const sleep = ms => new Promise(r => setTimeout(r, ms));

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
      receipt: null,
      receiptPath: e.receipt_path || null,
    };
  }

  function rememberLocalBackup() {
    if (!localStorage.getItem('adma.backup.projects')) {
      localStorage.setItem('adma.backup.projects', localStorage.getItem('adma.projects') || '[]');
    }
    if (!localStorage.getItem('adma.backup.expenses')) {
      localStorage.setItem('adma.backup.expenses', localStorage.getItem('adma.expenses') || '[]');
    }
  }

  function backupData() {
    try {
      return {
        projects: JSON.parse(localStorage.getItem('adma.backup.projects') || '[]'),
        expenses: JSON.parse(localStorage.getItem('adma.backup.expenses') || '[]'),
      };
    } catch {
      return { projects: [], expenses: [] };
    }
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
      const r = await api('create_project', {
        project: {
          name: p.name || 'Объект',
          address: p.address || null,
          client_name: p.client || null,
          comment: p.comment || null,
          status: p.status === 'archived' ? 'archived' : 'active',
        },
      });
      ids.set(String(p.id), r.project.id);
    }

    for (const e of old.expenses) {
      const projectId = ids.get(String(e.projectId));
      if (!projectId) continue;
      await api('create_expense', {
        expense: {
          project_id: projectId,
          amount: Number(e.amount || 0),
          expense_date: e.date,
          category: e.category || 'Прочее',
          supplier: e.supplier || null,
          paid_by: e.paidBy === 'client' ? 'client' : 'adma',
          reimbursement_required: e.paidBy !== 'client' && !!e.reimburse,
          reimbursed: !!e.reimbursed,
          comment: e.comment || null,
          receipt_path: null,
        },
      });
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

  function installCloudHandlers() {
    projectForm.onsubmit = async ev => {
      ev.preventDefault();
      if (!cloudReady) return;
      try {
        banner('Сохраняю объект…');
        await api('create_project', {
          project: {
            name: pName.value.trim(),
            address: pAddress.value.trim() || null,
            client_name: pClient.value.trim() || null,
            comment: pComment.value.trim() || null,
          },
        });
        projectDlg.close();
        await loadCloud();
        banner('Объект сохранён в облаке', 'ok');
      } catch (e) {
        console.error(e);
        banner('Не удалось сохранить объект: ' + e.message, 'error');
      }
    };

    expenseForm.onsubmit = async ev => {
      ev.preventDefault();
      if (!cloudReady) return;
      try {
        const payload = expensePayload();
        banner(editingExpenseId ? 'Сохраняю изменения…' : 'Сохраняю расход…');
        if (editingExpenseId) await api('update_expense', { expense: payload });
        else await api('create_expense', { expense: payload });
        editingExpenseId = null;
        state.receipt = null;
        expenseDlg.close();
        await loadCloud();
        banner('Сохранено в облаке', 'ok');
      } catch (e) {
        console.error(e);
        banner('Не удалось сохранить расход: ' + e.message, 'error');
      }
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
          banner('Расход удалён', 'ok');
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
      const msg = e.message === 'server_not_configured'
        ? 'В Supabase не найден TELEGRAM_BOT_TOKEN'
        : e.message === 'bad_signature'
          ? 'Telegram не подтвердил вход. Закройте Mini App и откройте снова.'
          : 'Облако пока недоступно: ' + e.message;
      banner(msg, 'error');
    }
  }

  setTimeout(start, 0);
})();
