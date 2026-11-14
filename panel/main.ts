import { agentState, choiceKey, defaultPokemon, type AgentRow, type Roster } from '../model.ts';
import { POKEMON, type Pokemon, type SpriteAnimation } from './sprites.ts';
import { setupAudioVisualizer, type AudioBridge, type AudioVisualizer } from './audio.ts';
import { updateAudioTheme } from './audio-theme.ts';
import { moveOrder, orderedIds, parseOrder, reconcileOrder, type OrderItem, type SortMode } from './order.ts';

interface FrameApi {
  host: { has(method: string): boolean; call(method: string, params: unknown): Promise<unknown> };
  plugin: AudioBridge;
  on(event: string, handler: (payload: unknown) => void): unknown;
  storage: { onDidChange(handler: (event: { key: string }) => void): unknown };
}

interface Companion {
  row: AgentRow;
  card: HTMLElement;
  title: HTMLElement;
  agentBadge: HTMLButtonElement;
  status: HTMLElement;
  focus: HTMLButtonElement;
  signal: HTMLElement;
  select: HTMLButtonElement;
  grip: HTMLButtonElement;
  sprite: HTMLElement;
  species: Pokemon;
  animation: Animation | null;
  saving: boolean;
  choiceRevision: number;
  storageKey: string;
  disposed: boolean;
}

