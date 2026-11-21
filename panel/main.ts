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
  dialogue: HTMLElement;
  focus: HTMLButtonElement;
  signal: HTMLElement;
  select: HTMLButtonElement;
  grip: HTMLButtonElement;
  sprite: HTMLElement;
  species: Pokemon;
  workAnimation: 'walk' | 'shock' | 'tumbleback';
  workSelect: HTMLFieldSetElement;
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
const filterSelect: HTMLSelectElement = element('agent-filter');
const viewButton: HTMLButtonElement = element('view-options-button');
const viewPanel: HTMLElement = element('view-options');
const clearFilter: HTMLButtonElement = element('clear-filter');
const activeFilterLabel: HTMLElement = element('active-filter-label');
const orderAnnouncement: HTMLElement = element('order-announcement');
const workspaceTooltip: HTMLElement = element('workspace-tooltip');
const workspaceTooltipText: HTMLElement = element('workspace-tooltip-text');
const speciesPanel: HTMLElement = element('species-panel');
speciesPanel.tabIndex = -1;
const speciesSearch: HTMLInputElement = element('species-search');
const speciesResults: HTMLElement = element('species-results');
const speciesEmpty: HTMLElement = element('species-empty');
const battleMenu: HTMLElement = element('battle-menu');
const battleFight: HTMLButtonElement = element('battle-fight');
const battlePokemon: HTMLButtonElement = element('battle-pokemon');
const battleWork: HTMLElement = element('battle-work');
const battleSpecies: HTMLElement = element('battle-species');
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
const orderSavePending: Set<string> = new Set();
const orderDirty: Set<string> = new Set();
let orderReloadPending: boolean = false;
let sortMode: SortMode = 'manual';
let statusFilter: 'all' | 'working' | 'blocked' | 'idle' = 'all';
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
  speciesPanel.setAttribute('aria-busy', 'false');
  element('battle-save-status').textContent = '';
  owner?.workSelect.remove();
  owner?.select.setAttribute('aria-expanded', 'false');
  if (speciesPanel.matches(':popover-open')) speciesPanel.hidePopover();
  if (restore && owner && !owner.disposed && !owner.card.closest('[hidden]')) owner.select.focus({ preventScroll: true });
}

function renderSpecies(): void {
  const owner: Companion | undefined = speciesOwner;
  if (!owner) return;
  element('battle-prompt').textContent = `What will ${owner.species.name} do?`;
  battleFight.disabled = owner.species.id !== 25;
  battleFight.title = owner.species.id === 25 ? 'Change work animation' : 'Work animation choices are currently available for Pikachu only';
  if (owner.species.id !== 25 && !battleWork.hidden) showBattlePage('menu');
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
  if (companion.saving) return;
  closeSpecies();
  hideWorkspaceTooltip();
  speciesOwner = companion;
  speciesSearch.value = '';
  speciesIndex = Math.max(0, POKEMON.indexOf(companion.species));
  companion.select.setAttribute('aria-expanded', 'true');
  showBattlePage('menu');
  speciesPanel.showPopover();
  renderSpecies();
  positionBattleMenu();
  (battleFight.disabled ? battlePokemon : battleFight).focus({ preventScroll: true });
}

function positionBattleMenu(): void {
  const companion: Companion | undefined = speciesOwner;
  if (!companion) return;
  const bounds: DOMRect = list.parentElement!.getBoundingClientRect();
  const anchor: DOMRect = companion.select.getBoundingClientRect();
  speciesPanel.style.width = `${Math.max(0, Math.min(240, bounds.width - 16))}px`;
  speciesPanel.style.maxHeight = `${Math.max(0, bounds.height - 16)}px`;
  speciesPanel.style.left = `${Math.max(bounds.left + 8, Math.min(anchor.left, bounds.right - speciesPanel.offsetWidth - 8))}px`;
  const height: number = speciesPanel.offsetHeight;
  const below: number = anchor.bottom + 6;
  const above: number = anchor.top - height - 6;
  const top: number = below + height <= bounds.bottom - 8 ? below : above;
  speciesPanel.style.top = `${Math.max(bounds.top + 8, Math.min(top, bounds.bottom - height - 8))}px`;
}

function paintSaveStatus(companion: Companion, message: string, busy: boolean = false): void {
  if (speciesOwner !== companion) return;
  const status: HTMLElement = element('battle-save-status');
  status.textContent = message;
  speciesPanel.setAttribute('aria-busy', String(busy));
  if (speciesPanel.matches(':popover-open')) positionBattleMenu();
}

