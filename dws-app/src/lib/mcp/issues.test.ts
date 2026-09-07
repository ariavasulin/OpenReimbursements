import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { formatIssueBody, issueMarker, validateIssueInput } from './issues-validation';
import { publishGithubIssue, reconcileGithubIssue } from './issues-github';
import { formatIssueResult } from './issues';

const report = { title: 'Photo upload fails', body: 'Steps:\n1. Select a photo.\n\nExpected: upload.', kind: 'bug', reporter_name: 'Ari', anonymous: false, confirmed: true };
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('safe publication remedies', () => {
  it('returns a known retry time and fixed administrator remedies without upstream text', () => {
    const row = { id: randomUUID(), status: 'failed' as const, error: { code: 'rate_limited', retry_at: '2026-09-07T01:02:03.000Z', message: 'private diagnostic' } };
    expect(formatIssueResult(row).error).toMatchObject({ code: 'rate_limited', retryable: true, retry_after: '2026-09-07T01:02:03.000Z' });
    expect(JSON.stringify(formatIssueResult(row))).not.toContain('private diagnostic');
    for (const code of ['configuration_required', 'github_rejected', 'private diagnostic']) {
      const result = formatIssueResult({ ...row, error: { code, retry_at: 'private diagnostic' } });
      expect(result.error?.message).toContain('administrator');
      expect(JSON.stringify(result)).not.toContain('private diagnostic');
      expect(result.error).not.toHaveProperty('retry_after');
    }
  });
  it('unknown retries describe reconciliation only and published results omit stale errors', () => {
    const id = randomUUID();
    expect(formatIssueResult({ id, status: 'unknown' }).error).toMatchObject({ code: 'publication_unknown', retryable: true });
    expect(formatIssueResult({ id, status: 'unknown' }).error?.message).toContain('will not create another issue');
    expect(formatIssueResult({ id, status: 'published', issue_url: 'https://github.com/ariavasulin/OpenReimbursements/issues/123', error: { code: 'rate_limited' } })).not.toHaveProperty('error');
  });
});