interface ProjectGroup {
  id: string;
  name: string;
  storageKey: string;
  section: HTMLElement;
  list: HTMLElement;
  title: HTMLElement;
  count: HTMLElement;
  toggle: HTMLButtonElement;
  grip: HTMLButtonElement;
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
const sortSelect: HTMLSelectElement = element('agent-sort');
const orderAnnouncement: HTMLElement = element('order-announcement');
const workspaceTooltip: HTMLElement = element('workspace-tooltip');
const workspaceTooltipText: HTMLElement = element('workspace-tooltip-text');
const speciesPanel: HTMLElement = element('species-panel');
const speciesSearch: HTMLInputElement = element('species-search');
const speciesResults: HTMLElement = element('species-results');
const speciesEmpty: HTMLElement = element('species-empty');
let speciesOwner: Companion | undefined;
let speciesMatches: Pokemon[] = [];
let speciesIndex: number = 0;
const orderKey: string = 'cards.order.v1';
const projectOrderKey: string = 'projects.order.v1';
const companions: Map<string, Companion> = new Map<string, Companion>();
const projects: Map<string, ProjectGroup> = new Map();
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
let orderError: string = '';
let orderLoadError: string = '';
let manualOrder: string[] = [];
let projectOrder: string[] = [];
let orderLoaded: boolean = false;
let cardOrderWritable: boolean = false;
let projectOrderWritable: boolean = false;
let orderRevision: number = 0;
let orderSaving: boolean = false;
let orderSavePending: boolean = false;
let orderDirty: boolean = false;
let orderReloadPending: boolean = false;
let sortMode: SortMode = 'manual';
let sortRequested: boolean = false;
let dragged: Companion | undefined;
let draggedProject: ProjectGroup | undefined;
let tooltipOwner: Companion | undefined;
let tooltipDelay: ReturnType<typeof setTimeout> | undefined;
let audioVisualizer: AudioVisualizer | undefined;
const statusUpdates: Map<string, { revision: number; state: AgentRow['state'] }> = new Map();

function showError(error: unknown): void {
  operationError = error instanceof Error ? error.message : String(error);
  paintError();
}

function closeSpecies(restore: boolean = false): void {
  const owner: Companion | undefined = speciesOwner;
  speciesOwner = undefined;
  owner?.select.setAttribute('aria-expanded', 'false');
  if (speciesPanel.matches(':popover-open')) speciesPanel.hidePopover();
  if (restore && owner && !owner.disposed && !owner.card.closest('[hidden]')) owner.select.focus({ preventScroll: true });
}

function renderSpecies(): void {
  const owner: Companion | undefined = speciesOwner;
  if (!owner) return;
  const optionFocused: boolean = speciesResults.contains(document.activeElement);
  speciesMatches = POKEMON.filter((pokemon: Pokemon): boolean => pokemon.name.toLowerCase().includes(speciesSearch.value.trim().toLowerCase()));
  speciesIndex = Math.max(0, Math.min(speciesIndex, speciesMatches.length - 1));
  speciesResults.replaceChildren();
  speciesMatches.forEach((pokemon: Pokemon, index: number): void => {
    const option: HTMLButtonElement = document.createElement('button');
    option.type = 'button';
    option.id = `species-option-${pokemon.id}`;
    option.role = 'option';
    option.tabIndex = -1;
    option.setAttribute('aria-selected', String(pokemon.id === owner.species.id));
    option.setAttribute('aria-disabled', String(owner.saving));
    option.classList.toggle('active', index === speciesIndex);
    option.textContent = `${pokemon.name}${pokemon.id === owner.species.id ? ' ✓' : ''}`;
    option.addEventListener('click', (): void => { void saveSpecies(owner, pokemon); });
    speciesResults.append(option);
  });
  speciesEmpty.hidden = speciesMatches.length !== 0;
  const active: HTMLElement | null = speciesResults.children[speciesIndex] as HTMLElement | undefined ?? null;
  if (active) {
    speciesSearch.setAttribute('aria-activedescendant', active.id);
    active.scrollIntoView({ block: 'nearest' });
  } else speciesSearch.removeAttribute('aria-activedescendant');
  if (optionFocused) speciesSearch.focus({ preventScroll: true });
}

function openSpecies(companion: Companion): void {
  if (companion.disposed || companion.select.disabled) return;
  if (speciesOwner === companion) { closeSpecies(true); return; }
  closeSpecies();
  hideWorkspaceTooltip();
  speciesOwner = companion;
  speciesSearch.value = '';
  speciesIndex = Math.max(0, POKEMON.indexOf(companion.species));
  companion.select.setAttribute('aria-expanded', 'true');
  speciesPanel.showPopover();
  renderSpecies();
  const bounds: DOMRect = list.parentElement!.getBoundingClientRect();
  const anchor: DOMRect = companion.select.getBoundingClientRect();
  speciesPanel.style.width = `${Math.max(0, Math.min(240, bounds.width - 16))}px`;
  speciesPanel.style.maxHeight = `${Math.max(0, bounds.height - 16)}px`;
  speciesPanel.style.left = `${Math.max(bounds.left + 8, Math.min(anchor.left, bounds.right - speciesPanel.offsetWidth - 8))}px`;
  speciesPanel.style.top = `${Math.max(bounds.top + 8, Math.min(anchor.bottom + 6, bounds.bottom - speciesPanel.offsetHeight - 8))}px`;
  speciesSearch.focus({ preventScroll: true });
}

async function saveSpecies(companion: Companion, next: Pokemon): Promise<void> {
  if (companion.disposed || companion.saving) return;
  companion.saving = true;
  companion.choiceRevision++;
  renderSpecies();
  try {
    if (!companion.storageKey) companion.storageKey = await choiceKey(companion.row.id);
    await orca.host.call('storage.set', { key: companion.storageKey, value: next.id });
    if (companion.disposed) return;
    companion.species = next;
    companion.select.title = `Change Pokémon: ${next.name}`;
    animateSprite(companion);
    operationError = '';
    paintError();
    if (speciesOwner === companion) closeSpecies(speciesPanel.contains(document.activeElement));
  } catch (error: unknown) {
    if (!companion.disposed) showError(error);
  } finally {
    companion.saving = false;
    if (speciesOwner === companion) renderSpecies();
  }
}

speciesSearch.addEventListener('input', (): void => { speciesIndex = 0; renderSpecies(); });
speciesPanel.addEventListener('keydown', (event: KeyboardEvent): void => {
  if (event.isComposing) return;
  if (event.key === 'Escape') { event.preventDefault(); closeSpecies(true); }
  else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    speciesIndex = (speciesIndex + (event.key === 'ArrowDown' ? 1 : -1) + speciesMatches.length) % (speciesMatches.length || 1);
    renderSpecies();
    speciesSearch.focus({ preventScroll: true });
  } else if (event.key === 'Enter' && event.target === speciesSearch) {
    event.preventDefault();
    if (speciesOwner && speciesMatches[speciesIndex]) void saveSpecies(speciesOwner, speciesMatches[speciesIndex]);
  } else if (event.key === 'Tab') closeSpecies(true);
});
document.addEventListener('pointerdown', (event: PointerEvent): void => {
  if (speciesOwner && event.target instanceof Node && !speciesPanel.contains(event.target) && !speciesOwner.select.contains(event.target)) closeSpecies();
});

function paintError(): void {
  errorBox.textContent = [operationError, rosterError, orderError, orderLoadError].filter(Boolean).join(' ');
  errorBox.hidden = !errorBox.textContent;
}

function hideWorkspaceTooltip(): void {
  clearTimeout(tooltipDelay);
  tooltipOwner?.agentBadge.removeAttribute('aria-describedby');
  tooltipOwner = undefined;
  workspaceTooltip.hidden = true;
}