function showBattlePage(page: 'menu' | 'species' | 'work'): void {
  const owner: Companion | undefined = speciesOwner;
  if (!owner) return;
  battleMenu.hidden = page !== 'menu';
  battleWork.hidden = page !== 'work';
  battleSpecies.hidden = page !== 'species';
  element('battle-prompt').textContent = `What will ${owner.species.name} do?`;
  battleFight.disabled = owner.species.id !== 25;
  battleFight.title = owner.species.id === 25 ? 'Change work animation' : 'Work animation choices are currently available for Pikachu only';
  if (page === 'work') {
    owner.workSelect.setAttribute('aria-labelledby', 'battle-work-label');
    element('battle-work-control').replaceChildren(owner.workSelect);
    owner.workSelect.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
  } else if (page === 'species') {
    renderSpecies();
    speciesSearch.focus({ preventScroll: true });
  } else (battleFight.disabled ? battlePokemon : battleFight).focus({ preventScroll: true });
  if (speciesPanel.matches(':popover-open')) positionBattleMenu();
}

battleFight.addEventListener('click', (): void => { if (!battleFight.disabled) showBattlePage('work'); });
battlePokemon.addEventListener('click', (): void => { showBattlePage('species'); });

async function saveSpecies(companion: Companion, next: Pokemon): Promise<void> {
  if (companion.disposed || companion.saving) return;
  companion.saving = true;
  paintSaveStatus(companion, 'Saving…', true);
  companion.workSelect.disabled = true;
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
    if (!companion.disposed) {
      showError(error);
      paintSaveStatus(companion, 'Save failed. Try again.');
    }
  } finally {
    companion.saving = false;
    companion.workSelect.disabled = false;
    if (speciesOwner === companion) renderSpecies();
    if (!companion.disposed) void loadChoice(companion);
  }
}

