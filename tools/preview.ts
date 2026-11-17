// Browser-only fixture server. Never connects to Orca or loads the plugin worker.
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname, sep } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import assert from 'node:assert/strict';

const root: string = resolve(fileURLToPath(new URL('..', import.meta.url)));
const types: Record<string, string> = { '.html': 'text/html', '.ts': 'text/javascript', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };

function previewPath(url: string): string {
  const path: string = resolve(root, `.${decodeURIComponent(new URL(url, 'http://localhost').pathname)}`);
  if (!path.startsWith(root + sep)) throw new Error('Invalid path');
  if (!types[extname(path)]) throw new Error('Not a preview asset');
  return path;
}

assert.equal(previewPath('/panel/index.html'), resolve(root, 'panel/index.html'));
assert.throws((): string => previewPath('/%2e%2e%2fsecret.html'));

export function createPreviewServer(): Server {
  return createServer(async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      const path: string = previewPath(request.url ?? '/');
      let content: Buffer | string = await readFile(path);
      if (extname(path) === '.ts') content = stripTypeScriptTypes(content.toString());
      if (path === resolve(root, 'panel/index.html')) {
        content = content.toString().replace('<script type="module"', '<script src="/test/mock.js"></script><script type="module"');
      }
      response.writeHead(200, { 'Content-Type': types[extname(path)], 'Cache-Control': 'no-store' });
      response.end(content);
    } catch {
      response.writeHead(404);
      response.end('Not found');
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createPreviewServer().listen(4317, '127.0.0.1', (): void => { console.log('Fixture preview: http://127.0.0.1:4317/panel/index.html'); });
}