function showWorkspaceTooltip(companion: Companion): void {
  clearTimeout(tooltipDelay);
  if (companion.disposed || dragged || draggedProject) return;
  if (tooltipOwner !== companion) hideWorkspaceTooltip();
  tooltipOwner = companion;
  workspaceTooltipText.textContent = companion.row.agent;
  companion.agentBadge.setAttribute('aria-describedby', workspaceTooltip.id);
  const bounds: DOMRect = list.parentElement!.getBoundingClientRect();
  const anchor: DOMRect = companion.agentBadge.getBoundingClientRect();
  workspaceTooltip.style.width = 'max-content';
  workspaceTooltip.style.maxWidth = `${Math.min(360, Math.max(0, bounds.width - 16))}px`;
  workspaceTooltip.style.maxHeight = `${Math.max(0, bounds.height - 16)}px`;
  workspaceTooltip.hidden = false;
  const width: number = workspaceTooltip.offsetWidth;
  const height: number = workspaceTooltip.offsetHeight;
  const center: number = anchor.left + anchor.width / 2;
  const left: number = Math.max(bounds.left + 8, Math.min(center - width / 2, bounds.right - width - 8));
  const above: boolean = anchor.top - height - 6 >= bounds.top + 8 || anchor.top - bounds.top > bounds.bottom - anchor.bottom;
  workspaceTooltip.dataset.side = above ? 'top' : 'bottom';
  workspaceTooltip.style.left = `${left}px`;
  workspaceTooltip.style.top = `${Math.max(bounds.top + 8, Math.min(above ? anchor.top - height - 6 : anchor.bottom + 6, bounds.bottom - height - 8))}px`;
  workspaceTooltip.style.setProperty('--tooltip-arrow', `${Math.max(10, Math.min(center - left, width - 10))}px`);
}

function arrangeCards(resort: boolean = false): void {
  if (!orderLoaded) return;
  const byKey: Map<string, Companion> = new Map(Array.from(companions.values(), (companion: Companion): [string, Companion] => [companion.storageKey, companion]));
  const previousLength: number = manualOrder.length;
  manualOrder = reconcileOrder(manualOrder, Array.from(byKey.keys()));
  const items: OrderItem[] = Array.from(byKey, ([id, companion]: [string, Companion]): OrderItem => ({ id, title: companion.row.title, state: companion.row.state }));
  const projectKeys: string[] = orderedIds(items, manualOrder, 'manual').map((key: string): string => projects.get(byKey.get(key)!.row.projectId)!.storageKey);
  const previousProjectLength: number = projectOrder.length;
  projectOrder = reconcileOrder(projectOrder, projectKeys);
  if ((manualOrder.length !== previousLength && cardOrderWritable) || (projectOrder.length !== previousProjectLength && projectOrderWritable)) void saveManualOrder();
  const focused: HTMLElement | null = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const groups: ProjectGroup[] = Array.from(projects.values()).sort((a: ProjectGroup, b: ProjectGroup): number => projectOrder.indexOf(a.storageKey) - projectOrder.indexOf(b.storageKey));
  for (let groupIndex: number = 0; groupIndex < groups.length; groupIndex++) {
    const group: ProjectGroup = groups[groupIndex];
    const members: OrderItem[] = items.filter((item: OrderItem): boolean => byKey.get(item.id)!.row.projectId === group.id);
    const keys: string[] = sortMode === 'manual' || resort ? orderedIds(members, manualOrder, sortMode) : Array.from(group.list.children, (card: Element): string => (card as HTMLElement).dataset.orderKey!);
    if (list.children[groupIndex] !== group.section) list.insertBefore(group.section, list.children[groupIndex] ?? null);
    group.title.textContent = group.name;
    group.count.textContent = String(members.length);
    group.toggle.setAttribute('aria-label', `${group.name}, ${members.length} agent${members.length === 1 ? '' : 's'}`);
    group.grip.setAttribute('aria-label', `Rearrange ${group.name} project`);
    group.grip.disabled = false;
    group.grip.draggable = true;
    for (let index: number = 0; index < keys.length; index++) {
      const companion: Companion | undefined = byKey.get(keys[index]);
      if (!companion) continue;
      if (group.list.children[index] !== companion.card) group.list.insertBefore(companion.card, group.list.children[index] ?? null);
      const movable: boolean = sortMode === 'manual';
      companion.grip.disabled = !movable;
      companion.grip.draggable = movable;
    }
  }
  if (focused?.isConnected && document.activeElement !== focused) {
    const restore: HTMLElement | null = focused instanceof HTMLButtonElement && focused.disabled ? focused.closest('.agent-card')?.querySelector('.species-picker') ?? null : focused;
    restore?.focus({ preventScroll: true });
  }
  sortSelect.disabled = false;
  sortSelect.title = sortMode === 'manual' ? 'Drag agents within projects. Drag project grips to arrange groups.' : 'Sort applies within each project. Choose Manual to rearrange agents; Refresh reapplies this sort.';
}

