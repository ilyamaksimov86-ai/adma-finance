/* @fragment 0200 */
  const moduleState = Object.fromEntries(['finance','masters','operations','designers','leads','knowledge'].map(name => [name, { status: 'idle', promise: null, error: null }]));

  function moduleLoader(name) {
    return ({ finance: loadFinanceCloud, masters: loadMastersCloud, operations: loadProjectOperationsCloud, designers: loadDesignersCloud, leads: loadLeadsCloud, knowledge: loadKnowledgeCloud })[name];
  }

  function ensureModule(name, force = false) {
    const entry = moduleState[name];
    if (!entry) return Promise.reject(new Error('unknown_module'));
    if (!force && entry.status === 'loaded') return Promise.resolve();
    if (entry.status === 'loading' && entry.promise) return entry.promise;
    entry.status = 'loading';
    entry.error = null;
    entry.promise = Promise.resolve().then(() => moduleLoader(name)()).then(() => {
      entry.status = 'loaded';
      entry.promise = null;
      if (cloudReady) render();
    }).catch(error => {
      entry.status = 'error';
      entry.error = error;
      entry.promise = null;
      if (cloudReady) render();
      throw error;
    });
    return entry.promise;
  }

  function patchMapped(listName, raw, mapper) {
    const mapped = mapper(raw);
    const list = state[listName] || (state[listName] = []);
    const index = list.findIndex(item => item.id === mapped.id);
    if (index < 0) list.push(mapped); else list[index] = mapped;
    return mapped;
  }

  function removeFromState(listName, id) {
    state[listName] = (state[listName] || []).filter(item => item.id !== id);
  }
