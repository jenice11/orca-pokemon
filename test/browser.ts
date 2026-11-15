import type { AgentRow, Roster } from '../model.ts';
import { POKEMON, type Pokemon, type SpriteAnimation } from '../panel/sprites.ts';

interface Fixture {
  agents: AgentRow[];
  failStorage: boolean;
  failRoster: boolean;
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

export async function run(): Promise<string[]> {
  const passed: string[] = [];
  await until((): boolean => document.querySelectorAll('.agent-card').length === 4 && !select().disabled);
  await orca.host.call('storage.set', { key: 'cards.order.v1', value: [] });
  await until((): boolean => firstCard().querySelector('h2')!.textContent === fixture.agents[0].title);
  check(document.getAnimations().length >= 4, 'Sprite and status animations must run.');
  check(document.documentElement.scrollWidth <= innerWidth, 'Panel must not overflow horizontally.');
  check(document.querySelector('.card-bottom') === null, 'Species controls must not reserve a bottom row on every card.');
  check(getComputedStyle(document.querySelector('.habitat')!).height === '72px', 'Agent cards must use the compact sprite area.');
  check(document.querySelector('.toolbar')!.contains(document.getElementById('agent-sort')) && document.querySelector('.toolbar')!.contains(button('motion')), 'Count, Sort, and Pause must share one toolbar.');
  check(document.getElementById('order-note') === null && document.querySelector('header p') === null, 'Permanent help text and the header subtitle must not consume panel space.');
  check(getComputedStyle(document.querySelector('h1')!).fontSize === '18px', 'Panel heading must use the compact size.');
  const originalWorkspace: string = fixture.agents[0].workspace;
  const originalAgent: string = fixture.agents[0].agent;
  fixture.agents[0].workspace = 'A long workspace name that must remain on one line instead of expanding the agent card';
  fixture.agents[0].agent = 'A long agent label that must truncate instead of expanding the card';
  await refresh();
  const agentIcon: HTMLButtonElement = firstCard().querySelector('.agent-icon')!;
  const areaBounds: DOMRect = firstCard().querySelector('.sprite-area')!.getBoundingClientRect();
  const iconBounds: DOMRect = agentIcon.getBoundingClientRect();
  check(firstCard().querySelector('.identity p') === null, 'Agent type must not reserve a text row in the card header.');
  check(Math.abs(iconBounds.right - (areaBounds.right - 6)) <= 1 && Math.abs(iconBounds.bottom - (areaBounds.bottom - 6)) <= 1, 'Agent icon must sit in the bottom-right of the sprite area.');
  check(iconBounds.width >= 24 && iconBounds.height >= 24, 'Small agent marks must retain an accessible click target.');
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
  fixture.agents[0].workspace = originalWorkspace;
  fixture.agents[0].agent = originalAgent;
  await refresh();
  agentIcon.focus();
  check(workspaceTooltip.getBoundingClientRect().width < rosterBounds.width, 'Short workspace details must use a content-sized tooltip rather than span the panel.');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  for (const card of Array.from(document.querySelectorAll<HTMLElement>('.agent-card'))) {
    const mark: HTMLElement = card.querySelector('.agent-icon')!;
    const brand: string = mark.dataset.agent!;
    check(['claude', 'codex', 'opencode'].includes(brand), 'Known fixture agents must use their own brand marks.');
    check(getComputedStyle(mark, '::before').maskImage.includes(`/assets/agents/${brand}.svg`), 'Brand mark must use a local, theme-aware SVG mask.');
    const iconImage: HTMLImageElement = new Image();
    iconImage.src = new URL(`../assets/agents/${brand}.svg`, import.meta.url).href;
    await iconImage.decode();
    const badge: HTMLElement = card.querySelector('.state')!;
    const style: CSSStyleDeclaration = getComputedStyle(badge);
    check(style.width === '10px' && style.height === '10px' && style.borderRadius === '50%', 'Every agent state must use a circle.');
    const header: HTMLElement = badge.parentElement!;
    check(Math.abs(badge.offsetLeft + badge.offsetWidth - (header.offsetLeft + header.offsetWidth - parseFloat(getComputedStyle(header).paddingRight))) <= 1, 'Agent indicator must stay on the right, including in narrow panels.');
    check(getComputedStyle(badge.querySelector('.state-label')!).clipPath === 'inset(50%)', 'State text must stay accessible but visually hidden.');
    if (card.dataset.state === 'working') {
      check(style.animationName === 'agent-working' && style.borderTopColor === 'rgb(217, 119, 6)', 'Working must use an orange loader.');
    } else if (card.dataset.state === 'blocked') {
      check(style.backgroundColor === 'rgb(220, 38, 38)', 'Permission and prompt requests must use red.');
    } else if (card.dataset.state === 'done') {
      check(style.backgroundColor === 'rgb(22, 163, 74)', 'Done must use green.');
    }
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
  check(document.activeElement === lastMenu && !document.getElementById('species-panel')!.matches(':popover-open'), 'Tab must resume navigation from the owning trigger.');
  lastMenu.click();
  (lastMenu.closest('.project-group')!.querySelector('.project-toggle') as HTMLButtonElement).click();
  check(!document.getElementById('species-panel')!.matches(':popover-open'), 'Collapsing the owner project must close picker.');
  (lastMenu.closest('.project-group')!.querySelector('.project-toggle') as HTMLButtonElement).click();
  document.querySelector('main')!.scrollTop = 0;

  button('motion').click();
  check(document.body.classList.contains('paused'), 'Pause must stop motion.');
  check(document.getAnimations().every((animation: Animation): boolean => animation.playState !== 'running'), 'Pause must stop sprite and CSS animations.');
  const pikachu: Pokemon = POKEMON.find((species: Pokemon): boolean => species.id === 25)!;
  for (const state of ['done', 'working'] as const) {
    fixture.agents[0].state = state;
    fixture.emit('agent.status.changed', { paneKey: 'tab:0', state });
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
    const sheet: SpriteAnimation = pikachu.animations[state === 'done' ? 'sleep' : 'walk'];
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
    check(Math.abs(visibleBottom - (groundBounds.top + groundBounds.height / 2)) <= 1, `${state} Pikachu must touch the grass at the lowest animation frame, including while motion is paused.`);
  }
  passed.push('sleeping and working Pikachu touch grass with state-specific grounding');
  button('motion').click();
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
  let resolveChoice: ((value: unknown) => void) | undefined;
  orca.host.call = async (method: string, params: unknown): Promise<unknown> => {
    if (method === 'storage.get' && (params as { key: string }).key.startsWith('pokemon.v1:')) return new Promise<unknown>((resolve): void => { resolveChoice = resolve; });
    return call(method, params);
  };
  fixture.agents.push({ ...fixture.agents[0], id: 'late-choice', paneKey: 'tab:late' });
  await refresh();
  await until((): boolean => resolveChoice !== undefined);
  const removed: HTMLElement = document.querySelector('.agent-card:last-child .sprite')!;
  fixture.agents.pop();
  await refresh();
  resolveChoice!({ value: 25 });
  await new Promise<number>(requestAnimationFrame);
  check(!removed.isConnected && removed.getAnimations().length === 0, 'Removed sprite must not restart after late storage read.');
  orca.host.call = call;
  passed.push('late storage response cannot revive removed sprite animations');

  const originalAgents: AgentRow[] = fixture.agents;
  fixture.agents = Array.from({ length: 20 }, (_: unknown, index: number): AgentRow => ({ ...originalAgents[0], id: `scroll-agent-${index}`, paneKey: `tab:scroll-${index}` }));
  await refresh();
  const scroller: HTMLElement = document.querySelector('main')!;
  const spotify: HTMLElement = document.querySelector('.audio-card')!;
  const spotifyTop: number = spotify.getBoundingClientRect().top;
  check(scroller.scrollHeight > scroller.clientHeight, 'Many agents must scroll inside the roster area.');
  scroller.scrollTop = scroller.scrollHeight;
  await new Promise<number>(requestAnimationFrame);
  check(scroller.scrollTop > 0, 'Roster must scroll independently.');
  check(Math.abs(spotify.getBoundingClientRect().top - spotifyTop) <= 1, 'Spotify must stay pinned while agents scroll.');
  if (spotify.hidden) {
    check(Math.abs(scroller.getBoundingClientRect().bottom - innerHeight) <= 1, 'Disabled Spotify must release its space to the roster.');
  } else {
    check(Math.abs(spotify.getBoundingClientRect().bottom - (innerHeight - 10)) <= 1, 'Spotify must remain at the panel bottom.');
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
