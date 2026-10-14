/**
 * Azure DevOps Services enumerator (dev.azure.com).
 *
 * Plain REST over Node's global `fetch`, with a small retry loop for 429.
 * Repo listing, PR listing and the clone itself all need only the PAT scope
 * Code (Read). `fullName` is `<project>/<repo>`: unique within one org, and
 * the same two-segment shape as GitHub's `owner/repo`.
 */

import {
  aggregatePullRequests,
  PullRequestFetchError,
  type PullRequestNode,
  type PullRequestStats,
  type PullRequestState,
} from '../analyse/pullRequests.js';
import { buildAuthenticatedCloneUrl } from './github.js';
import type {
  EnumerateOptions,
  RepoListing,
  ScmEnumerator,
  ScmScope,
} from './types.js';

const API_ORIGIN = 'https://dev.azure.com';
const API_VERSION = '7.1';
const PR_PAGE_SIZE = 100;
const MAX_ATTEMPTS = 4;
const MAX_RETRY_WAIT_MS = 120_000;
const MAX_PR_PAGES = 1000;
const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

export interface AzureDevOpsEnumeratorOptions {
  /** Override for tests — replaces the real timer between retries. */
  sleep?: (ms: number) => Promise<void>;
}

export class AzureDevOpsEnumerator implements ScmEnumerator {
  private readonly authHeader: string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly token: string,
    private readonly organization: string,
    options: AzureDevOpsEnumeratorOptions = {}
  ) {
    // Azure ignores the Basic-auth user name; the PAT is the password.
    this.authHeader = `Basic ${Buffer.from(`:${token}`).toString('base64')}`;
    this.sleep =
      options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async enumerate(
    scope: ScmScope,
    opts: EnumerateOptions
  ): Promise<RepoListing[]> {
    if (scope.provider !== 'azure') {
      throw new Error(
        `AzureDevOpsEnumerator received non-azure scope: ${scope.provider}`
      );
    }

    // Without a project, the org-level list covers every project. It is
    // undocumented but served, and not paged.
    const projectPath = scope.project ? `/${encodeURIComponent(scope.project)}` : '';
    let raw: AzureRepo[];
    try {
      const body = await this.getJson<{ value: AzureRepo[] }>(
        `${this.orgUrl()}${projectPath}/_apis/git/repositories?api-version=${API_VERSION}`
      );
      raw = body.value;
    } catch (err) {
      throw mapAzureError(err, scope);
    }

    return raw
      .map((repo) => this.toListing(repo))
      .filter((listing) => {
        if (!opts.includeArchived && listing.isArchived) return false;
        if (!opts.includeForks && listing.isFork) return false;
        return true;
      });
  }

  /** Page through every PR on `<project>/<repo>` and aggregate sizing facts. */
  async fetchPullRequestStats(
    fullName: string,
    options: { now?: Date } = {}
  ): Promise<PullRequestStats> {
    const slash = fullName.indexOf('/');
    if (slash <= 0 || slash === fullName.length - 1) {
      throw new PullRequestFetchError(
        `Cannot fetch pull requests for invalid repository name "${fullName}".`
      );
    }
    const project = fullName.slice(0, slash);
    const repo = fullName.slice(slash + 1);

    try {
      const base =
        `${this.orgUrl()}/${encodeURIComponent(project)}` +
        `/_apis/git/repositories/${encodeURIComponent(repo)}/pullrequests` +
        `?searchCriteria.status=all&$top=${PR_PAGE_SIZE}&api-version=${API_VERSION}`;

      const nodes: PullRequestNode[] = [];
      for (let pageNo = 0, skip = 0; ; pageNo++) {
        if (pageNo >= MAX_PR_PAGES) {
          throw new PullRequestFetchError(
            `Gave up listing pull requests for ${fullName} after ${MAX_PR_PAGES} pages.`
          );
        }
        const page = await this.getJson<{ value: AzurePullRequest[] }>(
          `${base}&$skip=${skip}`
        );
        // End on an empty page: `$top` has no documented ceiling, so a short
        // page may just be the server truncating.
        if (page.value.length === 0) break;
        for (const pr of page.value) {
          nodes.push({
            number: pr.pullRequestId,
            state: normalizePrState(pr.status),
            createdAt: normalizeTimestamp(pr.creationDate),
            // Not `uniqueName`: it is missing on some identities, and mixing
            // the two would count one person twice.
            authorLogin: pr.createdBy?.id ?? null,
          });
        }
        skip += page.value.length;
      }

      return aggregatePullRequests(nodes, { now: options.now });
    } catch (err) {
      if (err instanceof PullRequestFetchError) throw err;
      throw mapPullRequestFetchError(err, fullName);
    }
  }

  private orgUrl(): string {
    return `${API_ORIGIN}/${encodeURIComponent(this.organization)}`;
  }

  /** GET + parse JSON, retrying 429/5xx per `Retry-After`. */
  private async getJson<T>(url: string): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const res = await fetch(url, {
        headers: { Authorization: this.authHeader, Accept: 'application/json' },
        // A bad PAT is redirected to a sign-in page on another host; never follow.
        redirect: 'manual',
      });

      if (RETRYABLE_STATUSES.has(res.status) && attempt < MAX_ATTEMPTS) {
        await res.text().catch(() => '');
        const waitMs = retryDelayMs(res.headers.get('retry-after'), attempt);
        console.warn(
          `[azure] HTTP ${res.status} (GET ${new URL(url).pathname}); retrying after ${Math.ceil(waitMs / 1000)}s`
        );
        await this.sleep(waitMs);
        continue;
      }

      // A rejected PAT gets a 203, redirect or HTML sign-in page, not a 401.
      const contentType = res.headers.get('content-type') ?? '';
      if (
        res.status === 203 ||
        (res.status >= 300 && res.status < 400) ||
        (res.ok && contentType.includes('text/html'))
      ) {
        throw Object.assign(new Error('Azure DevOps answered with a sign-in page'), {
          status: 401,
        });
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw Object.assign(new Error(azureMessage(text) ?? res.statusText), {
          status: res.status,
        });
      }
      return (await res.json()) as T;
    }
  }

  private toListing(repo: AzureRepo): RepoListing {
    // Not `remoteUrl`: older orgs can return a `*.visualstudio.com` host.
    const httpsUrl =
      `${this.orgUrl()}/${encodeURIComponent(repo.project.name)}` +
      `/_git/${encodeURIComponent(repo.name)}`;
    return {
      fullName: `${repo.project.name}/${repo.name}`,
      cloneUrl: buildAuthenticatedCloneUrl(httpsUrl, this.token),
      defaultBranch: (repo.defaultBranch ?? '').replace(/^refs\/heads\//, ''),
      sizeKb: Math.round((repo.size ?? 0) / 1024),
      // Not in the repo list; one call per repo would make --list-only slow.
      pushedAt: '',
      // No archive state in Azure; a disabled repo is the closest equivalent.
      isArchived: Boolean(repo.isDisabled),
      isFork: Boolean(repo.isFork),
      isEmpty: !repo.defaultBranch,
    };
  }
}