speciesSearch.addEventListener('input', (): void => { speciesIndex = 0; renderSpecies(); });
speciesPanel.addEventListener('keydown', (event: KeyboardEvent): void => {
  if (event.isComposing) return;
  if (event.target === speciesSearch && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
    event.preventDefault();
    speciesIndex = (speciesIndex + (event.key === 'ArrowDown' ? 1 : -1) + speciesMatches.length) % (speciesMatches.length || 1);
    renderSpecies();
    speciesSearch.focus({ preventScroll: true });
  } else if (event.target instanceof HTMLButtonElement &&
      (battleMenu.contains(event.target) || battleWork.contains(event.target)) &&
      ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
    event.preventDefault();
    const group: HTMLElement = battleMenu.hidden ? battleWork : battleMenu;
    const buttons: HTMLButtonElement[] = Array.from(group.querySelectorAll<HTMLButtonElement>('button')).filter((button: HTMLButtonElement): boolean => !button.disabled);
    const index: number = buttons.indexOf(event.target);
    if (group === battleWork && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      const target: number = index < 2 ? index + 2 : index - 2;
      buttons[target]?.focus({ preventScroll: true });
      return;
    }
    const direction: number = event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1;
    buttons[(index + direction + buttons.length) % buttons.length]?.focus({ preventScroll: true });
  } else if (event.key === 'Enter' && event.target === speciesSearch) {
    event.preventDefault();
    if (speciesOwner && speciesMatches[speciesIndex]) void saveSpecies(speciesOwner, speciesMatches[speciesIndex]);
  }
});
speciesPanel.addEventListener('pointerover', (event: PointerEvent): void => {
  const button: HTMLButtonElement | null = event.target instanceof Element ? event.target.closest('button') : null;
  if (button && !button.disabled && (battleMenu.contains(button) || battleWork.contains(button))) {
    button.focus({ preventScroll: true });
  }
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
  if (companion.disposed || companion.card.closest('[hidden]') || dragged || draggedProject) return;
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
  const cardsChanged: boolean = manualOrder.length !== previousLength && cardOrderWritable;
  const projectsChanged: boolean = projectOrder.length !== previousProjectLength && projectOrderWritable;
  if (cardsChanged || projectsChanged) void saveManualOrder(cardsChanged, projectsChanged);
  const focused: HTMLElement | null = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const groups: ProjectGroup[] = Array.from(projects.values()).sort((a: ProjectGroup, b: ProjectGroup): number => projectOrder.indexOf(a.storageKey) - projectOrder.indexOf(b.storageKey));
  for (let groupIndex: number = 0; groupIndex < groups.length; groupIndex++) {
    const group: ProjectGroup = groups[groupIndex];
    const members: OrderItem[] = items.filter((item: OrderItem): boolean => byKey.get(item.id)!.row.projectId === group.id);
    const keys: string[] = sortMode === 'manual' || resort ? orderedIds(members, manualOrder, sortMode) : Array.from(group.list.children, (card: Element): string => (card as HTMLElement).dataset.orderKey!);
    if (list.children[groupIndex] !== group.section) list.insertBefore(group.section, list.children[groupIndex] ?? null);
    group.title.textContent = group.name;
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
    const restore: HTMLElement | null = focused.closest('[hidden]') ? viewButton : focused instanceof HTMLButtonElement && focused.disabled ? focused.closest('.agent-card')?.querySelector('.species-picker') ?? null : focused;
    restore?.focus({ preventScroll: restore !== viewButton });
  }
  sortSelect.disabled = false;
  filterSelect.disabled = viewButton.disabled = false;
  sortSelect.title = sortMode === 'manual' ? 'Drag agents within projects. Drag project grips to arrange groups.' : 'Sort applies within each project. Choose Manual to rearrange agents; Refresh reapplies this sort.';
  updateVisibility();
}

async function loadManualOrder(): Promise<void> {
  const revision: number = ++orderRevision;
  try {
    const [cardsRead, projectsRead]: PromiseSettledResult<unknown>[] = await Promise.allSettled([orca.host.call('storage.get', { key: orderKey }), orca.host.call('storage.get', { key: projectOrderKey })]);
    if (revision !== orderRevision) return;
    if (dragged || draggedProject || orderDirty.size) { orderReloadPending = true; return; }
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
    orderLoadError = missing.length ? `Could not load saved ${missing.join(' and ')} order. Moves stay local. Refresh to retry loading saved order.` : '';
  } catch {
    if (revision !== orderRevision) return;
    cardOrderWritable = projectOrderWritable = false;
    orderLoadError = 'Could not load saved agent and project order. Moves stay local. Refresh to retry loading saved order.';
  } finally {
    if (revision === orderRevision && !dragged && !draggedProject && !orderDirty.size) {
      orderLoaded = true;
      arrangeCards();
      paintError();
    }
  }
}

async function saveManualOrder(cardsChanged: boolean, projectsChanged: boolean): Promise<void> {
  if (cardsChanged && cardOrderWritable) { orderDirty.add(orderKey); orderSavePending.add(orderKey); }
  if (projectsChanged && projectOrderWritable) { orderDirty.add(projectOrderKey); orderSavePending.add(projectOrderKey); }
  if (orderSaving) return;
  for (const key of orderDirty) orderSavePending.add(key);
  orderSaving = true;
  try {
    while (orderSavePending.size) {
      const key: string = orderSavePending.values().next().value!;
      orderSavePending.delete(key);
      const snapshot: string[] = (key === orderKey ? manualOrder : projectOrder).slice();
      try {
        await orca.host.call('storage.set', { key, value: snapshot });
        if (!orderSavePending.has(key)) orderDirty.delete(key);
      } catch {
        orderError = 'Order changed here but could not be saved. Move an agent or project again to retry.';
      }
      if (!orderDirty.size) orderError = '';
      paintError();
    }
  } finally {
    orderSaving = false;
    if (orderReloadPending && !dragged && !draggedProject && !orderDirty.size) { orderReloadPending = false; void loadManualOrder(); }
  }
}

function finishDrag(): void {
  dragged = undefined;
  draggedProject = undefined;
  for (const companion of companions.values()) companion.card.classList.remove('dragging', 'drop-before', 'drop-after');
  for (const project of projects.values()) project.section.classList.remove('dragging', 'drop-before', 'drop-after');
  if (orderReloadPending && !orderSaving && !orderDirty.size) { orderReloadPending = false; void loadManualOrder(); }
}

function moveCompanion(source: Companion, target: Companion, after: boolean): void {
  if (!orderLoaded || sortMode !== 'manual' || source.disposed || target.disposed || source === target || source.row.projectId !== target.row.projectId) return;
  orderRevision++;
  manualOrder = moveOrder(manualOrder, source.storageKey, target.storageKey, after);
  arrangeCards();
  const visible: Element[] = Array.from(source.card.parentElement!.children).filter((card: Element): boolean => !(card as HTMLElement).hidden);
  orderAnnouncement.textContent = `${source.row.title} moved to position ${visible.indexOf(source.card) + 1} of ${visible.length} in ${projects.get(source.row.projectId)!.name}.`;
  void saveManualOrder(true, false);
}

function moveProject(source: ProjectGroup, target: ProjectGroup, after: boolean): void {
  if (!orderLoaded || source.disposed || target.disposed || source === target) return;
  orderRevision++;
  projectOrder = moveOrder(projectOrder, source.storageKey, target.storageKey, after);
  arrangeCards();
  const visible: Element[] = Array.from(list.children).filter((section: Element): boolean => !(section as HTMLElement).hidden);
  orderAnnouncement.textContent = `${source.name} project moved to position ${visible.indexOf(source.section) + 1} of ${visible.length}.`;
  void saveManualOrder(false, true);
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
    for (const companion of companions.values()) if (companion.row.projectId === id) syncSpriteMotion(companion);
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
    const sections: Element[] = Array.from(list.children).filter((section: Element): boolean => !(section as HTMLElement).hidden);
    const targetSection: Element | undefined = sections[sections.indexOf(section) + direction];
    const target: ProjectGroup | undefined = Array.from(projects.values()).find((item: ProjectGroup): boolean => item.section === targetSection);
    if (target) moveProject(project, target, direction > 0);
  });
  list.append(section);
  return project;
}

