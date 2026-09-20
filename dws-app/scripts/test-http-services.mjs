import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

/** Local-only GitHub fixture. Control URLs are never part of the application. */
export async function startGitHubMock({ token, restartNext }) {
  let mode = 'normal', visible = true, markerPage = 1;
  const issues = [], requests = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://fixture.local');
    const json = (status, body) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); };
    try {
      let raw = '';
      for await (const chunk of request) {
        raw += chunk;
        if (raw.length > 128 * 1024) return json(413, {});
      }
      const body = raw ? JSON.parse(raw) : {};
      if (url.pathname === '/__fixture/control' && request.method === 'POST') {
        if (body.reset) { issues.length = 0; requests.length = 0; mode = 'normal'; visible = true; markerPage = 1; }
        if (body.mode !== undefined) mode = body.mode;
        if (body.visible !== undefined) visible = body.visible;
        if (body.markerPage !== undefined) markerPage = body.markerPage;
        return json(200, { ok: true });
      }
      if (url.pathname === '/__fixture/state' && request.method === 'GET') return json(200, { issues, requests });
      if (url.pathname === '/__fixture/restart-next' && request.method === 'POST') {
        await restartNext();
        return json(200, { restarted: true });
      }
      if (url.pathname !== '/repos/ariavasulin/OpenReimbursements/issues' || !['GET', 'POST'].includes(request.method)) return json(404, {});
      const authorized = request.headers.authorization === `Bearer ${token}`;
      requests.push({ method: request.method, path: url.pathname + url.search, authorized, ...(request.method === 'POST' ? { body } : {}) });
      if (!authorized) return json(401, { message: 'Fixture credential required' });
      if (request.method === 'POST') {
        if (mode === 'reject') return json(403, { message: 'Fixture permission remedy required' });
        const number = 9000 + issues.length;
        const issue = { number, html_url: `https://github.com/ariavasulin/OpenReimbursements/issues/${number}`, title: body.title, body: body.body, labels: body.labels, created_at: new Date().toISOString() };
        issues.push(issue);
        if (mode === 'timeout') return; // Accepted remotely; caller's real deadline aborts the HTTP request.
        return json(201, issue);
      }
      const page = Number(url.searchParams.get('page') || 1);
      if (!visible) return json(200, []);
      if (page < markerPage) return json(200, Array.from({ length: 100 }, (_, index) => ({ number: index + 1, body: 'Unrelated synthetic issue', created_at: new Date().toISOString() })));
      return json(200, page === markerPage ? issues : []);
    } catch { if (!response.headersSent) json(500, { message: 'Fixture request failed' }); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: async () => { server.closeAllConnections(); await new Promise(resolveClose => server.close(resolveClose)); },
  };
}

/** A real Next process in the source-only snapshot, restartable without changing URL. */
export function nextHttpServer({ app, snapshot, env, port, output }) {
  let child;
  let logs = '';
  const redact = value => {
    for (const key of ['MCP_SHARED_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'DWS_GITHUB_ISSUES_TOKEN']) {
      if (env[key]) value = value.split(env[key]).join('[redacted]');
    }
    return value.replace(/([?&]token=)[^\s&]+/g, '$1[redacted]');
  };
  async function stop() {
    if (!child) return;
    const stopping = child;
    child = undefined;
    if (stopping.exitCode !== null) return;
    const exited = once(stopping, 'exit');
    try { process.kill(-stopping.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    const timer = setTimeout(() => { try { process.kill(-stopping.pid, 'SIGKILL'); } catch {} }, 5000);
    try { await exited; } finally { clearTimeout(timer); }
  }
  async function start() {
    child = spawn(process.execPath, [resolve(app, 'node_modules/next/dist/bin/next'), 'dev', '--hostname', 'localhost', '--port', String(port)], {
      cwd: snapshot, env: { ...env, NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1', NEXT_PUBLIC_PHOTOS_HOSTNAME: '' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', chunk => { logs = (logs + chunk).slice(-500_000); });
    child.stderr.on('data', chunk => { logs = (logs + chunk).slice(-500_000); });
    let spawnError;
    child.on('error', error => { spawnError = error; });
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      if (spawnError || child.exitCode !== null) throw new Error(`Local Next failed: ${redact(logs.slice(-2000))}`);
      try {
        const result = await fetch(`http://localhost:${port}/mcp/fixture-readiness`, { signal: AbortSignal.timeout(1000) });
        if (result.status === 404 || result.status === 401) return;
      } catch {}
      await delay(250);
    }
    throw new Error(`Local Next readiness timed out: ${redact(logs.slice(-2000))}`);
  }
  return {
    start,
    restart: async () => { await stop(); await start(); },
    close: async () => { await stop(); await mkdir(resolve(output, '..'), { recursive: true }); await writeFile(output, redact(logs)); },
  };
}
