/**
 * Azure DevOps enumerator tests.
 *
 * The enumerator uses Node's global `fetch` (no injectable client like
 * Octokit), so these intercept dev.azure.com with `nock`, which also pins the
 * URLs, query strings and auth header we send.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import nock from 'nock';
import { AzureDevOpsEnumerator } from '../scm/azure.js';
import { PullRequestFetchError } from '../analyse/pullRequests.js';
import { defaultIncluded } from '../scm/types.js';
import { REDACT_PATTERN, redactString } from '../preflight.js';

const ORIGIN = 'https://dev.azure.com';
const TOKEN = 'ado7pat7secrettokenaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const NOW = new Date('2026-08-01T00:00:00Z');
const ALL = { includeArchived: true, includeForks: true };
const ORG_SCOPE = { provider: 'azure', organization: 'acme' } as const;
const REPOS_PATH = '/acme/_apis/git/repositories';
const PRS_PATH = '/acme/Platform/_apis/git/repositories/api/pullrequests';

const makeRepo = (overrides: Record<string, unknown> = {}) => ({
  name: 'api',
  project: { name: 'Platform' },
  defaultBranch: 'refs/heads/main',
  size: 2048,
  ...overrides,
});

const makePr = (id: number, overrides: Record<string, unknown> = {}) => ({
  pullRequestId: id,
  status: 'completed',
  creationDate: '2026-07-20T01:02:03.1234567Z',
  createdBy: { id: 'user-1', uniqueName: 'alice@acme.example' },
  ...overrides,
});

const prQuery = (skip: number) => ({
  'searchCriteria.status': 'all',
  $top: '100',
  $skip: String(skip),
  'api-version': '7.1',
});

function enumerator(sleep: () => Promise<void> = async () => {}): AzureDevOpsEnumerator {
  return new AzureDevOpsEnumerator(TOKEN, 'acme', { sleep });
}

beforeAll(() => {
  nock.disableNetConnect();
});

afterEach(() => {
  expect(nock.pendingMocks()).toEqual([]);
  nock.cleanAll();
});

describe('AzureDevOpsEnumerator.enumerate', () => {
  it('lists the whole org, with dev.azure.com clone URLs', async () => {
    nock(ORIGIN, {
      reqheaders: { authorization: `Basic ${Buffer.from(`:${TOKEN}`).toString('base64')}` },
    })
      .get(REPOS_PATH)
      .query({ 'api-version': '7.1' })
      .reply(200, {
        value: [
          // remoteUrl is on a legacy host; we must not clone from it.
          makeRepo({ remoteUrl: 'https://acme.visualstudio.com/Platform/_git/api' }),
          makeRepo({ name: 'web', project: { name: 'Storefront' }, size: 5120 }),
        ],
      });

    const result = await enumerator().enumerate(ORG_SCOPE, ALL);

    expect(result.map((r) => r.fullName)).toEqual(['Platform/api', 'Storefront/web']);
    expect(result[0]).toMatchObject({ defaultBranch: 'main', sizeKb: 2, pushedAt: '' });
    expect(result[0].cloneUrl).toBe(
      `https://x-access-token:${TOKEN}@dev.azure.com/acme/Platform/_git/api`
    );
    // The existing log redactor must be able to scrub it completely.
    expect(result[0].cloneUrl.match(REDACT_PATTERN)).toEqual([`x-access-token:${TOKEN}@`]);
    expect(redactString(`fatal: unable to access '${result[0].cloneUrl}/'`)).toBe(
      "fatal: unable to access 'https://x-access-token:***@dev.azure.com/acme/Platform/_git/api/'"
    );
  });

  it('lists one project, URL-encoding names with spaces', async () => {
    nock(ORIGIN)
      .get('/acme/My%20Project/_apis/git/repositories')
      .query(true)
      .reply(200, { value: [makeRepo({ name: 'the repo', project: { name: 'My Project' } })] });

    const [listing] = await enumerator().enumerate({ ...ORG_SCOPE, project: 'My Project' }, ALL);

    expect(listing.fullName).toBe('My Project/the repo');
    expect(listing.cloneUrl).toContain('/acme/My%20Project/_git/the%20repo');
  });

  it('classifies disabled / fork / empty, and drops them on request', async () => {
    nock(ORIGIN)
      .get(REPOS_PATH)
      .query(true)
      .times(2)
      .reply(200, {
        value: [
          makeRepo({ name: 'active' }),
          makeRepo({ name: 'off', isDisabled: true }),
          makeRepo({ name: 'forked', isFork: true }),
          makeRepo({ name: 'blank', defaultBranch: undefined, size: 0 }),
        ],
      });

    const result = await enumerator().enumerate(ORG_SCOPE, ALL);
    expect(result.map(defaultIncluded)).toEqual([true, false, false, false]);
    expect(result[3]).toMatchObject({ isEmpty: true, defaultBranch: '' });

    const strict = await enumerator().enumerate(ORG_SCOPE, {
      includeArchived: false,
      includeForks: false,
    });
    expect(strict.map((r) => r.fullName)).toEqual(['Platform/active', 'Platform/blank']);
  });

  it('maps 401 to a friendly error', async () => {
    nock(ORIGIN).get(REPOS_PATH).query(true).reply(401, 'nope');
    await expect(enumerator().enumerate(ORG_SCOPE, ALL)).rejects.toThrow(
      /rejected the token \(401\).*Code \(Read\)/
    );
  });

  it('treats a 203 sign-in page or a redirect as a rejected token', async () => {
    nock(ORIGIN)
      .get(REPOS_PATH)
      .query(true)
      .reply(203, '<html>Sign In</html>', { 'content-type': 'text/html' });
    await expect(enumerator().enumerate(ORG_SCOPE, ALL)).rejects.toThrow(/rejected the token/);

    // Must not be followed to the other host.
    nock(ORIGIN)
      .get(REPOS_PATH)
      .query(true)
      .reply(302, '', { location: 'https://spsprodsig1.vssps.visualstudio.com/_signin' });
    await expect(enumerator().enumerate(ORG_SCOPE, ALL)).rejects.toThrow(/rejected the token/);
  });

  it('retries a 429 after Retry-After, and gives up eventually', async () => {
    const sleep = vi.fn(async () => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    nock(ORIGIN)
      .get(REPOS_PATH)
      .query(true)
      .reply(429, '', { 'retry-after': '7' })
      .get(REPOS_PATH)
      .query(true)
      .reply(200, { value: [makeRepo()] });

    expect(await enumerator(sleep).enumerate(ORG_SCOPE, ALL)).toHaveLength(1);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(7000);

    nock(ORIGIN).get(REPOS_PATH).query(true).times(4).reply(429, { message: 'Rate limit' });
    await expect(enumerator(sleep).enumerate(ORG_SCOPE, ALL)).rejects.toThrow(/HTTP 429/);
    warn.mockRestore();
  });
});

describe('AzureDevOpsEnumerator.fetchPullRequestStats', () => {
  it('pages until an empty page and aggregates windows, authors and statuses', async () => {
    const oldPage = Array.from({ length: 100 }, (_, i) =>
      makePr(i + 1, { creationDate: '2025-10-01T00:00:00Z', createdBy: { id: 'old' } })
    ); // a full page, so the next request has to $skip it
    nock(ORIGIN)
      .get(PRS_PATH)
      .query(prQuery(0))
      .reply(200, { value: oldPage })
      .get(PRS_PATH)
      .query(prQuery(100))
      .reply(200, {
        value: [
          makePr(101, { creationDate: '2026-07-28T00:00:00.0000000Z', createdBy: { id: 'bob' } }),
          makePr(102, { status: 'active', creationDate: '2026-07-10T00:00:00Z' }),
          makePr(103, { status: 'abandoned', creationDate: '2026-05-15T00:00:00Z', createdBy: {} }),
        ],
      })
      .get(PRS_PATH)
      .query(prQuery(103))
      .reply(200, { value: [] });

    const stats = await enumerator().fetchPullRequestStats('Platform/api', { now: NOW });

    expect(stats).toMatchObject({
      lastPrAt: '2026-07-28T00:00:00Z',
      prsLast1w: 1,
      prsLast4w: 2,
      prsLast3m: 3,
      prsLast12m: 103,
      // bob + user-1 (by id, not uniqueName); the PR with no author counts as none.
      prAuthorsLast4w: 2,
      prAuthorsLast24m: 3,
    });
  });

  it.each([401, 403, 404])('throws a loud PullRequestFetchError on HTTP %i', async (status) => {
    nock(ORIGIN).get(PRS_PATH).query(true).reply(status, { message: 'TF401019' });
    const err = await enumerator()
      .fetchPullRequestStats('Platform/api')
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(PullRequestFetchError);
    expect((err as Error).message).toMatch(/Platform\/api.*Code \(Read\)/s);
  });

  it('gives up if the server never ends the listing', async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => makePr(i + 1));
    nock(ORIGIN).get(PRS_PATH).query(true).times(1000).reply(200, { value: fullPage });
    await expect(
      enumerator().fetchPullRequestStats('Platform/api', { now: NOW })
    ).rejects.toThrow(PullRequestFetchError);
  });
});
