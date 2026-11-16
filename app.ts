// app.ts — HTTP plumbing for the forge: one process, one Store, four interfaces.
//
//   GET  /healthz                              -> {"ok": true} (no auth; the runner polls this)
//   GET  /api/v3/                              -> 200 + x-oauth-scopes (auth)
//   *    /api/v3/**                            -> REST v3 (auth; see rest.ts)
//   POST /api/graphql                          -> GraphQL v4 (auth; see graphql.ts)
//   POST /mcp                                  -> MCP JSON-RPC 2.0 (auth; see mcp.ts)
//   GET  /<owner>/<repo>.git/info/refs         -> git smart-HTTP advertisement (auth)
//   POST /<owner>/<repo>.git/git-upload-pack    -> git v0/v2 fetch (auth)
//   POST /<owner>/<repo>.git/git-receive-pack   -> git push (auth)
//
// Auth: Authorization: Bearer <token>, where <token> is $MAKEFUN_SHOP_TOKEN when that variable
// is set (the trial sets it); when it is unset any non-empty bearer token is accepted, and a
// missing or malformed header is always 401. Every reply carries a non-empty
// X-GitHub-Request-Id and application/json (except the git binary endpoints).

import http from 'node:http';
import { Store, VIEWER } from './store.ts';
import {
  advertisementV0,
  advertisementV2,
  fetchV0Response,
  fetchV2Response,
  parsePushBody,
  applyPush,
  pushReportResponse,
  parseV2Command,
  lsRefsResponse,
} from './gitproto.ts';
import { handleRest, type RestResult } from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** The bearer token is valid when it matches $MAKEFUN_SHOP_TOKEN, or (when that variable is
 *  unset) when any non-empty bearer token is presented. A missing header is never valid. */
export function isAuthorized(req: http.IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (header === undefined) return false;
  const match = /^Bearer\s+(.+)$/.exec(header);
  if (match === null || match[1] === '') return false;
  if (EXPECTED_TOKEN !== '') return match[1] === EXPECTED_TOKEN;
  return true;
}

let requestCounter = 0;

/** A unique, non-empty request id per reply; a counter, not a hash — this runs per response. */
function requestId(): string {
  requestCounter += 1;
  return `req-${process.pid}-${requestCounter}`;
}

function jsonResponse(res: http.ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': requestId(),
    ...extraHeaders,
  });
  res.end(payload);
}

function readBody(req: http.IncomingMessage): Promise<{ body: Buffer; error: boolean }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 64 * 1024 * 1024) failed = true;
      else chunks.push(chunk);
    });
    req.on('end', () => resolve({ body: Buffer.concat(chunks), error: failed }));
    req.on('error', () => resolve({ body: Buffer.alloc(0), error: true }));
  });
}

function parseJsonBody(raw: Buffer): { value: unknown; error: boolean } {
  if (raw.length === 0) return { value: undefined, error: false };
  try {
    return { value: JSON.parse(raw.toString('utf8')), error: false };
  } catch {
    return { value: undefined, error: true };
  }
}

/** The viewer is fixed by the trial contract (wire.ts): every authenticated call is adaiversen. */
export function createServer(store: Store): http.Server {
  return http.createServer(async (req, res) => {
    try {
      await handleRequest(store, req, res);
    } catch (err) {
      console.error(`[forge] ${(err as Error).stack ?? (err as Error).message}`);
      if (!res.headersSent) {
        jsonResponse(res, 500, { message: `Internal Server Error: ${(err as Error).message}` });
      } else {
        res.end();
      }
    }
  });
}

/** The entry point main.ts uses: a fresh store, one server. */
export function createApp(): http.Server {
  return createServer(new Store());
}

