// rest.ts — the REST v3 surface: repositories, branches, commits, contents, issues, labels,
// comments and pull requests. Every handler is a pure function of (store, params, query, body)
// returning {status, body, headers}; app.ts owns the HTTP plumbing and auth.

import {
  VIEWER,
  isObjectId,
  parseCommit,
  parseTree,
  flattenTree,
  mergeBase,
  type Repo,
  type Store,
  type Issue,
  type Pull,
  type Label,
} from './store.ts';

export interface RestResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): RestResult {
  return { status, body, headers };
}

export function err(status: number, message: string): RestResult {
  return { status, body: { message } };
}

const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

// ---------------------------------------------------------------------------------------------
// shapes
// ---------------------------------------------------------------------------------------------

export function userJson(login: string): Record<string, unknown> {
  return { login, id: login === VIEWER.login ? VIEWER.id : 0, type: 'User', site_admin: false };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  const openIssues = repo.issues.filter((issue) => issue.state === 'open').length
    + repo.pulls.filter((pull) => pull.state === 'open').length;
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: repo.fullName,
    owner: userJson(repo.owner),
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    html_url: `https://github.com/${repo.fullName}`,
    url: `/api/v3/repos/${repo.fullName}`,
    clone_url: `https://github.com/${repo.fullName}.git`,
    git_url: `git://github.com/${repo.fullName}.git`,
    ssh_url: `git@github.com:${repo.fullName}.git`,
    homepage: null,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: openIssues,
    license: null,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    archived: false,
    disabled: false,
    allow_forking: true,
    is_template: false,
    fork: false,
    mirror_url: null,
    size: 0,
  };
}

export function labelJson(label: Label): Record<string, unknown> {
  return { id: 0, name: label.name, color: label.color, description: label.description, default: true };
}

export function issueJson(repo: Repo, issue: Issue, store: Store): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: store.issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map(labelJson),
    user: userJson(issue.user),
    assignees: [],
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    comments: issue.comments.length,
    url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
    html_url: `https://github.com/${repo.fullName}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.fullName}`,
    labels_url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}/labels{/name}`,
    comments_url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}/comments`,
    events_url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}/events`,
    locked: false,
    author_association: 'OWNER',
    state_reason: null,
  };
}

export function pullJson(repo: Repo, pull: Pull, store: Store): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: store.pullGlobalId(repo, pull),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: {
      label: `${repo.owner}:${pull.head.ref}`,
      ref: pull.head.ref,
      sha: pull.head.sha,
      user: userJson(repo.owner),
      repo: repoJson(repo),
    },
    base: {
      label: `${repo.owner}:${pull.base.ref}`,
      ref: pull.base.ref,
      sha: pull.base.sha,
      user: userJson(repo.owner),
      repo: repoJson(repo),
    },
    merged: pull.merged,
    mergeable: pullMergeable(repo, pull),
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: userJson(pull.user),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    url: `/api/v3/repos/${repo.fullName}/pulls/${pull.number}`,
    html_url: `https://github.com/${repo.fullName}/pull/${pull.number}`,
    diff_url: `https://github.com/${repo.fullName}/pull/${pull.number}.diff`,
    patch_url: `https://github.com/${repo.fullName}/pull/${pull.number}.patch`,
    issue_url: `/api/v3/repos/${repo.fullName}/issues/${pull.number}`,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
    draft: false,
    locked: false,
    author_association: 'OWNER',
  };
}

export function commentJson(repo: Repo, issue: Issue, comment: { id: number; body: string; user: string; createdAt: string }, store: Store): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: store.commentGlobalId(repo, issue, comment),
    body: comment.body,
    user: userJson(comment.user),
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}/comments/${comment.id}`,
    html_url: `https://github.com/${repo.fullName}/issues/${issue.number}#issuecomment-${comment.id}`,
    issue_url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
    author_association: 'OWNER',
  };
}

// ---------------------------------------------------------------------------------------------
// pagination
// ---------------------------------------------------------------------------------------------

export interface Page {
  items: unknown[];
  link: string | null;
}

