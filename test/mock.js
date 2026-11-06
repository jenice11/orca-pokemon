// Test fixture only. Does not grant permissions or call a real Orca API.
const stored = new Map();
const listeners = new Map();
const storageListeners = [];
window.fixture = {
  calls: [],
  failStorage: false,
  failRoster: false,
  agents: ['working', 'blocked', 'waiting', 'done'].map((state, index) => ({
    id: `fixture-${index}`, workspaceId: 'fixture-workspace', workspace: 'Companion lab',
    paneKey: `tab:${index}`, title: ['Implement auth', 'Review changes', 'Plan migration', 'Write tests'][index],
    agent: ['Claude', 'Codex', 'OpenCode', 'Claude'][index], state
  })),
  emit(event, payload) { for (const listener of listeners.get(event) ?? []) listener(payload); }
};
window.orca = {
  host: {
    has: () => true,
    async call(method, params) {
      window.fixture.calls.push({ method, params });
      if (method === 'storage.get') return { value: stored.get(params.key) ?? null };
      if (method === 'storage.set') {
        if (window.fixture.failStorage) throw new Error('Fixture storage failure');
        stored.set(params.key, params.value);
        for (const listener of storageListeners) listener({ key: params.key });
        return { ok: true };
      }
      throw new Error(`Unexpected fixture call: ${method}`);
    }
  },
  plugin: {
    async request(name, input) {
      window.fixture.calls.push({ name, input });
      if (name === 'roster') {
        if (window.fixture.failRoster) throw new Error('Fixture roster failure');
        return { agents: window.fixture.agents.map(agent => ({ ...agent })), partial: false };
      }
      if (name === 'focus') return { focused: true };
      throw new Error(`Unexpected fixture request: ${name}`);
    }
  },
  on(event, handler) { listeners.set(event, [...listeners.get(event) ?? [], handler]); },
  storage: { onDidChange(handler) { storageListeners.push(handler); } }
};
