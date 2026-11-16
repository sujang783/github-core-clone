// graphql.ts — GraphQL v4: a small lexer/parser for the documents gh and github-mcp-server
// actually send, plus an executor over the store and a static schema for __type introspection.
//
// The suite sends 18 fixed documents (checks-graphql.ts GRAPHQL_DOCUMENTS). This module parses
// any of them — variables, inline enums, inline input objects, aliases, inline fragments,
// batched operation arrays — and answers {data, errors} with HTTP 200 for GraphQL-level failures
// (an unknown field is an errors array, never an HTTP error).

import {
  VIEWER,
  type Store,
  type Repo,
  type Issue,
  type Pull,
} from './store.ts';
import { pullMergeable, pullFiles, computeMerge, mergePull } from './rest.ts';

// ---------------------------------------------------------------------------------------------
// lexer
// ---------------------------------------------------------------------------------------------

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string };

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@|&'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      // A string (or block string) literal.
      if (source.slice(i, i + 3) === '"""') {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1]!;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === '\\' ? '\\' : esc === '"' ? '"' : esc === '/' ? '/' : esc;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      let isFloat = false;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j]!)) j += 1;
      }
      const text = source.slice(i, j);
      tokens.push(isFloat ? { kind: 'float', value: Number(text) } : { kind: 'int', value: Number(text) });
      i = j;
      continue;
    }
    if (isNameStart(ch)) {
      let j = i;
      while (j < source.length && isNameChar(source[j]!)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------------------------

export type ValueNode =
  | { kind: 'Variable'; name: string }
  | { kind: 'Int'; value: number }
  | { kind: 'Float'; value: number }
  | { kind: 'String'; value: string }
  | { kind: 'Boolean'; value: boolean }
  | { kind: 'Null' }
  | { kind: 'Enum'; value: string }
  | { kind: 'List'; values: ValueNode[] }
  | { kind: 'Object'; fields: Array<{ name: string; value: ValueNode }> };

export interface FieldNode {
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selectionSet: SelectionNode[] | null;
}

export type SelectionNode =
  | { kind: 'Field'; field: FieldNode }
  | { kind: 'InlineFragment'; typeCondition: string | null; selectionSet: SelectionNode[] }
  | { kind: 'FragmentSpread'; name: string };

export interface OperationNode {
  operation: 'query' | 'mutation' | 'subscription';
  name: string | null;
  variableDefinitions: Array<{ name: string; type: string; defaultValue: ValueNode | null }>;
  selectionSet: SelectionNode[];
}

export interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, SelectionNode[]>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`expected ${JSON.stringify(value)} in GraphQL document`);
    }
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in GraphQL document');
    if (value !== undefined && token.value !== value) throw new Error(`expected ${JSON.stringify(value)} in GraphQL document`);
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, SelectionNode[]>();
    while (this.pos < this.tokens.length) {
      const token = this.peek()!;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({
          operation: 'query',
          name: null,
          variableDefinitions: [],
          selectionSet: this.parseSelectionSet(),
        });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        const operation = token.value as 'query' | 'mutation' | 'subscription';
        this.next();
        let name: string | null = null;
        const next = this.peek();
        if (next?.kind === 'name') name = this.next().value as string;
        const variableDefinitions = this.parseVariableDefinitions();
        operations.push({ operation, name, variableDefinitions, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        this.expectName();
        fragments.set(name, this.parseSelectionSet());
        continue;
      }
      throw new Error(`unexpected token ${JSON.stringify(token)} in GraphQL document`);
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): Array<{ name: string; type: string; defaultValue: ValueNode | null }> {
    const defs: Array<{ name: string; type: string; defaultValue: ValueNode | null }> = [];
    const token = this.peek();
    if (token?.kind !== 'punct' || token.value !== '(') return defs;
    this.next();
    while (true) {
      const next = this.peek();
      if (next?.kind === 'punct' && next.value === ')') {
        this.next();
        return defs;
      }
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      const type = this.parseType();
      let defaultValue: ValueNode | null = null;
      const maybeEq = this.peek();
      if (maybeEq?.kind === 'punct' && maybeEq.value === '=') {
        this.next();
        defaultValue = this.parseValue();
      }
      defs.push({ name, type, defaultValue });
    }
  }

  private parseType(): string {
    const token = this.peek();
    let type: string;
    if (token?.kind === 'punct' && token.value === '[') {
      this.next();
      const inner = this.parseType();
      this.expectPunct(']');
      type = `[${inner}]`;
    } else {
      type = this.expectName();
    }
    const bang = this.peek();
    if (bang?.kind === 'punct' && bang.value === '!') {
      this.next();
      type += '!';
    }
    return type;
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    for (;;) {
      const token = this.peek();
      if (token === undefined) throw new Error('unterminated selection set');
      if (token.kind === 'punct' && token.value === '}') {
        this.next();
        return selections;
      }
      selections.push(this.parseSelection());
    }
  }

  private parseSelection(): SelectionNode {
    const token = this.peek()!;
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      const next = this.peek();
      if (next?.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        return { kind: 'InlineFragment', typeCondition, selectionSet: this.parseSelectionSet() };
      }
      if (next?.kind === 'name') {
        return { kind: 'FragmentSpread', name: this.next().value as string };
      }
      return { kind: 'InlineFragment', typeCondition: null, selectionSet: this.parseSelectionSet() };
    }
    if (token.kind !== 'name') throw new Error('expected a field name in GraphQL document');
    const first = this.next().value as string;
    let alias: string | null = null;
    let name = first;
    const colon = this.peek();
    if (colon?.kind === 'punct' && colon.value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    const open = this.peek();
    if (open?.kind === 'punct' && open.value === '(') {
      this.next();
      for (;;) {
        const next = this.peek();
        if (next?.kind === 'punct' && next.value === ')') {
          this.next();
          break;
        }
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
    }
    let selectionSet: SelectionNode[] | null = null;
    const brace = this.peek();
    if (brace?.kind === 'punct' && brace.value === '{') selectionSet = this.parseSelectionSet();
    return { kind: 'Field', field: { alias, name, args, selectionSet } };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'Variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      for (;;) {
        const next = this.peek();
        if (next?.kind === 'punct' && next.value === ']') {
          this.next();
          return { kind: 'List', values };
        }
        values.push(this.parseValue());
      }
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      for (;;) {
        const next = this.peek();
        if (next?.kind === 'punct' && next.value === '}') {
          this.next();
          return { kind: 'Object', fields };
        }
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
    }
    if (token.kind === 'int') return { kind: 'Int', value: token.value };
    if (token.kind === 'float') return { kind: 'Float', value: token.value };
    if (token.kind === 'string') return { kind: 'String', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'Boolean', value: true };
      if (token.value === 'false') return { kind: 'Boolean', value: false };
      if (token.value === 'null') return { kind: 'Null' };
      return { kind: 'Enum', value: token.value };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token)}`);
  }
}

export function parseDocument(source: string): DocumentNode {
  return new Parser(lex(source)).parseDocument();
}

// ---------------------------------------------------------------------------------------------
// schema (for __type introspection and field validation)
// ---------------------------------------------------------------------------------------------

const SCHEMA_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name', 'email', 'url'],
  Viewer: ['login', 'id', 'name', 'email', 'url'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'url', 'description',
    'private', 'createdAt', 'updatedAt',
  ],
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'files', 'headRef', 'baseRef', 'author', 'createdAt', 'updatedAt', 'mergedAt', 'mergeCommitSha',
  ],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  IssueCommentEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  Ref: ['name', 'target', 'prefix'],
  GitObject: ['oid'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'comment', 'clientMutationId'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'inputFields'],
  __Field: ['name', 'description', 'args', 'type'],
  __EnumValue: ['name', 'description'],
  __InputValue: ['name', 'description', 'type'],
  __Schema: ['types', 'queryType', 'mutationType'],
};

const SCHEMA_ENUMS: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// ---------------------------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------------------------

type Obj = Record<string, unknown> & { __typename: string };

interface ExecContext {
  store: Store;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
  fragments: Map<string, SelectionNode[]>;
}

function valueOf(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'Variable': return variables[node.name];
    case 'Int': case 'Float': case 'String': case 'Boolean': return node.value;
    case 'Null': return null;
    case 'Enum': return node.value;
    case 'List': return node.values.map((entry) => valueOf(entry, variables));
    case 'Object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = valueOf(field.value, variables);
      return out;
    }
  }
}

function argMap(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = valueOf(arg.value, variables);
  return out;
}

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function indexOfCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return -1;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : -1;
  } catch {
    return -1;
  }
}

function isIssueState(value: unknown): value is 'OPEN' | 'CLOSED' {
  return value === 'OPEN' || value === 'CLOSED';
}

/** The issue connection for a repository, with states/orderBy/first/after applied. */
function issuesConnection(
  ctx: ExecContext,
  repo: Repo,
  args: Record<string, unknown>,
  selection: SelectionNode[] | null,
): Obj {
  let list = [...repo.issues];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.filter(isIssueState).map((state) => (state === 'OPEN' ? 'open' : 'closed')));
    list = list.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const field = orderBy.field;
  const direction = orderBy.direction;
  if (field === 'CREATED_AT') {
    list.sort((a, b) => (direction === 'DESC' ? b.createdSeq - a.createdSeq : a.createdSeq - b.createdSeq));
  } else {
    list.sort((a, b) => a.createdSeq - b.createdSeq);
  }
  const first = typeof args.first === 'number' ? args.first : list.length;
  const afterIndex = indexOfCursor(args.after);
  const start = afterIndex + 1;
  const page = list.slice(start, start + first);
  const endIndex = start + page.length - 1;
  const hasNextPage = start + page.length < list.length;
  const endCursor = page.length > 0 ? cursorFor(endIndex) : null;
  return {
    __typename: 'IssueConnection',
    nodes: page.map((issue) => issueObject(ctx, repo, issue)),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage,
      hasPreviousPage: start > 0,
      startCursor: page.length > 0 ? cursorFor(start) : null,
      endCursor,
    },
    totalCount: list.length,
  };
}

function pullsConnection(ctx: ExecContext, repo: Repo, args: Record<string, unknown>): Obj {
  const list = [...repo.pulls].filter((pull) => pull.state === 'open').sort((a, b) => b.createdSeq - a.createdSeq);
  const first = typeof args.first === 'number' ? args.first : list.length;
  const page = list.slice(0, first);
  return {
    __typename: 'PullRequestConnection',
    nodes: page.map((pull) => pullObject(ctx, repo, pull)),
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: page.length < list.length,
      hasPreviousPage: false,
      startCursor: page.length > 0 ? cursorFor(0) : null,
      endCursor: page.length > 0 ? cursorFor(page.length - 1) : null,
    },
    totalCount: list.length,
  };
}

function repoObject(ctx: ExecContext, repo: Repo): Obj {
  return { __typename: 'Repository', repo };
}

function issueObject(ctx: ExecContext, repo: Repo, issue: Issue): Obj {
  return { __typename: 'Issue', repo, issue };
}

function pullObject(ctx: ExecContext, repo: Repo, pull: Pull): Obj {
  return { __typename: 'PullRequest', repo, pull };
}

/** Resolve one field on one object; null when the field is absent (a null in the data). */
function resolveField(ctx: ExecContext, parent: Obj, field: FieldNode): unknown {
  const args = argMap(field, ctx.variables);
  const type = parent.__typename;
  const repo = (parent as { repo?: Repo }).repo;
  const issue = (parent as { issue?: Issue }).issue;
  const pull = (parent as { pull?: Pull }).pull;

  switch (type) {
    case 'Query': {
      if (field.name === 'viewer') return { __typename: 'User', login: VIEWER.login };
      if (field.name === 'repository') {
        const owner = args.owner;
        const name = args.name;
        if (typeof owner !== 'string' || typeof name !== 'string') return null;
        const found = ctx.store.getRepo(owner, name);
        return found === null ? null : repoObject(ctx, found);
      }
      if (field.name === 'node') {
        const id = args.id;
        if (typeof id !== 'string') return null;
        const decoded = ctx.store.decodeGlobalId(id);
        if (decoded === null) return null;
        if (decoded.kind === 'Repository') {
          const found = ctx.store.repoByGlobalId(id);
          return found === null ? null : repoObject(ctx, found);
        }
        if (decoded.kind === 'Issue') {
          const found = ctx.store.issueByGlobalId(id);
          return found === null ? null : issueObject(ctx, found.repo, found.issue);
        }
        if (decoded.kind === 'PullRequest') {
          const found = ctx.store.pullByGlobalId(id);
          return found === null ? null : pullObject(ctx, found.repo, found.pull);
        }
        return null;
      }
      if (field.name === '__type') {
        const name = args.name;
        if (typeof name !== 'string') return null;
        const fields = SCHEMA_FIELDS[name];
        const enums = SCHEMA_ENUMS[name];
        if (fields === undefined && enums === undefined) return null;
        return {
          __typename: '__Type',
          name,
          kind: enums !== undefined ? 'ENUM' : fields !== undefined ? 'OBJECT' : 'SCALAR',
          fields: fields === undefined ? null : fields.map((entry) => ({ __typename: '__Field', name: entry })),
          enumValues: enums === undefined ? null : enums.map((entry) => ({ __typename: '__EnumValue', name: entry })),
        };
      }
      if (field.name === '__schema') {
        return {
          __typename: '__Schema',
          types: Object.keys(SCHEMA_FIELDS).map((name) => ({ __typename: '__Type', name })),
          queryType: { __typename: '__Type', name: 'Query' },
          mutationType: { __typename: '__Type', name: 'Mutation' },
        };
      }
      return undefined;
    }
    case 'Mutation': {
      if (field.name === 'createIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = typeof input.repositoryId === 'string' ? ctx.store.repoByGlobalId(input.repositoryId) : null;
        if (found === null) {
          ctx.errors.push({ message: `repository ${String(input.repositoryId)} not found` });
          return null;
        }
        if (typeof input.title !== 'string' || input.title === '') {
          ctx.errors.push({ message: 'createIssue needs a title' });
          return null;
        }
        const created = ctx.store.createIssue(found, input.title, typeof input.body === 'string' ? input.body : '', []);
        return { __typename: 'CreateIssuePayload', issue: issueObject(ctx, found, created) };
      }
      if (field.name === 'closeIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = typeof input.issueId === 'string' ? ctx.store.issueByGlobalId(input.issueId) : null;
        if (found === null) {
          ctx.errors.push({ message: `issue ${String(input.issueId)} not found` });
          return null;
        }
        found.issue.state = 'closed';
        found.issue.closedAt = ctx.store.stamp(ctx.store.nextSeqValue());
        found.issue.updatedAt = found.issue.closedAt;
        return { __typename: 'CloseIssuePayload', issue: issueObject(ctx, found.repo, found.issue) };
      }
      if (field.name === 'createPullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = typeof input.repositoryId === 'string' ? ctx.store.repoByGlobalId(input.repositoryId) : null;
        if (found === null) {
          ctx.errors.push({ message: `repository ${String(input.repositoryId)} not found` });
          return null;
        }
        const headRef = input.headRefName;
        const baseRef = input.baseRefName;
        if (typeof headRef !== 'string' || typeof baseRef !== 'string') {
          ctx.errors.push({ message: 'createPullRequest needs headRefName and baseRefName' });
          return null;
        }
        const headSha = found.refs.get(`refs/heads/${headRef}`);
        const baseSha = found.refs.get(`refs/heads/${baseRef}`);
        if (headSha === undefined || baseSha === undefined) {
          ctx.errors.push({ message: 'createPullRequest needs existing head and base branches' });
          return null;
        }
        const created = ctx.store.createPull(
          found,
          typeof input.title === 'string' ? input.title : '',
          typeof input.body === 'string' ? input.body : '',
          headRef,
          headSha,
          baseRef,
          baseSha,
        );
        return { __typename: 'CreatePullRequestPayload', pullRequest: pullObject(ctx, found, created) };
      }
      if (field.name === 'mergePullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = typeof input.pullRequestId === 'string' ? ctx.store.pullByGlobalId(input.pullRequestId) : null;
        if (found === null) {
          ctx.errors.push({ message: `pull request ${String(input.pullRequestId)} not found` });
          return null;
        }
        const method = typeof input.mergeMethod === 'string' ? input.mergeMethod.toLowerCase() : 'squash';
        const result = mergePull(ctx.store, found.repo, found.pull, method);
        if (!result.ok) {
          ctx.errors.push({ message: result.message });
          return null;
        }
        return { __typename: 'MergePullRequestPayload', pullRequest: pullObject(ctx, found.repo, found.pull) };
      }
      if (field.name === 'addComment') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = typeof input.subjectId === 'string' ? ctx.store.issueByGlobalId(input.subjectId) : null;
        if (found === null) {
          ctx.errors.push({ message: `issue ${String(input.subjectId)} not found` });
          return null;
        }
        if (typeof input.body !== 'string' || input.body === '') {
          ctx.errors.push({ message: 'addComment needs a body' });
          return null;
        }
        const seq = ctx.store.nextSeqValue();
        const comment = {
          id: found.repo.nextCommentId,
          body: input.body,
          user: VIEWER.login,
          createdAt: ctx.store.stamp(seq),
        };
        found.repo.nextCommentId += 1;
        found.issue.comments.push(comment);
        return {
          __typename: 'AddCommentPayload',
          commentEdge: {
            __typename: 'IssueCommentEdge',
            node: { __typename: 'IssueComment', repo: found.repo, issue: found.issue, comment },
            cursor: cursorFor(found.issue.comments.length - 1),
          },
        };
      }
      return undefined;
    }
    case 'User':
    case 'Viewer': {
      const login = (parent as { login: string }).login;
      if (field.name === 'login') return login;
      if (field.name === 'id') return ctx.store.globalId('User', login);
      if (field.name === 'name') return login === VIEWER.login ? VIEWER.name : login;
      if (field.name === 'email') return login === VIEWER.login ? VIEWER.email : '';
      if (field.name === 'url') return `https://github.com/${login}`;
      return undefined;
    }
    case 'Repository': {
      if (repo === undefined) return undefined;
      if (field.name === 'id') return ctx.store.repoGlobalId(repo);
      if (field.name === 'databaseId') return repo.id;
      if (field.name === 'name') return repo.name;
      if (field.name === 'nameWithOwner') return repo.fullName;
      if (field.name === 'owner') return { __typename: 'User', login: repo.owner };
      if (field.name === 'defaultBranchRef') {
        const tip = repo.defaultTip();
        if (tip === null) return null;
        return { __typename: 'Ref', name: repo.defaultBranch, oid: tip };
      }
      if (field.name === 'viewerPermission') return 'ADMIN';
      if (field.name === 'hasIssuesEnabled') return true;
      if (field.name === 'url') return `https://github.com/${repo.fullName}`;
      if (field.name === 'description') return repo.description;
      if (field.name === 'private') return repo.private;
      if (field.name === 'createdAt') return repo.createdAt;
      if (field.name === 'updatedAt') return repo.updatedAt;
      if (field.name === 'issue') {
        const number = args.number;
        if (typeof number !== 'number') return null;
        const found = repo.issues.find((entry) => entry.number === number);
        return found === undefined ? null : issueObject(ctx, repo, found);
      }
      if (field.name === 'issues') return issuesConnection(ctx, repo, args, field.selectionSet);
      if (field.name === 'pullRequests') return pullsConnection(ctx, repo, args);
      if (field.name === 'pullRequest') {
        const number = args.number;
        if (typeof number !== 'number') return null;
        const found = repo.pulls.find((entry) => entry.number === number);
        return found === undefined ? null : pullObject(ctx, repo, found);
      }
      return undefined;
    }
    case 'Issue': {
      if (repo === undefined || issue === undefined) return undefined;
      if (field.name === 'id') return ctx.store.issueGlobalId(repo, issue);
      if (field.name === 'number') return issue.number;
      if (field.name === 'title') return issue.title;
      if (field.name === 'state') return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      if (field.name === 'body') return issue.body;
      if (field.name === 'url') return `https://github.com/${repo.fullName}/issues/${issue.number}`;
      if (field.name === 'createdAt') return issue.createdAt;
      if (field.name === 'updatedAt') return issue.updatedAt;
      if (field.name === 'author') return { __typename: 'User', login: issue.user };
      if (field.name === 'labels') {
        return {
          __typename: 'IssueConnection',
          nodes: issue.labels.map((label) => ({ __typename: 'Label', ...label })),
          totalCount: issue.labels.length,
        };
      }
      if (field.name === 'comments') {
        return {
          __typename: 'IssueConnection',
          nodes: issue.comments.map((comment) => ({ __typename: 'IssueComment', repo, issue, comment })),
          totalCount: issue.comments.length,
        };
      }
      return undefined;
    }
    case 'PullRequest': {
      if (repo === undefined || pull === undefined) return undefined;
      if (field.name === 'id') return ctx.store.pullGlobalId(repo, pull);
      if (field.name === 'number') return pull.number;
      if (field.name === 'title') return pull.title;
      if (field.name === 'body') return pull.body;
      if (field.name === 'state') return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
      if (field.name === 'merged') return pull.merged;
      if (field.name === 'mergeable') return pullMergeable(repo, pull);
      if (field.name === 'headRefName') return pull.head.ref;
      if (field.name === 'baseRefName') return pull.base.ref;
      if (field.name === 'headRef') return { __typename: 'Ref', name: pull.head.ref, oid: pull.head.sha };
      if (field.name === 'baseRef') return { __typename: 'Ref', name: pull.base.ref, oid: pull.base.sha };
      if (field.name === 'author') return { __typename: 'User', login: pull.user };
      if (field.name === 'createdAt') return pull.createdAt;
      if (field.name === 'updatedAt') return pull.updatedAt;
      if (field.name === 'mergedAt') return pull.mergedAt;
      if (field.name === 'mergeCommitSha') return pull.mergeCommitSha;
      if (field.name === 'files') {
        const first = typeof args.first === 'number' ? args.first : 100;
        const files = pullFiles(repo, pull).slice(0, first);
        return {
          __typename: 'PullRequestConnection',
          nodes: files.map((file) => ({ __typename: 'PullRequestChangedFile', ...file })),
          totalCount: files.length,
        };
      }
      return undefined;
    }
    case 'IssueConnection':
    case 'PullRequestConnection': {
      if (field.name === 'nodes') {
        return (parent as { nodes?: unknown[] }).nodes ?? [];
      }
      if (field.name === 'edges') {
        const nodes = (parent as { nodes?: unknown[] }).nodes ?? [];
        return nodes.map((node, index) => ({
          __typename: parent.__typename === 'IssueConnection' ? 'IssueEdge' : 'PullRequestEdge',
          node,
          cursor: cursorFor(index),
        }));
      }
      if (field.name === 'pageInfo') return (parent as { pageInfo?: unknown }).pageInfo ?? null;
      if (field.name === 'totalCount') return (parent as { totalCount?: number }).totalCount ?? 0;
      return undefined;
    }
    case 'IssueEdge':
    case 'PullRequestEdge':
    case 'IssueCommentEdge': {
      if (field.name === 'node') return (parent as { node?: unknown }).node ?? null;
      if (field.name === 'cursor') return (parent as { cursor?: string }).cursor ?? null;
      return undefined;
    }
    case 'PageInfo': {
      const page = parent as unknown as Record<string, unknown>;
      if (field.name === 'hasNextPage') return page.hasNextPage ?? false;
      if (field.name === 'hasPreviousPage') return page.hasPreviousPage ?? false;
      if (field.name === 'startCursor') return page.startCursor ?? null;
      if (field.name === 'endCursor') return page.endCursor ?? null;
      return undefined;
    }
    case 'PullRequestChangedFile': {
      const file = parent as unknown as Record<string, unknown>;
      if (field.name === 'path') return file.filename ?? null;
      if (field.name === 'additions') return file.additions ?? 0;
      if (field.name === 'deletions') return file.deletions ?? 0;
      if (field.name === 'changeType') return file.status ?? null;
      return undefined;
    }
    case 'Ref': {
      const ref = parent as unknown as Record<string, unknown>;
      if (field.name === 'name') return ref.name ?? null;
      if (field.name === 'target') {
        const oid = ref.oid;
        return typeof oid === 'string' ? { __typename: 'GitObject', oid } : null;
      }
      if (field.name === 'prefix') return 'refs/heads/';
      return undefined;
    }
    case 'GitObject': {
      if (field.name === 'oid') return (parent as unknown as Record<string, unknown>).oid ?? null;
      return undefined;
    }
    case 'IssueComment': {
      const wrap = parent as unknown as { comment?: { id: number; body: string; user: string; createdAt: string }; repo?: Repo; issue?: Issue };
      if (field.name === 'id') {
        return wrap.repo && wrap.issue && wrap.comment ? ctx.store.commentGlobalId(wrap.repo, wrap.issue, wrap.comment) : null;
      }
      if (field.name === 'body') return wrap.comment?.body ?? null;
      if (field.name === 'author') return wrap.comment ? { __typename: 'User', login: wrap.comment.user } : null;
      if (field.name === 'createdAt') return wrap.comment?.createdAt ?? null;
      return undefined;
    }
    case 'Label': {
      const label = parent as unknown as Record<string, unknown>;
      if (field.name === 'name') return label.name ?? null;
      if (field.name === 'color') return label.color ?? null;
      if (field.name === 'description') return label.description ?? null;
      return undefined;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (field.name === 'issue') return (parent as { issue?: unknown }).issue ?? null;
      if (field.name === 'clientMutationId') return null;
      return undefined;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (field.name === 'pullRequest') return (parent as { pullRequest?: unknown }).pullRequest ?? null;
      if (field.name === 'clientMutationId') return null;
      return undefined;
    }
    case 'AddCommentPayload': {
      if (field.name === 'commentEdge') return (parent as { commentEdge?: unknown }).commentEdge ?? null;
      if (field.name === 'comment') {
        const edge = (parent as { commentEdge?: { node?: unknown } }).commentEdge;
        return edge?.node ?? null;
      }
      if (field.name === 'clientMutationId') return null;
      return undefined;
    }
    case '__Type': {
      const type = parent as unknown as Record<string, unknown>;
      if (field.name === 'name') return type.name ?? null;
      if (field.name === 'kind') return type.kind ?? null;
      if (field.name === 'description') return null;
      if (field.name === 'fields') {
        const args = argMap(field, ctx.variables);
        void args;
        const fields = (type.fields as Array<{ name: string }> | null) ?? null;
        return fields;
      }
      if (field.name === 'enumValues') {
        const values = (type.enumValues as Array<{ name: string }> | null) ?? null;
        return values;
      }
      if (field.name === 'inputFields') return null;
      return undefined;
    }
    case '__Field': {
      const f = parent as unknown as Record<string, unknown>;
      if (field.name === 'name') return f.name ?? null;
      if (field.name === 'description') return null;
      if (field.name === 'args') return [];
      if (field.name === 'type') return { __typename: '__Type', name: 'String', kind: 'SCALAR' };
      return undefined;
    }
    case '__EnumValue': {
      if (field.name === 'name') return (parent as unknown as Record<string, unknown>).name ?? null;
      if (field.name === 'description') return null;
      return undefined;
    }
    case '__Schema': {
      const schema = parent as unknown as Record<string, unknown>;
      if (field.name === 'types') return schema.types ?? null;
      if (field.name === 'queryType') return schema.queryType ?? null;
      if (field.name === 'mutationType') return schema.mutationType ?? null;
      return undefined;
    }
    default:
      return undefined;
  }
}