describe('confirmed issue validation and exact formatting (AC-12)', () => {
  it('preserves exact title/body/name, appends attribution and one exact marker', () => {
    const input = { ...report, title: ' Title  with spaces ', body: 'Before\r\n  indented\nAfter  ' };
    const { payload } = validateIssueInput(input); const id = randomUUID();
    expect(payload.title).toBe(input.title);
    expect(formatIssueBody(payload, id)).toBe(`${input.body}\n\nReported by: Ari\n\n<!-- dws-submission:${id} -->`);
    const anonymous = validateIssueInput({ ...input, anonymous: true }).payload;
    expect(anonymous).not.toHaveProperty('reporter_name');
    expect(formatIssueBody(anonymous, id)).toBe(`${input.body}\n\n<!-- dws-submission:${id} -->`);
  });

  it('normalizes digest only and excludes keys while including target/kind/attribution', () => {
    const a = validateIssueInput({ ...report, body: '  Step\r\nNext  ', idempotency_key: 'first' });
    const b = validateIssueInput({ ...report, body: 'Step\nNext', idempotency_key: 'second' });
    expect(a.digest).toBe(b.digest);
    for (const changed of [{ kind: 'feature' }, { reporter_name: 'Other' }, { anonymous: true }, { body: 'changed' }]) {
      expect(validateIssueInput({ ...report, ...changed }).digest).not.toBe(validateIssueInput(report).digest);
    }
  });

  it.each([
    { confirmed: false }, { confirmed: undefined }, { anonymous: undefined }, { reporter_name: undefined },
    { repository: 'other/repo' }, { labels: ['bug'] }, { attachment: new Uint8Array([1]) }, { files: [] },
    { body: 'data:image/png;base64,AAAA' }, { body: 'Attach J:\\Photos\\picture.jpg' },
    { body: 'J:\\Photos\\picture.jpg' }, { body: '/Users/ari/picture.jpg' }, { body: '\\\\office\\photos\\picture.jpg' },
    { body: '"J:\\My Photos\\picture.jpg"' }, { body: 'file:/Users/ari/picture.jpg' },
    { body: '/Users/ari/a.jpg\n\n/Users/ari/b.jpg' },
    { body: 'J:\\My Photos\\picture one.jpg' },
    { body: '/Users/ari/My Photos/picture one.jpg' },
    { body: '  "/Users/ari/My Photos/a.jpg"\r\n \t\r\n`J:\\My Photos\\b.jpg`  ' },
    { body: '[capture]: ./picture.jpg' },
    { body: '[capture](file:///Users/ari/image.png)' }, { body: 'See http://unsafe.example/image.png' },
    { body: '[x](javascript:alert(1))' }, { body: '[x](ftp://example.test/file)' }, { body: 'ftp://example.test/file' },
    { body: 'blob:https://example.test/id' }, { body: '[local](./image.png)' }, { body: '<mailto:private@example.test>' },
    { body: '[x](https://user:password@example.test/private.png)' }, { body: 'https://user:password@example.test/private.png' },
    { body: 'A'.repeat(300) }, { title: 'x'.repeat(201) }, { body: '.'.repeat(16001) },
    { body: '<!-- dws-submission:fake -->' }, { reporter_name: 'Ari\nother' }, { idempotency_key: 'bad key' },
  ])('rejects unconfirmed, override, attachment, marker and malformed input %j', changed => {
    expect(() => validateIssueInput({ ...report, ...changed })).toThrow();
  });

  it('accepts title/body boundaries and hosted HTTPS references without fetching them', () => {
    expect(validateIssueInput({ ...report, title: 'x'.repeat(200), body: '.'.repeat(16000) }).payload.body).toHaveLength(16000);
    expect(validateIssueInput({ ...report, body: '[Screenshot](https://example.test/photo.png)' }).payload.body).toContain('https://');
    expect(validateIssueInput({ ...report, body: 'Metadata: orientation is wrong.' }).payload.body).toContain('Metadata:');
  });

  it.each([
    { title: 'File: import failed', body: 'Files under J:\\Photos\\3612 fail to import.\nData: 3 files' },
    { title: 'Data: unexpected count', body: 'The folder /Users/ari/Photos contains 3 files, but the inventory shows 2.' },
    { title: 'File: missing progress', body: 'J:\\Photos\\3612\nError: permission denied after selecting the folder.' },
    { title: 'File: spaced folder import failed', body: 'Files under J:\\My Photos\\3612 fail to import.\n\nData: 3 files' },
    { title: 'File: attachment context', body: '/Users/ari/My Photos/a.jpg\n\nError: this selected file never appeared in the inventory.' },
    { title: 'Issue marker shown', body: 'The dws-submission: identifier appeared in the report.\nFile:\nData:' },
  ])('preserves contextual paths, colon labels, and marker prose: $title', input => {
    expect(validateIssueInput({ ...report, ...input }).payload).toMatchObject(input);
  });

  it('rejects configured secrets anywhere without echoing them', () => {
    vi.stubEnv('DWS_GITHUB_ISSUES_TOKEN', 'synthetic-private-credential');
    for (const changed of [{ body: 'synthetic-private-credential' }, { idempotency_key: 'synthetic-private-credential' },
      { attachment: { data: 'synthetic-private-credential' } }]) {
      try { validateIssueInput({ ...report, ...changed }); throw new Error('accepted secret'); }
      catch (error) { expect(String(error)).not.toContain('synthetic-private-credential'); expect(String(error)).not.toContain('accepted secret'); }
    }
  });
});

