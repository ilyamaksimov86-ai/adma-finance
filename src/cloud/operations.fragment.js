/* @fragment 0274 */
  let documentCategoryFilter = '';
  let photoStageFilter = '';
  let taskView = 'overdue';
  const documentCategoryLabels = {contract:'Договор',estimate:'Смета',addendum:'Дополнительные соглашения',design:'Дизайн-проект',technical:'Техническая документация',other:'Прочее'};
  const taskStatusLabels = {new:'Новая',in_progress:'В работе',completed:'Выполнена',cancelled:'Отменена'};
  const taskPriorityLabels = {low:'Низкий',normal:'Обычный',high:'Высокий',urgent:'Срочный'};

  async function loadProjectOperationsCloud(){const data=await operationsApi('load');state.projectDocuments=(data.documents||[]).map(mapProjectDocument);state.projectTasks=(data.tasks||[]).map(mapProjectTask);state.projectPhotos=(data.photos||[]).map(mapProjectPhoto)}

/* @fragment 0953 */
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
    await ensureModule('operations',true);
    if (message) banner(message, 'ok');
  }

  async function getProjectFileUrl(kind,item){
    if(item.fileUrl&&item.fileUrlExpiresAt>Date.now())return item.fileUrl;
    const data=await operationsApi('get_file_url',{kind,id:item.id});
    item.fileUrl=data.url||'';
    item.fileUrlExpiresAt=Date.now()+Math.max(0,Number(data.expires_in||3600)-60)*1000;
    return item.fileUrl;
  }

  async function openPrivateProjectFile(kind,item){
    try{const url=await getProjectFileUrl(kind,item);if(!url)throw new Error('file_unavailable');if(tgApp?.openLink)tgApp.openLink(url);else window.open(url,'_blank','noopener')}
    catch(error){banner('Не удалось открыть файл: '+error.message,'error')}
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
        ? '<button type="button" class="btn secondary" data-open-file>Открыть файл</button>'
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
          const data=await operationsApi('save_document', { document: {
            id: item.id,
            title: form.elements.title.value,
            category: form.elements.category.value,
            document_date: form.elements.documentDate.value || null,
            description: form.elements.description.value,
          }});patchMapped('projectDocuments',data.document,mapProjectDocument);
        } else {
          const data=await uploadProjectFile(form.elements.file.files[0], {
            kind: 'document', project_id: projectId,
            title: form.elements.title.value,
            category: form.elements.category.value,
            document_date: form.elements.documentDate.value,
            description: form.elements.description.value,
          });patchMapped('projectDocuments',data.document,mapProjectDocument);
        }
        dlg.close();
        render();banner(item ? 'Документ обновлён' : 'Документ загружен','ok');
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
        await operationsApi('delete_document', { id: item.id });removeFromState('projectDocuments',item.id);
        dlg.close();
        render();banner('Документ удалён','ok');
      } catch (error) { banner('Не удалось удалить документ: ' + error.message, 'error'); }
    };
    const open=dlg.querySelector('[data-open-file]');if(open)open.onclick=()=>openPrivateProjectFile('document',item);
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
      <div class="document-list">${items.length ? items.map(item => `<button class="card document-card" data-document-id="${esc(item.id)}"><span class="file-icon">${item.mime_type?.startsWith('image/') ? 'IMG' : 'DOC'}</span><span class="grow"><strong>${esc(item.title)}</strong><small>${esc(documentCategoryLabels[item.category] || item.category)} · ${esc(item.original_name || 'Файл')}</small><small>${esc(projectDate((item.documentDate || item.createdAt).slice(0, 10)))} · ${esc(item.authorName)}${item.size_bytes != null ? ' · ' + bytesLabel(item.size_bytes) : ''}</small></span><span class="badge paid">Приватный</span></button>`).join('') : '<div class="card empty">Документов в этой категории пока нет</div>'}</div>`;
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
        const data=await operationsApi('save_task', { task: {
          id: item?.id, project_id: projectId, title: form.elements.title.value,
          description: form.elements.description.value,
          assignee_user_id: kind === 'user' ? assigneeId : null,
          assignee_master_id: kind === 'master' ? assigneeId : null,
          deadline: form.elements.deadline.value || null, priority: form.elements.priority.value,
          status: form.elements.status.value, stage_id: form.elements.stage.value || null,
          act_id: form.elements.act?.value || null, waybill_id: form.elements.waybill?.value || null,
        }});patchMapped('projectTasks',data.task,mapProjectTask);
        dlg.close();
        render();banner(item ? 'Задача обновлена' : 'Задача добавлена','ok');
      } catch (error) { banner('Не удалось сохранить задачу: ' + error.message, 'error'); }
    };
    const remove = dlg.querySelector('[data-delete]');
    if (remove) remove.onclick = async () => {
      if (!confirm(`Удалить задачу «${item.title}»?`)) return;
      try {
        await operationsApi('delete_task', { id: item.id });removeFromState('projectTasks',item.id);
        dlg.close();
        render();banner('Задача удалена','ok');
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
        const data=await operationsApi('save_task', { task: taskPayload(item, { status: 'completed' }) });
        patchMapped('projectTasks',data.task,mapProjectTask);render();banner('Задача выполнена','ok');
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
      ${item ? '<button type="button" class="btn secondary" data-open-photo>Открыть фото</button>' : ''}
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
          const data=await operationsApi('save_photo', { photo: {
            id: item.id, stage_id: form.elements.stage.value || null,
            shot_date: form.elements.shotDate.value || null, caption: form.elements.caption.value,
          }});patchMapped('projectPhotos',data.photo,mapProjectPhoto);
        } else {
          const files = [...form.elements.files.files];
          for (let index = 0; index < files.length; index += 1) {
            banner(`Загружаю фото ${index + 1} из ${files.length}…`);
            const prepared = await photoUploadFile(files[index]);
            const data=await uploadProjectFile(prepared, {
              kind: 'photo', project_id: projectId, stage_id: form.elements.stage.value,
              shot_date: form.elements.shotDate.value, caption: form.elements.caption.value,
            });patchMapped('projectPhotos',data.photo,mapProjectPhoto);
          }
        }
        dlg.close();
        render();banner(item ? 'Фото обновлено' : 'Фото загружены','ok');
      } catch (error) { banner('Не удалось сохранить фото: ' + error.message, 'error'); }
      finally { submit.disabled = false; }
    };
    const remove = dlg.querySelector('[data-delete]');
    if (remove) remove.onclick = async () => {
      if (!confirm('Удалить фотографию из объекта и хранилища?')) return;
      try {
        await operationsApi('delete_photo', { id: item.id });removeFromState('projectPhotos',item.id);
        dlg.close();
        render();banner('Фото удалено','ok');
      } catch (error) { banner('Не удалось удалить фото: ' + error.message, 'error'); }
    };
    const open=dlg.querySelector('[data-open-photo]');if(open)open.onclick=()=>openPhotoViewer(item);
    dlg.showModal();
  }

  async function openPhotoViewer(photo) {
    let dlg = document.getElementById('photoViewerDlg');
    if (!dlg) { dlg = document.createElement('dialog'); dlg.id = 'photoViewerDlg'; document.body.appendChild(dlg); }
    dlg.innerHTML = '<div class="photo-viewer"><button type="button" data-close>Закрыть</button><div class="empty">Загружаем фото…</div></div>';
    dlg.querySelector('[data-close]').onclick = () => dlg.close();dlg.showModal();
    try{const url=await getProjectFileUrl('photo',photo);dlg.innerHTML=`<div class="photo-viewer"><button type="button" data-close>Закрыть</button><img src="${esc(url)}" alt="${esc(photo.caption || 'Фото объекта')}"><div><strong>${esc(photo.caption || 'Без подписи')}</strong><small>${esc(assignmentStage({ stageId: photo.stageId })?.name || 'Без этапа')} · ${esc(photo.authorName)}</small></div></div>`}
    catch(error){dlg.innerHTML='<div class="photo-viewer"><button type="button" data-close>Закрыть</button><div class="empty">Фото временно недоступно</div></div>'}
    dlg.querySelector('[data-close]').onclick = () => dlg.close();
    dlg.querySelector('img')?.addEventListener('click', () => dlg.close());
  }

  function renderProjectPhotos(project) {
    const stages = stagesFor(project.id);
    if (photoStageFilter && !stages.some(stage => stage.id === photoStageFilter)) photoStageFilter = '';
    const all = (state.projectPhotos || []).filter(item => item.projectId === project.id);
    const items = all.filter(item => !photoStageFilter || item.stageId === photoStageFilter).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    $('#projectSection').innerHTML = `
      <div class="page-title-row"><div><h2>Фото объекта</h2><p>Галерея объекта с привязкой к этапам</p></div>${project.status !== 'archived' ? '<button id="addProjectPhoto" class="btn primary">+ Фото</button>' : ''}</div>
      <section class="card operation-filter"><label>Этап<select id="photoStageFilter"><option value="">Все этапы</option>${stages.map(stage => `<option value="${esc(stage.id)}" ${photoStageFilter === stage.id ? 'selected' : ''}>${esc(stage.name)}</option>`).join('')}</select></label><span>${items.length} фото</span></section>
      <div class="photo-grid">${items.length ? items.map(item => `<article class="card photo-card"><button data-view-photo="${esc(item.id)}"><span class="photo-missing">Открыть фото</span></button><div><strong>${esc(item.caption || 'Без подписи')}</strong><small>${esc(assignmentStage({ stageId: item.stageId })?.name || 'Без этапа')} · ${esc(projectDate((item.shotDate || item.createdAt).slice(0, 10)))}</small><button class="btn secondary" data-edit-photo="${esc(item.id)}">Изменить</button></div></article>`).join('') : '<div class="card empty">Фотографий по выбранному этапу пока нет</div>'}</div>`;
    document.getElementById('addProjectPhoto')?.addEventListener('click', () => openProjectPhotoDialog(project.id));
    document.getElementById('photoStageFilter').onchange = event => { photoStageFilter = event.target.value; renderProjectPhotos(project); };
    document.querySelectorAll('[data-view-photo]').forEach(button => button.onclick = () => openPhotoViewer(all.find(item => item.id === button.dataset.viewPhoto)));
    document.querySelectorAll('[data-edit-photo]').forEach(button => button.onclick = () => openProjectPhotoDialog(project.id, button.dataset.editPhoto));
  }
