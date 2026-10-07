import http from 'http';
import path from 'path';
import { AddressInfo } from 'net';
import { previewEntry, readProjectFile } from './workspace';

/**
 * Static previews of generated web projects. Each previewed project gets its own local
 * port, which makes it a different origin from the office: the page (written by a model)
 * behaves like a normal site but cannot call the office API or read its settings.
 * Nothing is built or executed on this machine; the files are only served to the browser.
 */

interface Preview {
  server: http.Server;
  url: string;
  startedAt: number;
}

const MAX_PREVIEWS = 4;

const globalForPreview = globalThis as unknown as { __officePreviews?: Map<string, Preview> };
const previews: Map<string, Preview> = (globalForPreview.__officePreviews ??= new Map());

const serve = (project: string, root: string): Promise<Preview> =>
  new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      // Answer only when addressed as this computer (see refuseUnknownHost)
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(req.headers.host || '')) {
        res.writeHead(403).end();
        return;
      }
      let relative: string;
      try {
        relative = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname).replace(/^\/+/, '');
      } catch {
        res.writeHead(400).end();
        return;
      }
      if (!relative || relative.endsWith('/')) relative += 'index.html';

      // readProjectFile refuses anything outside the project folder
      const file = readProjectFile(project, path.posix.join(root, relative));
      if (!file) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': file.contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(file.data);
    });

    server.once('error', reject);
    // Reachable from this computer only, on a port the system picks
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      server.unref();
      resolve({ server, url: `http://127.0.0.1:${port}/`, startedAt: Date.now() });
    });
  });

/** Starts (or reuses) the preview of a project and returns its address, or null when it has no web page to show. */
export const startPreview = async (project: string) => {
  const entry = previewEntry(project);
  if (!entry) return null;

  const running = previews.get(project);
  if (running) return running.url;

  // Keep only a few previews alive; the oldest makes room
  if (previews.size >= MAX_PREVIEWS) {
    const [oldest] = Array.from(previews.entries()).sort((a, b) => a[1].startedAt - b[1].startedAt)[0];
    previews.get(oldest)?.server.close();
    previews.delete(oldest);
  }

  const preview = await serve(project, path.posix.dirname(entry) === '.' ? '' : path.posix.dirname(entry));
  previews.set(project, preview);
  return preview.url;
};
