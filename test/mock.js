// Test fixture only. Does not grant permissions or call a real Orca API.
const stored = new Map(JSON.parse(sessionStorage.getItem('pokemon-preview-storage') ?? '[]'));
const listeners = new Map();
const storageListeners = [];
const audioListeners = new Map();
window.fixture = {
  calls: [],
  failStorage: false,
  failAutoRead: new URL(location.href).searchParams.has('fail-auto-read'),
  deferAutoRead: new URL(location.href).searchParams.has('defer-auto-read'),
  resolveAutoRead: null,
  notifyStorage(key) { for (const listener of storageListeners) listener({ key }); },
  failRoster: false,
  failAudioStart: false,
  audio: { state: 'off', message: 'Off · Spotify is not playing.', session: null },
  agents: ['working', 'blocked', 'waiting', 'done'].map((state, index) => ({
    id: `fixture-${index}`, workspaceId: 'fixture-workspace', workspace: 'Companion lab',
    paneKey: `tab:${index}`, title: ['Implement auth', 'Review changes', 'Plan migration', 'Write tests'][index],
    agent: ['Claude', 'Codex', 'OpenCode', 'Claude'][index], state
  })),
  emit(event, payload) { for (const listener of listeners.get(event) ?? []) listener(payload); },
  post(event, payload) {
    if (event === 'audio.status') window.fixture.audio = { ...payload };
    for (const listener of audioListeners.get(event) ?? []) listener(payload);
  }
};
window.orca = {
  host: {
    has: () => true,
    async call(method, params) {
      window.fixture.calls.push({ method, params });
      if (method === 'storage.get') {
        if (params.key === 'audio.autostart.v1' && window.fixture.failAutoRead) throw new Error('Fixture preference read failure');
        if (params.key === 'audio.autostart.v1' && window.fixture.deferAutoRead) {
          return new Promise(resolve => { window.fixture.resolveAutoRead = resolve; });
        }
        return { value: stored.get(params.key) ?? null };
      }
      if (method === 'storage.set') {
        if (window.fixture.failStorage) throw new Error('Fixture storage failure');
        stored.set(params.key, params.value);
        sessionStorage.setItem('pokemon-preview-storage', JSON.stringify([...stored]));
        for (const listener of storageListeners) listener({ key: params.key });
        return { ok: true };
      }
      throw new Error(`Unexpected fixture call: ${method}`);
    }
  },
  plugin: {
    on(event, handler) {
      audioListeners.set(event, [...audioListeners.get(event) ?? [], handler]);
      return { dispose() { audioListeners.set(event, audioListeners.get(event).filter(listener => listener !== handler)); } };
    },
    async request(name, input) {
      window.fixture.calls.push({ name, input });
      if (name === 'roster') {
        if (window.fixture.failRoster) throw new Error('Fixture roster failure');
        return { agents: window.fixture.agents.map(agent => ({ ...agent })), partial: false };
      }
      if (name === 'focus') return { focused: true };
      if (name === 'audio.status' || name === 'audio.heartbeat') return { ...window.fixture.audio };
      if (name === 'audio.start') {
        if (window.fixture.failAudioStart) throw new Error('Fixture audio permission denied');
        window.fixture.audio = { state: 'starting', message: 'Starting Spotify capture…', session: input.session };
        return { ...window.fixture.audio };
      }
      if (name === 'audio.stop') {
        if (window.fixture.audio.session === input.session) window.fixture.post('audio.status', { state: 'off', message: 'Off · Spotify is not playing.', session: null });
        return { ...window.fixture.audio };
      }
      throw new Error(`Unexpected fixture request: ${name}`);
    }
  },
  on(event, handler) { listeners.set(event, [...listeners.get(event) ?? [], handler]); },
  storage: { onDidChange(handler) { storageListeners.push(handler); } }
};
