from pathlib import Path
import re

p = Path('cloud.js')
s = p.read_text()
marker = '// PROJECT_EDIT_ARCHIVE_V15'

if marker not in s:
    insert = r'''
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
'''
    anchor = '  // TEAM_ACCESS_V13'
    if anchor not in s:
        raise SystemExit('team marker missing')
    s = s.replace(anchor, insert + '\n' + anchor, 1)

old_open = '''  function installCloudHandlers() {\n    renderMore = renderMoreCloud;\n    const originalOpenExpense = openExpense;\n    openExpense = function(pid) {\n      clearSelectedReceipt();\n      return originalOpenExpense(pid);\n    };\n'''
new_open = '''  function installCloudHandlers() {\n    renderMore = renderMoreCloud;\n    renderHome = renderHomeCloud;\n    renderProjects = renderProjectsCloud;\n    renderProject = renderProjectCloud;\n    const originalOpenExpense = openExpense;\n    openExpense = function(pid) {\n      clearSelectedReceipt();\n      const active = activeProjects();\n      const requested = pid ? state.projects.find(p => p.id === pid) : null;\n      if (requested?.status === 'archived') { banner('Архивный объект доступен только для просмотра', 'error'); return; }\n      if (!active.length) { state.project = null; state.tab = 'projects'; render(); banner('Сначала создай активный объект', 'error'); return; }\n      const all = state.projects;\n      try { state.projects = active; return originalOpenExpense(pid); } finally { state.projects = all; }\n    };\n'''
if old_open in s:
    s = s.replace(old_open, new_open, 1)
elif 'renderHome = renderHomeCloud;' not in s:
    raise SystemExit('installCloudHandlers openExpense block missing')

old_form = '''    projectForm.onsubmit = async ev => {\n      ev.preventDefault();\n      if (!cloudReady) return;\n      try {\n        banner('Сохраняю объект…');\n        await api('create_project', { project: {\n          name: pName.value.trim(), address: pAddress.value.trim() || null,\n          client_name: pClient.value.trim() || null, comment: pComment.value.trim() || null,\n        }});\n        projectDlg.close();\n        await loadCloud();\n        banner('Объект сохранён в облаке', 'ok');\n      } catch (e) { console.error(e); banner('Не удалось сохранить объект: ' + e.message, 'error'); }\n    };\n'''
new_form = '''    projectForm.onsubmit = async ev => {\n      ev.preventDefault();\n      if (!cloudReady || !canManageProjects()) return;\n      try {\n        const project = {\n          name: pName.value.trim(), address: pAddress.value.trim() || null,\n          client_name: pClient.value.trim() || null, comment: pComment.value.trim() || null,\n        };\n        banner(editingProjectId ? 'Сохраняю изменения объекта…' : 'Сохраняю объект…');\n        if (editingProjectId) await api('update_project', { project: { id: editingProjectId, ...project } });\n        else await api('create_project', { project });\n        const wasEditing = !!editingProjectId;\n        editingProjectId = null;\n        projectDlg.close();\n        await loadCloud();\n        banner(wasEditing ? 'Объект обновлён' : 'Объект сохранён в облаке', 'ok');\n      } catch (e) { console.error(e); banner('Не удалось сохранить объект: ' + e.message, 'error'); }\n    };\n'''
if old_form in s:
    s = s.replace(old_form, new_form, 1)
elif "editingProjectId ? 'Сохраняю изменения объекта…'" not in s:
    raise SystemExit('project form block missing')

s = s.replace("const projects = state.projects.map(p =>", "const projects = state.projects.filter(p => p.status !== 'archived').map(p =>")
s = s.replace('Финансы объектов · облачная версия', 'Финансы объектов · облачная версия · v15')
p.write_text(s)

idx = Path('index.html')
h = idx.read_text()
h = re.sub(r'cloud\\.js\\?v=\\d+', 'cloud.js?v=15', h)
idx.write_text(h)
