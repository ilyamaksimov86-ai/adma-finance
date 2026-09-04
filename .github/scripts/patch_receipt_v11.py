from pathlib import Path
import re

p = Path('cloud.js')
s = p.read_text()

marker = "  let receiptUploadTicket = null;\n"
insert = """  let selectedReceiptBlob = null;
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
"""
if insert not in s:
    if marker not in s:
        raise SystemExit('receipt marker not found')
    s = s.replace(marker, marker + insert, 1)

start = s.index("  async function attachNewReceipt(payload) {")
end = s.index("  function installCloudHandlers", start)
new_attach = """  async function attachNewReceipt(payload) {
    if (!selectedReceiptBlob) return payload;
    const form = new FormData();
    form.append('initData', initData);
    form.append('file', selectedReceiptBlob, selectedReceiptBlob.name || 'receipt.jpg');
    banner('Загружаю чек в облако…');
    let res;
    try {
      res = await fetch(SUPABASE_FUNCTIONS + '/receipt-upload', { method: 'POST', body: form });
    } catch (e) {
      throw new Error('Не удалось отправить фото. Попробуй другой снимок или скриншот.');
    }
    let data = {};
    try { data = await res.json(); } catch {}
    if (!res.ok) {
      const message = data.error === 'receipt_too_large' ? 'Фото слишком большое. Выбери скриншот или другое фото.'
        : data.error === 'image_required' ? 'Этот формат изображения не поддерживается. Сделай скриншот чека.'
        : (data.error || ('upload_HTTP_' + res.status));
      throw new Error(message);
    }
    if (!data.path) throw new Error('Сервер не вернул путь к чеку');
    payload.receipt_path = data.path;
    return payload;
  }

"""
s = s[:start] + new_attach + s[end:]

install_marker = "  function installCloudHandlers() {\n"
install_code = """  function installCloudHandlers() {
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
"""
if install_marker not in s:
    raise SystemExit('install marker not found')
s = s.replace(install_marker, install_code, 1)

old_success = "        editingExpenseId = null;\n        state.receipt = null;\n        expenseDlg.close();"
new_success = "        editingExpenseId = null;\n        state.receipt = null;\n        clearSelectedReceipt();\n        expenseDlg.close();"
if old_success in s:
    s = s.replace(old_success, new_success, 1)

old_del = "      const delBtn = document.getElementById('del');\n"
new_del = """      const delBtn = document.getElementById('del');
      if (delBtn) {
        delBtn.textContent = 'Удалить расход';
        const actions = delBtn.parentElement;
        if (actions) actions.style.flexWrap = 'wrap';
        delBtn.style.flex = '1 0 100%';
        delBtn.style.width = '100%';
        delBtn.style.marginTop = '2px';
      }
"""
if old_del not in s:
    raise SystemExit('delete marker not found')
s = s.replace(old_del, new_del, 1)

p.write_text(s)

i = Path('index.html')
h = i.read_text()
h, n = re.subn(r'cloud\.js\?v=\d+', 'cloud.js?v=11', h, count=1)
if n != 1:
    raise SystemExit('cloud version not found')
i.write_text(h)