/** Wrap a raw connection node (an Issue, Pull, or PullFile) into its typed object. */
function wrapNode(_ctx: ExecContext, _parent: Obj, node: unknown, _selection: SelectionNode[] | null): unknown {
  return node;
}

/** Execute one selection set on an object, validating field names against the schema. */
function executeSelection(ctx: ExecContext, parent: Obj, selections: SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const parentType = parent.__typename;
  const allowed = SCHEMA_FIELDS[parentType];
  for (const selection of selections) {
    if (selection.kind === 'FragmentSpread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment) Object.assign(out, executeSelection(ctx, parent, fragment));
      continue;
    }
    if (selection.kind === 'InlineFragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== parentType) continue;
      Object.assign(out, executeSelection(ctx, parent, selection.selectionSet));
      continue;
    }
    const field = selection.field;
    const responseName = field.alias ?? field.name;
    if (allowed !== undefined && !allowed.includes(field.name)) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${parentType}".` });
      continue;
    }
    const value = resolveField(ctx, parent, field);
    if (value === undefined) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${parentType}".` });
      continue;
    }
    if (value === null || field.selectionSet === null) {
      out[responseName] = value;
      continue;
    }
    if (Array.isArray(value)) {
      out[responseName] = value.map((entry) =>
        entry !== null && typeof entry === 'object' && '__typename' in (entry as Obj)
          ? executeSelection(ctx, entry as Obj, field.selectionSet!)
          : entry,
      );
      continue;
    }
    if (typeof value === 'object') {
      const obj = value as Obj;
      if ('__typename' in obj) {
        out[responseName] = executeSelection(ctx, obj, field.selectionSet);
      } else {
        out[responseName] = value;
      }
      continue;
    }
    out[responseName] = value;
  }
  return out;
}

/** Execute one operation document: {data, errors}. */
export function executeGraphQL(
  store: Store,
  query: string,
  variables: Record<string, unknown>,
  operationName?: string,
): { data: Record<string, unknown> | null; errors: Array<{ message: string }> } {
  let document: DocumentNode;
  try {
    document = parseDocument(query);
  } catch (err) {
    return { data: null, errors: [{ message: `GraphQL parse error: ${(err as Error).message}` }] };
  }
  const operation =
    document.operations.find((entry) => operationName !== undefined && entry.name === operationName) ??
    document.operations[0];
  if (operation === undefined) return { data: null, errors: [{ message: 'No operation in document' }] };
  const vars: Record<string, unknown> = { ...variables };
  for (const def of operation.variableDefinitions) {
    if (!(def.name in vars) && def.defaultValue !== null) vars[def.name] = valueOf(def.defaultValue, vars);
  }
  const ctx: ExecContext = { store, variables: vars, errors: [], fragments: document.fragments };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const root: Obj = { __typename: rootType };
  const data = executeSelection(ctx, root, operation.selectionSet);
  if (ctx.errors.length > 0) return { data: null, errors: ctx.errors };
  return { data, errors: [] };
}