/** Slice a list by per_page/page and build a GitHub Link header (absolute, same-origin). */
export function paginate(
  all: unknown[],
  query: URLSearchParams,
  baseUrl: string,
  path: string,
  defaultPerPage = 30,
): Page {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? defaultPerPage) || defaultPerPage));
  const page = Math.max(1, Number(query.get('page') ?? 1) || 1);
  const start = (page - 1) * perPage;
  const items = all.slice(start, start + perPage);
  let link: string | null = null;
  const totalPages = Math.max(1, Math.ceil(all.length / perPage));
  if (page < totalPages) {
    const next = new URL(`${baseUrl}${path}`);
    for (const [key, value] of query) if (key !== 'page') next.searchParams.set(key, value);
    next.searchParams.set('per_page', String(perPage));
    next.searchParams.set('page', String(page + 1));
    link = `<${next.toString()}>; rel="next"`;
    const last = new URL(`${baseUrl}${path}`);
    for (const [key, value] of query) if (key !== 'page') last.searchParams.set(key, value);
    last.searchParams.set('per_page', String(perPage));
    last.searchParams.set('page', String(totalPages));
    link += `, <${last.toString()}>; rel="last"`;
  }
  return { items, link };
}

// ---------------------------------------------------------------------------------------------
// pull request helpers (shared with GraphQL and MCP)
// ---------------------------------------------------------------------------------------------

/** 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' for a pull request, by a three-way check. */
export function pullMergeable(repo: Repo, pull: Pull): string {
  if (pull.state !== 'open') return 'UNKNOWN';
  const merged = computeMerge(repo, pull);
  return merged.conflict ? 'CONFLICTING' : 'MERGEABLE';
}

