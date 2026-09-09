/* @fragment 0278 */
  async function loadCloud() {
    const data = await api('load');
    state.projects = (data.projects || []).map(mapProject);
    state.expenses = (data.expenses || []).map(mapExpense);
    state.stages = (data.stages || []).map(mapStage);
    const modules=[['Финансы','finance'],['Команда','masters'],['Задачи и файлы','operations'],['Дизайнеры','designers'],['Заявки','leads'],['База знаний','knowledge']];
    const results=await Promise.allSettled(modules.map(([,name])=>ensureModule(name,true)));
    dashboardLoadErrors=results.flatMap((result,index)=>result.status==='rejected'?[modules[index][0]]:[]);
    save();
    render();
    if(dashboardLoadErrors.length)banner(`Не загрузились: ${dashboardLoadErrors.join(', ')}. Остальные данные доступны.`,'error');
    return data;
  }


/* @fragment 1414 */
  function renderFutureModuleCloud(tab) {
    const modules = {
      leads: ['◇', 'Заявки', 'Базовый экран и маршрут готовы. Воронка и превращение заявки в объект будут реализованы на отдельном этапе.', 'Дизайнер → Заявка → Объект'],
      designers: ['✦', 'Дизайнеры', 'Базовый экран CRM готов. Контакты, воронка и история взаимодействий появятся на отдельном этапе.', 'Дизайнер → Заявки / Объекты'],
      masters: ['◎', 'Мастера', 'Базовый экран общей базы готов. Специализации, занятость и назначения появятся на отдельном этапе.', 'Мастер → Объект / Этап'],
    };
    const [icon, title, description, relation] = modules[tab];
    $('#app').innerHTML = `${pageHeader(`ADMA · ${title.toUpperCase()}`, title, 'Раздел встроен в единую структуру приложения')}${moduleScreen(icon, title, description, relation)}`;
  }


/* @fragment 1488 */
  function renderFallbackCloud() {
    const moduleByTab={finance:'finance',masters:'masters',designers:'designers',leads:'leads',knowledge:'knowledge'};
    const moduleName=moduleByTab[state.tab];
    if(moduleName&&moduleState[moduleName].status!=='loaded'){
      const entry=moduleState[moduleName];
      $('#app').innerHTML=`${pageHeader('ADMA',globalTabLabels[state.tab]||'Раздел','Загрузка данных')}<div class="card empty">${entry.status==='error'?'Не удалось загрузить раздел. Повторите попытку.':'Загружаем данные…'}${entry.status==='error'?`<br><button class="btn secondary" id="retryModule">Повторить</button>`:''}</div>`;
      const retry=document.getElementById('retryModule');if(retry)retry.onclick=()=>ensureModule(moduleName,true).catch(()=>{});
      if(entry.status==='idle')ensureModule(moduleName).catch(()=>{});
      return;
    }
    if (state.tab === 'finance') return renderGlobalFinanceCloud();
    if (state.tab === 'masters') return renderMastersCloud();
    if (state.tab === 'designers') return renderDesignersCloud();
    if (state.tab === 'leads') return renderLeadsCloudHotfix();
    if (state.tab === 'knowledge') return renderKnowledgeCloudHotfix();
    return renderMoreCloud();
  }

  function renderMoreCloud() {
    const role = currentUser?.role || 'foreman';
    const name = [currentUser?.first_name, currentUser?.last_name].filter(Boolean).join(' ');
    $('#app').innerHTML = `${pageHeader('ADMA · ПРОФИЛЬ', 'Ещё', 'Разделы приложения и настройки доступа')}<div class="mobile-module-links"><button class="card mobile-module-link" data-mobile-route="leads"><span>◇</span><strong>Заявки</strong><small>Воронка обращений</small></button><button class="card mobile-module-link" data-mobile-route="designers"><span>✦</span><strong>Дизайнеры</strong><small>Партнёрская CRM</small></button><button class="card mobile-module-link" data-mobile-route="masters"><span>◎</span><strong>Мастера</strong><small>Команда и занятость</small></button><button class="card mobile-module-link" data-mobile-route="knowledge"><span>▤</span><strong>База знаний</strong><small>Техкарты и косяки</small></button></div><div class="card"><strong>Облачная синхронизация включена</strong><p class="muted">Объекты, расходы и чеки хранятся в защищённом облаке Supabase и доступны на ваших устройствах.</p></div>
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
    installProjectHandlers();
    installFinanceHandlers();
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
      state.project = null;
      // Web accounts never auto-import another user's local cache.
      save();
      cloudReady = true;
      installCloudHandlers();
      delete document.body.dataset.locked;
      applyHashRoute();
      render();
      banner('Облако подключено · ' + roleLabel(currentUser.role), 'ok');
      const background=['finance','masters','operations','designers','leads','knowledge'];
      Promise.allSettled(background.map(name=>ensureModule(name))).then(results=>{
        dashboardLoadErrors=results.flatMap((result,index)=>result.status==='rejected'?[globalTabLabels[background[index]]||background[index]]:[]);
        if(dashboardLoadErrors.length)banner(`Не загрузились: ${dashboardLoadErrors.join(', ')}. Остальные данные доступны.`,'error');
      });
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