function animateSprite(companion: Companion): void {
  const dialogue: Record<AgentRow['state'], string> = {
    working: 'works.',
    blocked: 'needs help!',
    waiting: 'waits for you.',
    done: 'done. Now rests.',
    unknown: 'status unknown.'
  };
  const message: string = `${companion.species.name} ${dialogue[companion.row.state]}`;
  if (companion.dialogue.textContent !== message) companion.dialogue.textContent = message;
  companion.animation?.cancel();
  companion.animation = null;
  if (companion.disposed) return;
  const state: AgentRow['state'] = companion.row.state;
  const sheet: SpriteAnimation = state === 'working'
    ? (companion.workAnimation === 'tumbleback' ? companion.species.animations.tumble : undefined) ??
      companion.species.animations[companion.workAnimation ?? 'shock'] ?? companion.species.animations.walk
    : companion.species.animations[state === 'done' ? 'sleep' : 'idle'];
  const scale: number = sheet.scale ?? companion.species.scale;
  const width: number = sheet.width * scale;
  const height: number = sheet.height * scale;
  const sprite: HTMLElement = companion.sprite;
  if (companion.workSelect) {
    companion.workSelect.hidden = companion.species.id !== 25;
    for (const button of Array.from(companion.workSelect.querySelectorAll('button'))) {
      button.setAttribute('aria-pressed', String(button.value === companion.workAnimation));
    }
    companion.workSelect.disabled = companion.saving || companion.select.disabled;
  }
  const turning: boolean = state === 'working' && sheet === companion.species.animations.shock;
  const tumbling: boolean = state === 'working' &&
    (sheet === companion.species.animations.tumble || sheet === companion.species.animations.tumbleback);
  sprite.dataset.turning = String(turning);
  sprite.dataset.tumbling = String(tumbling);
  sprite.style.width = `${width}px`;
  sprite.style.height = `${height}px`;
  sprite.style.backgroundImage = `url("${sheet.path}")`;
  sprite.style.backgroundSize = `${width * sheet.columns}px auto`;
  sprite.style.backgroundPosition = `0px ${-sheet.row * height}px`;
  sprite.style.transform = tumbling
    ? `translateY(${sheet.rotatedBottomOffsets![0] * scale}px) rotate(90deg)`
    : `translateY(${sheet.bottomOffset * scale}px)`;
  if (paused || state === 'unknown') return;
  const durations: number[] = sheet.durations.slice(0, sheet.columns);
  const cycle: number = durations.reduce((sum: number, duration: number): number => sum + duration, 0);
  const segments: number = turning ? 8 : tumbling ? 2 : 1;
  const total: number = tumbling
    ? cycle + companion.species.animations.tumbleback!.durations.reduce((sum: number, duration: number): number => sum + duration, 0)
    : cycle * segments;
  const frames: Keyframe[] = [];
  let elapsed: number = 0;
  for (let segment: number = 0; segment < segments; segment++) {
    const segmentSheet: SpriteAnimation = tumbling && segment === 1 ? companion.species.animations.tumbleback! : sheet;
    const segmentScale: number = segmentSheet.scale ?? companion.species.scale;
    const segmentWidth: number = segmentSheet.width * segmentScale;
    const segmentHeight: number = segmentSheet.height * segmentScale;
    const segmentDurations: number[] = segmentSheet.durations;
    const row: number = turning ? segment : sheet.row;
    for (let index: number = 0; index < segmentDurations.length; index++) {
      const frame: Keyframe = { backgroundPosition: `${-index * segmentWidth}px ${-row * segmentHeight}px`, offset: elapsed / total, easing: 'steps(1, end)' };
      if (tumbling) {
        const progress: number = index / (segmentDurations.length - 1);
        frame.backgroundImage = `url("${segmentSheet.path}")`;
        frame.backgroundSize = `${segmentWidth * segmentSheet.columns}px auto`;
        frame.width = `${segmentWidth}px`;
        frame.height = `${segmentHeight}px`;
        frame.transform = `translate(${segment === 0 ? -35 + 70 * progress : 35 - 70 * progress}px, ${segmentSheet.rotatedBottomOffsets![segment] * segmentScale}px) rotate(${segment === 0 ? 90 : -90}deg)`;
      }
      frames.push(frame);
      elapsed += segmentDurations[index];
    }
  }
  if (frames.length > 1) {
    frames.push({ ...frames[frames.length - 1], offset: 1 });
    companion.animation = sprite.animate(frames, { duration: total * (turning || tumbling ? 4 : 1), iterations: Infinity });
    syncSpriteMotion(companion);
  }
}

function syncSpriteMotion(companion: Companion): void {
  const animation: Animation | null = companion.animation;
  if (!animation) return;
  const hidden: boolean = paused || document.hidden || companion.card.closest('[hidden]') !== null;
  if (hidden && animation.playState === 'running') animation.pause();
  else if (!hidden && animation.playState === 'paused') animation.play();
}

