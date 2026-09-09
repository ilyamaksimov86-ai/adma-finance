/* @fragment 0510 */
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
  const inMonth = (value, month) => !month || String(value || '').slice(0, 7) === month;
  function projectFinanceTotals(projectId, month = '') {
    const acts=actsFor(projectId).filter(x=>inMonth(x.date,month)),waybills=waybillsFor(projectId).filter(x=>inMonth(x.date,month));
    const actsAmount=totalAmounts(acts),actsProfit=acts.reduce((s,x)=>s+actProfit(x),0);
    const waybillsAmount=totalAmounts(waybills),waybillsProfit=waybills.reduce((s,x)=>s+waybillProfit(x),0);
    const checks=(state.expenses||[]).filter(x=>x.projectId===projectId&&inMonth(x.date,month));
    return {actsAmount,actsProfit,waybillsAmount,waybillsProfit,checks:totalAmounts(checks),due:totalAmounts(checks.filter(pending)),profit:actsProfit+waybillsProfit};
  }
  function companyFinanceTotals(month = '') {
    const objectProfit=(state.projects||[]).reduce((s,p)=>s+projectFinanceTotals(p.id,month).profit,0);
    const general=totalAmounts((state.companyExpenses||[]).filter(x=>inMonth(x.date,month)));
    const dueTotal=totalAmounts((state.expenses||[]).filter(x=>pending(x)&&inMonth(x.date,month)));
    return {objectProfit,general,due:dueTotal,profit:objectProfit-general};
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
      const mobileTab = ['designers', 'masters', 'knowledge'].includes(state.tab) ? 'more' : state.tab;
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
    pContractAmount.value = p.contractAmount ?? '';
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


/* @fragment 0766 */
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
    return `<div class="object-breadcrumb"><button id="back" class="breadcrumb-button"><strong>Объекты</strong></button> / ${esc(p.name)}</div><section class="card object-head"><div class="row"><div class="grow"><div class="row object-title-row"><h2>${esc(p.name)}</h2><span class="badge ${projectStatusClass(p.status)}">${projectStatusLabel(p.status)}</span></div><div class="muted">${esc(meta || 'Адрес и площадь не указаны')}</div><div class="muted object-meta">Сумма договора: <span data-contract-amount style="font-variant-numeric:tabular-nums">${p.contractAmount == null ? 'Не указана' : money(p.contractAmount)}</span></div><div class="muted object-meta">${esc(p.client ? `Заказчик: ${p.client}` : 'Заказчик не указан')}</div></div><div class="object-actions">${p.status !== 'archived' ? '<button id="objectOperation" class="btn primary">+ Операция</button>' : ''}${canManageProjects() ? `<button id="editProjectCloud" class="btn secondary">Редактировать</button><button id="archiveProjectCloud" class="btn ${p.status === 'archived' ? 'primary' : 'danger'}">${p.status === 'archived' ? 'Вернуть в работу' : 'В архив'}</button>` : ''}</div></div><div class="object-schedule"><div><small>Готовность</small><strong>${summary.stages.length ? summary.progress + '%' : '—'}</strong></div><div><small>Текущий этап</small><strong>${esc(summary.current?.name || (summary.stages.length ? 'Ожидает начала' : 'График не заполнен'))}</strong></div><div><small>Начало</small><strong>${esc(projectDate(p.startDate))}</strong></div><div><small>Отклонение</small><strong>${esc(delayLabel(summary))}</strong></div></div></section><nav class="project-tabs" aria-label="Разделы объекта">${projectSections.map(([id, label]) => `<button class="project-tab ${projectSection === id ? 'active' : ''}" data-project-section="${id}">${label}</button>`).join('')}</nav><div id="projectSection"></div>`;
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


/* @fragment 1237 */
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

  function installProjectHandlers() {
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
          contract_amount: pContractAmount.value === '' ? null : Number(pContractAmount.value),
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
  }
