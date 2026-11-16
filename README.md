# github-core-clone — a GitHub-compatible git forge in one Node process

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/sujang783/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/sujang783/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

Built for the [github-core-clone-01 bounty on make.fun](https://make.fun/bounty/github-core-clone-01).

A standalone forge serving all four interfaces the grader drives, from a single
in-memory store and no outside service:

- **Git smart HTTP** — protocol v2 `upload-pack` (`ls-refs` with `peel`/`symrefs`/`unborn`/
  `ref-prefix`, `fetch` with `shallow`/`deepen`/`thin-pack`/`ofs-delta`) and v0
  `upload-pack`, plus `receive-pack` with `report-status`/`side-band-64k`/`delete-refs`.
  Packs are delta-free v2 with a verified SHA-1 trailer; fast-forward rules, per-ref
  report lines, and `non-fast-forward` refusals match real git.
- **REST v3** (`/api/v3/`) — repositories, branches, commits, contents, labels, issues,
  comments, pull requests (including squash merge with conflict detection), plus
  `GET /api/v3/meta`, `GET /api/v3/user`, and the `X-GitHub-Request-Id` header on every
  reply. Unknown routes are 404 JSON; malformed bodies are 400.
- **GraphQL v4** (`/api/graphql`) — a hand-rolled lexer/parser/executor for the
  documents the suite sends: viewer, repository, issue/pull-request connections with
  `states`/`orderBy`/`first`/`after` pagination, `node` with opaque global ids,
  `__type` introspection, create/close issue, create/merge pull request, add comment,
  and batched operation arrays. Unknown fields are HTTP 200 with an `errors` array.
- **MCP** (`/mcp`) — JSON-RPC 2.0 Streamable HTTP, protocol revision 2026-07-28 via
  `server/discover` with a legacy `initialize` fallback. Eight tools, including the six
  the suite requires (`create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`), acting on the same store as REST.

## Running

```sh
node main.ts            # trial lifecycle: needs $MAKEFUN_ENV_URL (see the kit)
```

For a local check, `createApp()` in `app.ts` builds the server; the kit's runner
drives it:

```sh
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:PORT --token TOK [--perf]
```

Auth is `Authorization: Bearer $MAKEFUN_SHOP_TOKEN` when that variable is set; when
it is unset any non-empty bearer token is accepted. A missing header is always 401.
`/healthz` needs no auth.

## Layout

| File | What it is |
| --- | --- |
| `main.ts` | The entry <-> env lifecycle (kit starter, unchanged). |
| `app.ts` | HTTP plumbing: body reading, auth, request ids, dispatch to the four interfaces. |
| `store.ts` | The in-memory store: git objects (SHA-1, commit/tree/tag, reachability), repos, refs, issues, pulls, labels, deterministic timestamps, opaque global ids. |
| `gitproto.ts` | Pkt-lines, packfiles (write + read with OFS/REF delta resolution), advertisements, ls-refs/fetch/push handling. |
| `rest.ts` | The REST v3 router and all resource shapes, pagination, merge logic. |
| `graphql.ts` | GraphQL lexer/parser/executor and the static schema for introspection. |
| `mcp.ts` | MCP `server/discover` / `initialize` / `tools/list` / `tools/call`. |

## Notes

- State is in-memory only and deterministic: timestamps come from a fixed epoch plus
  a monotonic sequence, never the wall clock, so two runs on the same instance leave
  identical state exports.
- The viewer is fixed by the trial contract: every authenticated call is `adaiversen`
  (id 1000); repositories live under that owner.
- No dependencies, no git binary, no package manager, no outside service — Node 22
  standard library only.
