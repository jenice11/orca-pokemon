import type { AgentRow, Roster } from '../model.ts';
import { POKEMON, type Pokemon, type SpriteAnimation } from '../panel/sprites.ts';

interface Fixture {
  agents: AgentRow[];
  failStorage: boolean;
  failRoster: boolean;
  notifyStorage(key: string): void;
  calls: { name?: string; method?: string; params?: { key: string } }[];
  emit(event: string, payload: unknown): void;
}

declare const fixture: Fixture;
declare const orca: {
  plugin: { request(name: string, input?: unknown): Promise<unknown> };
  host: { call(method: string, params: unknown): Promise<unknown> };
};

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function until(condition: () => boolean): Promise<void> {
  for (let frame: number = 0; frame < 120; frame++) {
    if (condition()) return;
    await new Promise<number>(requestAnimationFrame);
  }
  throw new Error('Browser test did not settle within 120 frames.');
}

function button(id: string): HTMLButtonElement { return document.getElementById(id) as HTMLButtonElement; }
function select(): HTMLButtonElement { return document.querySelector('.species-picker')!; }
function searchSpecies(query: string): void {
  if (!document.getElementById('battle-menu')!.hidden) button('battle-pokemon').click();
  const search: HTMLInputElement = document.querySelector('#species-search')!;
  search.value = query;
  search.dispatchEvent(new Event('input'));
}
function chooseSpecies(query: string): void {
  select().click();
  searchSpecies(query);
  (document.querySelector('#species-results button') as HTMLButtonElement).click();
}
function firstCard(): HTMLElement { return document.querySelector('.agent-card')!; }
async function refresh(): Promise<void> {
  await until((): boolean => !button('refresh').disabled);
  button('refresh').click();
  await until((): boolean => !button('refresh').disabled);
}

export async function runChoiceReadRaces(): Promise<string> {
  await until((): boolean => document.querySelectorAll('.species-picker:enabled').length === 4);
  const key: string = firstCard().dataset.orderKey!;
  const call: typeof orca.host.call = orca.host.call;
  for (let index: number = 0; index < 2; index++) {
    const delayedKey: string = index === 0 ? key : `${key}.work`;
    const species: Pokemon = POKEMON.find((pokemon: Pokemon): boolean => pokemon.id === (index === 0 ? 25 : 133))!;
    let rejectOld: ((reason: Error) => void) | undefined;
    orca.host.call = async (method: string, params: unknown): Promise<unknown> => {
      if (method === 'storage.get' && (params as { key: string }).key === delayedKey && !rejectOld) {
        return new Promise<unknown>((_, reject): void => { rejectOld = reject; });
      }
      return call(method, params);
    };
    try {
      fixture.notifyStorage(key);
      await until((): boolean => rejectOld !== undefined);
      await call('storage.set', { key, value: species.id });
      await until((): boolean => select().title.includes(species.name));
      rejectOld!(new Error('Obsolete choice read failed'));
      await new Promise<number>(requestAnimationFrame);
      check(document.getElementById('error')!.hidden, 'Obsolete species and work reads must not report errors after a newer successful read.');
    } finally { orca.host.call = call; }
  }
  orca.host.call = async (method: string, params: unknown): Promise<unknown> => {
    if (method === 'storage.get' && (params as { key: string }).key === `${key}.work`) throw new Error('Current work read failed');
    return call(method, params);
  };
  try {
    fixture.notifyStorage(`${key}.work`);
    await until((): boolean => !document.getElementById('error')!.hidden);
    check(document.getElementById('error')!.textContent!.includes('Current work read failed'), 'Current read failures must remain visible.');
  } finally { orca.host.call = call; }
  return 'obsolete choice-read errors stay hidden while current failures remain visible';
}