async function loadManualOrder(): Promise<void> {
  const revision: number = ++orderRevision;
  try {
    const [cardsRead, projectsRead]: PromiseSettledResult<unknown>[] = await Promise.allSettled([orca.host.call('storage.get', { key: orderKey }), orca.host.call('storage.get', { key: projectOrderKey })]);
    if (revision !== orderRevision) return;
    if (dragged || draggedProject || orderDirty) { orderReloadPending = true; return; }
    cardOrderWritable = cardsRead.status === 'fulfilled';
    projectOrderWritable = projectsRead.status === 'fulfilled';
    if (cardsRead.status === 'fulfilled') {
      const result: unknown = cardsRead.value;
      manualOrder = parseOrder(result !== null && typeof result === 'object' && 'value' in result ? result.value : null);
    }
    if (projectsRead.status === 'fulfilled') {
      const result: unknown = projectsRead.value;
      projectOrder = parseOrder(result !== null && typeof result === 'object' && 'value' in result ? result.value : null);
    }
    const missing: string[] = [];
    if (!cardOrderWritable) missing.push('agent');
    if (!projectOrderWritable) missing.push('project');
    orderLoadError = missing.length ? `Could not load saved ${missing.join(' and ')} order. You can still rearrange here.` : '';
  } catch {
    if (revision !== orderRevision) return;
    cardOrderWritable = projectOrderWritable = false;
    orderLoadError = 'Could not load saved agent and project order. You can still rearrange here.';
  } finally {
    if (revision === orderRevision && !dragged && !draggedProject && !orderDirty) {
      orderLoaded = true;
      arrangeCards();
      paintError();
    }
  }
}

async function saveManualOrder(): Promise<void> {
  orderSavePending = true;
  orderDirty = true;
  if (orderSaving) return;
  orderSaving = true;
  try {
    while (orderSavePending) {
      orderSavePending = false;
      try {
        const cardsSnapshot: string[] = manualOrder.slice();
        const projectsSnapshot: string[] = projectOrder.slice();
        const writeCards: boolean = cardOrderWritable;
        const writeProjects: boolean = projectOrderWritable;
        if (writeCards) await orca.host.call('storage.set', { key: orderKey, value: cardsSnapshot });
        if (writeProjects) await orca.host.call('storage.set', { key: projectOrderKey, value: projectsSnapshot });
        if (!orderSavePending) orderDirty = false;
        orderError = '';
      } catch {
        orderError = 'Agent order changed here but could not be saved. Move an agent again to retry.';
      }
      paintError();
    }
  } finally {
    orderSaving = false;
    if (orderReloadPending && !dragged && !draggedProject && !orderDirty) { orderReloadPending = false; void loadManualOrder(); }
  }
}

function finishDrag(): void {
  dragged = undefined;
  draggedProject = undefined;
  for (const companion of companions.values()) companion.card.classList.remove('dragging', 'drop-before', 'drop-after');
  for (const project of projects.values()) project.section.classList.remove('dragging', 'drop-before', 'drop-after');
  if (orderReloadPending && !orderSaving && !orderDirty) { orderReloadPending = false; void loadManualOrder(); }
}

function moveCompanion(source: Companion, target: Companion, after: boolean): void {
  if (!orderLoaded || sortMode !== 'manual' || source.disposed || target.disposed || source === target || source.row.projectId !== target.row.projectId) return;
  orderRevision++;
  cardOrderWritable = true;
  manualOrder = moveOrder(manualOrder, source.storageKey, target.storageKey, after);
  arrangeCards();
  orderAnnouncement.textContent = `${source.row.title} moved to position ${Array.from(source.card.parentElement!.children).indexOf(source.card) + 1} of ${source.card.parentElement!.children.length} in ${projects.get(source.row.projectId)!.name}.`;
  void saveManualOrder();
}