async function handleRequest(store: Store, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const path = url.pathname;
  const method = (req.method ?? 'GET').toUpperCase();
  const query = Object.fromEntries(url.searchParams.entries());

  if (method === 'GET' && path === '/healthz') {
    jsonResponse(res, 200, { ok: true });
    return;
  }

  // ---- git smart HTTP: /<owner>/<repo>.git/info/refs and .../git-upload-pack|git-receive-pack
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
  if (gitMatch !== null) {
    await handleGit(store, req, res, gitMatch[1]!, gitMatch[2]!, gitMatch[3]!, query);
    return;
  }

  // ---- GraphQL
  if (path === '/api/graphql') {
    if (!isAuthorized(req)) {
      jsonResponse(res, 401, { message: 'Requires authentication' });
      return;
    }
    if (method !== 'POST') {
      jsonResponse(res, 404, { message: 'Not Found' });
      return;
    }
    const { body, error } = await readBody(req);
    if (error) {
      jsonResponse(res, 400, { errors: [{ message: 'Request body too large' }] });
      return;
    }
    const parsed = parseJsonBody(body);
    if (parsed.error) {
      jsonResponse(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
      return;
    }
    // Batched operation documents: an array of {query, variables, operationName} answers an
    // array of {data, errors}, in order.
    if (Array.isArray(parsed.value)) {
      const results = parsed.value.map((entry) => {
        if (entry === null || typeof entry !== 'object' || typeof (entry as { query?: unknown }).query !== 'string') {
          return { data: null, errors: [{ message: 'GraphQL request must include a query string' }] };
        }
        const doc = entry as { query: string; variables?: Record<string, unknown>; operationName?: string };
        return executeGraphQL(store, doc.query, doc.variables ?? {}, doc.operationName);
      });
      jsonResponse(res, 200, results);
      return;
    }
    if (parsed.value === null || typeof parsed.value !== 'object' || typeof (parsed.value as { query?: unknown }).query !== 'string') {
      jsonResponse(res, 400, { errors: [{ message: 'GraphQL request must include a query string' }] });
      return;
    }
    const doc = parsed.value as { query: string; variables?: Record<string, unknown>; operationName?: string };
    jsonResponse(res, 200, executeGraphQL(store, doc.query, doc.variables ?? {}, doc.operationName));
    return;
  }

  // ---- MCP
  if (path === '/mcp') {
    if (!isAuthorized(req)) {
      jsonResponse(res, 401, { message: 'Requires authentication' });
      return;
    }
    if (method !== 'POST') {
      jsonResponse(res, 404, { message: 'Not Found' });
      return;
    }
    const { body, error } = await readBody(req);
    if (error) {
      jsonResponse(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    const parsed = parseJsonBody(body);
    const result = handleMcp(store, parsed.value, parsed.error);
    if (result.body === null) {
      res.writeHead(result.status, { 'x-github-request-id': requestId() });
      res.end();
      return;
    }
    jsonResponse(res, result.status, result.body);
    return;
  }

  // ---- REST v3 (and the 404-for-unknown-route rule)
  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (!isAuthorized(req)) {
      jsonResponse(res, 401, { message: 'Requires authentication' });
      return;
    }
    const { body, error } = await readBody(req);
    if (error) {
      jsonResponse(res, 400, { message: 'Request body too large' });
      return;
    }
    const parsed = parseJsonBody(body);
    const segments = path.replace(/^\/api\/v3\/?/, '').split('/').filter((part) => part !== '');
    const baseUrl = `http://${req.headers.host ?? 'localhost'}`;
    const result: RestResult = handleRest({ store, baseUrl }, method, segments, url.searchParams, parsed.value, parsed.error);
    jsonResponse(res, result.status, result.body, result.headers);
    return;
  }

  jsonResponse(res, 404, { message: 'Not Found' });
}

async function handleGit(
  store: Store,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  owner: string,
  repoName: string,
  service: string,
  query: Record<string, string>,
): Promise<void> {
  if (!isAuthorized(req)) {
    jsonResponse(res, 401, { message: 'Requires authentication' });
    return;
  }
  const method = (req.method ?? 'GET').toUpperCase();
  const repo = store.getRepo(owner, repoName);
  if (repo === null) {
    jsonResponse(res, 404, { message: 'Not Found' });
    return;
  }
  const sendBinary = (status: number, contentType: string, payload: Buffer): void => {
    res.writeHead(status, {
      'content-type': contentType,
      'x-github-request-id': requestId(),
      'content-length': payload.length,
    });
    res.end(payload);
  };

  if (service === 'info/refs') {
    if (method !== 'GET') {
      jsonResponse(res, 404, { message: 'Not Found' });
      return;
    }
    const requested = query.service ?? '';
    if (requested === 'git-upload-pack') {
      // Protocol v2 capability advertisement: the client asks for it with the
      // Git-Protocol: version=2 header on the info/refs GET.
      if ((req.headers['git-protocol'] ?? '') === 'version=2') {
        sendBinary(200, 'application/x-git-upload-pack-advertisement', advertisementV2());
        return;
      }
      sendBinary(200, 'application/x-git-upload-pack-advertisement', advertisementV0(repo, 'git-upload-pack'));
      return;
    }
    if (requested === 'git-receive-pack') {
      sendBinary(200, 'application/x-git-receive-pack-advertisement', advertisementV0(repo, 'git-receive-pack'));
      return;
    }
    jsonResponse(res, 400, { message: 'Unknown service' });
    return;
  }

  if (method !== 'POST') {
    jsonResponse(res, 404, { message: 'Not Found' });
    return;
  }
  const { body, error } = await readBody(req);
  if (error) {
    jsonResponse(res, 400, { message: 'Request body too large' });
    return;
  }

  if (service === 'git-upload-pack') {
    // A malformed git request body is a client error (400), never a crash: the suite probes
    // the server with garbage and then checks it is still serving.
    try {
      // Protocol v2 is signalled by the Git-Protocol: version=2 request header; the body then
      // starts directly with the command pkt-lines (no "version 2" preamble in the request).
      if ((req.headers['git-protocol'] ?? '') === 'version=2') {
        const command = parseV2Command(body);
        if (command.command === 'ls-refs') {
          sendBinary(200, 'application/x-git-upload-pack-result', lsRefsResponse(repo, command.args));
          return;
        }
        sendBinary(200, 'application/x-git-upload-pack-result', fetchV2Response(repo, command.args));
        return;
      }
      // Protocol v0: wants/haves/shallow/deepen pkt-lines, sideband pack in reply.
      sendBinary(200, 'application/x-git-upload-pack-result', fetchV0Response(repo, body));
      return;
    } catch (err) {
      jsonResponse(res, 400, { message: `Bad git request: ${(err as Error).message}` });
      return;
    }
  }

  // git-receive-pack: commands + pack, report-status in the reply.
  try {
    const parsed = parsePushBody(body);
    const outcomes = applyPush(repo, parsed.commands, parsed.pack);
    sendBinary(200, 'application/x-git-receive-pack-result', pushReportResponse(outcomes));
  } catch (err) {
    jsonResponse(res, 400, { message: `Bad git request: ${(err as Error).message}` });
  }
}

export { VIEWER };
