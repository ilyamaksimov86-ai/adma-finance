// Passwords are sent once over HTTPS; only revocable Supabase session tokens persist.
window.AdmaAuth = (() => {
  const key = 'adma.web.session';
  let request, telegramData = '', refreshing = null;
  const read = () => { try { return JSON.parse(localStorage.getItem(key)||'null'); } catch { return null; } };
  const store = session => { if(session)localStorage.setItem(key,JSON.stringify(session));else localStorage.removeItem(key); };
  async function refresh() {
    const session=read();
    if(!session?.refresh_token)throw new Error('session_required');
    if(session.expires_at > Date.now()/1000+90)return session.access_token;
    try {
      const data=await request('web-auth',{action:'refresh',refreshToken:session.refresh_token});
      store(data.session);return data.session.access_token;
    } catch(e) {if(['invalid_session','not_approved'].includes(e.message))store(null);throw e;}
  }
  return {
    init(post,initData) {request=post;telegramData=initData;},
    hasSession: () => !!read()?.refresh_token,
    async credentials() {
      if(telegramData)return {initData:telegramData};
      if(!refreshing) {
        refreshing=(navigator.locks ? navigator.locks.request('adma-session-refresh',refresh) : refresh()).finally(()=>{refreshing=null;});
      }
      return {accessToken:await refreshing};
    },
    async login(login,password) {
      const data=await request('web-auth',{action:'login',login,password});
      if(!data.session?.access_token)throw new Error('invalid_session');
      store(data.session);
    },
    async logout() {
      const session=read();
      try {if(session?.access_token)await request('web-auth',{action:'logout',accessToken:session.access_token});}
      finally {
        store(null);
        // Never show the preceding user's financial cache to the next user.
        for(const name of ['adma.projects','adma.expenses','adma.backup.projects','adma.backup.expenses'])localStorage.removeItem(name);
      }
    },
    forget: () => store(null),
  };
})();
window.addEventListener('storage',e=>{if(e.key==='adma.web.session'&&!e.newValue&&!window.Telegram?.WebApp?.initData)location.reload();});