function moveProject(source: ProjectGroup, target: ProjectGroup, after: boolean): void {
  if (!orderLoaded || source.disposed || target.disposed || source === target) return;
  orderRevision++;
  projectOrderWritable = true;
  projectOrder = moveOrder(projectOrder, source.storageKey, target.storageKey, after);
  arrangeCards();
  orderAnnouncement.textContent = `${source.name} project moved to position ${Array.from(list.children).indexOf(source.section) + 1} of ${projects.size}.`;
  void saveManualOrder();
}

function createProject(id: string, name: string, storageKey: string): ProjectGroup {
  const section: HTMLElement = document.createElement('section');
  section.className = 'project-group';
  section.dataset.orderKey = storageKey;
  section.innerHTML = '<div class="project-heading"><button class="project-grip" type="button" title="Drag project to rearrange, or use Arrow Up and Arrow Down" disabled>⠿</button><h2><button class="project-toggle" type="button" aria-expanded="true"><span class="project-name"></span><span class="project-count"></span></button></h2></div><div class="project-agents"></div>';
  const project: ProjectGroup = {
    id, name, storageKey, section, disposed: false,
    list: section.querySelector('.project-agents')!,
    title: section.querySelector('.project-name')!,
    count: section.querySelector('.project-count')!,
    toggle: section.querySelector('.project-toggle')!,
    grip: section.querySelector('.project-grip')!
  };
  project.list.id = `project-agents-${storageKey.slice('pokemon.v1:'.length)}`;
  project.title.id = `project-title-${storageKey.slice('pokemon.v1:'.length)}`;
  section.setAttribute('aria-labelledby', project.title.id);
  project.toggle.setAttribute('aria-controls', project.list.id);
  project.grip.setAttribute('aria-label', `Rearrange ${name} project`);
  project.toggle.addEventListener('click', (): void => {
    hideWorkspaceTooltip();
    project.list.hidden = !project.list.hidden;
    project.toggle.setAttribute('aria-expanded', String(!project.list.hidden));
  });
  project.grip.addEventListener('dragstart', (event: DragEvent): void => {
    if (!orderLoaded || project.disposed || !event.dataTransfer) { event.preventDefault(); return; }
    finishDrag();
    draggedProject = project;
    hideWorkspaceTooltip();
    section.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', storageKey);
  });
  project.grip.addEventListener('dragend', finishDrag);
  section.addEventListener('dragover', (event: DragEvent): void => {
    if (!draggedProject || draggedProject === project || draggedProject.disposed) return;
    event.preventDefault();
    const heading: DOMRect = section.querySelector('.project-heading')!.getBoundingClientRect();
    const after: boolean = event.clientY > heading.top + heading.height / 2;
    section.classList.toggle('drop-before', !after);
    section.classList.toggle('drop-after', after);
    const bounds: DOMRect = list.parentElement!.getBoundingClientRect();
    if (event.clientY < bounds.top + 40) list.parentElement!.scrollBy(0, -20);
    else if (event.clientY > bounds.bottom - 40) list.parentElement!.scrollBy(0, 20);
  });
  section.addEventListener('dragleave', (event: DragEvent): void => {
    if (!(event.relatedTarget instanceof Node) || !section.contains(event.relatedTarget)) section.classList.remove('drop-before', 'drop-after');
  });
  section.addEventListener('drop', (event: DragEvent): void => {
    const source: ProjectGroup | undefined = draggedProject;
    if (!source || event.dataTransfer?.getData('text/plain') !== source.storageKey) return;
    event.preventDefault();
    const heading: DOMRect = section.querySelector('.project-heading')!.getBoundingClientRect();
    moveProject(source, project, event.clientY > heading.top + heading.height / 2);
    finishDrag();
  });
  project.grip.addEventListener('keydown', (event: KeyboardEvent): void => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const direction: number = event.key === 'ArrowUp' ? -1 : 1;
    const sections: Element[] = Array.from(list.children);
    const targetSection: Element | undefined = sections[sections.indexOf(section) + direction];
    const target: ProjectGroup | undefined = Array.from(projects.values()).find((item: ProjectGroup): boolean => item.section === targetSection);
    if (target) moveProject(project, target, direction > 0);
  });
  list.append(section);
  return project;
}

