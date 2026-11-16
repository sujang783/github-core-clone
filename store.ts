// store.ts — the forge's in-memory store: git objects, refs, repos, issues, pull requests.
// Everything is synchronous and in memory: the suite drives this server hard (2000 sequential
// reads, 50 concurrent clones) and no request may touch the disk.
//
// Determinism: every timestamp the server invents comes from FIXED_EPOCH plus a monotonic
// sequence, never from a clock, so two runs that see the same requests build identical objects.

import { createHash } from 'node:crypto';

export const ZERO_OID = '0'.repeat(40);
export const FIXED_EPOCH = 1_700_000_000;

/** The token owner's identity, from the suite's fixed scenario seed (wire.ts buildScenario). */
export const VIEWER = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

const HEX40 = /^[0-9a-f]{40}$/;
export function isObjectId(value: string): boolean {
  return HEX40.test(value);
}

/** git's object id: SHA-1 over `<type> <size>\0` + the object's bytes. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

/** Parse a tree object into its entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree-entry sort: byte order of the name, a directory compared as if it ended in '/'. */
function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object from entries; entries are sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

/** Parse a commit object. */
export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headerText = data.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  if (!isObjectId(tree)) throw new Error('commit has no valid tree header');
  return { tree, parents, author, committer, message };
}

export interface TagView {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) continue;
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: (headers.get('type') ?? 'commit') as GitObjectType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

