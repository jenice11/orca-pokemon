import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { createPreviewServer } from './preview.ts';

const server: Server = createPreviewServer();
interface Scenario {
  module: string;
  method: string;
  query?: string;
  reloadMethod?: string;
}
interface BrowserCase extends Scenario {
  width: number;
  height: number;
  textScale: number;
  reducedMotion: 'no-preference' | 'reduce';
}
const scenarios: Scenario[] = [
  { module: 'browser', method: 'run' },
  { module: 'browser', method: 'runChoiceReadRaces' },
  { module: 'order-browser', method: 'run', reloadMethod: 'verifyReload' },
  { module: 'order-browser', method: 'runRaces' },
  { module: 'project-browser', method: 'run', reloadMethod: 'verifyReload' },
  { module: 'project-browser', method: 'runStatusIsolation' },
  { module: 'view-browser', method: 'run' },
  { module: 'project-browser', method: 'verifyPartialReadFailure', query: '?fail-order-read=cards.order.v1' },
  { module: 'project-browser', method: 'verifyPartialReadFailure', query: '?fail-order-read=projects.order.v1' },
  { module: 'audio-browser', method: 'run' },
  { module: 'autostart-browser', method: 'consent', reloadMethod: 'remembered' },
  { module: 'autostart-browser', method: 'delayedRead', query: '?defer-auto-read' },
  { module: 'autostart-browser', method: 'delayedNotification' },
  { module: 'autostart-browser', method: 'failedRead', query: '?fail-auto-read' }
];
const cases: BrowserCase[] = scenarios.flatMap((scenario: Scenario): BrowserCase[] =>
  [260, 320, 480].flatMap((width: number): BrowserCase[] =>
    (scenario.module === 'browser' ? ['no-preference', 'reduce'] as const : ['no-preference'] as const)
      .map((reducedMotion: 'no-preference' | 'reduce'): BrowserCase => ({
        ...scenario, width, height: 760, textScale: 1, reducedMotion
      }))));
for (const width of [260, 320, 480]) {
  for (const height of [320, 400]) {
    for (const textScale of [1, 2]) {
      cases.push({ module: 'layout-browser', method: 'run', width, height, textScale, reducedMotion: 'no-preference' });
    }
  }
}
let browser: Browser | undefined;
try {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address: AddressInfo = server.address() as AddressInfo;
  browser = await chromium.launch();
  for (const scenario of cases) {
    const { width, height, textScale, reducedMotion }: BrowserCase = scenario;
    const description: string = `${width}x${height}px, text=${textScale * 100}%, motion=${reducedMotion}: ${scenario.module}.${scenario.method}${scenario.query ?? ''}`;
    const context: BrowserContext = await browser.newContext({ viewport: { width, height }, reducedMotion });
    try {
      const page: Page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', (error: Error): void => { errors.push(error.message); });
      await page.goto(`http://127.0.0.1:${address.port}/panel/index.html${scenario.query ?? ''}`);
      if (scenario.module === 'browser') {
        await page.waitForSelector('.species-picker:enabled');
        await page.locator('.species-picker').first().click();
        await page.locator('#audio-enable:enabled').focus();
        await page.keyboard.press('Enter');
        await page.waitForSelector('#audio-consent:modal');
        await page.keyboard.press('Escape');
        if (await page.locator('#audio-consent').evaluate((dialog: HTMLDialogElement): boolean => dialog.open)) {
          throw new Error('Escape must dismiss modal consent before the background species menu.');
        }
        await page.keyboard.press('Escape');
      }
      const run: (method: string) => Promise<void> = async (method: string): Promise<void> => {
        await page.evaluate(async ({ module, method }: { module: string; method: string }): Promise<void> => {
          await document.fonts.ready;
          await new Promise<number>(requestAnimationFrame);
          const suite: Record<string, () => Promise<unknown>> = await import(`/test/${module}.ts`);
          await suite[method]();
        }, { module: scenario.module, method });
      };
      if (scenario.module === 'layout-browser') {
        await page.waitForSelector('#view-options-button:enabled');
        await run('prepare');
        if (textScale === 2) {
          await page.evaluate((): void => {
            const typography: { node: HTMLElement; fontSize: number; lineHeight: number }[] =
              Array.from(document.querySelectorAll<HTMLElement>('*'))
                .filter((node: HTMLElement): boolean => node instanceof HTMLElement)
                .map((node: HTMLElement): { node: HTMLElement; fontSize: number; lineHeight: number } => {
                  const style: CSSStyleDeclaration = getComputedStyle(node);
                  return { node, fontSize: parseFloat(style.fontSize), lineHeight: parseFloat(style.lineHeight) };
                });
            // Snapshot first: inherited sizes must not compound; hidden popup controls need enlargement too.
            for (const { node, fontSize, lineHeight } of typography) {
              node.style.fontSize = `${fontSize * 2}px`;
              if (Number.isFinite(lineHeight)) node.style.lineHeight = `${lineHeight * 2}px`;
            }
          });
        }
      }
      await run(scenario.method);
      if (scenario.module === 'view-browser' || scenario.module === 'layout-browser') {
        if (scenario.module === 'layout-browser') {
          await page.keyboard.press('Escape');
          await page.waitForSelector('#view-options:popover-open', { state: 'hidden' });
        }
        await page.locator('#view-options-button').click();
        await page.waitForSelector('#view-options:popover-open');
        await page.keyboard.press('Escape');
        await page.waitForSelector('#view-options:popover-open', { state: 'hidden' });
        await page.waitForFunction((): boolean => document.getElementById('view-options-button')!.getAttribute('aria-expanded') === 'false');
        if (await page.locator('#view-options-button').evaluate((button: HTMLButtonElement): boolean => document.activeElement !== button)) {
          throw new Error('Escape must return focus to the view-options button.');
        }
        await page.locator('#view-options-button').click();
        await page.waitForSelector('#view-options:popover-open');
        await page.locator('#refresh').click();
        await page.waitForSelector('#view-options:popover-open', { state: 'hidden' });
        await page.waitForFunction((): boolean => document.getElementById('view-options-button')!.getAttribute('aria-expanded') === 'false');
        if (await page.locator('#refresh').evaluate((button: HTMLButtonElement): boolean => document.activeElement !== button)) {
          throw new Error('Outside dismissal must retain focus on the clicked control.');
        }
      }
      if (scenario.reloadMethod) {
        await page.reload();
        await run(scenario.reloadMethod);
      }
      if (errors.length) throw new Error(errors.join('\n'));
      console.log(`PASS ${description}`);
    } catch (error: unknown) {
      throw new Error(description, { cause: error });
    } finally {
      await context.close();
    }
  }
} finally {
  await browser?.close();
  server.closeAllConnections();
  await new Promise<void>((resolve, reject): void => {
    server.close((error?: Error): void => { if (error) reject(error); else resolve(); });
  });
}
