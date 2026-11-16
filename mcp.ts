// mcp.ts — Model Context Protocol endpoint at /mcp: JSON-RPC 2.0 over Streamable HTTP.
//
// Protocol revision 2026-07-28 is answered directly (server/discover reports supportedVersions),
// with a legacy initialize fallback for the 2025-11-25 and earlier revisions. Every tool acts on
// the same Store as REST and GraphQL, so a repository created over MCP reads back over /api/v3.

import { VIEWER, type Store, type Repo } from './store.ts';
import { repoJson, issueJson, pullJson, mergePull } from './rest.ts';

const PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required?: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Name of the repository to create.' } },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Name of the repository.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        title: { type: 'string', description: 'Title of the issue.' },
        body: { type: 'string', description: 'Body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        state: { type: 'string', description: 'Issue state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        title: { type: 'string', description: 'Title of the pull request.' },
        head: { type: 'string', description: 'Name of the head branch.' },
        base: { type: 'string', description: 'Name of the base branch.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        pull_number: { type: 'number', description: 'Number of the pull request to merge.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'list_repos',
    description: 'List repositories owned by a user.',
    inputSchema: {
      type: 'object',
      properties: { owner: { type: 'string', description: 'Owner login to list repositories for.' } },
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login of the repository.' },
        repo: { type: 'string', description: 'Name of the repository.' },
        state: { type: 'string', description: 'Pull request state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
];

export interface McpResult {
  status: number;
  /** null body means: no content (a notification got a 202 with an empty body). */
  body: unknown;
}

function rpcResult(id: string | number | null | undefined, result: unknown): McpResult {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, result } };
}

function rpcError(id: string | number | null | undefined, code: number, message: string, status = 200): McpResult {
  return { status, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function toolText(text: string): { content: Array<{ type: string; text: string }>; isError?: boolean } {
  return { content: [{ type: 'text', text }] };
}

function toolError(text: string): { content: Array<{ type: string; text: string }>; isError: boolean } {
  return { content: [{ type: 'text', text }], isError: true };
}

function requireString(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function findRepo(store: Store, owner: string, name: string): Repo | null {
  return store.getRepo(owner, name);
}

/** Run one tool by name; the caller maps the name onto the nearest tool first. */
function callTool(store: Store, name: string, args: Record<string, unknown>): { content: Array<{ type: string; text: string }>; isError?: boolean } {
  const key = name.toLowerCase();
  const match = (suffix: string): boolean => key === suffix || key.endsWith(`__${suffix}`) || key.endsWith(`_${suffix}`);
  const missing = (field: string): { content: Array<{ type: string; text: string }>; isError: boolean } =>
    toolError(`Missing required argument: ${field}`);

  if (match('create_repo')) {
    const repoName = requireString(args, 'name');
    if (repoName === null) return missing('name');
    const short = repoName.includes('/') ? repoName.split('/').slice(1).join('/') : repoName;
    if (store.getRepo(VIEWER.login, short) !== null) {
      return toolError(`Repository ${VIEWER.login}/${short} already exists.`);
    }
    const created = store.createRepo(short, '', false);
    return toolText(JSON.stringify(repoJson(created)));
  }
  if (match('get_repo')) {
    const owner = requireString(args, 'owner');
    const repo = requireString(args, 'repo');
    if (owner === null) return missing('owner');
    if (repo === null) return missing('repo');
    const found = findRepo(store, owner, repo);
    if (found === null) return toolError(`Repository ${owner}/${repo} not found.`);
    return toolText(JSON.stringify(repoJson(found)));
  }
  if (match('create_issue')) {
    const owner = requireString(args, 'owner');
    const repo = requireString(args, 'repo');
    const title = requireString(args, 'title');
    if (owner === null) return missing('owner');
    if (repo === null) return missing('repo');
    if (title === null) return missing('title');
    const found = findRepo(store, owner, repo);
    if (found === null) return toolError(`Repository ${owner}/${repo} not found.`);
    const body = typeof args.body === 'string' ? args.body : '';
    const created = store.createIssue(found, title, body, []);
    return toolText(JSON.stringify(issueJson(found, created, store)));
  }
  if (match('list_issues')) {
    const owner = requireString(args, 'owner');
    const repo = requireString(args, 'repo');
    if (owner === null) return missing('owner');
    if (repo === null) return missing('repo');
    const found = findRepo(store, owner, repo);
    if (found === null) return toolError(`Repository ${owner}/${repo} not found.`);
    const state = typeof args.state === 'string' ? args.state : 'open';
    const list = found.issues.filter((issue) => state === 'all' || issue.state === state);
    return toolText(JSON.stringify(list.map((issue) => issueJson(found, issue, store))));
  }
  if (match('create_pull_request')) {
    const owner = requireString(args, 'owner');
    const repo = requireString(args, 'repo');
    const title = requireString(args, 'title');
    const head = requireString(args, 'head');
    const base = requireString(args, 'base');
    if (owner === null) return missing('owner');
    if (repo === null) return missing('repo');
    if (title === null) return missing('title');
    if (head === null) return missing('head');
    if (base === null) return missing('base');
    const found = findRepo(store, owner, repo);
    if (found === null) return toolError(`Repository ${owner}/${repo} not found.`);
    const headSha = found.refs.get(`refs/heads/${head}`);
    const baseSha = found.refs.get(`refs/heads/${base}`);
    if (headSha === undefined) return toolError(`Head branch ${head} not found.`);
    if (baseSha === undefined) return toolError(`Base branch ${base} not found.`);
    const created = store.createPull(found, title, '', head, headSha, base, baseSha);
    return toolText(JSON.stringify(pullJson(found, created, store)));
  }
  if (match('merge_pull_request')) {
    const owner = requireString(args, 'owner');
    const repo = requireString(args, 'repo');
    if (owner === null) return missing('owner');
    if (repo === null) return missing('repo');
    const pullNumber = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
    if (!Number.isFinite(pullNumber)) return missing('pull_number');
    const found = findRepo(store, owner, repo);
    if (found === null) return toolError(`Repository ${owner}/${repo} not found.`);
    const pull = found.pulls.find((entry) => entry.number === pullNumber);
    if (pull === undefined) return toolError(`Pull request #${pullNumber} not found.`);
    const result = mergePull(store, found, pull, 'squash');
    if (!result.ok) return toolError(result.message);
    return toolText(JSON.stringify(pullJson(found, pull, store)));
  }
  if (match('list_repos')) {
    const owner = requireString(args, 'owner') ?? VIEWER.login;
    return toolText(JSON.stringify(store.listRepos().map((repo) => repoJson(repo))));
  }
  if (match('list_pull_requests')) {
    const owner = requireString(args, 'owner');
    const repo = requireString(args, 'repo');
    if (owner === null) return missing('owner');
    if (repo === null) return missing('repo');
    const found = findRepo(store, owner, repo);
    if (found === null) return toolError(`Repository ${owner}/${repo} not found.`);
    const state = typeof args.state === 'string' ? args.state : 'open';
    const list = found.pulls.filter((pull) => state === 'all' || pull.state === state);
    return toolText(JSON.stringify(list.map((pull) => pullJson(found, pull, store))));
  }
  return toolError(`Unknown tool: ${name}`);
}

/**
 * Handle one JSON-RPC 2.0 request body (already parsed; bodyError means the JSON was malformed).
 * Returns the HTTP status and the JSON body to send (null body = 202 with no content).
 */
export function handleMcp(store: Store, body: unknown, bodyError: boolean): McpResult {
  if (bodyError) {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return rpcError(null, -32600, 'Invalid Request', 400);
  }
  const request = body as { jsonrpc?: unknown; id?: string | number | null; method?: unknown; params?: unknown };
  const id = typeof request.id === 'string' || typeof request.id === 'number' ? request.id : null;
  const hasId = request.id !== undefined;
  const method = typeof request.method === 'string' ? request.method : null;
  const params = (request.params ?? {}) as Record<string, unknown>;
  if (method === null) {
    return rpcError(id, -32600, 'Invalid Request', 400);
  }

  if (method === 'server/discover') {
    return rpcResult(id, {
      protocolVersion: '2026-07-28',
      supportedVersions: [...PROTOCOL_VERSIONS],
      capabilities: { tools: {} },
      serverInfo: { name: 'github-core-clone', version: '1.0.0' },
    });
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const chosen = PROTOCOL_VERSIONS.includes(requested) ? requested : '2025-11-25';
    return rpcResult(id, {
      protocolVersion: chosen,
      capabilities: { tools: {} },
      serverInfo: { name: 'github-core-clone', version: '1.0.0' },
    });
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    // A notification gets no JSON-RPC reply: HTTP 202 with an empty body.
    return { status: 202, body: null };
  }
  if (method === 'ping') {
    return rpcResult(id, {});
  }
  if (method === 'tools/list') {
    // TOOLS is a module constant, so two calls serialize byte-identically.
    return rpcResult(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const tool = TOOLS.find((entry) => {
      const key = entry.name.toLowerCase();
      const wanted = name.toLowerCase();
      return wanted === key || wanted.endsWith(`__${key}`) || wanted.endsWith(`_${key}`);
    });
    if (tool === undefined) {
      return rpcError(id, -32602, `Unknown tool: ${name}`);
    }
    const result = callTool(store, tool.name, args);
    return rpcResult(id, result);
  }
  void hasId;
  return rpcError(id, -32601, `Method not found: ${method}`);
}
