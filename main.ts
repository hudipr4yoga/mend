// main.ts is mend, the CLI SPEC.md specifies. It reads a patch in one of four formats (unified diff,
// SEARCH/REPLACE blocks, V4A, JSON edits), finds the lines each edit names at the first of three
// matching tiers (exact, trailing-trim, both-trim), and changes every file or none, printing what it
// changed or why it failed. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's lines under SPEC.md section 3: its line break, its lines, whether it ends with one. */
interface FileLines {
  lines: string[];
  br: '\r\n' | '\n';
  final: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(f: FileLines): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** Matching lines, SPEC.md section 5. */
function trimTrail(s: string): string {
  return s.replace(/[ \t]+$/, '');
}
function trimBoth(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}
function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0]!;
}
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimTrail(a) === trimTrail(b);
  return trimBoth(a) === trimBoth(b);
}
function occurrencesAt(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = 0; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) { ok = false; break; }
    }
    if (ok) out.push(i);
  }
  return out;
}
function firstTier(lines: string[], o: string[], maxTier: number): { tier: number; occ: number[] } | null {
  for (let tier = 0; tier <= maxTier; tier++) {
    const occ = occurrencesAt(lines, o, tier);
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

/** One line of N: a context line (written as the file's own line at index ctx of O) or an added line. */
interface NLine {
  text: string;
  ctx: number | null;
}

function buildReplacement(lines: string[], at: number, o: string[], n: NLine[], tier: number): string[] {
  let f = '';
  let p = '';
  if (tier === 2 && o.length > 0) {
    f = leadWs(lines[at]!);
    p = leadWs(o[0]!);
  }
  return n.map((l) => {
    if (l.ctx !== null) return lines[at + l.ctx]!;
    if (tier === 2 && l.text !== '' && l.text.trim() !== '' && l.text.startsWith(p)) return f + l.text.slice(p.length);
    return l.text;
  });
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  move(oldP: string, newP: string, content: string): void {
    this.now.set(oldP, null);
    this.now.set(newP, content);
    this.moves.push([oldP, newP]);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  // SPEC.md section 1 detection, literally: a bare `@@` hunk, or a `*** Update File:`
  // first line, is NOT unified/v4a here, so it stays `error: format` (the section 6/8
  // parse sentences for those only fire when the format is forced with --format).
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** Unified diffs, SPEC.md section 6. */
interface UBodyLine {
  kind: 'ctx' | 'old' | 'new' | 'back';
  text: string;
}
interface UHunk {
  a: number;
  body: UBodyLine[];
}
interface USection {
  diffOld: string | null;
  diffNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  sawPair: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  delFile: boolean;
  hunks: UHunk[];
}

function uniPath(raw: string): string | null {
  let p = raw.split('\t')[0]!;
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/')) p = p.slice(2);
  else if (p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseHunk(lines: string[], at: number): { hunk: UHunk; next: number } {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(lines[at]!);
  if (m === null) throw new Exit2(`error: parse ${at + 1}`);
  const a = Number(m[1]);
  const body: UBodyLine[] = [];
  let j = at + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') body.push({ kind: 'ctx', text: '' });
    else if (l.startsWith(' ')) body.push({ kind: 'ctx', text: l.slice(1) });
    else if (l.startsWith('-')) body.push({ kind: 'old', text: l.slice(1) });
    else if (l.startsWith('+')) body.push({ kind: 'new', text: l.slice(1) });
    else if (l.startsWith('\\')) body.push({ kind: 'back', text: l });
    else break;
    j++;
  }
  while (body.length > 0) {
    const lastB = body[body.length - 1]!;
    if (lastB.kind === 'ctx' && lastB.text === '') body.pop();
    else break;
  }
  return { hunk: { a, body }, next: j };
}

function parseUnified(lines: string[], maxTier: number): Edit[] {
  const sections: USection[] = [];
  const diffRe = /^diff --git a\/(\S+) b\/(\S+)[ \t]*$/;
  let i = 0;
  let cur: USection | null = null;
  const newSection = (dOld: string | null, dNew: string | null): USection => {
    const s: USection = { diffOld: dOld, diffNew: dNew, pairOld: null, pairNew: null, sawPair: false, renameFrom: null, renameTo: null, newFile: false, delFile: false, hunks: [] };
    sections.push(s);
    return s;
  };
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git')) {
      const m = diffRe.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection(m[1]!, m[2]!);
      i++;
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (l.startsWith('--- ')) {
        const nx = lines[i + 1] ?? '';
        if (!nx.startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        if (!cur.sawPair) {
          cur.pairOld = uniPath(l.slice(4));
          cur.pairNew = uniPath(nx.slice(4));
          cur.sawPair = true;
        }
        i += 2;
        continue;
      }
      if (l.startsWith('rename from ')) {
        if (!cur.sawPair && cur.renameFrom === null) cur.renameFrom = l.slice(12).trim();
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        if (!cur.sawPair && cur.renameTo === null) cur.renameTo = l.slice(10).trim();
        i++;
        continue;
      }
      if (l.startsWith('new file mode')) { cur.newFile = true; i++; continue; }
      if (l.startsWith('deleted file mode')) { cur.delFile = true; i++; continue; }
      if (l.startsWith('@@')) {
        const h = parseHunk(lines, i);
        cur.hunks.push(h.hunk);
        i = h.next;
        continue;
      }
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      cur = newSection(null, null);
      cur.pairOld = uniPath(l.slice(4));
      cur.pairNew = uniPath(lines[i + 1]!.slice(4));
      cur.sawPair = true;
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const h = parseHunk(lines, i);
      cur.hunks.push(h.hunk);
      i = h.next;
      continue;
    }
    i++;
  }
  return sections.map((s) => unifiedEdit(s, maxTier));
}

function hunkON(h: UHunk): { o: string[]; n: NLine[]; noNL: boolean } {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const b of h.body) {
    if (b.kind === 'ctx') { o.push(b.text); n.push({ text: b.text, ctx: o.length - 1 }); }
    else if (b.kind === 'old') { o.push(b.text); }
    else if (b.kind === 'new') { n.push({ text: b.text, ctx: null }); }
  }
  let noNL = false;
  for (let k = h.body.length - 1; k >= 0; k--) {
    const b = h.body[k]!;
    if (b.kind === 'ctx' || b.kind === 'new') {
      noNL = k + 1 < h.body.length && h.body[k + 1]!.kind === 'back';
      break;
    }
  }
  return { o, n, noNL };
}

function applyUnifiedHunk(f: FileLines, h: UHunk, d: number, maxTier: number, path: string): { f: FileLines; delta: number } {
  const { o, n, noNL } = hunkON(h);
  if (o.length === 0) {
    const pos = Math.min(Math.max(h.a + d, 0), f.lines.length);
    const rep = n.map((l) => l.text);
    const final = pos === f.lines.length ? !noNL : f.final;
    return { f: { lines: [...f.lines.slice(0, pos), ...rep, ...f.lines.slice(pos)], br: f.br, final }, delta: n.length };
  }
  const found = firstTier(f.lines, o, maxTier);
  if (found === null) throw new Fail('no-match', path);
  const target = h.a - 1 + d;
  let best = found.occ[0]!;
  let bestDist = Math.abs(best - target);
  for (const p of found.occ) {
    const dist = Math.abs(p - target);
    if (dist < bestDist) { best = p; bestDist = dist; }
  }
  const rep = buildReplacement(f.lines, best, o, n, found.tier);
  const atEnd = best + o.length === f.lines.length;
  const final = atEnd ? !noNL : f.final;
  return { f: { lines: [...f.lines.slice(0, best), ...rep, ...f.lines.slice(best + o.length)], br: f.br, final }, delta: n.length - o.length };
}

function unifiedEdit(sec: USection, maxTier: number): Edit {
  return (tree) => {
    const oldP = sec.pairOld ?? sec.renameFrom ?? sec.diffOld;
    const newP = sec.pairNew ?? sec.renameTo ?? sec.diffNew;
    let kind: 'create' | 'delete' | 'move' | 'change';
    if (sec.newFile) kind = 'create';
    else if (sec.delFile) kind = 'delete';
    else if (oldP === null) kind = 'create';
    else if (newP === null) kind = 'delete';
    else if (oldP !== newP) kind = 'move';
    else kind = 'change';
    if (kind === 'create') {
      const p = newP ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      for (const h of sec.hunks) for (const b of h.body) if (b.kind === 'new') plus.push(b.text);
      if (plus.length === 0) { tree.now.set(p, ''); return; }
      let noNL = false;
      let foundPlus = false;
      for (let hi = sec.hunks.length - 1; hi >= 0 && !foundPlus; hi--) {
        const body = sec.hunks[hi]!.body;
        for (let k = body.length - 1; k >= 0; k--) {
          if (body[k]!.kind === 'new') {
            noNL = k + 1 < body.length && body[k + 1]!.kind === 'back';
            foundPlus = true;
            break;
          }
        }
      }
      tree.now.set(p, plus.join('\n') + (noNL ? '' : '\n'));
      return;
    }
    if (kind === 'delete') {
      const p = oldP ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (kind === 'move') {
      const op = oldP!;
      const np = newP!;
      if (!safe(op)) throw new Fail('unsafe', op);
      if (!safe(np)) throw new Fail('unsafe', np);
      const before = tree.get(op);
      if (before === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      let f = splitFile(before);
      let d = 0;
      for (const h of sec.hunks) {
        const r = applyUnifiedHunk(f, h, d, maxTier, op);
        f = r.f;
        d += r.delta;
      }
      tree.move(op, np, joinFile(f));
      return;
    }
    const p = oldP!;
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    let f = splitFile(before);
    let d = 0;
    for (const h of sec.hunks) {
      const r = applyUnifiedHunk(f, h, d, maxTier, p);
      f = r.f;
      d += r.delta;
    }
    tree.now.set(p, joinFile(f));
  };
}

/** SEARCH/REPLACE blocks, SPEC.md section 7. */
interface SRBlock {
  path: string;
  old: string[];
  new: string[];
}

function parseSR(lines: string[], maxTier: number): Edit[] {
  const edits: Edit[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') { i++; continue; }
    const s = i;
    let eq = -1;
    let j = s + 1;
    while (j < lines.length) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') { eq = j; break; }
      if (t === '>>>>>>> REPLACE') break;
      j++;
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    let k = eq + 1;
    while (k < lines.length) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') { rep = k; break; }
      k++;
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    const oldLines = lines.slice(s + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    let path: string | null = null;
    for (let p = s - 1; p > prevReplace; p--) {
      const pl = lines[p]!;
      if (blank(pl)) continue;
      if (pl.trim().startsWith('```')) continue;
      path = pl.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    edits.push(srEdit({ path, old: oldLines, new: newLines }, maxTier));
    prevPath = path;
    prevReplace = rep;
    i = rep + 1;
  }
  return edits;
}

function srEdit(block: SRBlock, maxTier: number): Edit {
  return (tree) => {
    const p = block.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (block.old.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, block.new.length === 0 ? '' : `${block.new.join('\n')}\n`);
      return;
    }
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const f = splitFile(before);
    const found = firstTier(f.lines, block.old, maxTier);
    if (found === null) throw new Fail('no-match', p);
    if (found.occ.length > 1) throw new Fail('ambiguous', p);
    const at = found.occ[0]!;
    const rep = buildReplacement(f.lines, at, block.old, block.new.map((t) => ({ text: t, ctx: null })), found.tier);
    tree.now.set(p, joinFile({ lines: [...f.lines.slice(0, at), ...rep, ...f.lines.slice(at + block.old.length)], br: f.br, final: f.final }));
  };
}

/** V4A patches, SPEC.md section 8. */
interface VChunk {
  anchor: string | null;
  o: string[];
  n: NLine[];
  eof: boolean;
  bodyRaw: string[];
}
interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  lines: string[];
  moveTo: string | null;
  chunks: VChunk[];
}

function buildVChunk(anchor: string | null, body: string[], eof: boolean): VChunk {
  const o: string[] = [];
  const n: NLine[] = [];
  for (const l of body) {
    if (l === '' || l.startsWith(' ')) {
      const text = l === '' ? '' : l.slice(1);
      o.push(text);
      n.push({ text, ctx: o.length - 1 });
    } else if (l.startsWith('-')) {
      o.push(l.slice(1));
    } else if (l.startsWith('+')) {
      n.push({ text: l.slice(1), ctx: null });
    }
  }
  return { anchor, o, n, eof, bodyRaw: [...body] };
}

function parseV4A(lines: string[], maxTier: number): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (l: string): boolean => l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) { i++; continue; }
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice(14).trim();
      i++;
      const fileLines: string[] = [];
      const fromBlank: boolean[] = [];
      while (i < last) {
        const cl = lines[i]!;
        if (isSectionStart(cl)) break;
        if (cl.startsWith('+')) { fileLines.push(cl.slice(1)); fromBlank.push(false); i++; }
        else if (blank(cl)) { fileLines.push(''); fromBlank.push(true); i++; }
        else throw new Exit2(`error: parse ${i + 1}`);
      }
      while (fileLines.length > 0 && fromBlank[fromBlank.length - 1]) { fileLines.pop(); fromBlank.pop(); }
      edits.push(v4aEdit({ kind: 'add', path, lines: fileLines, moveTo: null, chunks: [] }, maxTier));
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const path = l.slice(17).trim();
      i++;
      while (i < last) {
        const cl = lines[i]!;
        if (isSectionStart(cl)) break;
        if (blank(cl)) { i++; continue; }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      edits.push(v4aEdit({ kind: 'delete', path, lines: [], moveTo: null, chunks: [] }, maxTier));
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const path = l.slice(17).trim();
      const updateLine = i + 1;
      i++;
      let moveTo: string | null = null;
      const chunks: VChunk[] = [];
      let cur: { anchor: string | null; body: string[] } | null = null;
      const finish = (eof: boolean): void => {
        if (cur === null) return;
        chunks.push(buildVChunk(cur.anchor, cur.body, eof));
        cur = null;
      };
      while (i < last) {
        const cl = lines[i]!;
        if (isSectionStart(cl)) break;
        if (cl.startsWith('*** Move to: ')) {
          if (cur !== null || chunks.length > 0 || moveTo !== null) throw new Exit2(`error: parse ${i + 1}`);
          moveTo = cl.slice(13).trim();
          i++;
          continue;
        }
        if (cl === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
          finish(true);
          i++;
          continue;
        }
        if (cl.startsWith('@@')) {
          finish(false);
          const anchorText = cl.slice(2).trim();
          cur = { anchor: anchorText === '' ? null : anchorText, body: [] };
          i++;
          continue;
        }
        if (cl === '' || cl.startsWith(' ') || cl.startsWith('-') || cl.startsWith('+')) {
          if (cur === null) {
            if (chunks.length > 0) {
              if (blank(cl)) { i++; continue; }
              throw new Exit2(`error: parse ${i + 1}`);
            }
            cur = { anchor: null, body: [] };
          }
          cur.body.push(cl);
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      finish(false);
      if (chunks.length > 0) {
        const lastCh = chunks[chunks.length - 1]!;
        while (lastCh.bodyRaw.length > 0 && blank(lastCh.bodyRaw[lastCh.bodyRaw.length - 1]!)) lastCh.bodyRaw.pop();
        const rebuilt = buildVChunk(lastCh.anchor, lastCh.bodyRaw, lastCh.eof);
        lastCh.o = rebuilt.o;
        lastCh.n = rebuilt.n;
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      edits.push(v4aEdit({ kind: 'update', path, lines: [], moveTo, chunks }, maxTier));
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  return edits;
}

function applyV4AChunk(f: FileLines, ch: VChunk, cursor: number, maxTier: number, path: string): { f: FileLines; cursor: number } {
  let cur = cursor;
  if (ch.anchor !== null) {
    let foundAt: number | null = null;
    for (let tier = 0; tier <= maxTier && foundAt === null; tier++) {
      for (let k = cur; k < f.lines.length; k++) {
        if (lineEq(f.lines[k]!, ch.anchor, tier)) { foundAt = k; break; }
      }
    }
    if (foundAt === null) throw new Fail('no-match', path);
    cur = foundAt + 1;
  }
  const O = ch.o;
  if (O.length === 0) {
    const pos = ch.eof ? f.lines.length : cur;
    const rep = ch.n.map((l) => l.text);
    return { f: { lines: [...f.lines.slice(0, pos), ...rep, ...f.lines.slice(pos)], br: f.br, final: f.final }, cursor: pos + rep.length };
  }
  let found: { tier: number; pos: number } | null = null;
  for (let tier = 0; tier <= maxTier; tier++) {
    const occ = occurrencesAt(f.lines, O, tier).filter((p) => p >= cur && (!ch.eof || p + O.length === f.lines.length));
    if (occ.length > 0) { found = { tier, pos: occ[0]! }; break; }
  }
  if (found === null) throw new Fail('no-match', path);
  const rep = buildReplacement(f.lines, found.pos, O, ch.n, found.tier);
  return { f: { lines: [...f.lines.slice(0, found.pos), ...rep, ...f.lines.slice(found.pos + O.length)], br: f.br, final: f.final }, cursor: found.pos + rep.length };
}

function v4aEdit(sec: VSection, maxTier: number): Edit {
  return (tree) => {
    if (sec.kind === 'add') {
      const p = sec.path;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, sec.lines.length === 0 ? '' : `${sec.lines.join('\n')}\n`);
      return;
    }
    if (sec.kind === 'delete') {
      const p = sec.path;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const p = sec.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    let f = splitFile(before);
    let cursor = 0;
    for (const ch of sec.chunks) {
      const r = applyV4AChunk(f, ch, cursor, maxTier, p);
      f = r.f;
      cursor = r.cursor;
    }
    const text = joinFile(f);
    if (sec.moveTo !== null) tree.move(p, sec.moveTo, text);
    else tree.now.set(p, text);
  };
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  const maxTier = strict ? 0 : 2;
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, maxTier);
    else if (kind === 'search-replace') edits = parseSR(lines, maxTier);
    else edits = parseV4A(lines, maxTier);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const moveMark = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = moveMark;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: Array<{ key: string; text: string }> = [];
  const movedOld = new Set<string>();
  const movedNew = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (tree.original(oldP) !== null && tree.original(newP) === null && tree.now.get(oldP) === null && tree.now.get(newP) !== null) {
      movedOld.add(oldP);
      movedNew.add(newP);
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
    }
  }
  const sortedPaths = [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  for (const p of sortedPaths) {
    if (movedOld.has(p) || movedNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of sortedPaths) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now || now !== null) continue;
      rmSync(p, { force: true });
    }
    for (const p of sortedPaths) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now || now === null) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
