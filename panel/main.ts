import { agentState, choiceKey, defaultPokemon, type AgentRow, type Roster } from '../model.ts';
import { POKEMON, type Pokemon, type SpriteAnimation } from './sprites.ts';

interface FrameApi {
  host: { has(method: string): boolean; call(method: string, params: unknown): Promise<unknown> };
  plugin: { request(name: string, input?: unknown): Promise<unknown> };
  on(event: string, handler: (payload: unknown) => void): unknown;
  storage: { onDidChange(handler: (event: { key: string }) => void): unknown };
}

interface Companion {
  row: AgentRow;
  card: HTMLElement;
  title: HTMLElement;
  workspace: HTMLElement;
  status: HTMLElement;
  focus: HTMLButtonElement;
  signal: HTMLElement;
  select: HTMLSelectElement;
  sprite: HTMLElement;
  species: Pokemon;
  animation: Animation | null;
  saving: boolean;
  choiceRevision: number;
  storageKey: string;
  disposed: boolean;
}

declare const orca: FrameApi;

function element<T extends HTMLElement>(id: string): T {
  const node: HTMLElement | null = document.getElementById(id);
  if (!node) throw new Error(`Missing panel element: ${id}`);
  return node as T;
}

const list: HTMLElement = element('agents');
const errorBox: HTMLElement = element('error');
const summary: HTMLElement = element('summary');
const refreshButton: HTMLButtonElement = element('refresh');
const motionButton: HTMLButtonElement = element('motion');
const companions: Map<string, Companion> = new Map<string, Companion>();
const reducedMotion: MediaQueryList = matchMedia('(prefers-reduced-motion: reduce)');
const labels: Record<AgentRow['state'], string> = {
  working: 'Working', blocked: 'Needs you', waiting: 'Waiting', done: 'Done', unknown: 'Unknown'
};
let paused: boolean = reducedMotion.matches;
let refreshing: boolean = false;
let refreshAgain: boolean = false;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let statusRevision: number = 0;
let rosterStale: boolean = false;
let rosterError: string = '';
let operationError: string = '';
const statusUpdates: Map<string, { revision: number; state: AgentRow['state'] }> = new Map();

function showError(error: unknown): void {
  operationError = error instanceof Error ? error.message : String(error);
  paintError();
}

function paintError(): void {
  errorBox.textContent = [operationError, rosterError].filter(Boolean).join(' ');
  errorBox.hidden = !errorBox.textContent;
}

function animateSprite(companion: Companion): void {
  companion.animation?.cancel();
  companion.animation = null;
  if (companion.disposed) return;
  const state: AgentRow['state'] = companion.row.state;
  const sheet: SpriteAnimation = companion.species.animations[
    state === 'working' ? 'walk' : state === 'done' ? 'sleep' : 'idle'
  ];
  const scale: number = Math.min(2, 88 / sheet.width, 80 / sheet.height);
  const width: number = sheet.width * scale;
  const height: number = sheet.height * scale;
  const sprite: HTMLElement = companion.sprite;
  sprite.style.width = `${width}px`;
  sprite.style.height = `${height}px`;
  sprite.style.backgroundImage = `url("${sheet.path}")`;
  sprite.style.backgroundSize = `${width * sheet.columns}px auto`;
  sprite.style.backgroundPosition = `0px ${-sheet.row * height}px`;
  if (paused || state === 'unknown') return;
  const durations: number[] = sheet.durations.slice(0, sheet.columns);
  const total: number = durations.reduce((sum: number, duration: number): number => sum + duration, 0);
  const frames: Keyframe[] = [];
  let elapsed: number = 0;
  for (let index: number = 0; index < durations.length; index++) {
    frames.push({ backgroundPosition: `${-index * width}px ${-sheet.row * height}px`, offset: elapsed / total, easing: 'steps(1, end)' });
    elapsed += durations[index];
  }
  if (frames.length > 1) {
    frames.push({ ...frames[frames.length - 1], offset: 1 });
    companion.animation = sprite.animate(frames, { duration: total, iterations: Infinity });
  }
}

function updateMotion(): void {
  document.body.classList.toggle('paused', paused);
  motionButton.textContent = paused ? 'Resume motion' : 'Pause motion';
  motionButton.setAttribute('aria-pressed', String(paused));
  for (const companion of companions.values()) animateSprite(companion);
}