function animateSprite(companion: Companion): void {
  companion.animation?.cancel();
  companion.animation = null;
  if (companion.disposed) return;
  const state: AgentRow['state'] = companion.row.state;
  const sheet: SpriteAnimation = companion.species.animations[
    state === 'working' ? 'walk' : state === 'done' ? 'sleep' : 'idle'
  ];
  const scale: number = companion.species.scale;
  const width: number = sheet.width * scale;
  const height: number = sheet.height * scale;
  const sprite: HTMLElement = companion.sprite;
  sprite.style.width = `${width}px`;
  sprite.style.height = `${height}px`;
  sprite.style.backgroundImage = `url("${sheet.path}")`;
  sprite.style.backgroundSize = `${width * sheet.columns}px auto`;
  sprite.style.backgroundPosition = `0px ${-sheet.row * height}px`;
  sprite.style.transform = `translateY(${sheet.bottomOffset * scale}px)`;
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
  motionButton.textContent = paused ? 'Resume' : 'Pause';
  motionButton.title = paused ? 'Resume motion' : 'Pause motion';
  motionButton.setAttribute('aria-label', motionButton.title);
  motionButton.setAttribute('aria-pressed', String(paused));
  for (const companion of companions.values()) animateSprite(companion);
  audioVisualizer?.setMotionPaused(paused);
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
    companion.select.title = `Change Pokémon: ${companion.species.name}`;
    if (speciesOwner === companion) renderSpecies();
    animateSprite(companion);
  } catch (error: unknown) { if (!companion.disposed) showError(error); }
  finally { if (!companion.disposed && !companion.saving) companion.select.disabled = false; }
}

function createCompanion(row: AgentRow, storageKey: string): Companion {
  const card: HTMLElement = document.createElement('article');
  card.className = 'agent-card';
  card.dataset.orderKey = storageKey;
  // This is constant markup. Agent names and all host data use textContent below.
  card.innerHTML = '<div class="card-top"><button class="drag-grip" type="button" disabled title="Drag to rearrange, or use Arrow Up and Arrow Down">⠿</button><div class="identity"><h2></h2></div><span class="state"><span class="state-label"></span></span></div><div class="sprite-area"><button type="button" class="habitat"><span class="ground" aria-hidden="true"></span><span class="actor" aria-hidden="true"><span class="sprite"></span></span><span class="signal" aria-hidden="true"></span></button><button type="button" class="agent-icon" data-agent="unknown"></button><button type="button" class="species-control species-picker" aria-haspopup="dialog" aria-expanded="false" aria-controls="species-panel" title="Change Pokémon"><span class="pokeball" aria-hidden="true"></span></button></div>';
  const select: HTMLButtonElement = card.querySelector('.species-picker')!;
  const species: Pokemon = POKEMON[defaultPokemon(row.id, POKEMON.length)];
  select.disabled = true;
  const companion: Companion = {
    row, card, select, species,
    title: card.querySelector('h2')!,
    agentBadge: card.querySelector('.agent-icon')!,
    status: card.querySelector('.state-label')!,
    focus: card.querySelector('.habitat')!,
    grip: card.querySelector('.drag-grip')!,
    signal: card.querySelector('.signal')!,
    sprite: card.querySelector('.sprite')!,
    animation: null, saving: false, choiceRevision: 0, storageKey, disposed: false
  };
  companion.agentBadge.addEventListener('mouseenter', (): void => {
    if (document.activeElement === companion.agentBadge) { showWorkspaceTooltip(companion); return; }
    hideWorkspaceTooltip();
    tooltipDelay = setTimeout((): void => { showWorkspaceTooltip(companion); }, 600);
  });
  companion.agentBadge.addEventListener('focus', (): void => { showWorkspaceTooltip(companion); });
  companion.agentBadge.addEventListener('click', (): void => { showWorkspaceTooltip(companion); });
  companion.agentBadge.addEventListener('mouseleave', (): void => { if (document.activeElement !== companion.agentBadge) hideWorkspaceTooltip(); });
  companion.agentBadge.addEventListener('blur', hideWorkspaceTooltip);
  companion.grip.addEventListener('dragstart', (event: DragEvent): void => {
    if (!orderLoaded || sortMode !== 'manual' || companion.disposed || !event.dataTransfer) { event.preventDefault(); return; }
    finishDrag();
    dragged = companion;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', companion.storageKey);
    companion.card.classList.add('dragging');
  });
  companion.grip.addEventListener('dragend', (): void => {
    finishDrag();
  });
  card.addEventListener('dragover', (event: DragEvent): void => {
    if (!dragged || dragged === companion || dragged.disposed || sortMode !== 'manual' || dragged.row.projectId !== companion.row.projectId) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    const after: boolean = event.clientY > card.getBoundingClientRect().top + card.offsetHeight / 2;
    card.classList.toggle('drop-before', !after);
    card.classList.toggle('drop-after', after);
    const scroller: HTMLElement = list.parentElement!;
    const bounds: DOMRect = scroller.getBoundingClientRect();
    if (event.clientY < bounds.top + 40) scroller.scrollBy(0, -20);
    else if (event.clientY > bounds.bottom - 40) scroller.scrollBy(0, 20);
  });
  card.addEventListener('dragleave', (event: DragEvent): void => {
    if (!(event.relatedTarget instanceof Node) || !card.contains(event.relatedTarget)) card.classList.remove('drop-before', 'drop-after');
  });
  card.addEventListener('drop', (event: DragEvent): void => {
    card.classList.remove('drop-before', 'drop-after');
    const source: Companion | undefined = dragged;
    if (!source || event.dataTransfer?.getData('text/plain') !== source.storageKey) return;
    event.preventDefault();
    moveCompanion(source, companion, event.clientY > card.getBoundingClientRect().top + card.offsetHeight / 2);
    finishDrag();
  });
  companion.grip.addEventListener('keydown', (event: KeyboardEvent): void => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const direction: number = event.key === 'ArrowUp' ? -1 : 1;
    const cards: Element[] = Array.from(card.parentElement!.children);
    const targetCard: Element | undefined = cards[cards.indexOf(card) + direction];
    const target: Companion | undefined = Array.from(companions.values()).find((item: Companion): boolean => item.card === targetCard);
    if (target) moveCompanion(companion, target, direction > 0);
  });
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
    openSpecies(companion);
  });
  select.addEventListener('click', (): void => { openSpecies(companion); });
  projects.get(row.projectId)!.list.append(card);
  void loadChoice(companion);
  return companion;
}

