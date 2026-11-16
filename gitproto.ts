// gitproto.ts — the git smart-HTTP wire: pkt-lines, packfiles (read with delta resolution,
// written delta-free), advertisements, ls-refs, fetch (v2 and v0) and receive-pack.
//
// The suite's client (kit program/env/src/git-client.ts) is the contract: every framing choice
// below answers a shape that client parses. Deltas are never emitted (plain objects verify
// byte-for-byte), but incoming packs are resolved fully, including OFS_DELTA and REF_DELTA.

import { deflateSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import {
  ZERO_OID,
  isObjectId,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  collectReachable,
  isAncestor,
  type GitObject,
  type GitObjectType,
  type Repo,
} from './store.ts';

// ---------------------------------------------------------------------------------------------
// pkt-lines
// ---------------------------------------------------------------------------------------------

export const PKT_LINE_MAX = 65520;

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  if (length > PKT_LINE_MAX) throw new Error(`pkt-line of ${length} bytes exceeds ${PKT_LINE_MAX}`);
  const head = Buffer.alloc(4);
  head.write(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export type PktPacket =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' };

/** Decode a whole pkt-line stream. Throws on a malformed length (the caller answers 400). */
export function decodePktLines(buffer: Buffer): PktPacket[] {
  const packets: PktPacket[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line length');
    const head = buffer.subarray(offset, offset + 4).toString('ascii');
    if (head === '0000') {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (head === '0001') {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`bad pkt-line length ${JSON.stringify(head)}`);
    const length = parseInt(head, 16);
    if (length < 4 || offset + length > buffer.length) throw new Error('pkt-line length out of range');
    packets.push({ kind: 'data', payload: Buffer.from(buffer.subarray(offset + 4, offset + length)) });
    offset += length;
  }
  return packets;
}

// ---------------------------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------------------------

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a packfile from plain objects (no deltas). Trailer is SHA-1 over everything before it. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    // Level 1 is the fastest deflate: the wire does not care about pack size, only speed.
    parts.push(deflateSync(object.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** The empty pack: PACK v2, 0 objects, trailer. */
export function emptyPack(): Buffer {
  return writePack([]);
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new Error('pack entry has no size header');
  let byte = buffer[start]!;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset++]!;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buffer.length) throw new Error('ofs-delta has no base offset');
  let byte = buffer[start]!;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('ofs-delta base offset is truncated');
    byte = buffer[offset++]!;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Inflate one zlib stream at `offset`; returns its bytes and the offset just past the stream. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/** Apply a git delta to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++]!;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++]!;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += delta[offset++]! * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += delta[offset++]! * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

export interface PackRead {
  objects: Map<string, GitObject>;
  deltaCount: number;
}

/**
 * Read a packfile (version 2 or 3) and resolve every object, including OFS_DELTA and REF_DELTA.
 * `resolveBase` supplies a base object a thin pack leaves out. Every object's SHA-1 is recomputed
 * and its declared size checked; any mismatch throws.
 */
export function readPack(pack: Buffer, resolveBase: (oid: string) => GitObject | undefined): PackRead {
  if (pack.length < 32) throw new Error(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computedTrailer = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computedTrailer) throw new Error('pack trailer does not match its bytes');

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolvedType?: GitObjectType;
    resolved?: Buffer;
    oid?: string;
  }

  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) {
        throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset ${base.baseOffset}`);
      }
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) {
      throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);

  const objects = new Map<string, GitObject>();
  const resolving = new Set<number>();
  const resolvedByOid = new Map<string, RawEntry>();

  const resolve = (entry: RawEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} is neither in the pack nor supplied`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode]!;
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };

  let deltaCount = 0;
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (entry.typeCode === 6 || entry.typeCode === 7) deltaCount += 1;
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return { objects, deltaCount };
}

// ---------------------------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------------------------

export const AGENT = 'forge/1.0';

/** Peel an annotated tag to its commit (recursively), or null when the target is not a tag. */
function peelTag(repo: Repo, oid: string): string | null {
  let current = oid;
  for (let depth = 0; depth < 10; depth += 1) {
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tag') return depth === 0 ? null : current;
    current = parseTag(object.data).object;
  }
  return null;
}

/** All refs, sorted: HEAD first, then heads, then tags. */
export interface ListedRef {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

export function listRefs(repo: Repo): ListedRef[] {
  const refs: ListedRef[] = [];
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  const tip = repo.refs.get(defaultRef);
  if (tip === undefined) {
    refs.push({ oid: ZERO_OID, name: 'HEAD', unborn: true, symrefTarget: defaultRef });
  } else {
    refs.push({ oid: tip, name: 'HEAD', symrefTarget: defaultRef });
  }
  const heads = [...repo.refs.keys()].filter((name) => name.startsWith('refs/heads/')).sort();
  for (const name of heads) {
    refs.push({ oid: repo.refs.get(name)!, name });
  }
  const tags = [...repo.refs.keys()].filter((name) => name.startsWith('refs/tags/')).sort();
  for (const name of tags) {
    const oid = repo.refs.get(name)!;
    const peeled = peelTag(repo, oid);
    refs.push(peeled === null ? { oid, name } : { oid, name, peeled });
  }
  return refs;
}

/** The v2 capability advertisement for git-upload-pack. */
export function advertisementV2(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine('agent\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    pktFlush(),
  ]);
}

/** The v0 ref advertisement for a service. */
export function advertisementV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const caps =
    service === 'git-upload-pack'
      ? `symref=HEAD:refs/heads/${repo.defaultBranch} side-band-64k thin-pack ofs-delta shallow agent=${AGENT}`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const refs = listRefs(repo);
  const real = refs.filter((ref) => ref.name !== 'HEAD');
  if (real.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    for (const ref of refs) {
      if (ref.name === 'HEAD') {
        parts.push(pktLine(`${ref.oid} HEAD${first ? `\0${caps}` : ''}\n`));
        first = false;
        continue;
      }
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled !== undefined) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// fetch planning
// ---------------------------------------------------------------------------------------------

export interface FetchPlan {
  /** Objects to send, in a stable order (commits first, then trees, then blobs). */
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
  acks: string[];
  nak: boolean;
}

/**
 * Plan a fetch: which objects to send for `wants`, given what the client already `haves` and its
 * current shallow boundaries, and an optional depth. The send set is the reachable closure of the
 * wants minus the closure of the haves, cut at the depth. Boundaries are the included commits
 * whose parents exist but were cut; unshallow boundaries are old ones whose parents were sent.
 */
export function planFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  shallow: readonly string[],
  depth: number | null,
): FetchPlan {
  // What the client actually holds: the closure of its haves, but a shallow boundary's
  // parents are NOT held — that is the whole point of a shallow clone, and a deepen fetch
  // must deliver them.
  const shallowSet = new Set(shallow);
  const haveReachable = ((): Set<string> => {
    const seen = new Set<string>();
    const queue: string[] = [];
    for (const have of haves) if (isObjectId(have)) queue.push(have);
    while (queue.length > 0) {
      const oid = queue.pop()!;
      if (seen.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object) continue;
      seen.add(oid);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        queue.push(commit.tree);
        if (!shallowSet.has(oid)) {
          for (const parent of commit.parents) queue.push(parent);
        }
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
  })();
  const included = new Set<string>();
  const boundary = new Set<string>();
  // BFS over commits with a generation depth; tags expand to their target commit.
  const seenDepth = new Map<string, number>();
  const queue: Array<{ oid: string; depth: number }> = [];
  const expandTag = (oid: string): string | null => {
    let current = oid;
    for (let i = 0; i < 10; i += 1) {
      const object = repo.objects.get(current);
      if (!object) return null;
      if (object.type === 'tag') current = parseTag(object.data).object;
      else return current;
    }
    return null;
  };
  for (const want of wants) {
    const object = repo.objects.get(want);
    if (!object) continue;
    if (object.type === 'tag') {
      included.add(want);
      const target = expandTag(want);
      if (target !== null) queue.push({ oid: target, depth: 0 });
    } else if (object.type === 'commit') {
      queue.push({ oid: want, depth: 0 });
    } else {
      included.add(want);
    }
  }
  while (queue.length > 0) {
    const { oid, depth: d } = queue.shift()!;
    const seen = seenDepth.get(oid);
    if (seen !== undefined && seen <= d) continue;
    seenDepth.set(oid, d);
    const isHeld = haveReachable.has(oid);
    // A held commit that is not a shallow boundary needs nothing: its whole history is held.
    // A held shallow boundary is different — its parents are NOT held, so the walk continues
    // past it (a deepen fetch) even though the boundary commit itself is never re-sent.
    if (isHeld && !shallowSet.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    if (!isHeld) included.add(oid);
    const commit = parseCommit(object.data);
    const cut = depth !== null && d + 1 >= depth;
    if (cut) {
      for (const parent of commit.parents) {
        if (repo.objects.has(parent) && !haveReachable.has(parent)) boundary.add(oid);
      }
    } else {
      for (const parent of commit.parents) queue.push({ oid: parent, depth: d + 1 });
    }
  }
  // Trees and blobs of the included commits ONLY: a full reachable closure here would undo
  // the depth cut by re-adding the parents the BFS deliberately excluded.
  const collectTreeObjects = (treeOid: string, out: Set<string>): void => {
    const object = repo.objects.get(treeOid);
    if (!object || object.type !== 'tree') return;
    out.add(treeOid);
    for (const entry of parseTree(object.data)) {
      if (entry.mode === '40000') collectTreeObjects(entry.oid, out);
      else if (entry.mode !== '160000') out.add(entry.oid);
    }
  };
  const send = new Set<string>();
  for (const oid of included) {
    const object = repo.objects.get(oid);
    if (!object) continue;
    send.add(oid);
    if (object.type === 'commit') collectTreeObjects(parseCommit(object.data).tree, send);
  }
  for (const oid of [...send]) if (haveReachable.has(oid)) send.delete(oid);
  // A boundary commit is one whose parent exists in the store but was not sent and is not held.
  const shallowOut: string[] = [];
  for (const oid of boundary) {
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.some((parent) => repo.objects.has(parent) && !send.has(parent) && !haveReachable.has(parent))) {
      shallowOut.push(oid);
    }
  }
  const unshallowOut: string[] = [];
  for (const old of shallow) {
    if (!haveReachable.has(old)) continue;
    const object = repo.objects.get(old);
    if (!object || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.some((parent) => send.has(parent))) unshallowOut.push(old);
  }
  // ACKs: a have that is an ancestor of (or equal to) a want. With no haves there can be
  // no ACKs, so skip the full-history walk entirely (a fresh clone's hot path).
  const acks: string[] = [];
  if (haves.length > 0) {
    const wantReachable = collectReachable(repo, wants);
    for (const have of haves) {
      if (wantReachable.has(have) && repo.objects.get(have)?.type === 'commit') acks.push(have);
    }
  }
  // Stable order: commits, then tags, then trees, then blobs, each by oid.
  const order: Record<GitObjectType, number> = { commit: 0, tag: 1, tree: 2, blob: 3 };
  const objects: GitObject[] = [];
  for (const oid of [...send].sort((a, b) => {
    const ta = repo.objects.get(a)!.type;
    const tb = repo.objects.get(b)!.type;
    return order[ta] - order[tb] || (a < b ? -1 : a > b ? 1 : 0);
  })) {
    objects.push(repo.objects.get(oid)!);
  }
  return { objects, shallow: shallowOut.sort(), unshallow: unshallowOut.sort(), acks, nak: acks.length === 0 };
}

/** Frame pack bytes as sideband band-1 pkt-lines (chunks under the pkt-line cap). */
export function sidebandPack(pack: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  const maxPayload = 65500;
  let offset = 0;
  do {
    const slice = pack.subarray(offset, offset + maxPayload);
    const payload = Buffer.concat([Buffer.from([1]), slice]);
    chunks.push(pktLine(payload));
    offset += slice.length;
  } while (offset < pack.length);
  return chunks;
}

// ---------------------------------------------------------------------------------------------
// v2 ls-refs / fetch request parsing
// ---------------------------------------------------------------------------------------------

export interface V2Command {
  command: string;
  args: string[];
}

/** Parse a v2 command body into its command and argument lines (throws on a malformed body). */
export function parseV2Command(body: Buffer): V2Command {
  const packets = decodePktLines(body);
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
    else if (packet.kind === 'flush') break;
  }
  if (lines.length === 0) throw new Error('empty v2 command');
  const first = lines[0]!;
  const match = /^command=([a-z-]+)\n?$/.exec(first);
  if (!match) throw new Error(`not a v2 command: ${JSON.stringify(first.slice(0, 40))}`);
  return { command: match[1]!, args: lines.slice(1).map((line) => line.replace(/\n$/, '')) };
}

/** Answer a v2 ls-refs command. */
export function lsRefsResponse(repo: Repo, args: readonly string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
    else if (arg.startsWith('agent=') || arg.startsWith('object-format=')) continue;
    else if (arg === '') continue;
  }
  const refs = listRefs(repo);
  const parts: Buffer[] = [];
  for (const ref of refs) {
    if (prefixes.length > 0 && !prefixes.some((prefix) => ref.name.startsWith(prefix))) continue;
    if (ref.unborn === true) {
      if (!unborn) continue;
      parts.push(pktLine(`unborn HEAD symref-target:${ref.symrefTarget}\n`));
      continue;
    }
    let line = `${ref.oid} ${ref.name}`;
    if (ref.name === 'HEAD' && symrefs && ref.symrefTarget) line += ` symref-target:${ref.symrefTarget}`;
    if (peel && ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** Answer a v2 fetch command. */
export function fetchV2Response(repo: Repo, args: readonly string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) depth = Number(arg.slice(7).trim());
    else if (
      arg === 'thin-pack' ||
      arg === 'no-progress' ||
      arg === 'ofs-delta' ||
      arg === 'done' ||
      arg.startsWith('agent=') ||
      arg.startsWith('object-format=') ||
      arg.startsWith('deepen-since ') ||
      arg.startsWith('deepen-not ') ||
      arg.startsWith('filter ')
    ) {
      continue;
    }
  }
  const done = args.includes('done');
  const plan = planFetch(repo, wants, haves, shallow, depth);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  if (!done) {
    // A negotiation round (no "done" yet): the acknowledgments section alone, terminated
    // by a flush — no packfile section is sent in this round.
    parts.push(pktLine('acknowledgments\n'));
    if (plan.acks.length > 0) {
      for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
      parts.push(pktLine('ready\n'));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(pktFlush());
    return Buffer.concat(parts);
  }
  // The client sent "done": the protocol-v2 spec requires the acknowledgments section to
  // be omitted from the response entirely — real git clients die with
  // "expected 'packfile', received 'acknowledgments'" if it is present.
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  parts.push(pktLine('packfile\n'));
  for (const chunk of sidebandPack(pack)) parts.push(chunk);
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** Answer a v0 fetch (wants/haves/deepen pkt-lines, two sections). */
export function fetchV0Response(repo: Repo, body: Buffer): Buffer {
  const packets = decodePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const oid = line.slice(5).split(' ')[0]!;
      if (isObjectId(oid)) wants.push(oid);
    } else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number(line.slice(7).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
  }
  void section;
  const plan = planFetch(repo, wants, haves, shallow, depth);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  if (plan.acks.length > 0) {
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
    parts.push(pktLine('ready\n'));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  for (const chunk of sidebandPack(pack)) parts.push(chunk);
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------------------------

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export interface PushReportLine {
  ref: string;
  ok: boolean;
  reason: string;
}

/**
 * Apply a receive-pack: unpack the pack, then evaluate each command's fast-forward rule.
 * Returns the report lines; `unpackOk` is false only when the pack itself is corrupt.
 */
export function applyPush(
  repo: Repo,
  commands: readonly PushCommand[],
  pack: Buffer | null,
): { unpackOk: boolean; unpackDetail: string; refs: PushReportLine[] } {
  if (pack !== null && pack.length > 0) {
    try {
      const read = readPack(pack, (oid) => repo.objects.get(oid));
      for (const [oid, object] of read.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      return { unpackOk: false, unpackDetail: (err as Error).message, refs: [] };
    }
  }
  const refs: PushReportLine[] = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // delete
      if (current === undefined) {
        refs.push({ ref: command.ref, ok: false, reason: 'ref does not exist' });
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        refs.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.delete(command.ref);
        refs.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      refs.push({ ref: command.ref, ok: false, reason: 'object not found' });
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      // create
      if (current !== undefined) {
        refs.push({ ref: command.ref, ok: false, reason: 'already exists' });
      } else {
        repo.refs.set(command.ref, command.newOid);
        refs.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    // update: the old value must match, and the new commit must descend from it.
    if (current === undefined) {
      refs.push({ ref: command.ref, ok: false, reason: 'ref does not exist' });
    } else if (command.oldOid !== current) {
      refs.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
    } else if (!isAncestor(repo, command.oldOid, command.newOid)) {
      refs.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
    } else {
      repo.refs.set(command.ref, command.newOid);
      refs.push({ ref: command.ref, ok: true, reason: '' });
    }
  }
  return { unpackOk: true, unpackDetail: 'ok', refs };
}

/** Frame a push report as sideband band-1 pkt-lines (the report itself is pkt-lined inside). */
export function pushReportResponse(result: {
  unpackOk: boolean;
  unpackDetail: string;
  refs: PushReportLine[];
}): Buffer {
  const lines: string[] = [`unpack ${result.unpackOk ? 'ok' : result.unpackDetail}\n`];
  for (const ref of result.refs) {
    lines.push(ref.ok ? `ok ${ref.ref}\n` : `ng ${ref.ref} ${ref.reason}\n`);
  }
  // git's own receive-pack emits the whole report as ONE band-1 sideband
  // payload: every report line as an inner pkt-line, terminated by an inner
  // flush (0000) that ends the client's report reader cleanly; the outer
  // flush then ends the sideband demuxer. Without the inner flush the
  // demuxer swallows the outer flush and git dies with "the remote end hung
  // up unexpectedly" after reading the last report line (verified against
  // git 2.43.0 http-backend packet traces).
  const inner = Buffer.concat([...lines.map((line) => pktLine(line)), pktFlush()]);
  const parts: Buffer[] = [];
  const maxPayload = 65515; // pkt-line cap 65520 minus band byte and header
  for (let offset = 0; offset < inner.length; offset += maxPayload) {
    const slice = inner.subarray(offset, offset + maxPayload);
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** Parse a receive-pack request body: command pkt-lines, a flush, then the raw pack bytes. */
export function parsePushBody(body: Buffer): { commands: PushCommand[]; pack: Buffer | null } {
  const commands: PushCommand[] = [];
  let offset = 0;
  let pack: Buffer | null = null;
  while (offset < body.length) {
    if (offset + 4 > body.length) throw new Error('truncated pkt-line length');
    const head = body.subarray(offset, offset + 4).toString('ascii');
    if (head === '0000') {
      // Flush: the raw pack follows (a delete-only push sends none).
      offset += 4;
      pack = offset < body.length ? Buffer.from(body.subarray(offset)) : null;
      break;
    }
    if (head === '0001') {
      offset += 4;
      continue;
    }
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`bad pkt-line length ${JSON.stringify(head)}`);
    const length = parseInt(head, 16);
    if (length < 4 || offset + length > body.length) throw new Error('pkt-line length out of range');
    const text = body.subarray(offset + 4, offset + length).toString('utf8');
    const nul = text.indexOf('\0');
    const line = (nul >= 0 ? text.slice(0, nul) : text).replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length < 3 || !isObjectId(parts[0]!) || !isObjectId(parts[1]!)) {
      throw new Error(`bad push command ${JSON.stringify(line.slice(0, 60))}`);
    }
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
    offset += length;
  }
  if (commands.length === 0) throw new Error('push has no commands');
  return { commands, pack };
}