describe('minimal fixed GitHub publisher (AC-13)', () => {
  function setup() { vi.stubEnv('DWS_GITHUB_ISSUES_TOKEN', 'synthetic-issues-token'); vi.stubEnv('DWS_TEST_GITHUB_API_URL', ''); }
  function remote(number: number, body = '') { return { number, html_url: `https://github.com/ariavasulin/OpenReimbursements/issues/${number}`, body }; }

  it('posts only the fixed repository, labels and exact confirmed body', async () => {
    setup(); const fetcher = vi.fn().mockResolvedValue(Response.json(remote(42), { status: 201 })); vi.stubGlobal('fetch', fetcher);
    const payload = validateIssueInput(report).payload; const id = randomUUID();
    expect(await publishGithubIssue(payload, id)).toEqual({ status: 'published', number: 42, url: remote(42).html_url });
    expect(fetcher.mock.calls[0][0]).toBe('https://api.github.com/repos/ariavasulin/OpenReimbursements/issues');
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ title: report.title, body: formatIssueBody(payload, id), labels: ['source:dws-mcp', 'bug'] });
    expect(fetcher.mock.calls[0][1].redirect).toBe('error');
  });

  it('ambiguous send stays unknown; definitive rejection is failed with no upstream diagnostic', async () => {
    setup(); const fetcher = vi.fn().mockRejectedValue(new Error('private upstream message')); vi.stubGlobal('fetch', fetcher);
    expect(await publishGithubIssue(validateIssueInput(report).payload, randomUUID())).toEqual({ status: 'unknown', code: 'publication_unknown' });
    fetcher.mockResolvedValue(new Response('private upstream diagnostic', { status: 403 }));
    expect(await publishGithubIssue(validateIssueInput(report).payload, randomUUID())).toEqual({ status: 'failed', code: 'github_rejected' });
  });

  it.each([
    ['HTTP 500', () => new Response('private upstream diagnostic', { status: 500 })],
    ['HTTP 502', () => new Response('private upstream diagnostic', { status: 502 })],
    ['malformed 201 JSON', () => new Response('{"message":"private upstream diagnostic",', { status: 201 })],
    ['malformed 201 object', () => Response.json({ number: '42', html_url: remote(42).html_url, message: 'private upstream diagnostic' }, { status: 201 })],
    ['foreign 201 issue URL', () => Response.json({ number: 42, html_url: 'https://github.com/other/repository/issues/42', message: 'private upstream diagnostic' }, { status: 201 })],
  ] as const)('%s stays unknown without returning a URL, diagnostics, or sending again', async (_name, response) => {
    setup(); const fetcher = vi.fn().mockResolvedValue(response()); vi.stubGlobal('fetch', fetcher);
    const outcome = await publishGithubIssue(validateIssueInput(report).payload, randomUUID());
    expect(outcome).toEqual({ status: 'unknown', code: 'publication_unknown' });
    expect(outcome).not.toHaveProperty('url');
    expect(JSON.stringify(outcome)).not.toContain('private upstream diagnostic');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1].method).toBe('POST');
  });

  it('carries a bounded safe Retry-After timestamp for rate-limit rejections', async () => {
    setup(); const now = Date.now();
    const fetcher = vi.fn().mockResolvedValue(new Response('private upstream diagnostic', { status: 429, headers: { 'Retry-After': '120' } })); vi.stubGlobal('fetch', fetcher);
    const result = await publishGithubIssue(validateIssueInput(report).payload, randomUUID());
    expect(result).toMatchObject({ status: 'failed', code: 'rate_limited' });
    if (result.status !== 'published') expect(Date.parse(result.retryAt!) - now).toBeGreaterThanOrEqual(120_000);
  });

  it('reconciles exact marker on later page, excluding pull requests and marker substrings', async () => {
    setup(); const id = randomUUID(); const marker = issueMarker(id);
    const page1 = Array.from({ length: 100 }, (_, i) => remote(i + 1, `prefix${marker}`));
    page1[0] = { ...remote(1, marker), pull_request: {} } as typeof page1[number];
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json(page1)).mockResolvedValueOnce(Response.json([remote(200, `Report\n\n${marker}`)])); vi.stubGlobal('fetch', fetcher);
    expect(await reconcileGithubIssue(id, '2026-09-07T01:00:00.123456Z')).toEqual({ status: 'published', number: 200, url: remote(200).html_url });
    expect(new URL(fetcher.mock.calls[1][0]).searchParams.get('page')).toBe('2');
    expect(new URL(fetcher.mock.calls[0][0]).searchParams.get('since')).toBe('2026-09-07T01:00:00.000Z');
    expect(fetcher.mock.calls.every(call => call[1].method === 'GET')).toBe(true);
  });

  it('absent markers and exhausted pagination remain unknown without a create', async () => {
    setup(); const fetcher = vi.fn().mockImplementation(() => Promise.resolve(Response.json(Array.from({ length: 100 }, (_, i) => remote(i + 1))))); vi.stubGlobal('fetch', fetcher);
    expect((await reconcileGithubIssue(randomUUID(), new Date().toISOString())).status).toBe('unknown');
    expect(fetcher).toHaveBeenCalledTimes(20);
    expect(fetcher.mock.calls.every(call => call[1].method === 'GET')).toBe(true);
  });

  it('refuses external test overrides before sending a credential', async () => {
    setup(); vi.stubEnv('DWS_TEST_GITHUB_API_URL', 'https://attacker.invalid');
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    expect((await publishGithubIssue(validateIssueInput(report).payload, randomUUID())).status).toBe('failed');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