export async function run(): Promise<string[]> {
  const passed: string[] = [];
  const reduceMotion: boolean = matchMedia('(prefers-reduced-motion: reduce)').matches;
  await until((): boolean => document.querySelectorAll('.agent-card').length === 4 && !select().disabled);
  await orca.host.call('storage.set', { key: 'cards.order.v1', value: [] });
  await until((): boolean => firstCard().querySelector('h2')!.textContent === fixture.agents[0].title);
  for (const event of ['focus', 'pageshow']) {
    const rosterCalls: number = fixture.calls.filter((call): boolean => call.name === 'roster').length;
    window.dispatchEvent(new Event(event));
    await until((): boolean => fixture.calls.filter((call): boolean => call.name === 'roster').length > rosterCalls);
  }
  const rosterRequests = (): number => fixture.calls.filter((call): boolean => call.name === 'roster').length;
  const refreshIdle = (): boolean => !(document.getElementById('refresh') as HTMLButtonElement).disabled;
  let repaints: number = 0;
  const repaintWatcher: MutationObserver = new MutationObserver((records: MutationRecord[]): void => { repaints += records.length; });
  // paintCompanion rewrites data-state on every repaint, even when the value is unchanged.
  repaintWatcher.observe(firstCard(), { attributes: true, attributeFilter: ['data-state'] });
  const requestsBeforeSame: number = rosterRequests();
  window.dispatchEvent(new Event('focus'));
  await until((): boolean => rosterRequests() > requestsBeforeSame);
  await until(refreshIdle);
  await new Promise<void>((resolve): void => { setTimeout(resolve, 0); });
  check(repaints === 0, 'A refresh that returns an unchanged roster must not repaint cards.');
  const originalState: AgentRow['state'] = fixture.agents[0].state;
  fixture.agents[0].state = originalState === 'working' ? 'done' : 'working';
  window.dispatchEvent(new Event('focus'));
  await until((): boolean => repaints > 0);
  fixture.agents[0].state = originalState;
  window.dispatchEvent(new Event('focus'));
  await until((): boolean => firstCard().dataset.state === originalState);
  await until(refreshIdle);
  repaintWatcher.disconnect();
  const liveDialogue: HTMLElement = firstCard().querySelector('.companion-dialogue')!;
  check(liveDialogue.getAttribute('role') === 'status' && liveDialogue.getAttribute('aria-live') === 'polite' &&
    liveDialogue.getAttribute('aria-atomic') === 'true', 'Dialogue changes must expose a polite, complete status announcement.');
  let repeatedAnnouncements: number = 0;
  const announcements: MutationObserver = new MutationObserver((records: MutationRecord[]): void => { repeatedAnnouncements += records.length; });
  announcements.observe(liveDialogue, { childList: true, characterData: true, subtree: true });
  announcements.observe(document.getElementById('summary')!, { childList: true, characterData: true, subtree: true });
  await refresh();
  await Promise.resolve();
  announcements.disconnect();
  check(repeatedAnnouncements === 0, 'Refreshing unchanged agents must not repeat dialogue or summary announcements.');
  if (reduceMotion) {
    check(document.body.classList.contains('paused') && document.getAnimations().every((animation: Animation): boolean => animation.playState !== 'running'), 'Reduced motion must start with sprite and status animations stopped.');
  } else check(document.getAnimations().length >= 4, 'Sprite and status animations must run.');
  check(document.documentElement.scrollWidth <= innerWidth, 'Panel must not overflow horizontally.');
  check(document.querySelector('.card-bottom') === null, 'Species controls must not reserve a bottom row on every card.');
  check(getComputedStyle(document.querySelector('.habitat')!).height === '72px', 'Agent cards must use the compact sprite area.');
  const dialogueStyle: CSSStyleDeclaration = getComputedStyle(liveDialogue);
  check(dialogueStyle.fontSize === '10px' && liveDialogue.offsetHeight + parseFloat(dialogueStyle.marginTop) +
    parseFloat(dialogueStyle.marginBottom) <= 27, 'Single-line dialogue must stay compact without shrinking text.');
  check(getComputedStyle(document.querySelector('main')!).padding === '10px' &&
    getComputedStyle(document.getElementById('agents')!).gap === '6px' &&
    getComputedStyle(document.querySelector('.project-agents')!).gap === '6px', 'Roster padding and gaps must preserve panel space.');
  for (const control of Array.from(document.querySelectorAll<HTMLButtonElement>('.bottom-bar-controls > button:not([hidden])'))) {
    const icon: DOMRect = control.querySelector('svg')!.getBoundingClientRect();
    const text: DOMRect = control.querySelector('span')!.getBoundingClientRect();
    check(control.getBoundingClientRect().height === 40 && icon.right <= text.left &&
      Math.abs(icon.top + icon.height / 2 - text.top - text.height / 2) <= 1,
    'Footer controls must keep 40px targets with icons beside their labels.');
  }
  check(document.querySelector('.toolbar')!.contains(button('view-options-button')) && document.querySelector('.toolbar')!.contains(button('motion')), 'Count, Filter and sort, and Pause must share one toolbar.');
  const summaryControl: HTMLElement = document.getElementById('summary')!;
  const sortControl: HTMLSelectElement = document.getElementById('agent-sort') as HTMLSelectElement;
  const originalSummary: string = summaryControl.textContent!;
  const originalSort: string = sortControl.value;
  check(document.getElementById('view-options')!.contains(sortControl) && sortControl.getClientRects().length === 0,
    'Sort options must live in the closed popover, not reserve toolbar space.');
  try {
    for (const message of ['2 companions · live', '4 companions · 1 needs you', '100 companions · stale']) {
      summaryControl.textContent = message;
      for (const mode of ['manual', 'attention', 'name']) {
        sortControl.value = mode;
        const summaryBounds: DOMRect = summaryControl.getBoundingClientRect();
        const sortBounds: DOMRect = button('view-options-button').getBoundingClientRect();
        const motionBounds: DOMRect = button('motion').getBoundingClientRect();
        const toolbarBounds: DOMRect = document.querySelector('.toolbar')!.getBoundingClientRect();
        check(Math.abs(summaryBounds.top + summaryBounds.height / 2 - motionBounds.top - motionBounds.height / 2) <= 1 &&
          Math.abs(sortBounds.top + sortBounds.height / 2 - motionBounds.top - motionBounds.height / 2) <= 1 &&
          Math.abs(motionBounds.right - toolbarBounds.right) <= 1 && summaryBounds.right <= sortBounds.left &&
          sortBounds.right <= motionBounds.left && toolbarBounds.height <= motionBounds.height + 1,
        'Count, Filter and sort icon, and Pause must share exactly one row without overlaps or extra height.');
      }
    }
  } finally { summaryControl.textContent = originalSummary; sortControl.value = originalSort; }
  check(document.getElementById('order-note') === null && document.querySelector('header > p') === null, 'Permanent help text and the header subtitle must not consume panel space.');
  const usageTooltip: HTMLElement = document.getElementById('usage-tooltip')!;
  check(usageTooltip.hasAttribute('popover') && !usageTooltip.matches(':popover-open') && usageTooltip.getClientRects().length === 0, 'Usage help must stay out of the layout until requested.');
  check(getComputedStyle(document.querySelector('h1')!).fontSize === '18px', 'Panel heading must use the compact size.');
  const originalWorkspace: string = fixture.agents[0].workspace;
  const originalAgent: string = fixture.agents[0].agent;
  const originalTitle: string = fixture.agents[0].title;
  fixture.agents[0].title = 'A very long agent task title that must truncate without widening the narrow panel';
  fixture.agents[0].workspace = 'A long workspace name that must remain on one line instead of expanding the agent card';
  fixture.agents[0].agent = 'A long agent label that must truncate instead of expanding the card';
  await refresh();
  check(document.documentElement.scrollWidth <= innerWidth, 'Long task and agent names must not widen the panel.');
  check(firstCard().scrollWidth <= firstCard().clientWidth, 'Long labels and dialogue must stay inside the card.');
  const agentIcon: HTMLButtonElement = firstCard().querySelector('.agent-icon')!;
  const areaBounds: DOMRect = firstCard().querySelector('.sprite-area')!.getBoundingClientRect();
  const iconBounds: DOMRect = agentIcon.getBoundingClientRect();
  check(firstCard().querySelector('.identity p') === null, 'Agent type must not reserve a text row in the card header.');
  check(Math.abs(iconBounds.right - (areaBounds.right - 10)) <= 1 && Math.abs(iconBounds.bottom - (areaBounds.bottom - 6)) <= 1, 'Agent icon must sit in the bottom-right of the sprite area.');
  const gripBounds: DOMRect = firstCard().querySelector('.drag-grip')!.getBoundingClientRect();
  const ballBounds: DOMRect = select().getBoundingClientRect();
  for (const bounds of [iconBounds, gripBounds, ballBounds]) {
    check(bounds.width === 24 && bounds.height === 24, 'Icon controls must share a 24px square click target.');
  }
  check(Math.abs(gripBounds.left + gripBounds.width / 2 - ballBounds.left - ballBounds.width / 2) <= 1, 'Drag grip and Poké Ball must share a vertical centerline.');
  check(Math.abs(ballBounds.bottom - iconBounds.bottom) <= 1, 'Lower icon controls must share a baseline.');
  check(agentIcon.dataset.agent === 'unknown' && agentIcon.getAttribute('aria-label')!.includes(fixture.agents[0].agent), 'Unknown agent types must use a neutral fallback with the full accessible agent name.');
  const terminalFocusCalls: number = fixture.calls.filter((call): boolean => call.name === 'focus').length;
  agentIcon.click();
  check(fixture.calls.filter((call): boolean => call.name === 'focus').length === terminalFocusCalls, 'Clicking agent details must not focus the terminal.');
  const cardHeight: number = firstCard().offsetHeight;
  agentIcon.focus();
  const workspaceTooltip: HTMLElement | null = document.getElementById('workspace-tooltip');
  check(workspaceTooltip && !workspaceTooltip.hidden && workspaceTooltip.textContent === fixture.agents[0].agent, 'Agent icon tooltip must show only the agent name, without repeating project or workspace details.');
  agentIcon.dispatchEvent(new MouseEvent('mouseenter'));
  check(!workspaceTooltip.hidden, 'Moving the pointer onto a keyboard-focused workspace must keep its tooltip visible.');
  const tooltipBounds: DOMRect = workspaceTooltip.getBoundingClientRect();
  const rosterBounds: DOMRect = document.querySelector('main')!.getBoundingClientRect();
  check(tooltipBounds.width > 0 && tooltipBounds.left >= 0 && tooltipBounds.right <= innerWidth && tooltipBounds.top >= rosterBounds.top && tooltipBounds.bottom <= rosterBounds.bottom, 'Workspace tooltip must fit inside the visible roster area.');
  const workspaceBounds: DOMRect = agentIcon.getBoundingClientRect();
  const expectedLeft: number = Math.max(rosterBounds.left + 8, Math.min(workspaceBounds.left + workspaceBounds.width / 2 - tooltipBounds.width / 2, rosterBounds.right - tooltipBounds.width - 8));
  check(Math.abs(tooltipBounds.left - expectedLeft) <= 1, 'Workspace tooltip must center on its text and clamp at panel edges like Orca.');
  check(workspaceTooltip.dataset.side === 'top' && tooltipBounds.bottom < workspaceBounds.top, 'Workspace tooltip must prefer placement above its trigger.');
  check(firstCard().offsetHeight === cardHeight, 'Showing workspace details must not move other cards.');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  check(workspaceTooltip.hidden, 'Escape must dismiss workspace details.');
  agentIcon.blur();
  const hoverStarted: number = performance.now();
  agentIcon.dispatchEvent(new MouseEvent('mouseenter'));
  check(workspaceTooltip.hidden, 'Hover tooltip must wait instead of opening immediately.');
  await until((): boolean => !workspaceTooltip.hidden);
  check(performance.now() - hoverStarted >= 500, 'Hover tooltip must follow Orca\'s approximately 600ms delay.');
  check(!workspaceTooltip.hidden, 'Pointer entry must reveal the in-panel tooltip.');
  agentIcon.dispatchEvent(new MouseEvent('mouseleave', { relatedTarget: workspaceTooltip }));
  check(workspaceTooltip.hidden, 'Tooltip must close when leaving its trigger, like Orca\'s non-hoverable tooltip.');
  agentIcon.focus();
  const dock: HTMLElement = document.querySelector('.audio-card')!;
  const previousHeight: string = dock.style.height;
  if (!dock.hidden) {
    dock.style.height = `${dock.offsetHeight + 24}px`;
    await new Promise<number>(requestAnimationFrame);
    await new Promise<number>(requestAnimationFrame);
    check(workspaceTooltip.hidden, 'Changing Spotify height must dismiss stale tooltip geometry before it can overlap the dock.');
  }
  dock.style.height = previousHeight;
  const brandAgents: [string, string][] = [
    ['Claude Code', 'claude'],
    ['OpenAI Codex', 'codex'],
    ['OpenCode', 'opencode'],
    ['Gemini CLI', 'gemini'],
    ['GitHub Copilot', 'copilot'],
    ['Cursor', 'cursor'],
    ['Amp', 'amp'],
    ['Cline', 'cline'],
    ['Kilo Code', 'kilocode'],
    ['Roo Code', 'roocode'],
    ['Windsurf', 'windsurf'],
    ['Devin', 'devin'],
    ['Trae', 'trae'],
    ['Zencoder', 'zencoder'],
    ['Lovable', 'lovable']
  ];
  for (const [agentName, brand] of brandAgents) {
    fixture.agents[0].agent = agentName;
    await refresh();
    const mark: HTMLElement = firstCard().querySelector('.agent-icon')!;
    check(mark.dataset.agent === brand, `${agentName} must use the ${brand} brand mark.`);
    check(getComputedStyle(mark, '::before').maskImage.includes(`/assets/agents/${brand}.svg`), `${brand} must use a local theme-aware SVG mask.`);
  }
  fixture.agents[0].agent = 'Example';
  await refresh();
  check(firstCard().querySelector<HTMLElement>('.agent-icon')!.dataset.agent === 'unknown', 'Unknown agent names containing "amp" must keep the neutral fallback.');
  fixture.agents[0].workspace = originalWorkspace;
  fixture.agents[0].agent = originalAgent;
  fixture.agents[0].title = originalTitle;
  await refresh();
  agentIcon.focus();
  check(workspaceTooltip.getBoundingClientRect().width < rosterBounds.width, 'Short workspace details must use a content-sized tooltip rather than span the panel.');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  for (const card of Array.from(document.querySelectorAll<HTMLElement>('.agent-card'))) {
    const mark: HTMLElement = card.querySelector('.agent-icon')!;
    const brand: string = mark.dataset.agent!;
    check(['claude', 'codex', 'opencode', 'amp', 'cline', 'copilot', 'cursor', 'devin', 'gemini', 'kilocode', 'lovable', 'roocode', 'trae', 'windsurf', 'zencoder'].includes(brand), 'Known fixture agents must use their own brand marks.');
    check(getComputedStyle(mark, '::before').maskImage.includes(`/assets/agents/${brand}.svg`), 'Brand mark must use a local, theme-aware SVG mask.');
    const iconImage: HTMLImageElement = new Image();
    iconImage.src = new URL(`../assets/agents/${brand}.svg`, import.meta.url).href;
    await iconImage.decode();
    if (brand === 'copilot') {
      const iconSource: string = await (await fetch(iconImage.src)).text();
      check(iconSource.includes('<title>GithubCopilot</title>'), 'Copilot must use the GitHub Copilot mark.');
    }
    const badge: HTMLElement = card.querySelector('.state')!;
    const style: CSSStyleDeclaration = getComputedStyle(badge);
    check(style.width === '10px' && style.height === '10px' && style.borderRadius === '50%', 'Every agent state must use a circle.');
    const header: HTMLElement = badge.parentElement!;
    check(Math.abs(badge.offsetLeft + badge.offsetWidth - (header.offsetLeft + header.offsetWidth - parseFloat(getComputedStyle(header).paddingRight))) <= 1, 'Agent indicator must stay on the right, including in narrow panels.');
    check(getComputedStyle(badge.querySelector('.state-label')!).clipPath === 'inset(50%)', 'State text must stay accessible but visually hidden.');
    if (card.dataset.state === 'working') {
      check(style.animationName === (reduceMotion ? 'none' : 'agent-working') && style.borderTopColor === 'rgb(217, 119, 6)', 'Working must use an orange indicator and respect reduced motion.');
    } else if (card.dataset.state === 'blocked') {
      check(style.backgroundColor === 'rgb(220, 38, 38)', 'Permission and prompt requests must use red.');
    } else if (card.dataset.state === 'done') {
      check(style.backgroundColor === 'rgb(22, 163, 74)', 'Done must use green.');
      check(getComputedStyle(card.querySelector('.sprite')!).backgroundImage.includes('Sleep'), 'Done companions must use sleeping sprites.');
    }
    check(getComputedStyle(card.querySelector('.companion-dialogue')!).backgroundColor === 'rgb(32, 35, 42)', 'Dialogue must keep a dark background.');
  }
  passed.push('four states render with animations and no horizontal overflow');

  check(!firstCard().querySelector('details, summary'), 'Species picker must not use an actions menu.');
  check(POKEMON.some((species: Pokemon): boolean => select().title.includes(species.name)), 'Trigger must name the current species.');
  check(Boolean(select().getAttribute('aria-label')), 'Species picker must have an accessible label.');
  check(select().getAttribute('aria-haspopup') === 'dialog' && select().getAttribute('aria-controls') === 'species-panel', 'Trigger must announce its search dialog.');
  check(Boolean(firstCard().querySelector('.species-control .pokeball[aria-hidden="true"]')), 'Poké Ball trigger must not add another row.');
  const titleBounds: DOMRect = firstCard().querySelector('h2')!.getBoundingClientRect();
  (firstCard().querySelector('.habitat') as HTMLButtonElement).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  check(document.activeElement === document.querySelector('#species-search'), 'Right-click must open search.');
  check(Boolean(document.querySelector('#species-results [aria-selected="true"]')), 'Current species must be marked.');
  searchSpecies('NOT A POKEMON');
  check(!document.getElementById('species-empty')!.hidden && !document.querySelector('#species-results button'), 'No-match search must show an empty state.');
  searchSpecies('PIKA');
  check(document.querySelector('#species-results')!.children.length === 1, 'Search must ignore case.');
  const callsBeforeComposition: number = fixture.calls.filter((call): boolean => call.method === 'storage.set').length;
  document.getElementById('species-search')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }));
  check(fixture.calls.filter((call): boolean => call.method === 'storage.set').length === callsBeforeComposition, 'Composition-confirming Enter must not choose a species.');
  const openTitleBounds: DOMRect = firstCard().querySelector('h2')!.getBoundingClientRect();
  check(titleBounds.width === openTitleBounds.width && titleBounds.height === openTitleBounds.height, 'Opening the picker must not squeeze or rewrap the title.');
  const pickerBounds: DOMRect = select().getBoundingClientRect();
  const spriteAreaBounds: DOMRect = firstCard().querySelector('.sprite-area')!.getBoundingClientRect();
  check(pickerBounds.left >= spriteAreaBounds.left && pickerBounds.bottom <= spriteAreaBounds.bottom && pickerBounds.top >= spriteAreaBounds.top, 'Species picker must stay inside the lower-left sprite area.');
  document.getElementById('species-search')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  document.getElementById('species-search')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await until((): boolean => !document.querySelector('#species-panel')!.matches(':popover-open'));
  check(document.activeElement === select(), 'Successful selection must restore trigger focus.');
  check(select().title.includes('Pikachu'), 'Saved trigger must name the new species.');
  await refresh();
  check(select().title.includes('Pikachu'), 'Species choice must survive refresh.');
  select().click();
  check(!document.getElementById('battle-menu')!.hidden, 'Poké Ball must open the battle commands first.');
  check(getComputedStyle(document.getElementById('species-panel')!).backgroundColor === 'rgb(32, 35, 42)', 'Popup must use the dark palette.');
  button('battle-fight').dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
  check(document.activeElement === button('battle-fight'), 'Hover must move the menu cursor.');
  button('battle-pokemon').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  check(document.activeElement === button('battle-fight'), 'Arrow keys must move focus between battle commands.');
  button('battle-fight').click();
  const workAnimation: HTMLFieldSetElement = document.querySelector('#battle-work .work-animation')!;
  check(!workAnimation.hidden && workAnimation.querySelector('button[aria-pressed="true"]')?.getAttribute('value') === 'shock', 'Pikachu must expose work animation buttons, defaulting to Shock.');
  check(workAnimation.querySelectorAll('button').length === 3, 'Work animation must offer three buttons.');
  const workButtons: HTMLButtonElement[] = Array.from(workAnimation.querySelectorAll('button'));
  check(workButtons[0].offsetTop === workButtons[1].offsetTop && workButtons[2].offsetTop > workButtons[0].offsetTop &&
    workButtons[2].offsetLeft === workButtons[0].offsetLeft &&
    workButtons[1].getBoundingClientRect().left >= workButtons[0].getBoundingClientRect().right, 'Work choices must use a two-column layout without overlap.');
  for (const choice of Array.from(workAnimation.querySelectorAll('button'))) {
    check(choice.scrollWidth <= choice.clientWidth, 'Work button labels must fit without clipping.');
  }
  workAnimation.querySelector<HTMLButtonElement>('button[value="shock"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  check(document.activeElement === workAnimation.querySelector('button[value="tumbleback"]'), 'Arrow keys must move focus between animation buttons.');
  check(workAnimation.querySelector('button[aria-pressed="true"]')?.getAttribute('value') === 'shock', 'Moving the cursor must not change the saved animation.');
  const walkButton: HTMLButtonElement = workAnimation.querySelector('button[value="walk"]')!;
  fixture.failStorage = true;
  walkButton.focus();
  walkButton.click();
  await until((): boolean => !workAnimation.disabled);
  check(document.getElementById('species-panel')!.matches(':popover-open') && document.activeElement === walkButton, 'Failed work saves must keep the menu open and restore the chosen button focus.');
  const saveStatus: HTMLElement = document.getElementById('battle-save-status')!;
  check(saveStatus.getAttribute('role') === 'status' && saveStatus.getAttribute('aria-live') === 'polite' &&
    !saveStatus.hidden && saveStatus.textContent === 'Save failed. Try again.', 'Save failures must expose a visible polite announcement.');
  check(getComputedStyle(walkButton).outlineStyle !== 'none', 'Failed work saves must retain a visible focus outline.');
  fixture.failStorage = false;
  const saveCall: typeof orca.host.call = orca.host.call;
  let releaseSave: (() => void) | undefined;
  orca.host.call = async (method: string, params: unknown): Promise<unknown> => {
    if (method === 'storage.set' && (params as { key: string }).key.endsWith('.work')) {
      await new Promise<void>((resolve): void => { releaseSave = resolve; });
    }
    return saveCall(method, params);
  };
  walkButton.click();
  await until((): boolean => releaseSave !== undefined);
  button('motion').focus();
  releaseSave!();
  await until((): boolean => !workAnimation.disabled);
  check(!document.getElementById('species-panel')!.matches(':popover-open') && document.activeElement === button('motion'), 'Successful work saves must not steal focus moved outside while saving.');
  releaseSave = undefined;
  select().click();
  button('battle-fight').click();
  walkButton.focus();
  walkButton.click();
  await until((): boolean => releaseSave !== undefined);
  document.getElementById('species-panel')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  check(document.activeElement === select(), 'Escape during a pending save must restore Poké Ball focus.');
  releaseSave!();
  await until((): boolean => !workAnimation.disabled);
  orca.host.call = saveCall;
  select().click();
  button('battle-fight').click();
  workAnimation.querySelector<HTMLButtonElement>('button[value="walk"]')!.click();
  await until((): boolean => !workAnimation.disabled);
  check(!document.getElementById('species-panel')!.matches(':popover-open'), 'Saving a work animation must close the popup.');
  check(document.activeElement === select(), 'Saving a work animation must restore Poké Ball focus.');
  check(firstCard().querySelector('.companion-dialogue')!.textContent!.startsWith('Pikachu '), 'Status dialogue must name the current Pokémon.');
  if (!document.body.classList.contains('paused') && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    check(firstCard().querySelector('.habitat')!.classList.contains('selection-hop'), 'A successful animation choice must trigger a confirmation hop.');
    button('motion').click();
    check(!firstCard().querySelector('.habitat')!.classList.contains('selection-hop'), 'Pausing must clear the confirmation hop.');
    button('motion').click();
    check(!firstCard().querySelector('.habitat')!.classList.contains('selection-hop'), 'Resuming must not replay the confirmation hop.');
  }
  check(firstCard().querySelector<HTMLElement>('.sprite')!.dataset.turning === 'false', 'Walk must disable Shock turning.');
  check(fixture.calls.some((call): boolean => call.method === 'storage.set' && call.params!.key.endsWith('.work') && (call.params as { key: string; value?: unknown }).value === 'walk'), 'Work animation must save separately from species.');
  select().click();
  button('battle-fight').click();
  workAnimation.querySelector<HTMLButtonElement>('button[value="tumbleback"]')!.click();
  await until((): boolean => !workAnimation.disabled);
  const tumbleSprite: HTMLElement = firstCard().querySelector('.sprite')!;
  if (reduceMotion) {
    check(tumbleSprite.getAnimations().length === 0, 'Tumble must stay still with reduced motion.');
  } else {
    const tumbleAnimation: Animation = tumbleSprite.getAnimations()[0];
    tumbleAnimation.currentTime = 800;
    check(getComputedStyle(tumbleSprite).backgroundImage.includes('/Tumble-Anim.png'), 'Rightward travel must use Tumble.');
    tumbleAnimation.currentTime = 2400;
    check(getComputedStyle(tumbleSprite).backgroundImage.includes('/TumbleBack-Anim.png'), 'Leftward travel must use TumbleBack.');
  }
  select().click();
  button('battle-fight').click();
  workAnimation.querySelector<HTMLButtonElement>('button[value="shock"]')!.click();
  await until((): boolean => !workAnimation.disabled);
  passed.push('Pikachu work animation choice saves and switches immediately');
  check(!document.getElementById('battle-back'), 'Popup must not include a Back button.');
  document.getElementById('species-panel')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  check(fixture.calls.filter((call): boolean => call.method === 'storage.set').every((call): boolean => call.params!.key.length <= 256), 'Storage keys must be bounded.');
  (document.querySelector('.habitat') as HTMLButtonElement).click();
  await until((): boolean => !(document.querySelector('.habitat') as HTMLButtonElement).disabled);
  check(fixture.calls.some((call): boolean => call.name === 'focus'), 'Sprite click must request focus.');
  passed.push('species persistence and click-to-focus bridge');
  const lastMenu: HTMLElement = document.querySelector('.agent-card:last-child .species-picker')!;
  lastMenu.scrollIntoView({ block: 'nearest' });
  await new Promise<number>(requestAnimationFrame);
  lastMenu.click();
  const menuBounds: DOMRect = document.getElementById('species-panel')!.getBoundingClientRect();
  const scrollBounds: DOMRect = document.querySelector('main')!.getBoundingClientRect();
  check(menuBounds.left >= 0 && menuBounds.right <= innerWidth && menuBounds.top >= scrollBounds.top && menuBounds.bottom <= scrollBounds.bottom, 'Last-card species picker must remain reachable.');
  document.getElementById('species-search')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  check(document.activeElement === lastMenu && !document.getElementById('species-panel')!.matches(':popover-open'), 'Escape must close and restore trigger focus.');
  lastMenu.click();
  document.getElementById('species-search')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
  check(document.getElementById('species-panel')!.matches(':popover-open'), 'Tab must allow navigation between battle controls.');
  button('motion').focus();
  button('motion').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, isComposing: true }));
  check(document.getElementById('species-panel')!.matches(':popover-open'), 'Composing Escape outside the manual popup must not close it.');
  button('motion').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  check(!document.getElementById('species-panel')!.matches(':popover-open') && document.activeElement === lastMenu, 'Escape outside the manual popup must close it and restore trigger focus.');
  lastMenu.click();
  (lastMenu.closest('.project-group')!.querySelector('.project-toggle') as HTMLButtonElement).click();
  check(!document.getElementById('species-panel')!.matches(':popover-open'), 'Collapsing the owner project must close picker.');
  (lastMenu.closest('.project-group')!.querySelector('.project-toggle') as HTMLButtonElement).click();
  document.querySelector('main')!.scrollTop = 0;

  if (!document.body.classList.contains('paused')) button('motion').click();
  check(document.body.classList.contains('paused'), 'Pause must stop motion.');
  check(document.getAnimations().every((animation: Animation): boolean => animation.playState !== 'running'), 'Pause must stop sprite and CSS animations.');
  const pikachu: Pokemon = POKEMON.find((species: Pokemon): boolean => species.id === 25)!;
  for (const state of ['done', 'working'] as const) {
    fixture.agents[0].state = state;
    fixture.emit('agent.status.changed', { paneKey: 'tab:0', state });
    check(liveDialogue.textContent === (state === 'done' ? 'Pikachu done. Now rests.' : 'Pikachu works.'), 'Live dialogue must describe the current state.');
    const badge: HTMLElement = firstCard().querySelector('.state')!;
    const badgeStyle: CSSStyleDeclaration = getComputedStyle(badge);
    check(badge.textContent === (state === 'done' ? 'Done' : 'Working'), 'Status must retain its accessible text.');
    if (state === 'done') {
      check(badgeStyle.width === '10px' && badgeStyle.height === '10px' && badgeStyle.borderRadius === '50%', 'Done must render as a small circle.');
      check(getComputedStyle(badge.querySelector('.state-label')!).clipPath === 'inset(50%)', 'Done text must be visually hidden.');
    } else {
      check(getComputedStyle(badge.querySelector('.state-label')!).clipPath === 'inset(50%)', 'Working must keep the status text visually hidden.');
      check(badgeStyle.borderTopColor === 'rgb(217, 119, 6)' && badgeStyle.animationName === 'none', 'Paused working loader must retain its orange indicator without motion.');
    }
    const sprite: HTMLElement = firstCard().querySelector('.sprite')!;
    const sheet: SpriteAnimation = state === 'done' ? pikachu.animations.sleep : pikachu.animations.shock!;
    const image: HTMLImageElement = new Image();
    image.src = new URL(sheet.path, new URL('../panel/sprites.ts', import.meta.url)).href;
    await image.decode();
    const canvas: HTMLCanvasElement = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = sheet.height;
    const context: CanvasRenderingContext2D = canvas.getContext('2d')!;
    context.drawImage(image, 0, -sheet.row * sheet.height);
    const pixels: Uint8ClampedArray = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let lastOpaqueRow: number = -1;
    for (let y: number = 0; y < canvas.height; y++) {
      for (let x: number = 0; x < canvas.width; x++) {
        if (pixels[(y * canvas.width + x) * 4 + 3] > 0) lastOpaqueRow = y;
      }
    }
    check(lastOpaqueRow >= 0, `${state} animation must contain visible pixels.`);
    const spriteBounds: DOMRect = sprite.getBoundingClientRect();
    const groundBounds: DOMRect = firstCard().querySelector('.ground')!.getBoundingClientRect();
    const visibleBottom: number = spriteBounds.bottom - (sheet.height - 1 - lastOpaqueRow) * spriteBounds.height / sheet.height;
    const groundLevel: number = groundBounds.top + groundBounds.height / 2;
    const clearance: number = state === 'working' ? 2 * (sheet.scale ?? pikachu.scale) + 1 : 1;
    check(visibleBottom <= groundLevel + 1 && groundLevel - visibleBottom <= clearance, `${state} Pikachu must stay above the grass with only source-frame clearance, including while motion is paused.`);
  }
  passed.push('sleeping and working Pikachu touch grass with state-specific grounding');
  if (!reduceMotion) button('motion').click();
  passed.push('pause and resume all motion');

  const request: typeof orca.plugin.request = orca.plugin.request;
  let resolveRoster: ((roster: Roster) => void) | undefined;
  const oldRoster: Roster = { agents: fixture.agents.map((agent: AgentRow): AgentRow => ({ ...agent })), partial: false };
  orca.plugin.request = async (name: string, input?: unknown): Promise<unknown> => {
    if (name === 'roster' && !resolveRoster) return new Promise<Roster>((resolve): void => { resolveRoster = resolve; });
    return request(name, input);
  };
  button('refresh').click();
  await until((): boolean => resolveRoster !== undefined);
  fixture.agents[0].state = 'blocked';
  fixture.emit('agent.status.changed', { paneKey: 'tab:0', state: 'blocked' });
  resolveRoster!(oldRoster);
  await until((): boolean => !button('refresh').disabled);
  check(firstCard().dataset.state === 'blocked', 'Late roster must not overwrite a newer status event.');
  orca.plugin.request = request;
  passed.push('newer status wins over a deferred roster response');

  fixture.failStorage = true;
  chooseSpecies('Eevee');
  await until((): boolean => !document.getElementById('error')!.hidden);
  check(document.getElementById('species-panel')!.matches(':popover-open'), 'Failed save must leave picker usable.');
  await refresh();
  check(!document.getElementById('error')!.hidden, 'Roster refresh must not hide save failure.');
  check(select().title.includes('Pikachu'), 'Failed save must retain previous choice.');
  fixture.failStorage = false;
  searchSpecies('Pikachu');
  (document.querySelector('#species-results button') as HTMLButtonElement).click();
  await until((): boolean => !document.getElementById('species-panel')!.matches(':popover-open'));
  check(document.getElementById('error')!.hidden, 'Picker must support retry after a failed save.');
  select().click();
  button('motion').focus();
  button('motion').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  check(!document.getElementById('species-panel')!.matches(':popover-open'), 'Outside pointer must dismiss picker.');
  check(document.activeElement === button('motion'), 'Outside dismissal must not steal focus.');
  passed.push('save failure remains visible after successful roster refresh');

  fixture.failRoster = true;
  await refresh();
  fixture.emit('agent.status.changed', { paneKey: 'tab:0', state: 'working' });
  check(document.getElementById('summary')!.textContent!.includes('stale'), 'Status event must not hide stale roster.');
  fixture.failRoster = false;
  await refresh();
  passed.push('failed roster remains stale during live events');

  const call: typeof orca.host.call = orca.host.call;
  const resolveChoices: Map<string, (value: unknown) => void> = new Map();
  orca.host.call = async (method: string, params: unknown): Promise<unknown> => {
    const key: string = (params as { key: string }).key;
    if (method === 'storage.get' && key.startsWith('pokemon.v1:')) return new Promise<unknown>((resolve): void => { resolveChoices.set(key, resolve); });
    return call(method, params);
  };
  fixture.agents.push({ ...fixture.agents[0], id: 'late-choice', paneKey: 'tab:late' });
  await refresh();
  await until((): boolean => resolveChoices.size === 2);
  const removed: HTMLElement = document.querySelector('.agent-card:last-child .sprite')!;
  fixture.agents.pop();
  await refresh();
  for (const [key, resolveChoice] of resolveChoices) resolveChoice({ value: key.endsWith('.work') ? 'shock' : 25 });
  await new Promise<number>(requestAnimationFrame);
  check(!removed.isConnected && removed.getAnimations().length === 0, 'Removed sprite must not restart after late storage read.');
  orca.host.call = call;
  passed.push('late storage response cannot revive removed sprite animations');

  const otherProject: AgentRow = { ...fixture.agents[3] };
  fixture.agents[3].projectId = 'order-write-project';
  fixture.agents[3].projectName = 'Order write project';
  await refresh();
  await new Promise<number>(requestAnimationFrame);
  const cardGrip: HTMLButtonElement = firstCard().querySelector('.drag-grip')!;
  const moveDown: () => void = (): void => {
    cardGrip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  };
  let orderCallsStart: number = fixture.calls.length;
  moveDown();
  await new Promise<number>(requestAnimationFrame);
  let orderWrites: string[] = fixture.calls.slice(orderCallsStart).filter((entry): boolean => entry.method === 'storage.set').map((entry): string => entry.params!.key);
  check(orderWrites.length === 1 && orderWrites[0] === 'cards.order.v1', 'Moving a card must write only card order, never stale project order from another panel.');
  const projectGrip: HTMLButtonElement = cardGrip.closest('.project-group')!.querySelector('.project-grip')!;
  orderCallsStart = fixture.calls.length;
  projectGrip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  await new Promise<number>(requestAnimationFrame);
  orderWrites = fixture.calls.slice(orderCallsStart).filter((entry): boolean => entry.method === 'storage.set').map((entry): string => entry.params!.key);
  check(orderWrites.length === 1 && orderWrites[0] === 'projects.order.v1', 'Moving a project must write only project order, never stale card order from another panel.');

  let releaseOrder: (() => void) | undefined;
  orca.host.call = async (method: string, params: unknown): Promise<unknown> => {
    if (method === 'storage.set' && (params as { key: string }).key === 'cards.order.v1' && !releaseOrder) {
      await new Promise<void>((resolve): void => { releaseOrder = resolve; });
    }
    return call(method, params);
  };
  orderCallsStart = fixture.calls.length;
  moveDown();
  await until((): boolean => releaseOrder !== undefined);
  projectGrip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
  cardGrip.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
  const expectedCardOrder: string[] = Array.from(cardGrip.closest('.project-agents')!.children, (card: Element): string => (card as HTMLElement).dataset.orderKey!);
  releaseOrder!();
  await new Promise<number>(requestAnimationFrame);
  orca.host.call = call;
  orderWrites = fixture.calls.slice(orderCallsStart).filter((entry): boolean => entry.method === 'storage.set').map((entry): string => entry.params!.key);
  check(orderWrites.includes('cards.order.v1') && orderWrites.filter((key: string): boolean => key === 'projects.order.v1').length === 1, 'Serialized card saves must retain a pending project move without writing project order twice.');
  const savedCards: { value: string[] } = await call('storage.get', { key: 'cards.order.v1' }) as { value: string[] };
  check(JSON.stringify(savedCards.value.filter((key: string): boolean => expectedCardOrder.includes(key))) === JSON.stringify(expectedCardOrder), 'A card move queued during another save must persist the latest card order.');
  fixture.agents[3] = otherProject;
  await refresh();
  passed.push('card and project order writes stay independent across serialized moves');

  const originalAgents: AgentRow[] = fixture.agents;
  fixture.agents = Array.from({ length: 20 }, (_: unknown, index: number): AgentRow => ({ ...originalAgents[0], id: `scroll-agent-${index}`, paneKey: `tab:scroll-${index}` }));
  await refresh();
  const scroller: HTMLElement = document.querySelector('main')!;
  const spotify: HTMLElement = document.querySelector('.audio-card')!;
  const spotifyTop: number = spotify.getBoundingClientRect().top;
  const bottomBar: DOMRect = document.querySelector('.bottom-bar')!.getBoundingClientRect();
  check(Math.abs(bottomBar.bottom - innerHeight) <= 1, 'Bottom controls must stay at the viewport bottom.');
  check(scroller.scrollHeight > scroller.clientHeight, 'Many agents must scroll inside the roster area.');
  scroller.scrollTop = scroller.scrollHeight;
  await new Promise<number>(requestAnimationFrame);
  check(scroller.scrollTop > 0, 'Roster must scroll independently.');
  check(Math.abs(spotify.getBoundingClientRect().top - spotifyTop) <= 1, 'Spotify must stay pinned while agents scroll.');
  if (spotify.hidden) {
    check(Math.abs(scroller.getBoundingClientRect().bottom - bottomBar.top) <= 1, 'Disabled Spotify must release its space above the bottom controls to the roster.');
  } else {
    check(Math.abs(spotify.getBoundingClientRect().bottom - (bottomBar.top - 10)) <= 1, 'Spotify must remain above the bottom controls.');
    check(scroller.getBoundingClientRect().bottom <= spotifyTop, 'Pinned Spotify must not cover the agent area.');
  }
  fixture.agents = originalAgents;
  await refresh();
  scroller.scrollTop = 0;
  passed.push('many-agent scrolling keeps Spotify pinned without overlap');

  fixture.agents = [];
  await refresh();
  check(!document.getElementById('empty')!.hidden && document.querySelectorAll('.agent-card').length === 0, 'Empty crew must show empty state.');
  passed.push('empty roster removes old cards');
  return passed;
}