/** A line diff's added/removed line counts (multiset difference; the suite checks shape, not exact counts). */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  if (oldLines.length > 0 && oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines.length > 0 && newLines[newLines.length - 1] === '') newLines.pop();
  const oldCounts = new Map<string, number>();
  for (const line of oldLines) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of newLines) {
    const count = oldCounts.get(line) ?? 0;
    if (count > 0) oldCounts.set(line, count - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const count of oldCounts.values()) deletions += count;
  return { additions, deletions };
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

/** The changed files of a pull request: base tip tree vs head tip tree. */
export function pullFiles(repo: Repo, pull: Pull): PullFile[] {
  const baseTree = repo.treeOf(pull.base.sha);
  const headTree = repo.treeOf(pull.head.sha);
  const base = baseTree === null ? new Map() : flattenTree(repo, baseTree);
  const head = headTree === null ? new Map() : flattenTree(repo, headTree);
  const files: PullFile[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const inBase = base.get(path);
    const inHead = head.get(path);
    if (inBase && !inHead) {
      const old = repo.objects.get(inBase.oid);
      const oldText = old ? old.data.toString('utf8') : '';
      const { additions, deletions } = lineDiff(oldText, '');
      files.push({ filename: path, status: 'removed', additions, deletions, changes: additions + deletions });
    } else if (!inBase && inHead) {
      const next = repo.objects.get(inHead.oid);
      const newText = next ? next.data.toString('utf8') : '';
      const { additions, deletions } = lineDiff('', newText);
      files.push({ filename: path, status: 'added', additions, deletions, changes: additions + deletions });
    } else if (inBase && inHead && inBase.oid !== inHead.oid) {
      const old = repo.objects.get(inBase.oid);
      const next = repo.objects.get(inHead.oid);
      const { additions, deletions } = lineDiff(
        old ? old.data.toString('utf8') : '',
        next ? next.data.toString('utf8') : '',
      );
      files.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return files;
}

/** The three-way merge of a pull request: the result tree, or a conflict. */
export function computeMerge(repo: Repo, pull: Pull): { conflict: boolean; treeOid: string | null } {
  // The merge is against the CURRENT tip of the base branch, not the sha captured when the
  // pull request was opened: another pull request merged in the meantime moves the base, and
  // a second pull request changing the same file to different content must then conflict.
  const baseTip = repo.refs.get(`refs/heads/${pull.base.ref}`) ?? pull.base.sha;
  const headTip = pull.head.sha;
  const base = mergeBase(repo, headTip, baseTip);
  const baseTree = base === null ? null : repo.treeOf(base);
  const headTree = repo.treeOf(headTip);
  const currentTree = repo.treeOf(baseTip);
  if (headTree === null || currentTree === null) return { conflict: false, treeOid: headTree };
  const baseFlat = baseTree === null ? new Map() : flattenTree(repo, baseTree);
  const headFlat = flattenTree(repo, headTree);
  const currentFlat = flattenTree(repo, currentTree);
  // Paths changed on the head side vs the merge-base.
  const headChanged = new Map<string, string | null>();
  for (const path of new Set([...baseFlat.keys(), ...headFlat.keys()])) {
    const b = baseFlat.get(path)?.oid;
    const h = headFlat.get(path)?.oid;
    if (b !== h) headChanged.set(path, h ?? null);
  }
  const baseChanged = new Map<string, string | null>();
  for (const path of new Set([...baseFlat.keys(), ...currentFlat.keys()])) {
    const b = baseFlat.get(path)?.oid;
    const c = currentFlat.get(path)?.oid;
    if (b !== c) baseChanged.set(path, c ?? null);
  }
  for (const [path, headOid] of headChanged) {
    if (!baseChanged.has(path)) continue;
    if (baseChanged.get(path) !== headOid) return { conflict: true, treeOid: null };
  }
  // Apply the head's changes onto the current base tree.
  let treeOid = currentTree;
  for (const [path, headOid] of headChanged) {
    if (headOid === null) treeOid = repo.writePath(treeOid, path, null);
    else treeOid = repo.writePath(treeOid, path, headOid);
  }
  return { conflict: false, treeOid };
}

/** Squash-merge an open pull request onto its base branch. Returns the merge commit sha, or an error. */
export function mergePull(
  store: Store,
  repo: Repo,
  pull: Pull,
  method: string,
): { ok: true; sha: string } | { ok: false; status: number; message: string } {
  if (pull.state !== 'open') {
    return { ok: false, status: 405, message: pull.merged ? 'Pull request has already been merged' : 'Pull request is closed' };
  }
  if (method !== undefined && method !== '' && method !== 'squash' && method !== 'merge' && method !== 'rebase') {
    return { ok: false, status: 422, message: `Unknown merge method ${method}` };
  }
  const merged = computeMerge(repo, pull);
  if (merged.conflict || merged.treeOid === null) {
    return { ok: false, status: 405, message: 'Merge conflict' };
  }
  const baseTip = repo.refs.get(`refs/heads/${pull.base.ref}`);
  if (baseTip === undefined) return { ok: false, status: 422, message: `Base branch ${pull.base.ref} does not exist` };
  const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.head.ref}\n\n${pull.title}`;
  const sha = store.makeCommit(repo, merged.treeOid, [baseTip], message);
  repo.refs.set(`refs/heads/${pull.base.ref}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = store.stamp(store.nextSeqValue());
  pull.mergeCommitSha = sha;
  pull.updatedAt = pull.mergedAt;
  return { ok: true, sha };
}

// ---------------------------------------------------------------------------------------------
// contents helpers (shared with the MCP setup's branch creation)
// ---------------------------------------------------------------------------------------------

/**
 * Write a file on a branch (creating the branch from the default tip when it does not exist),
 * committing it. Returns the commit sha and the blob sha, or an error.
 */
export function commitFile(
  store: Store,
  repo: Repo,
  path: string,
  contentBase64: string,
  message: string,
  branch: string | undefined,
  expectedSha: string | undefined,
): { ok: true; commitSha: string; blobSha: string; created: boolean } | { ok: false; status: number; message: string } {
  let branchName = branch ?? repo.defaultBranch;
  let tip = repo.refs.get(`refs/heads/${branchName}`);
  if (tip === undefined) {
    // A contents write on a branch that does not exist creates it from the default tip.
    const defaultTip = repo.defaultTip();
    if (defaultTip === null) {
      // The repository has no commits at all: the branch starts unborn.
      tip = undefined;
    } else {
      repo.refs.set(`refs/heads/${branchName}`, defaultTip);
      tip = defaultTip;
    }
  }
  const baseTree = tip === undefined ? null : repo.treeOf(tip);
  const existing = baseTree === null ? null : repo.readPath(baseTree, path);
  let content: Buffer;
  try {
    content = Buffer.from(contentBase64.replace(/[\r\n\t ]+/g, ''), 'base64');
  } catch {
    return { ok: false, status: 422, message: 'content is not valid base64' };
  }
  const created = existing === null;
  if (!created && expectedSha !== undefined && expectedSha !== existing!.oid) {
    return { ok: false, status: 409, message: 'sha does not match the current file' };
  }
  const blobSha = repo.putObject('blob', content);
  const treeOid = repo.writePath(baseTree, path, blobSha);
  const commitSha = store.makeCommit(repo, treeOid, tip === undefined ? [] : [tip], message);
  repo.refs.set(`refs/heads/${branchName}`, commitSha);
  return { ok: true, commitSha, blobSha, created };
}

/** Delete a file on a branch, committing it. */
export function deleteFile(
  store: Store,
  repo: Repo,
  path: string,
  message: string,
  branch: string | undefined,
  expectedSha: string | undefined,
): { ok: true; commitSha: string } | { ok: false; status: number; message: string } {
  const branchName = branch ?? repo.defaultBranch;
  const tip = repo.refs.get(`refs/heads/${branchName}`);
  if (tip === undefined) return { ok: false, status: 404, message: 'Not Found' };
  const baseTree = repo.treeOf(tip);
  const existing = baseTree === null ? null : repo.readPath(baseTree, path);
  if (existing === null) return { ok: false, status: 404, message: 'Not Found' };
  if (expectedSha !== undefined && expectedSha !== existing.oid) {
    return { ok: false, status: 409, message: 'sha does not match the current file' };
  }
  const treeOid = repo.writePath(baseTree, path, null);
  const commitSha = store.makeCommit(repo, treeOid, [tip], message);
  repo.refs.set(`refs/heads/${branchName}`, commitSha);
  return { ok: true, commitSha };
}

// ---------------------------------------------------------------------------------------------
// the REST router
// ---------------------------------------------------------------------------------------------

export interface RestContext {
  store: Store;
  /** The request's origin, for absolute pagination URLs. */
  baseUrl: string;
}

/**
 * Handle one REST request. `segments` are the path parts after /api/v3, `query` the parsed query,
 * `body` the parsed JSON body (undefined when none was sent; a JSON parse error is reported via
 * `bodyError`). Returns the response. Unknown routes are 404 JSON.
 */
export function handleRest(
  ctx: RestContext,
  method: string,
  segments: string[],
  query: URLSearchParams,
  body: unknown,
  bodyError: boolean,
): RestResult {
  const { store } = ctx;
  const get = (index: number): string | undefined => segments[index];

  if (bodyError) return err(400, 'Invalid JSON body');

  // GET /api/v3/ — the API root.
  if (segments.length === 0) {
    if (method !== 'GET') return err(404, 'Not Found');
    return json(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
  }

  // GET /api/v3/meta
  if (segments.length === 1 && get(0) === 'meta') {
    if (method !== 'GET') return err(404, 'Not Found');
    return json(200, { installed_version: '1.0.0' });
  }

  // GET /api/v3/user
  if (segments.length === 1 && get(0) === 'user') {
    if (method !== 'GET') return err(404, 'Not Found');
    return json(200, {
      login: VIEWER.login,
      id: VIEWER.id,
      node_id: store.globalId('User', VIEWER.login),
      name: VIEWER.name,
      email: VIEWER.email,
      type: 'User',
      site_admin: false,
      avatar_url: '',
      html_url: `https://github.com/${VIEWER.login}`,
      url: '/api/v3/user',
      public_repos: store.listRepos().length,
      followers: 0,
      following: 0,
    });
  }

  // POST /api/v3/user/repos, GET /api/v3/user/repos
  if (segments.length === 2 && get(0) === 'user' && get(1) === 'repos') {
    if (method === 'POST') {
      const input = (body ?? {}) as Record<string, unknown>;
      const name = input.name;
      if (typeof name !== 'string' || name === '' || !REPO_NAME.test(name) || name.endsWith('.git')) {
        return err(422, 'name is required and must be a valid repository name');
      }
      if (store.getRepo(VIEWER.login, name) !== null) {
        return err(422, `Repository ${VIEWER.login}/${name} already exists`);
      }
      const repo = store.createRepo(
        name,
        typeof input.description === 'string' ? input.description : '',
        input.private === true,
      );
      return json(201, repoJson(repo));
    }
    if (method === 'GET') {
      const all = store.listRepos().map((repo) => repoJson(repo));
      const page = paginate(all, query, ctx.baseUrl, '/api/v3/user/repos');
      return json(200, page.items, page.link !== null ? { link: page.link } : {});
    }
    return err(404, 'Not Found');
  }

  // /api/v3/repos/{owner}/{repo}[/...]
  if (get(0) === 'repos' && segments.length >= 3) {
    const owner = decodeURIComponent(get(1)!);
    const repoName = decodeURIComponent(get(2)!);
    const repo = store.getRepo(owner, repoName);
    const tail = segments.slice(3);

    // The repository itself.
    if (tail.length === 0) {
      if (repo === null) return err(404, 'Not Found');
      if (method === 'GET') return json(200, repoJson(repo));
      if (method === 'PATCH') {
        const input = (body ?? {}) as Record<string, unknown>;
        if (typeof input.description === 'string') repo.description = input.description;
        if (typeof input.private === 'boolean') repo.private = input.private;
        repo.updatedAt = store.stamp(store.nextSeqValue());
        return json(200, repoJson(repo));
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, repoName);
        return { status: 204, body: null };
      }
      return err(404, 'Not Found');
    }
    if (repo === null) return err(404, 'Not Found');

    // GET /branches, GET /branches/{branch}
    if (tail[0] === 'branches') {
      if (method !== 'GET') return err(404, 'Not Found');
      const branches = [...repo.refs.keys()]
        .filter((name) => name.startsWith('refs/heads/'))
        .sort()
        .map((name) => ({ name: name.slice('refs/heads/'.length), commit: { sha: repo.refs.get(name)! } }));
      if (tail.length === 1) return json(200, branches);
      if (tail.length === 2) {
        const found = branches.find((branch) => branch.name === decodeURIComponent(tail[1]!));
        if (!found) return err(404, 'Not Found');
        return json(200, found);
      }
      return err(404, 'Not Found');
    }

    // GET /commits[?sha=ref]
    if (tail[0] === 'commits') {
      if (method !== 'GET' || tail.length !== 1) return err(404, 'Not Found');
      const ref = query.get('sha') ?? repo.defaultBranch;
      const tip = repo.resolveRef(ref);
      if (tip === null) return json(200, []);
      const commits: Record<string, unknown>[] = [];
      const seen = new Set<string>();
      const queue = [tip];
      while (queue.length > 0) {
        const oid = queue.shift()!;
        if (seen.has(oid)) continue;
        seen.add(oid);
        const object = repo.objects.get(oid);
        if (!object || object.type !== 'commit') continue;
        const view = parseCommit(object.data);
        const authorLine = view.author;
        const authorMatch = /^(.*) <(.*)> (\d+) \+0000$/.exec(authorLine);
        commits.push({
          sha: oid,
          commit: {
            message: view.message,
            author: {
              name: authorMatch?.[1] ?? authorLine,
              email: authorMatch?.[2] ?? '',
              date: authorMatch ? new Date(Number(authorMatch[3]) * 1000).toISOString() : '',
            },
            committer: {
              name: authorMatch?.[1] ?? authorLine,
              email: authorMatch?.[2] ?? '',
              date: authorMatch ? new Date(Number(authorMatch[3]) * 1000).toISOString() : '',
            },
            tree: { sha: view.tree },
          },
          parents: view.parents.map((parent) => ({ sha: parent })),
          url: `/api/v3/repos/${repo.fullName}/commits/${oid}`,
          html_url: `https://github.com/${repo.fullName}/commit/${oid}`,
        });
        for (const parent of view.parents) queue.push(parent);
      }
      const page = paginate(commits, query, ctx.baseUrl, `/api/v3/repos/${owner}/${repoName}/commits`);
      return json(200, page.items, page.link !== null ? { link: page.link } : {});
    }

    // /git/refs
    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (method === 'POST' && tail.length === 2) {
        const input = (body ?? {}) as Record<string, unknown>;
        const ref = input.ref;
        const sha = input.sha;
        if (typeof ref !== 'string' || !ref.startsWith('refs/') || typeof sha !== 'string' || !isObjectId(sha)) {
          return err(422, 'ref and sha are required');
        }
        if (repo.refs.has(ref)) return err(422, 'Reference already exists');
        if (!repo.objects.has(sha)) return err(422, 'Object does not exist');
        repo.refs.set(ref, sha);
        return json(201, { ref, object: { sha, type: repo.objects.get(sha)!.type, url: '' } });
      }
      if (method === 'GET') {
        if (tail.length === 2) {
          const all = [...repo.refs.entries()]
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([ref, sha]) => ({ ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: '' } }));
          return json(200, all);
        }
        const refName = tail.slice(2).map((segment) => decodeURIComponent(segment)).join('/');
        const sha = repo.refs.get(refName);
        if (sha === undefined) return err(404, 'Not Found');
        return json(200, { ref: refName, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: '' } });
      }
      return err(404, 'Not Found');
    }

    // /contents/{path}
    if (tail[0] === 'contents') {
      const path = tail.slice(1).map((segment) => decodeURIComponent(segment)).join('/');
      if (method === 'GET') {
        const ref = query.get('ref') ?? repo.defaultBranch;
        const treeOid = repo.treeOf(ref);
        if (treeOid === null) return err(404, 'Not Found');
        if (path === '') {
          const entries = repo.listDir(treeOid, '');
          if (entries === null) return err(404, 'Not Found');
          return json(200, entries.map((entry) => ({
            type: entry.type,
            name: entry.name,
            path: entry.path,
            sha: entry.oid,
            size: entry.size,
            url: `/api/v3/repos/${repo.fullName}/contents/${entry.path}`,
            html_url: `https://github.com/${repo.fullName}/blob/${ref}/${entry.path}`,
          })));
        }
        const file = repo.readPath(treeOid, path);
        if (file !== null) {
          return json(200, {
            type: 'file',
            encoding: 'base64',
            size: file.data.length,
            name: path.split('/').pop()!,
            path,
            content: file.data.toString('base64'),
            sha: file.oid,
            url: `/api/v3/repos/${repo.fullName}/contents/${path}`,
            html_url: `https://github.com/${repo.fullName}/blob/${ref}/${path}`,
          });
        }
        const entries = repo.listDir(treeOid, path);
        if (entries === null) return err(404, 'Not Found');
        return json(200, entries.map((entry) => ({
          type: entry.type,
          name: entry.name,
          path: entry.path,
          sha: entry.oid,
          size: entry.size,
          url: `/api/v3/repos/${repo.fullName}/contents/${entry.path}`,
          html_url: `https://github.com/${repo.fullName}/blob/${ref}/${entry.path}`,
        })));
      }
      if (method === 'PUT') {
        const input = (body ?? {}) as Record<string, unknown>;
        const message = typeof input.message === 'string' ? input.message : 'Update file';
        const content = typeof input.content === 'string' ? input.content : '';
        const branch = typeof input.branch === 'string' ? input.branch : undefined;
        const sha = typeof input.sha === 'string' ? input.sha : undefined;
        const result = commitFile(store, repo, path, content, message, branch, sha);
        if (!result.ok) return err(result.status, result.message);
        const treeOid = repo.treeOf(branch ?? repo.defaultBranch);
        const file = treeOid === null ? null : repo.readPath(treeOid, path);
        return json(result.created ? 201 : 200, {
          content: {
            type: 'file',
            encoding: 'base64',
            size: file ? file.data.length : 0,
            name: path.split('/').pop()!,
            path,
            content,
            sha: result.blobSha,
            url: `/api/v3/repos/${repo.fullName}/contents/${path}`,
          },
          commit: { sha: result.commitSha, message },
        });
      }
      if (method === 'DELETE') {
        const input = (body ?? {}) as Record<string, unknown>;
        const message = typeof input.message === 'string' ? input.message : 'Delete file';
        const branch = typeof input.branch === 'string' ? input.branch : undefined;
        const sha = typeof input.sha === 'string' ? input.sha : undefined;
        const result = deleteFile(store, repo, path, message, branch, sha);
        if (!result.ok) return err(result.status, result.message);
        return json(200, { commit: { sha: result.commitSha, message } });
      }
      return err(404, 'Not Found');
    }

    // /labels
    if (tail[0] === 'labels') {
      if (method === 'GET' && tail.length === 1) return json(200, repo.labels.map(labelJson));
      if (method === 'POST' && tail.length === 1) {
        const input = (body ?? {}) as Record<string, unknown>;
        const name = input.name;
        if (typeof name !== 'string' || name === '') return err(422, 'name is required');
        // Creating a label that already exists (including the defaults a new repository
        // is seeded with) answers 201 with the existing label, as the suite's fixtures
        // create their labels through this route on fresh repositories.
        const existing = repo.labels.find((label) => label.name === name);
        if (existing !== undefined) return json(201, labelJson(existing));
        const label: Label = {
          name,
          color: typeof input.color === 'string' ? input.color.replace(/^#/, '') : 'ededed',
          description: typeof input.description === 'string' ? input.description : '',
        };
        repo.labels.push(label);
        return json(201, labelJson(label));
      }
      return err(404, 'Not Found');
    }

    // /issues[/{n}[/comments]]
    if (tail[0] === 'issues') {
      if (tail.length === 1) {
        if (method === 'POST') {
          const input = (body ?? {}) as Record<string, unknown>;
          const title = input.title;
          if (typeof title !== 'string' || title === '') return err(422, 'title is required');
          const wanted = Array.isArray(input.labels) ? (input.labels as unknown[]) : [];
          const labels: Label[] = [];
          for (const name of wanted) {
            if (typeof name !== 'string') continue;
            const found = repo.labels.find((label) => label.name === name);
            if (!found) return err(422, `Invalid label: ${name}`);
            labels.push(found);
          }
          const issue = store.createIssue(repo, title, typeof input.body === 'string' ? input.body : '', labels);
          return json(201, issueJson(repo, issue, store));
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const sort = query.get('sort') ?? 'created';
          const direction = query.get('direction') ?? 'desc';
          let list = [...repo.issues];
          if (state === 'open') list = list.filter((issue) => issue.state === 'open');
          else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
          else if (state !== 'all') return err(422, `Invalid state ${state}`);
          if (sort === 'created') {
            list.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
          }
          const all = list.map((issue) => issueJson(repo, issue, store));
          const page = paginate(all, query, ctx.baseUrl, `/api/v3/repos/${owner}/${repoName}/issues`);
          return json(200, page.items, page.link !== null ? { link: page.link } : {});
        }
        return err(404, 'Not Found');
      }
      const number = Number(tail[1]);
      if (!Number.isInteger(number) || number <= 0) return err(404, 'Not Found');
      const issue = repo.issues.find((entry) => entry.number === number);
      if (tail.length === 2) {
        if (issue === undefined) return err(404, 'Not Found');
        if (method === 'GET') return json(200, issueJson(repo, issue, store));
        if (method === 'PATCH') {
          const input = (body ?? {}) as Record<string, unknown>;
          if (typeof input.title === 'string') issue.title = input.title;
          if (typeof input.body === 'string') issue.body = input.body;
          if (input.state === 'closed' || input.state === 'open') {
            issue.state = input.state;
            issue.closedAt = input.state === 'closed' ? store.stamp(store.nextSeqValue()) : null;
          }
          issue.updatedAt = store.stamp(store.nextSeqValue());
          return json(200, issueJson(repo, issue, store));
        }
        return err(404, 'Not Found');
      }
      if (tail.length === 3 && tail[2] === 'comments') {
        if (issue === undefined) return err(404, 'Not Found');
        if (method === 'GET') {
          return json(200, issue.comments.map((comment) => commentJson(repo, issue, comment, store)));
        }
        if (method === 'POST') {
          const input = (body ?? {}) as Record<string, unknown>;
          const text = input.body;
          if (typeof text !== 'string' || text === '') return err(422, 'body is required');
          const seq = store.nextSeqValue();
          const comment = { id: repo.nextCommentId, body: text, user: VIEWER.login, createdAt: store.stamp(seq) };
          repo.nextCommentId += 1;
          issue.comments.push(comment);
          return json(201, commentJson(repo, issue, comment, store));
        }
        return err(404, 'Not Found');
      }
      return err(404, 'Not Found');
    }

    // /pulls[/{n}[/files|/merge]]
    if (tail[0] === 'pulls') {
      if (tail.length === 1) {
        if (method === 'POST') {
          const input = (body ?? {}) as Record<string, unknown>;
          const title = input.title;
          const head = input.head;
          const base = input.base;
          if (typeof title !== 'string' || title === '') return err(422, 'title is required');
          if (typeof head !== 'string' || typeof base !== 'string') return err(422, 'head and base are required');
          const headSha = repo.refs.get(`refs/heads/${head}`);
          const baseSha = repo.refs.get(`refs/heads/${base}`);
          if (headSha === undefined) return err(422, `Invalid head branch ${head}`);
          if (baseSha === undefined) return err(422, `Invalid base branch ${base}`);
          const existing = repo.pulls.find((pull) => pull.head.ref === head && pull.base.ref === base && pull.state === 'open');
          if (existing !== undefined) return err(422, `A pull request already exists for ${head}`);
          const pull = store.createPull(repo, title, typeof input.body === 'string' ? input.body : '', head, headSha, base, baseSha);
          return json(201, pullJson(repo, pull, store));
        }
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          let list = [...repo.pulls];
          if (state === 'open') list = list.filter((pull) => pull.state === 'open');
          else if (state === 'closed') list = list.filter((pull) => pull.state === 'closed');
          else if (state !== 'all') return err(422, `Invalid state ${state}`);
          list.sort((a, b) => b.createdSeq - a.createdSeq);
          const all = list.map((pull) => pullJson(repo, pull, store));
          const page = paginate(all, query, ctx.baseUrl, `/api/v3/repos/${owner}/${repoName}/pulls`);
          return json(200, page.items, page.link !== null ? { link: page.link } : {});
        }
        return err(404, 'Not Found');
      }
      const number = Number(tail[1]);
      if (!Number.isInteger(number) || number <= 0) return err(404, 'Not Found');
      const pull = repo.pulls.find((entry) => entry.number === number);
      if (tail.length === 2) {
        if (pull === undefined) return err(404, 'Not Found');
        if (method === 'GET') return json(200, pullJson(repo, pull, store));
        return err(404, 'Not Found');
      }
      if (tail.length === 3 && tail[2] === 'files') {
        if (pull === undefined) return err(404, 'Not Found');
        if (method === 'GET') return json(200, pullFiles(repo, pull));
        return err(404, 'Not Found');
      }
      if (tail.length === 3 && tail[2] === 'merge') {
        if (pull === undefined) return err(404, 'Not Found');
        if (method === 'PUT') {
          const input = (body ?? {}) as Record<string, unknown>;
          const methodName = typeof input.merge_method === 'string' ? input.merge_method : 'squash';
          const result = mergePull(store, repo, pull, methodName);
          if (!result.ok) return err(result.status, result.message);
          return json(200, { sha: result.sha, merged: true, message: 'Pull request successfully merged' });
        }
        return err(404, 'Not Found');
      }
      return err(404, 'Not Found');
    }

    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}