function updateMotion(): void {
  document.body.classList.toggle('paused', paused);
  motionButton.setAttribute('aria-label', paused ? 'Resume motion' : 'Pause motion');
  motionButton.removeAttribute('title');
  motionButton.setAttribute('aria-pressed', String(paused));
  for (const companion of companions.values()) {
    if (paused || reducedMotion.matches) {
      companion.focus.classList.remove('selection-hop');
      companion.signal.classList.remove('state-pop');
    }
    animateSprite(companion);
  }
  audioVisualizer?.setMotionPaused(paused);
}

async function loadChoice(companion: Companion): Promise<void> {
  const revision: number = ++companion.choiceRevision;
  try {
    if (!companion.storageKey) companion.storageKey = await choiceKey(companion.row.id);
    if (companion.disposed) return;
    const [result, work]: { value: unknown }[] = await Promise.all([
      orca.host.call('storage.get', { key: companion.storageKey }),
      orca.host.call('storage.get', { key: `${companion.storageKey}.work` }).catch((error: unknown): { value: unknown } => {
        if (!companion.disposed && revision === companion.choiceRevision && !companion.saving) showError(error);
        return { value: companion.workAnimation };
      })
    ]) as { value: unknown }[];
    if (companion.disposed || revision !== companion.choiceRevision || companion.saving) return;
    const species: Pokemon | undefined = POKEMON.find((pokemon: Pokemon): boolean => pokemon.id === result.value);
    companion.species = species ?? POKEMON[defaultPokemon(companion.row.id, POKEMON.length)];
    companion.workAnimation = work.value === 'walk' || work.value === 'tumbleback' ? work.value : 'shock';
    companion.select.title = `Change Pokémon: ${companion.species.name}`;
    if (speciesOwner === companion) renderSpecies();
    animateSprite(companion);
  } catch (error: unknown) { if (!companion.disposed && revision === companion.choiceRevision && !companion.saving) showError(error); }
  finally {
    if (!companion.disposed && revision === companion.choiceRevision && !companion.saving) {
      companion.select.disabled = false;
      companion.workSelect.disabled = false;
    }
  }
}

function createCompanion(row: AgentRow, storageKey: string): Companion {
  const card: HTMLElement = document.createElement('article');
  card.className = 'agent-card';
  card.dataset.orderKey = storageKey;
  // This is constant markup. Agent names and all host data use textContent below.
  card.innerHTML = '<div class="card-top"><button class="drag-grip" type="button" disabled title="Drag to rearrange, or use Arrow Up and Arrow Down">⠿</button><div class="identity"><h2></h2></div><span class="state"><span class="state-label"></span></span></div><div class="sprite-area"><button type="button" class="habitat"><span class="ground" aria-hidden="true"></span><span class="actor" aria-hidden="true"><span class="sprite"></span></span><span class="signal" aria-hidden="true"></span></button><button type="button" class="agent-icon" data-agent="unknown"></button><button type="button" class="species-control species-picker" aria-haspopup="dialog" aria-expanded="false" aria-controls="species-panel" title="Change Pokémon"><span class="pokeball" aria-hidden="true"></span></button></div>';
  const select: HTMLButtonElement = card.querySelector('.species-picker')!;
  const species: Pokemon = POKEMON[defaultPokemon(row.id, POKEMON.length)];
  const workSelect: HTMLFieldSetElement = document.createElement('fieldset');
  const dialogue: HTMLParagraphElement = document.createElement('p');
  dialogue.className = 'companion-dialogue';
  dialogue.setAttribute('role', 'status');
  dialogue.setAttribute('aria-live', 'polite');
  dialogue.setAttribute('aria-atomic', 'true');
  card.append(dialogue);
  workSelect.className = 'work-animation';
  workSelect.setAttribute('aria-label', 'Pikachu work animation');
  workSelect.innerHTML = '<button type="button" value="walk">Walk</button><button type="button" value="shock">Shock</button><button type="button" value="tumbleback">Tumble</button>';
  workSelect.hidden = species.id !== 25;
  workSelect.disabled = true;
  select.disabled = true;
  const companion: Companion = {
    row, card, select, species, workSelect, workAnimation: 'shock',
    title: card.querySelector('h2')!,
    agentBadge: card.querySelector('.agent-icon')!,
    status: card.querySelector('.state-label')!,
    dialogue,
    focus: card.querySelector('.habitat')!,
    grip: card.querySelector('.drag-grip')!,
    signal: card.querySelector('.signal')!,
    sprite: card.querySelector('.sprite')!,
    animation: null, saving: false, choiceRevision: 0, storageKey, disposed: false
  };
  workSelect.addEventListener('click', async (event: MouseEvent): Promise<void> => {
    const button: HTMLButtonElement | null = event.target instanceof Element ? event.target.closest('button') : null;
    if (!button || !workSelect.contains(button)) return;
    if (companion.disposed || companion.saving || companion.species.id !== 25) return;
    if (workSelect.contains(document.activeElement)) speciesPanel.focus({ preventScroll: true });
    const next: Companion['workAnimation'] = button.value === 'walk' || button.value === 'tumbleback' ? button.value : 'shock';
    companion.saving = true;
    paintSaveStatus(companion, 'Saving…', true);
    companion.choiceRevision++;
    workSelect.disabled = true;
    try {
      await orca.host.call('storage.set', { key: `${companion.storageKey}.work`, value: next });
      if (companion.disposed) return;
      companion.workAnimation = next;
      if (!paused && !reducedMotion.matches) {
        companion.focus.classList.add('selection-hop');
        companion.focus.addEventListener('animationend', (): void => {
          companion.focus.classList.remove('selection-hop');
        }, { once: true });
      }
      operationError = '';
      paintError();
      if (speciesOwner === companion) {
        companion.select.disabled = false;
        closeSpecies(speciesPanel.contains(document.activeElement));
      }
    } catch (error: unknown) {
      if (!companion.disposed) {
        showError(error);
        paintSaveStatus(companion, 'Save failed. Try again.');
      }
    } finally {
      companion.saving = false;
      if (!companion.disposed) {
        companion.select.disabled = false;
        animateSprite(companion);
        if (speciesOwner === companion && !battleWork.hidden && speciesPanel.contains(document.activeElement)) {
          button.focus({ preventScroll: true });
        }
        void loadChoice(companion);
      }
    }
  });
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
    const cards: Element[] = Array.from(card.parentElement!.children).filter((item: Element): boolean => !(item as HTMLElement).hidden);
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
    if (speciesOwner === companion) showBattlePage('species');
  });
  select.addEventListener('click', (): void => { openSpecies(companion); });
  projects.get(row.projectId)!.list.append(card);
  void loadChoice(companion);
  return companion;
}

