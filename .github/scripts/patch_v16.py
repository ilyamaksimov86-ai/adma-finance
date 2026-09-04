from pathlib import Path
import re

p = Path('cloud.js')
s = p.read_text()
marker = '// PDF_EXPORT_V16'
if marker not in s:
    block = r'''
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
'''
    anchor = '\n  // PROJECT_EDIT_ARCHIVE_V15'
    if anchor not in s:
        raise SystemExit('project archive anchor missing')
    s = s.replace(anchor, '\n' + block + anchor, 1)

old = '    renderProject = renderProjectCloud;\n'
new = '    renderProject = renderProjectCloud;\n    renderDue = renderDueCloud;\n'
if old in s and 'renderDue = renderDueCloud;' not in s:
    s = s.replace(old, new, 1)

s = s.replace('облачная версия · v15', 'облачная версия · v16')
p.write_text(s)

idx = Path('index.html')
h = idx.read_text()
h = re.sub(r'cloud\.js\?v=\d+', 'cloud.js?v=16', h)
idx.write_text(h)