function paintCompanion(companion: Companion, row: AgentRow): void {
  const changed: boolean = companion.row.state !== row.state;
  companion.row = row;
  companion.card.dataset.state = row.state;
  companion.title.textContent = row.title;
  companion.title.title = row.title;
  const agent: string = row.agent.trim().toLowerCase();
  companion.agentBadge.dataset.agent = agent === 'claude' || agent === 'codex' || agent === 'opencode' ? agent : 'unknown';
  companion.agentBadge.setAttribute('aria-label', `${row.agent} agent details`);
  if (tooltipOwner === companion) showWorkspaceTooltip(companion);
  companion.status.textContent = labels[row.state];
  companion.status.parentElement!.title = labels[row.state];
  companion.grip.setAttribute('aria-label', `Rearrange ${row.title}`);
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
    const keys: string[] = await Promise.all(roster.agents.map((row: AgentRow): Promise<string> => {
      const existing: Companion | undefined = companions.get(row.id);
      return existing ? Promise.resolve(existing.storageKey) : choiceKey(row.id);
    }));
    const projectNames: Map<string, string> = new Map(roster.agents.map((row: AgentRow): [string, string] => [row.projectId, row.projectName]));
    const projectIds: string[] = Array.from(projectNames.keys());
    const projectKeys: string[] = await Promise.all(projectIds.map((id: string): Promise<string> => {
      const existing: ProjectGroup | undefined = projects.get(id);
      return existing ? Promise.resolve(existing.storageKey) : choiceKey(`project:${id}`);
    }));
    for (let index: number = 0; index < projectIds.length; index++) {
      const id: string = projectIds[index];
      const name: string = projectNames.get(id)!;
      const existing: ProjectGroup | undefined = projects.get(id);
      if (existing) existing.name = name;
      else projects.set(id, createProject(id, name, projectKeys[index]));
    }
    const focusedBeforeRefresh: HTMLElement | null = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const ids: Set<string> = new Set<string>(roster.agents.map((row: AgentRow): string => row.id));
    for (const [id, companion] of companions) {
      if (ids.has(id)) continue;
      companion.disposed = true;
      if (speciesOwner === companion) closeSpecies();
      if (tooltipOwner === companion) hideWorkspaceTooltip();
      if (dragged === companion) finishDrag();
      companion.choiceRevision++;
      companion.animation?.cancel();
      companion.card.remove();
      companions.delete(id);
    }
    for (let index: number = 0; index < roster.agents.length; index++) {
      const row: AgentRow = roster.agents[index];
      let companion: Companion | undefined = companions.get(row.id);
      if (!companion) { companion = createCompanion(row, keys[index]); companions.set(row.id, companion); }
      const group: ProjectGroup = projects.get(row.projectId)!;
      if (companion.card.parentElement !== group.list) {
        if (speciesOwner === companion) closeSpecies();
        if (dragged === companion) finishDrag();
        if (tooltipOwner === companion) hideWorkspaceTooltip();
        group.list.append(companion.card);
      }
      const update: { revision: number; state: AgentRow['state'] } | undefined = statusUpdates.get(row.paneKey);
      paintCompanion(companion, update && update.revision > queryRevision ? { ...row, state: update.state } : row);
    }
    for (const [id, project] of projects) {
      if (projectNames.has(id)) continue;
      project.disposed = true;
      if (draggedProject === project) finishDrag();
      project.section.remove();
      projects.delete(id);
    }
    for (const [key, update] of statusUpdates) if (update.revision <= queryRevision) statusUpdates.delete(key);
    element('empty').hidden = companions.size !== 0;
    element('partial').hidden = !roster.partial;
    rosterStale = false;
    rosterError = '';
    paintError();
    updateSummary();
    arrangeCards(sortRequested);
    if (focusedBeforeRefresh?.isConnected && document.activeElement !== focusedBeforeRefresh) {
      const group: ProjectGroup | undefined = Array.from(projects.values()).find((project: ProjectGroup): boolean => project.section.contains(focusedBeforeRefresh));
      const restore: HTMLElement | null = group?.list.hidden ? group.toggle : focusedBeforeRefresh instanceof HTMLButtonElement && focusedBeforeRefresh.disabled ? focusedBeforeRefresh.closest('.agent-card')?.querySelector('.species-picker') ?? null : focusedBeforeRefresh;
      restore?.focus({ preventScroll: true });
    }
    sortRequested = false;
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
  list.parentElement!.addEventListener('scroll', (): void => { closeSpecies(); });
  new ResizeObserver((): void => { closeSpecies(); }).observe(list.parentElement!);
  list.addEventListener('dragstart', (): void => { closeSpecies(); });
  list.addEventListener('click', (event: MouseEvent): void => {
    if (event.target instanceof Element && event.target.closest('.project-toggle')) closeSpecies();
  });
  window.addEventListener('resize', (): void => { closeSpecies(); });
  document.addEventListener('visibilitychange', (): void => { closeSpecies(); });
  list.parentElement!.addEventListener('scroll', hideWorkspaceTooltip);
  new ResizeObserver(hideWorkspaceTooltip).observe(list.parentElement!);
  list.addEventListener('pointerdown', hideWorkspaceTooltip);
  list.addEventListener('dragstart', hideWorkspaceTooltip);
  window.addEventListener('resize', hideWorkspaceTooltip);
  document.addEventListener('keydown', (event: KeyboardEvent): void => { if (event.key === 'Escape') hideWorkspaceTooltip(); });
  updateMotion();
  refreshButton.addEventListener('click', (): void => { sortRequested = true; void refresh(); });
  sortSelect.addEventListener('change', (): void => {
    sortMode = sortSelect.value === 'attention' || sortSelect.value === 'name' ? sortSelect.value : 'manual';
    finishDrag();
    arrangeCards(true);
  });
  motionButton.addEventListener('click', (): void => { paused = !paused; updateMotion(); });
  reducedMotion.addEventListener('change', (): void => { paused = reducedMotion.matches; updateMotion(); });
  if (typeof orca === 'undefined') { showError('Open this panel inside Orca after approving its permissions.'); return; }
  for (const method of ['agents.list', 'events.subscribe', 'plugin.request', 'storage.get', 'storage.set']) {
    if (!orca.host.has(method)) { showError(`This Orca does not support ${method}. Update Orca to 1.4.250 or newer.`); return; }
  }
  audioVisualizer = setupAudioVisualizer(orca.plugin, paused, orca.host);
  updateAudioTheme();
  orca.on('theme', updateAudioTheme);
  orca.on('agent.status.changed', statusChanged);
  orca.on('workspace.changed', scheduleRefresh);
  orca.on('workspace.created', scheduleRefresh);
  orca.on('workspace.removed', scheduleRefresh);
  orca.storage.onDidChange((event: { key: string }): void => {
    if (event.key === orderKey || event.key === projectOrderKey) {
      if (orderSaving || dragged || draggedProject || orderDirty) orderReloadPending = true;
      else void loadManualOrder();
    }
    audioVisualizer?.preferenceChanged(event.key);
    for (const companion of companions.values()) {
      if (companion.storageKey === event.key && !companion.saving) void loadChoice(companion);
    }
  });
  document.addEventListener('visibilitychange', (): void => { hideWorkspaceTooltip(); if (!document.hidden) scheduleRefresh(); });
  await loadManualOrder();
  await refresh();
}

void start().catch(showError);