function agentBrand(agent: string): string {
  const name: string = agent.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  if (name.includes('claude')) return 'claude';
  if (name.includes('codex') || name.includes('openai')) return 'codex';
  if (name.includes('opencode')) return 'opencode';
  if (name.includes('gemini')) return 'gemini';
  if (name.includes('github copilot') || name.includes('copilot')) return 'copilot';
  if (name.includes('cursor')) return 'cursor';
  if (name.includes('kilo') || name.includes('kilocode')) return 'kilocode';
  if (name.includes('roo code') || name.includes('roocode')) return 'roocode';
  if (name.includes('windsurf')) return 'windsurf';
  if (name.includes('cline')) return 'cline';
  if (name.split(' ').includes('amp')) return 'amp';
  if (name.includes('devin')) return 'devin';
  if (name.includes('trae')) return 'trae';
  if (name.includes('zencoder')) return 'zencoder';
  if (name.includes('lovable')) return 'lovable';
  return 'unknown';
}

function paintCompanion(companion: Companion, row: AgentRow): void {
  const changed: boolean = companion.row.state !== row.state;
  companion.row = row;
  companion.card.dataset.state = row.state;
  companion.title.textContent = row.title;
  companion.title.title = row.title;
  companion.agentBadge.dataset.agent = agentBrand(row.agent);
  companion.agentBadge.setAttribute('aria-label', `${row.agent} agent details`);
  if (tooltipOwner === companion) showWorkspaceTooltip(companion);
  companion.status.textContent = labels[row.state];
  companion.status.parentElement!.title = labels[row.state];
  companion.grip.setAttribute('aria-label', `Rearrange ${row.title}`);
  companion.focus.setAttribute('aria-label', `Focus ${row.title} in ${row.workspace}`);
  companion.focus.title = `Focus ${row.title}`;
  companion.select.setAttribute('aria-label', `Pokémon for ${row.title} in ${row.workspace}`);
  companion.signal.textContent = row.state === 'blocked' ? '!' : row.state === 'done' ? 'zz' : row.state === 'waiting' ? '?' : '';
  if (row.state !== 'blocked') companion.signal.classList.remove('state-pop');
  if (changed && row.state === 'blocked' && !paused && !reducedMotion.matches) {
    companion.signal.classList.add('state-pop');
    companion.signal.addEventListener('animationend', (): void => {
      companion.signal.classList.remove('state-pop');
    }, { once: true });
  }
  if (changed || !companion.sprite.style.backgroundImage) animateSprite(companion);
}