async function loadChoice(companion: Companion): Promise<void> {
  const revision: number = ++companion.choiceRevision;
  try {
    if (!companion.storageKey) companion.storageKey = await choiceKey(companion.row.id);
    if (companion.disposed) return;
    const result: { value: unknown } = await orca.host.call('storage.get', { key: companion.storageKey }) as { value: unknown };
    if (companion.disposed || revision !== companion.choiceRevision || companion.saving) return;
    const species: Pokemon | undefined = POKEMON.find((pokemon: Pokemon): boolean => pokemon.id === result.value);
    companion.species = species ?? POKEMON[defaultPokemon(companion.row.id, POKEMON.length)];
    companion.select.value = String(companion.species.id);
    animateSprite(companion);
  } catch (error: unknown) { if (!companion.disposed) showError(error); }
  finally { if (!companion.disposed && !companion.saving) companion.select.disabled = false; }
}

function createCompanion(row: AgentRow): Companion {
  const card: HTMLElement = document.createElement('article');
  card.className = 'agent-card';
  // This is constant markup. Agent names and all host data use textContent below.
  card.innerHTML = '<div class="card-top"><div class="identity"><h2></h2><p class="workspace"></p></div><span class="state"></span></div><button type="button" class="habitat"><span class="ground" aria-hidden="true"></span><span class="actor" aria-hidden="true"><span class="sprite"></span></span><span class="signal" aria-hidden="true"></span></button><div class="card-bottom"><label class="species-label">Companion</label><select></select></div>';
  const select: HTMLSelectElement = card.querySelector('select')!;
  const species: Pokemon = POKEMON[defaultPokemon(row.id, POKEMON.length)];
  for (const pokemon of POKEMON) {
    const option: HTMLOptionElement = document.createElement('option');
    option.value = String(pokemon.id);
    option.textContent = `${String(pokemon.id).padStart(3, '0')} · ${pokemon.name}`;
    select.append(option);
  }
  select.value = String(species.id);
  select.disabled = true;
  const companion: Companion = {
    row, card, select, species,
    title: card.querySelector('h2')!,
    workspace: card.querySelector('.workspace')!,
    status: card.querySelector('.state')!,
    focus: card.querySelector('button')!,
    signal: card.querySelector('.signal')!,
    sprite: card.querySelector('.sprite')!,
    animation: null, saving: false, choiceRevision: 0, storageKey: '', disposed: false
  };
  companion.focus.addEventListener('click', async (): Promise<void> => {
    companion.focus.disabled = true;
    try {
      await orca.plugin.request('focus', { id: companion.row.id });
      operationError = '';
      paintError();
    } catch (error: unknown) { showError(error); }
    finally { companion.focus.disabled = false; }
  });
  companion.focus.addEventListener('contextmenu', (event: MouseEvent): void => {
    event.preventDefault();
    select.focus();
  });
  select.addEventListener('change', async (): Promise<void> => {
    const next: Pokemon | undefined = POKEMON.find((pokemon: Pokemon): boolean => pokemon.id === Number(select.value));
    if (!next) return;
    companion.saving = true;
    companion.choiceRevision++;
    select.disabled = true;
    try {
      if (!companion.storageKey) companion.storageKey = await choiceKey(companion.row.id);
      await orca.host.call('storage.set', { key: companion.storageKey, value: next.id });
      if (companion.disposed) return;
      companion.species = next;
      animateSprite(companion);
      operationError = '';
      paintError();
    } catch (error: unknown) {
      select.value = String(companion.species.id);
      showError(error);
    } finally { companion.saving = false; select.disabled = false; }
  });
  list.append(card);
  void loadChoice(companion);
  return companion;
}

function paintCompanion(companion: Companion, row: AgentRow): void {
  const changed: boolean = companion.row.state !== row.state;
  companion.row = row;
  companion.card.dataset.state = row.state;
  companion.title.textContent = row.title;
  companion.workspace.textContent = `${row.workspace} · ${row.agent}`;
  companion.status.textContent = labels[row.state];
  companion.focus.setAttribute('aria-label', `Focus ${row.title} in ${row.workspace}`);
  companion.focus.title = `Focus ${row.title}`;
  companion.select.setAttribute('aria-label', `Pokémon for ${row.title} in ${row.workspace}`);
  companion.signal.textContent = row.state === 'blocked' ? '!' : row.state === 'done' ? 'z z' : row.state === 'waiting' ? '…' : '';
  if (changed || !companion.sprite.style.backgroundImage) animateSprite(companion);
}