type AzureScope = Extract<ScmScope, { provider: 'azure' }>;

interface AzureRepo {
  name: string;
  project: { name: string };
  defaultBranch?: string;
  /** Bytes. */
  size?: number;
  isDisabled?: boolean;
  isFork?: boolean;
}

interface AzurePullRequest {
  pullRequestId: number;
  status: string;
  creationDate: string;
  createdBy?: { id?: string };
}

function normalizePrState(status: string): PullRequestState {
  if (status === 'active') return 'OPEN';
  if (status === 'completed') return 'MERGED';
  return 'CLOSED';
}

/** Trim Azure's 7-digit fraction so `last_pr_at` matches GitHub's `...Z`. */
function normalizeTimestamp(value: string): string {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return value;
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function retryDelayMs(header: string | null, attempt: number): number {
  const seconds = Number(header);
  const ms = header && Number.isFinite(seconds) ? seconds * 1000 : 2 ** attempt * 1000;
  return Math.min(ms, MAX_RETRY_WAIT_MS);
}

function azureMessage(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { message?: unknown };
    return typeof parsed.message === 'string' ? parsed.message : undefined;
  } catch {
    return undefined;
  }
}

function mapPullRequestFetchError(err: unknown, fullName: string): PullRequestFetchError {
  const message = err instanceof Error ? err.message : String(err);
  return new PullRequestFetchError(
    `Failed to fetch pull requests for ${fullName}. ` +
      `Check that the PAT has the scope "Code (Read)" ` +
      `(see README Authentication).\n` +
      `Underlying error: ${message.split('\n')[0]}`
  );
}

/** Translate raw HTTP failures into user-facing errors. */
function mapAzureError(err: unknown, scope: AzureScope): Error {
  const e = err as { status?: number; message?: string };
  const where = `organisation "${scope.organization}"${scope.project ? `, project "${scope.project}"` : ''}`;
  if (e.status === 401) {
    return new Error(
      'Azure DevOps rejected the token (401). Check that the PAT has not expired, was created for the organisation you are sizing, and has the scope "Code (Read)" — see README for the click-path.'
    );
  }
  if (e.status === 404) {
    return new Error(
      `Azure DevOps returned 404 for ${where}. Check the spelling in --scope, and that the PAT belongs to that organisation.`
    );
  }
  if (e.status === 403) {
    return new Error(
      `Azure DevOps denied the request (403) for ${where}. The token likely lacks the scope "Code (Read)" or access to that project.`
    );
  }
  return new Error(
    `Azure DevOps enumeration failed${e.status ? ` (HTTP ${e.status})` : ''}: ${e.message ?? 'unknown error'}`
  );
}
