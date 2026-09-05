export class AuthError extends Error {
  constructor(message, status = 401) { super(message); this.status = status; }
}
const hex = bytes => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
async function hmac(key, text) {
  const k = await crypto.subtle.importKey('raw', key, {name:'HMAC',hash:'SHA-256'}, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, new TextEncoder().encode(text));
}
export async function verifyTelegram(initData, botToken) {
  if (!botToken) throw new AuthError('server_not_configured',503);
  const p = new URLSearchParams(initData), hash = p.get('hash');
  if (!hash) throw new AuthError('missing_hash');
  p.delete('hash');
  const check = [...p.entries()].sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([k,v])=>`${k}=${v}`).join('\n');
  const secret = await hmac(new TextEncoder().encode('WebAppData'), botToken);
  const calculated = hex(await hmac(secret, check));
  let diff = calculated.length ^ hash.length;
  for (let i=0;i<calculated.length;i++) diff |= calculated.charCodeAt(i) ^ (hash.charCodeAt(i)||0);
  if (diff) throw new AuthError('bad_signature');
  const now = Math.floor(Date.now()/1000), date = Number(p.get('auth_date')||0);
  if (!date || date > now+60 || now-date > 86400) throw new AuthError('expired_init_data');
  let user;
  try { user = JSON.parse(p.get('user')||'null'); } catch { throw new AuthError('missing_user'); }
  if (!Number.isSafeInteger(user?.id)) throw new AuthError('missing_user');
  return user;
}
export async function requireUser(db, credentials, botToken) {
  let field, id;
  if (credentials.accessToken) {
    // Never trust a decoded JWT or editable user_metadata for app identity/role.
    const {data,error} = await db.auth.getUser(String(credentials.accessToken));
    if (error || !data?.user) throw new AuthError('invalid_session');
    field = 'id'; id = data.user.id;
  } else {
    const tg = await verifyTelegram(String(credentials.initData||''), botToken);
    field = 'telegram_user_id'; id = tg.id;
  }
  const {data:user,error} = await db.from('app_users').select('*').eq(field,id).maybeSingle();
  if (error) throw error;
  if (!user) throw new AuthError('not_registered',403);
  if (!user.is_active) throw new AuthError('not_approved',403);
  return user;
}
export const credentialsFromForm = form => ({initData:String(form.get('initData')||''),accessToken:String(form.get('accessToken')||'')});