/** Build a commit object's bytes. */
export function buildCommit(fields: {
  tree: string;
  parents?: readonly string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
}): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author} ${fields.timestamp} +0000`, `committer ${fields.committer} ${fields.timestamp} +0000`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

/** Flatten a tree into path -> {oid, mode}, recursively. */
export function flattenTree(
  repo: Repo,
  treeOid: string,
  prefix = '',
  out: Map<string, { oid: string; mode: string }> = new Map(),
): Map<string, { oid: string; mode: string }> {
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(repo, entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return out;
}

/** The object reachable from `roots`: commit -> tree + parents, tree -> entries, tag -> target. */
export function collectReachable(repo: Repo, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root)) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** True when `ancestor` is reachable from `tip` (or equal to it). */
export function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return false;
}

/** The first commit reachable from both `a` and `b` (the merge-base), or null. */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsA = new Set<string>();
  const queueA = [a];
  while (queueA.length > 0) {
    const oid = queueA.pop()!;
    if (ancestorsA.has(oid)) continue;
    ancestorsA.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueA.push(parent);
  }
  const queueB = [b];
  const seenB = new Set<string>();
  while (queueB.length > 0) {
    const oid = queueB.shift()!;
    if (ancestorsA.has(oid)) return oid;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueB.push(parent);
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// issues, pull requests, labels, comments
// ---------------------------------------------------------------------------------------------

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  user: string;
  createdAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: Comment[];
  createdSeq: number;
  user: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdSeq: number;
  user: string;
  createdAt: string;
  updatedAt: string;
}

const DEFAULT_LABELS: Label[] = [
  { name: 'bug', color: 'd73a4a', description: "Something isn't working" },
  { name: 'enhancement', color: 'a2eeef', description: 'New feature or request' },
  { name: 'documentation', color: '0075ca', description: 'Improvements or additions to documentation' },
  { name: 'question', color: 'd876e3', description: 'Further information is requested' },
  { name: 'good first issue', color: '7057ff', description: 'Good for newcomers' },
  { name: 'help wanted', color: '008672', description: 'Extra attention is needed' },
];

// ---------------------------------------------------------------------------------------------
// repository
// ---------------------------------------------------------------------------------------------

export class Repo {
  readonly id: number;
  readonly name: string;
  readonly owner: string;
  description: string;
  private: boolean;
  readonly defaultBranch = 'main';
  readonly createdSeq: number;
  readonly createdAt: string;
  updatedAt: string;
  /** git objects by id. */
  readonly objects = new Map<string, GitObject>();
  /** refs by full name, e.g. refs/heads/main -> oid. */
  readonly refs = new Map<string, string>();
  readonly issues: Issue[] = [];
  readonly pulls: Pull[] = [];
  readonly labels: Label[] = DEFAULT_LABELS.map((label) => ({ ...label }));
  /** One counter for issues and pull requests, as GitHub numbers them together. */
  nextNumber = 1;
  nextCommentId = 1;

  constructor(id: number, name: string, owner: string, description: string, isPrivate: boolean, createdSeq: number) {
    this.id = id;
    this.name = name;
    this.owner = owner;
    this.description = description;
    this.private = isPrivate;
    this.createdSeq = createdSeq;
    this.createdAt = new Date((FIXED_EPOCH + createdSeq) * 1000).toISOString();
    this.updatedAt = this.createdAt;
  }

  get fullName(): string {
    return `${this.owner}/${this.name}`;
  }

  /** The default branch's tip, or null when the repository has no commits yet. */
  defaultTip(): string | null {
    return this.refs.get(`refs/heads/${this.defaultBranch}`) ?? null;
  }

  /** Store an object, returning its id (idempotent). */
  putObject(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  /** Resolve a ref name, a branch name, or a full 40-hex oid to a commit oid, or null. */
  resolveRef(ref: string): string | null {
    if (isObjectId(ref)) return this.objects.has(ref) ? ref : null;
    if (ref.startsWith('refs/')) return this.refs.get(ref) ?? null;
    if (ref === 'HEAD') return this.defaultTip();
    return this.refs.get(`refs/heads/${ref}`) ?? this.refs.get(`refs/tags/${ref}`) ?? null;
  }

  /** The tree oid of a ref's tip, or null. */
  treeOf(ref: string): string | null {
    const tip = this.resolveRef(ref);
    if (tip === null) return null;
    const object = this.objects.get(tip);
    if (!object) return null;
    if (object.type === 'commit') return parseCommit(object.data).tree;
    if (object.type === 'tag') {
      const target = this.objects.get(parseTag(object.data).object);
      if (target && target.type === 'commit') return parseCommit(target.data).tree;
    }
    return null;
  }

  /** Read one file (or null) from a tree. */
  readPath(treeOid: string | null, path: string): { oid: string; mode: string; data: Buffer } | null {
    if (treeOid === null) return null;
    const flat = flattenTree(this, treeOid);
    const entry = flat.get(path);
    if (!entry) return null;
    const object = this.objects.get(entry.oid);
    if (!object || object.type !== 'blob') return null;
    return { oid: entry.oid, mode: entry.mode, data: object.data };
  }

  /** List the immediate children of a directory path in a tree ('' is the root). */
  listDir(
    treeOid: string | null,
    dir: string,
  ): Array<{ name: string; path: string; type: 'file' | 'dir'; oid: string; size: number }> | null {
    if (treeOid === null) return null;
    let current = treeOid;
    if (dir !== '') {
      for (const segment of dir.split('/')) {
        const object = this.objects.get(current);
        if (!object || object.type !== 'tree') return null;
        const entry = parseTree(object.data).find((candidate) => candidate.name === segment);
        if (!entry || entry.mode !== '40000') return null;
        current = entry.oid;
      }
    }
    const object = this.objects.get(current);
    if (!object || object.type !== 'tree') return null;
    const out: Array<{ name: string; path: string; type: 'file' | 'dir'; oid: string; size: number }> = [];
    for (const entry of parseTree(object.data)) {
      const path = dir === '' ? entry.name : `${dir}/${entry.name}`;
      if (entry.mode === '40000') {
        out.push({ name: entry.name, path, type: 'dir', oid: entry.oid, size: 0 });
      } else {
        const blob = this.objects.get(entry.oid);
        out.push({ name: entry.name, path, type: 'file', oid: entry.oid, size: blob ? blob.data.length : 0 });
      }
    }
    return out;
  }

  /**
   * Build a new root tree from `baseTreeOid` with one file set (blobOid) or deleted (null).
   * Intermediate trees are stored. Returns the new root tree oid.
   */
  writePath(baseTreeOid: string | null, path: string, blobOid: string | null): string {
    const segments = path.split('/').filter((segment) => segment !== '');
    const build = (treeOid: string | null, depth: number): string => {
      const entries = new Map<string, TreeEntry>();
      if (treeOid !== null) {
        const object = this.objects.get(treeOid);
        if (object && object.type === 'tree') {
          for (const entry of parseTree(object.data)) entries.set(entry.name, entry);
        }
      }
      const name = segments[depth]!;
      if (depth === segments.length - 1) {
        if (blobOid === null) entries.delete(name);
        else entries.set(name, { mode: '100644', name, oid: blobOid });
      } else {
        const child = entries.get(name);
        const childTree = child && child.mode === '40000' ? child.oid : null;
        const next = build(childTree, depth + 1);
        const nextObject = this.objects.get(next);
        const empty = nextObject !== undefined && nextObject.type === 'tree' && parseTree(nextObject.data).length === 0;
        if (empty) entries.delete(name);
        else entries.set(name, { mode: '40000', name, oid: next });
      }
      return this.putObject('tree', buildTree([...entries.values()]));
    };
    return build(baseTreeOid, 0);
  }
}

// ---------------------------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------------------------

export class Store {
  /** repos by "owner/name". */
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextSeq = 1;
  /** Monotonic commit timestamp counter (deterministic, never a clock). */
  private commitSeq = 0;

  get viewerLogin(): string {
    return VIEWER.login;
  }

  /** The next deterministic timestamp (seconds) for a server-made commit. */
  nextCommitTimestamp(): number {
    this.commitSeq += 1;
    return FIXED_EPOCH + this.commitSeq;
  }

  nextSeqValue(): number {
    this.nextSeq += 1;
    return this.nextSeq;
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo {
    const repo = new Repo(this.nextRepoId, name, VIEWER.login, description, isPrivate, this.nextSeqValue());
    this.nextRepoId += 1;
    this.repos.set(`${VIEWER.login}/${name}`, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | null {
    if (owner !== VIEWER.login) return null;
    return this.repos.get(`${owner}/${name}`) ?? null;
  }

  deleteRepo(owner: string, name: string): boolean {
    if (owner !== VIEWER.login) return false;
    return this.repos.delete(`${owner}/${name}`);
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  /** A deterministic ISO timestamp for an issue/PR/comment, from a sequence number. */
  stamp(seq: number): string {
    return new Date((FIXED_EPOCH + seq) * 1000).toISOString();
  }

  createIssue(repo: Repo, title: string, body: string, labels: Label[]): Issue {
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const seq = this.nextSeqValue();
    const issue: Issue = {
      id: this.nextIssueId,
      number,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      createdSeq: seq,
      user: VIEWER.login,
      createdAt: this.stamp(seq),
      updatedAt: this.stamp(seq),
      closedAt: null,
    };
    this.nextIssueId += 1;
    repo.issues.push(issue);
    return issue;
  }

  createPull(
    repo: Repo,
    title: string,
    body: string,
    headRef: string,
    headSha: string,
    baseRef: string,
    baseSha: string,
  ): Pull {
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const seq = this.nextSeqValue();
    const pull: Pull = {
      id: this.nextIssueId,
      number,
      title,
      body,
      state: 'open',
      head: { ref: headRef, sha: headSha },
      base: { ref: baseRef, sha: baseSha },
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdSeq: seq,
      user: VIEWER.login,
      createdAt: this.stamp(seq),
      updatedAt: this.stamp(seq),
    };
    this.nextIssueId += 1;
    repo.pulls.push(pull);
    return pull;
  }

  /**
   * Create a commit on `repo` with the viewer's identity and a deterministic timestamp.
   * The commit object is stored; the caller moves the ref.
   */
  makeCommit(repo: Repo, treeOid: string, parents: readonly string[], message: string): string {
    const timestamp = this.nextCommitTimestamp();
    const who = `${VIEWER.name} <${VIEWER.email}>`;
    const data = buildCommit({ tree: treeOid, parents, message, author: who, committer: who, timestamp });
    return repo.putObject('commit', data);
  }

  /** Opaque, stable global ids (Relay-style), never the plain database id or number. */
  globalId(kind: string, key: string): string {
    return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
  }

  repoGlobalId(repo: Repo): string {
    return this.globalId('Repository', String(repo.id));
  }

  issueGlobalId(repo: Repo, issue: Issue): string {
    return this.globalId('Issue', `${repo.id}:${issue.number}`);
  }

  pullGlobalId(repo: Repo, pull: Pull): string {
    return this.globalId('PullRequest', `${repo.id}:${pull.number}`);
  }

  commentGlobalId(repo: Repo, issue: Issue, comment: Comment): string {
    return this.globalId('IssueComment', `${repo.id}:${issue.number}:${comment.id}`);
  }

  /** Decode a global id back to its kind and key, or null. */
  decodeGlobalId(id: string): { kind: string; key: string } | null {
    try {
      const text = Buffer.from(id, 'base64').toString('utf8');
      const colon = text.indexOf(':');
      if (colon < 0) return null;
      return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
    } catch {
      return null;
    }
  }

  repoByGlobalId(id: string): Repo | null {
    const decoded = this.decodeGlobalId(id);
    if (!decoded || decoded.kind !== 'Repository') return null;
    const dbid = Number(decoded.key);
    if (!Number.isInteger(dbid)) return null;
    for (const repo of this.repos.values()) if (repo.id === dbid) return repo;
    return null;
  }

  issueByGlobalId(id: string): { repo: Repo; issue: Issue } | null {
    const decoded = this.decodeGlobalId(id);
    if (!decoded || decoded.kind !== 'Issue') return null;
    const [repoId, number] = decoded.key.split(':').map(Number);
    if (!Number.isInteger(repoId) || !Number.isInteger(number)) return null;
    for (const repo of this.repos.values()) {
      if (repo.id !== repoId) continue;
      const issue = repo.issues.find((entry) => entry.number === number);
      if (issue) return { repo, issue };
    }
    return null;
  }

  pullByGlobalId(id: string): { repo: Repo; pull: Pull } | null {
    const decoded = this.decodeGlobalId(id);
    if (!decoded || decoded.kind !== 'PullRequest') return null;
    const [repoId, number] = decoded.key.split(':').map(Number);
    if (!Number.isInteger(repoId) || !Number.isInteger(number)) return null;
    for (const repo of this.repos.values()) {
      if (repo.id !== repoId) continue;
      const pull = repo.pulls.find((entry) => entry.number === number);
      if (pull) return { repo, pull };
    }
    return null;
  }
}
