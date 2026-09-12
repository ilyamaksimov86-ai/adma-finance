/* @fragment 0505 */
  function canDeleteProjects() {
    return currentUser?.role === 'owner';
  }

  function openProjectDeleteDialog() {
    if (!canDeleteProjects() || !editingProjectId) return;
    const project = state.projects.find(x => x.id === editingProjectId);
    if (!project) return;
    projectDeleteDlg.dataset.projectId = project.id;
    projectDeleteExpectedName.textContent = project.name;
    projectDeleteName.value = '';
    projectDeleteError.textContent = '';
    confirmProjectDelete.disabled = true;
    projectDeleteDlg.showModal();
  }

  function removeDeletedProjectFromState(projectId) {
    const actIds = new Set((state.acts || []).filter(x => x.projectId === projectId).map(x => x.id));
    const waybillIds = new Set((state.waybills || []).filter(x => x.projectId === projectId).map(x => x.id));
    state.projects = (state.projects || []).filter(x => x.id !== projectId);
    for (const key of ['stages','expenses','acts','waybills','masterAssignments','projectDocuments','projectTasks','projectPhotos']) state[key] = (state[key] || []).filter(x => x.projectId !== projectId);
    state.actCosts = (state.actCosts || []).filter(x => !actIds.has(x.actId));
    state.actPayments = (state.actPayments || []).filter(x => !actIds.has(x.actId));
    state.waybillPayments = (state.waybillPayments || []).filter(x => !waybillIds.has(x.waybillId));
    state.projectResponsibles = (state.projectResponsibles || []).filter(x => x.project_id !== projectId);
    state.leads = (state.leads || []).map(x => x.projectId === projectId ? {...x, projectId: ''} : x);
  }

  function installProjectDeleteHandlers() {
    projectDeleteDanger.onclick = openProjectDeleteDialog;
    cancelProjectDelete.onclick = () => projectDeleteDlg.close();
    projectDeleteName.oninput = () => {
      confirmProjectDelete.disabled = projectDeleteName.value !== projectDeleteExpectedName.textContent;
      projectDeleteError.textContent = '';
    };
    projectDeleteForm.onsubmit = async ev => {
      ev.preventDefault();
      if (!cloudReady || !canDeleteProjects() || confirmProjectDelete.disabled) return;
      const projectId = projectDeleteDlg.dataset.projectId;
      const project = state.projects.find(x => x.id === projectId);
      if (!project || projectDeleteName.value !== project.name) return;
      const controls = [...projectDeleteForm.querySelectorAll('input,button')];
      controls.forEach(control => control.disabled = true);
      try {
        await api('delete_project', { project_id: projectId, confirmation: projectDeleteName.value });
        removeDeletedProjectFromState(projectId);
        editingProjectId = null;
        state.project = null;
        state.tab = 'projects';
        showArchivedProjects = false;
        projectDeleteDlg.close();
        projectDlg.close();
        save();render();
        banner('Объект удалён', 'ok');
      } catch (e) {
        projectDeleteError.textContent = 'Не удалось удалить объект: ' + e.message;
      } finally {
        controls.forEach(control => control.disabled = false);
        confirmProjectDelete.disabled = projectDeleteName.value !== projectDeleteExpectedName.textContent;
      }
    };
  }