function updateVisibility(): void {
  const focused: Element | null = document.activeElement;
  let focusHidden: boolean = false;
  let visible: number = 0;
  for (const companion of companions.values()) {
    companion.card.hidden = statusFilter !== 'all' && (statusFilter === 'idle'
      ? companion.row.state !== 'waiting' && companion.row.state !== 'done'
      : companion.row.state !== statusFilter);
    if (!companion.card.hidden) { visible++; continue; }
    if (companion.card.contains(focused) || (speciesOwner === companion && speciesPanel.contains(focused))) focusHidden = true;
    if (speciesOwner === companion) closeSpecies();
    if (tooltipOwner === companion) hideWorkspaceTooltip();
  }
  for (const project of projects.values()) {
    const shown: number = Array.from(project.list.children).filter((card: Element): boolean => !(card as HTMLElement).hidden).length;
    project.section.hidden = shown === 0;
    if (project.section.hidden && project.section.contains(focused)) focusHidden = true;
    project.count.textContent = statusFilter === 'all' ? String(project.list.children.length) : `${shown}/${project.list.children.length}`;
    project.toggle.setAttribute('aria-label', `${project.name}, ${shown}${statusFilter === 'all' ? '' : ` of ${project.list.children.length}`} agent${shown === 1 ? '' : 's'}`);
  }
  for (const companion of companions.values()) syncSpriteMotion(companion);
  if (dragged?.card.hidden || draggedProject?.section.hidden) finishDrag();
  if (focusHidden) viewButton.focus();
  element('filter-empty').hidden = companions.size === 0 || visible !== 0;
  clearFilter.hidden = statusFilter === 'all';
  const filterLabel: string = filterSelect.selectedOptions[0].textContent!;
  if (activeFilterLabel.textContent !== filterLabel) activeFilterLabel.textContent = filterLabel;
  clearFilter.title = clearFilter.ariaLabel = `Clear status filter: ${filterLabel}`;
  viewButton.dataset.active = String(statusFilter !== 'all' || sortMode !== 'manual');
  viewButton.title = `Filter and sort agents: ${filterSelect.selectedOptions[0].textContent}, ${sortSelect.selectedOptions[0].textContent}`;
  const blocked: number = [...companions.values()].filter((companion: Companion): boolean => companion.row.state === 'blocked').length;
  const count: string = statusFilter === 'all' ? String(companions.size) : `${visible}/${companions.size}`;
  const message: string = `${count} companion${companions.size === 1 ? '' : 's'}${rosterStale ? ' · stale' : statusFilter !== 'all' ? '' : blocked ? ` · ${blocked} need${blocked === 1 ? 's' : ''} you` : ' · live'}`;
  if (summary.textContent !== message) summary.textContent = message;
}

function setStatusFilter(value: string): void {
  statusFilter = value === 'working' || value === 'blocked' || value === 'idle' ? value : 'all';
  filterSelect.value = statusFilter;
  finishDrag();
  updateVisibility();
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
      const update: { revision: number; state: AgentRow['state'] } | undefined = statusUpdates.get(JSON.stringify([row.workspaceId, row.paneKey]));
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
    arrangeCards(sortRequested);
    if (focusedBeforeRefresh?.isConnected && document.activeElement !== focusedBeforeRefresh) {
      const group: ProjectGroup | undefined = Array.from(projects.values()).find((project: ProjectGroup): boolean => project.section.contains(focusedBeforeRefresh));
      const restore: HTMLElement | null = focusedBeforeRefresh.closest('.agent-card[hidden], .project-group[hidden]') ? viewButton : group?.list.hidden ? group.toggle : focusedBeforeRefresh instanceof HTMLButtonElement && focusedBeforeRefresh.disabled ? focusedBeforeRefresh.closest('.agent-card')?.querySelector('.species-picker') ?? null : focusedBeforeRefresh;
      restore?.focus({ preventScroll: restore !== viewButton });
    }
    sortRequested = false;
  } catch (error: unknown) {
    rosterStale = true;
    rosterError = error instanceof Error ? error.message : String(error);
    paintError();
    if (companions.size) updateVisibility();
    else if (summary.textContent !== 'Roster unavailable') summary.textContent = 'Roster unavailable';
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
  const event: { paneKey?: unknown; workspaceId?: unknown; state?: unknown } = payload as { paneKey?: unknown; workspaceId?: unknown; state?: unknown };
  if (typeof event.paneKey !== 'string') return;
  const workspaceId: string | undefined = typeof event.workspaceId === 'string' ? event.workspaceId : undefined;
  const matches: Companion[] = Array.from(companions.values()).filter((companion: Companion): boolean =>
    companion.row.paneKey === event.paneKey && (workspaceId === undefined || companion.row.workspaceId === workspaceId));
  if (workspaceId === undefined && matches.length !== 1) { scheduleRefresh(); return; }
  const key: string = JSON.stringify([workspaceId ?? matches[0].row.workspaceId, event.paneKey]);
  const state: AgentRow['state'] = agentState(event.state);
  statusUpdates.set(key, { revision: ++statusRevision, state });
  for (const companion of matches) {
    paintCompanion(companion, { ...companion.row, state });
  }
  updateVisibility();
  scheduleRefresh();
}

