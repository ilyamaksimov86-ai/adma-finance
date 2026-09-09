/* @fragment 0002 */
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
  let projectSection = 'overview';
  let projectFinanceSection = 'summary';
  const globalTabs = new Set(['home', 'projects', 'finance', 'leads', 'designers', 'masters', 'knowledge', 'more']);
  const globalTabLabels = {
    home: 'Главная', projects: 'Объекты', finance: 'Финансы',
    leads: 'Заявки', designers: 'Дизайнеры', masters: 'Мастера', knowledge: 'База знаний', more: 'Ещё',
  };
  const projectStatuses = {
    active: 'В работе', preparation: 'Подготовка', in_progress: 'В работе',
    paused: 'Приостановлен', handover: 'Сдача', warranty: 'Гарантия', archived: 'Архив',
  };
  const projectSections = [
    ['overview', 'Обзор'], ['schedule', 'График'], ['finance', 'Финансы'],
    ['team', 'Команда'], ['documents', 'Документы'], ['tasks', 'Задачи'], ['photos', 'Фото'],
  ];
  const projectFinanceSections = [
    ['summary', 'Сводка'], ['acts', 'Акты'], ['waybills', 'Накладные'], ['checks', 'Чеки / Разное'],
  ];
  const stageStatuses = {
    planned: 'Запланирован', in_progress: 'В работе', completed: 'Выполнен',
    delayed: 'Задерживается', paused: 'Приостановлен',
  };

  const optionalValue = value => String(value || '').trim() || null;
  const projectStatusLabel = status => projectStatuses[status] || projectStatuses.active;
  const projectStatusClass = status => ['paused'].includes(status) ? 'pending' : ['archived'].includes(status) ? 'neutral' : 'paid';
  const projectDate = value => value ? fmt(value) : 'Не указана';

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

  AdmaAuth.init(post, initData);
  async function api(action, extra = {}) {
    return post('adma-api', { ...await AdmaAuth.credentials(), action, ...extra });
  }

  async function financeApi(action, extra = {}) {
    return post('finance-api', { ...await AdmaAuth.credentials(), action, ...extra });
  }

  async function mastersApi(action, extra = {}) {
    return post('masters-api', { ...await AdmaAuth.credentials(), action, ...extra });
  }

  async function operationsApi(action, extra = {}) {
    return post('project-operations-api', { ...await AdmaAuth.credentials(), action, ...extra });
  }

  async function designersApi(action, extra = {}) {
    return post('designers-api', { ...await AdmaAuth.credentials(), action, ...extra });
  }

  async function leadsApi(action, extra = {}) {
    return post('leads-api', { ...await AdmaAuth.credentials(), action, ...extra });
  }

  async function knowledgeApi(action, extra = {}) {
    return post('knowledge-api', { ...await AdmaAuth.credentials(), action, ...extra });
  }

  function mapProject(p) {
    return {
      id: p.id,
      name: p.name,
      address: p.address || '',
      client: p.client_name || '',
      comment: p.comment || '',
      status: p.status || 'active',
      area: p.area_sqm == null ? null : Number(p.area_sqm),
      clientPhone: p.client_phone || '',
      startDate: p.start_date || '',
      plannedEndDate: p.planned_end_date || '',
      actualEndDate: p.actual_end_date || '',
      contractNumber: p.contract_number || '',
      warrantyUntil: p.warranty_until || '',
      designerId: p.designer_id || '',
    };
  }

  function mapStage(s) {
    return {
      id: s.id, projectId: s.project_id, name: s.name, position: Number(s.position || 0),
      plannedStart: s.planned_start || '', plannedEnd: s.planned_end || '',
      actualStart: s.actual_start || '', actualEnd: s.actual_end || '',
      progress: Number(s.progress || 0), status: s.status || 'planned',
      responsibleUserId: s.responsible_user_id || '', workCost: s.work_cost == null ? null : Number(s.work_cost),
      comment: s.comment || '', createdAt: s.created_at || '',
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
      author: e.author ? ([e.author.first_name,e.author.last_name].filter(Boolean).join(' ') || e.author.web_login || e.author.telegram_username || 'ADMA') : 'ADMA',
    };
  }

  const numeric = value => Number(value || 0);
  const mapAct = a => ({...a, projectId:a.project_id, stageId:a.stage_id||'', date:a.act_date, amount:numeric(a.amount), filePath:a.file_path||'', fileUrl:a.file_url||''});
  const mapActCost = x => ({...x, actId:x.act_id, date:x.cost_date, amount:numeric(x.amount)});
  const mapActPayment = x => ({...x, actId:x.act_id, date:x.payment_date, amount:numeric(x.amount)});
  const mapWaybill = w => ({...w, projectId:w.project_id, date:w.waybill_date, amount:numeric(w.amount), filePath:w.file_path||'', fileUrl:w.file_url||''});
  const mapWaybillPayment = x => ({...x, waybillId:x.waybill_id, date:x.payment_date, amount:numeric(x.amount)});
  const mapCompanyExpense = x => ({...x, date:x.expense_date, amount:numeric(x.amount), filePath:x.file_path||'', fileUrl:x.file_url||'', authorName:x.author?([x.author.first_name,x.author.last_name].filter(Boolean).join(' ')||x.author.web_login||x.author.telegram_username||'ADMA'):'ADMA'});
  const mapMaster = x => ({...x, primarySpecialty:x.primary_specialty||'other', additionalSkills:Array.isArray(x.additional_skills)?x.additional_skills:[], priceLevel:x.price_level||'', isActive:x.is_active!==false});
  const mapMasterAssignment = x => ({...x, masterId:x.master_id, projectId:x.project_id, stageId:x.stage_id||'', startDate:x.start_date, plannedEndDate:x.planned_end_date||'', actualEndDate:x.actual_end_date||''});
  const authorName=x=>x?.author?([x.author.first_name,x.author.last_name].filter(Boolean).join(' ')||x.author.web_login||x.author.telegram_username||'ADMA'):'ADMA';
  const mapProjectDocument=x=>({...x,projectId:x.project_id,filePath:x.storage_path,fileUrl:x.file_url||'',documentDate:x.document_date||'',createdAt:x.created_at,authorName:authorName(x)});
  const mapProjectTask=x=>({...x,projectId:x.project_id,stageId:x.stage_id||'',actId:x.act_id||'',waybillId:x.waybill_id||'',assigneeUserId:x.assignee_user_id||'',assigneeMasterId:x.assignee_master_id||'',createdAt:x.created_at,authorName:authorName(x)});
  const mapProjectPhoto=x=>({...x,projectId:x.project_id,stageId:x.stage_id||'',filePath:x.storage_path,fileUrl:x.file_url||'',shotDate:x.shot_date||'',createdAt:x.created_at,authorName:authorName(x)});
  const mapDesigner=x=>({...x,fullName:x.full_name, responsibleUserId:x.responsible_user_id||'', lastContactAt:x.last_contact_at||'', nextContactAt:x.next_contact_at||'', nextAction:x.next_action||'', portfolioUrl:x.portfolio_url||'', isArchived:!!x.is_archived});
  const mapDesignerInteraction=x=>({...x,designerId:x.designer_id,occurredAt:x.occurred_at,type:x.interaction_type,authorName:authorName(x)});
  const mapLead=x=>({...x,clientName:x.client_name,projectName:x.project_name,area:x.area_sqm==null?null:Number(x.area_sqm),budget:x.estimated_budget==null?null:Number(x.estimated_budget),hasDesignProject:x.has_design_project,designProjectUrl:x.design_project_url||'',desiredStartDate:x.desired_start_date||'',designerId:x.designer_id||'',responsibleUserId:x.responsible_user_id||'',lastContactAt:x.last_contact_at||'',nextContactAt:x.next_contact_at||'',nextAction:x.next_action||'',lossReason:x.loss_reason||'',lossComment:x.loss_comment||'',projectId:x.project_id||'',createdAt:x.created_at});
  const mapLeadInteraction=x=>({...x,leadId:x.lead_id,occurredAt:x.occurred_at,type:x.interaction_type,authorName:authorName(x)});
  const mapKnowledgeTechCard=x=>({...x,createdAt:x.created_at,updatedAt:x.updated_at,authorName:authorName(x)});
  const mapKnowledgeChecklistItem=x=>({...x,techCardId:x.tech_card_id,text:x.item_text,position:Number(x.position||0)});
  const mapKnowledgeIssue=x=>({...x,createdAt:x.created_at,updatedAt:x.updated_at,authorName:authorName(x)});
  const mapKnowledgeAttachment=x=>({...x,techCardId:x.tech_card_id||'',issueId:x.issue_id||'',filePath:x.storage_path,fileUrl:x.file_url||'',createdAt:x.created_at,authorName:authorName(x)});