function updateSummary(): void {
  const blocked: number = [...companions.values()].filter((companion: Companion): boolean => companion.row.state === 'blocked').length;
  summary.textContent = `${companions.size} companion${companions.size === 1 ? '' : 's'}${rosterStale ? ' · stale' : blocked ? ` · ${blocked} need${blocked === 1 ? 's' : ''} you` : ' · live'}`;
}

async function refresh(): Promise<void> {
  if (refreshing) { refreshAgain = true; return; }
  refreshing = true;
  refreshButton.disabled = true;
  const queryRevision: number = statusRevision;
  try {
    const roster: Roster = await orca.plugin.request('roster') as Roster;
    const ids: Set<string> = new Set<string>(roster.agents.map((row: AgentRow): string => row.id));
    for (const [id, companion] of companions) {
      if (ids.has(id)) continue;
      companion.disposed = true;
      companion.choiceRevision++;
      companion.animation?.cancel();
      companion.card.remove();
      companions.delete(id);
    }
    for (const row of roster.agents) {
      let companion: Companion | undefined = companions.get(row.id);
      if (!companion) { companion = createCompanion(row); companions.set(row.id, companion); }
      const update: { revision: number; state: AgentRow['state'] } | undefined = statusUpdates.get(row.paneKey);
      paintCompanion(companion, update && update.revision > queryRevision ? { ...row, state: update.state } : row);
    }
    for (const [key, update] of statusUpdates) if (update.revision <= queryRevision) statusUpdates.delete(key);
    element('empty').hidden = companions.size !== 0;
    element('partial').hidden = !roster.partial;
    rosterStale = false;
    rosterError = '';
    paintError();
    updateSummary();
  } catch (error: unknown) {
    rosterStale = true;
    rosterError = error instanceof Error ? error.message : String(error);
    paintError();
    summary.textContent = companions.size ? `${companions.size} companions · stale` : 'Roster unavailable';
  } finally {
    refreshing = false;
    refreshButton.disabled = false;
    if (refreshAgain) { refreshAgain = false; scheduleRefresh(); }
  }
}

function scheduleRefresh(): void {
  if (refreshTimer !== undefined) return;
  refreshTimer = setTimeout((): void => { refreshTimer = undefined; void refresh(); }, 200);
}

function statusChanged(payload: unknown): void {
  if (payload === null || typeof payload !== 'object') return;
  const event: { paneKey?: unknown; state?: unknown } = payload as { paneKey?: unknown; state?: unknown };
  if (typeof event.paneKey !== 'string') return;
  statusUpdates.set(event.paneKey, { revision: ++statusRevision, state: agentState(event.state) });
  for (const companion of companions.values()) {
    if (companion.row.paneKey !== event.paneKey) continue;
    paintCompanion(companion, { ...companion.row, state: agentState(event.state) });
  }
  updateSummary();
  scheduleRefresh();
}

async function start(): Promise<void> {
  updateMotion();
  refreshButton.addEventListener('click', (): void => { void refresh(); });
  motionButton.addEventListener('click', (): void => { paused = !paused; updateMotion(); });
  reducedMotion.addEventListener('change', (): void => { paused = reducedMotion.matches; updateMotion(); });
  if (typeof orca === 'undefined') { showError('Open this panel inside Orca after approving its permissions.'); return; }
  for (const method of ['agents.list', 'events.subscribe', 'plugin.request', 'storage.get', 'storage.set']) {
    if (!orca.host.has(method)) { showError(`This Orca does not support ${method}. Update Orca to 1.4.250 or newer.`); return; }
  }
  orca.on('agent.status.changed', statusChanged);
  orca.on('workspace.changed', scheduleRefresh);
  orca.on('workspace.created', scheduleRefresh);
  orca.on('workspace.removed', scheduleRefresh);
  orca.storage.onDidChange((event: { key: string }): void => {
    for (const companion of companions.values()) {
      if (companion.storageKey === event.key && !companion.saving) void loadChoice(companion);
    }
  });
  document.addEventListener('visibilitychange', (): void => { if (!document.hidden) scheduleRefresh(); });
  await refresh();
}

void start().catch(showError);