async function start(): Promise<void> {
  viewPanel.addEventListener('toggle', (): void => {
    const open: boolean = viewPanel.matches(':popover-open');
    viewButton.setAttribute('aria-expanded', String(open));
    if (!open) return;
    closeSpecies();
    hideWorkspaceTooltip();
    const anchor: DOMRect = viewButton.getBoundingClientRect();
    viewPanel.style.left = `${Math.max(8, Math.min(anchor.right - viewPanel.offsetWidth, innerWidth - viewPanel.offsetWidth - 8))}px`;
    viewPanel.style.top = `${Math.max(8, Math.min(anchor.bottom + 6, innerHeight - viewPanel.offsetHeight - 8))}px`;
    filterSelect.focus({ preventScroll: true });
  });
  const usageButton: HTMLButtonElement = element('usage-help');
  const usageTooltip: HTMLElement = element('usage-tooltip');
  let usageHideTimer: ReturnType<typeof setTimeout> | undefined;
  function showUsage(): void {
    clearTimeout(usageHideTimer);
    usageTooltip.showPopover();
  }
  function hideUsageSoon(): void {
    clearTimeout(usageHideTimer);
    usageHideTimer = setTimeout((): void => { usageTooltip.hidePopover(); }, 100);
  }
  usageButton.removeAttribute('popovertarget');
  usageButton.removeAttribute('title');
  usageButton.setAttribute('aria-describedby', 'usage-tooltip');
  usageButton.addEventListener('pointerenter', showUsage);
  usageButton.addEventListener('pointerleave', hideUsageSoon);
  usageTooltip.addEventListener('pointerenter', showUsage);
  usageTooltip.addEventListener('pointerleave', hideUsageSoon);
  usageButton.addEventListener('focus', showUsage);
  usageButton.addEventListener('click', showUsage);
  usageButton.addEventListener('blur', (): void => { usageTooltip.hidePopover(); });
  list.parentElement!.addEventListener('scroll', (): void => { closeSpecies(speciesPanel.contains(document.activeElement)); });
  new ResizeObserver((): void => { closeSpecies(speciesPanel.contains(document.activeElement)); }).observe(list.parentElement!);
  list.addEventListener('dragstart', (): void => { closeSpecies(); });
  list.addEventListener('click', (event: MouseEvent): void => {
    if (event.target instanceof Element && event.target.closest('.project-toggle')) closeSpecies();
  });
  window.addEventListener('resize', (): void => { closeSpecies(speciesPanel.contains(document.activeElement)); viewPanel.hidePopover(); });
  document.addEventListener('visibilitychange', (): void => { closeSpecies(); viewPanel.hidePopover(); });
  list.parentElement!.addEventListener('scroll', hideWorkspaceTooltip);
  new ResizeObserver(hideWorkspaceTooltip).observe(list.parentElement!);
  list.addEventListener('pointerdown', hideWorkspaceTooltip);
  list.addEventListener('dragstart', hideWorkspaceTooltip);
  window.addEventListener('resize', hideWorkspaceTooltip);
  document.addEventListener('keydown', (event: KeyboardEvent): void => {
    if (event.isComposing || event.key !== 'Escape') return;
    if (event.target instanceof Element && event.target.closest('dialog:modal')) return;
    hideWorkspaceTooltip();
    if (speciesOwner) { event.preventDefault(); closeSpecies(true); }
  });
  updateMotion();
  refreshButton.addEventListener('click', async (): Promise<void> => {
    sortRequested = true;
    audioVisualizer?.refresh();
    if (!cardOrderWritable || !projectOrderWritable) {
      refreshButton.disabled = true;
      await loadManualOrder();
    }
    await refresh();
  });
  sortSelect.addEventListener('change', (): void => {
    sortMode = sortSelect.value === 'attention' || sortSelect.value === 'name' ? sortSelect.value : 'manual';
    finishDrag();
    arrangeCards(true);
  });
  filterSelect.addEventListener('change', (): void => {
    setStatusFilter(filterSelect.value);
  });
  clearFilter.addEventListener('click', (): void => {
    setStatusFilter('all');
    viewButton.focus();
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
      if (orderSaving || dragged || draggedProject || orderDirty.size) orderReloadPending = true;
      else void loadManualOrder();
    }
    audioVisualizer?.preferenceChanged(event.key);
    for (const companion of companions.values()) {
      if ((companion.storageKey === event.key || `${companion.storageKey}.work` === event.key) && !companion.saving) void loadChoice(companion);
    }
  });
  document.addEventListener('visibilitychange', (): void => {
    hideWorkspaceTooltip();
    for (const companion of companions.values()) syncSpriteMotion(companion);
    if (!document.hidden) scheduleRefresh();
  });
  window.addEventListener('focus', scheduleRefresh);
  window.addEventListener('pageshow', scheduleRefresh);
  await loadManualOrder();
  await refresh();
}

void start().catch(showError);
