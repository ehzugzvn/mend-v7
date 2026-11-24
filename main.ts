// mend v7 — a dispatch-table design.
//
// The tool is built around two tables. FORMAT_PARSERS maps a format name to
// the function that turns patch lines into tagged edit records, and APPLY
// maps an edit record's kind to the function that carries it out. Shared
// helpers (the three-tier line matcher, the file tree, path safety) sit
// behind the tables, so no format or edit kind is routed by a long chain
// of if/else branches.

import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

type Br = '\r\n' | '\n';
type FormatName = 'unified' | 'search-replace' | 'v4a' | 'json';

interface FileDoc {
  lines: string[];
  ends: boolean;
  br: Br;
}

type Op = { t: 'ctx' | 'del' | 'add'; text: string };
interface Hunk { a: number; ops: Op[]; noBreak: boolean; lastPlusNoBreak: boolean }
interface Chunk { anchor: string | null; eof: boolean; ops: Op[] }

type Edit =
  | { kind: 'create'; path: string; text: string }
  | { kind: 'delete'; path: string }
  | { kind: 'unified'; oldPath: string; newPath: string | null; hunks: Hunk[] }
  | { kind: 'sr'; path: string; oldLines: string[]; newLines: string[] }
  | { kind: 'v4a'; path: string; newPath: string | null; chunks: Chunk[] }
  | { kind: 'json-create'; path: string; text: string }
  | { kind: 'json-str-replace'; path: string; oldStr: string; newStr: string }
  | { kind: 'json-insert'; path: string; insertLine: number; newStr: string };

interface Fail { code: string; path: string }

interface State {
  files: Map<string, FileDoc>;
  initial: Map<string, string>;
  moves: { old: string; nw: string }[];
  strict: boolean;
}

class ParseFail extends Error {
  line: number;
  constructor(line: number) {
    super('parse ' + line);
    this.line = line;
  }
}

// A patch's lines: split at \n, one trailing \r removed per line, and the
// empty piece after a final \n dropped.
function splitPatch(text: string): string[] {
  const lines = text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  if (text.endsWith('\n')) lines.pop();
  return lines;
}

function parseFile(text: string): FileDoc {
  if (text === '') return { lines: [], ends: false, br: '\n' };
  const firstNl = text.indexOf('\n');
  const br: Br = firstNl > 0 && text[firstNl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let ends = false;
  if (text.endsWith(br)) {
    parts.pop();
    ends = true;
  }
  return { lines: parts, ends, br };
}

function serialize(doc: FileDoc): string {
  if (doc.lines.length === 0) return '';
  return doc.lines.join(doc.br) + (doc.ends ? doc.br : '');
}

function isSafe(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.' || seg === '..') return false;
  }
  return true;
}

function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function leadingWs(s: string): string {
  const m = s.match(/^[ \t]*/);
  return m === null ? '' : m[0];
}

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

// Every occurrence of O in lines at one tier, starting at or after `from`.
function findOcc(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (normLine(lines[i + j], tier) !== normLine(o[j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

// The first tier (0, then 1, then 2; only 0 when strict) at which O occurs.
function findTier(
  lines: string[],
  o: string[],
  strict: boolean,
  from: number,
): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions = findOcc(lines, o, tier, from);
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

// The lines that replace a matched span: context lines are the file's own
// matched lines; at tier 2 every other new line is re-indented from the
// patch's first-line indent to the file's.
function replaceSegment(lines: string[], pos: number, ops: Op[], tier: number): string[] {
  let firstOld = '';
  for (const op of ops) {
    if (op.t !== 'add') {
      firstOld = op.text;
      break;
    }
  }
  const f = leadingWs(lines[pos] ?? '');
  const p = leadingWs(firstOld);
  const out: string[] = [];
  let j = pos;
  for (const op of ops) {
    if (op.t === 'ctx') {
      out.push(lines[j]);
      j += 1;
    } else if (op.t === 'del') {
      j += 1;
    } else if (tier === 2 && op.text !== '' && op.text.trim() !== '' && op.text.startsWith(p)) {
      out.push(f + op.text.slice(p.length));
    } else {
      out.push(op.text);
    }
  }
  return out;
}

function readTree(dir: string, base: string, out: Map<string, string>): void {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    const rel = base === '' ? ent.name : base + '/' + ent.name;
    if (ent.isDirectory()) readTree(p, rel, out);
    else if (ent.isFile()) out.set(rel, readFileSync(p, 'utf8'));
  }
}

// ---------------------------------------------------------------------------
// Format parsers. Each turns patch lines into tagged edit records.
// ---------------------------------------------------------------------------

function headerPath(line: string): string | null {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab !== -1) p = p.slice(0, tab);
  p = p.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

interface Section {
  pairOld: string | null | undefined;
  pairNew: string | null | undefined;
  hasPair: boolean;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  diffOld: string | undefined;
  diffNew: string | undefined;
  createFlag: boolean;
  delFlag: boolean;
  hunks: Hunk[];
  phase: 'header' | 'hunk' | 'skip';
}

function newSection(diffOld: string | undefined, diffNew: string | undefined): Section {
  return {
    pairOld: undefined,
    pairNew: undefined,
    hasPair: false,
    renameFrom: undefined,
    renameTo: undefined,
    diffOld,
    diffNew,
    createFlag: false,
    delFlag: false,
    hunks: [],
    phase: 'header',
  };
}

function sectionToEdit(sec: Section): Edit | null {
  const oldP = sec.hasPair ? sec.pairOld : (sec.renameFrom ?? sec.diffOld);
  const newP = sec.hasPair ? sec.pairNew : (sec.renameTo ?? sec.diffNew);
  if (sec.createFlag || oldP === null) {
    if (typeof newP !== 'string') return null;
    const plus: string[] = [];
    let lastPlusNoBreak = false;
    for (const h of sec.hunks) {
      for (const op of h.ops) if (op.t === 'add') plus.push(op.text);
      if (h.ops.some((op) => op.t === 'add')) lastPlusNoBreak = h.lastPlusNoBreak;
    }
    const text = plus.length === 0 ? '' : lastPlusNoBreak ? plus.join('\n') : plus.join('\n') + '\n';
    return { kind: 'create', path: newP, text };
  }
  if (sec.delFlag || newP === null) {
    if (typeof oldP !== 'string') return null;
    return { kind: 'delete', path: oldP };
  }
  if (typeof oldP !== 'string' || typeof newP !== 'string') return null;
  if (oldP !== newP) return { kind: 'unified', oldPath: oldP, newPath: newP, hunks: sec.hunks };
  return { kind: 'unified', oldPath: oldP, newPath: null, hunks: sec.hunks };
}

// One hunk starting at lines[i] (a @@ header). Returns the hunk and the
// index of the first line after its body.
function parseHunk(lines: string[], i: number): { hunk: Hunk; next: number } {
  const m = lines[i].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (m === null) throw new ParseFail(i + 1);
  const a = parseInt(m[1], 10);
  const raw: { kind: 'ctx' | 'del' | 'add' | 'bs'; text: string }[] = [];
  let j = i + 1;
  while (j < lines.length) {
    const l = lines[j];
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && j + 1 < lines.length && lines[j + 1].startsWith('+++ ')) break;
    if (l === '') {
      raw.push({ kind: 'ctx', text: '' });
      j += 1;
      continue;
    }
    const c = l[0];
    if (c === ' ') {
      raw.push({ kind: 'ctx', text: l.slice(1) });
      j += 1;
      continue;
    }
    if (c === '-') {
      raw.push({ kind: 'del', text: l.slice(1) });
      j += 1;
      continue;
    }
    if (c === '+') {
      raw.push({ kind: 'add', text: l.slice(1) });
      j += 1;
      continue;
    }
    if (c === '\\') {
      raw.push({ kind: 'bs', text: l.slice(1) });
      j += 1;
      continue;
    }
    break;
  }
  while (raw.length > 0 && raw[raw.length - 1].kind === 'ctx' && raw[raw.length - 1].text === '') raw.pop();
  const ops: Op[] = [];
  for (const r of raw) {
    if (r.kind !== 'bs') ops.push({ t: r.kind, text: r.text });
  }
  // A \ line refers to the body line before it: it cancels the final line
  // break when it follows the hunk's last context or + line (or its last
  // + line, for a creation).
  let noBreak = false;
  let lastPlusNoBreak = false;
  let lastCtxAdd = -1;
  let lastPlus = -1;
  for (let k = 0; k < raw.length; k++) {
    if (raw[k].kind === 'ctx' || raw[k].kind === 'add') lastCtxAdd = k;
    if (raw[k].kind === 'add') lastPlus = k;
  }
  if (lastCtxAdd !== -1 && raw[lastCtxAdd + 1] !== undefined && raw[lastCtxAdd + 1].kind === 'bs') noBreak = true;
  if (lastPlus !== -1 && raw[lastPlus + 1] !== undefined && raw[lastPlus + 1].kind === 'bs') lastPlusNoBreak = true;
  return { hunk: { a, ops, noBreak, lastPlusNoBreak }, next: j };
}

function parseUnified(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let sec: Section | null = null;
  const flush = (): void => {
    if (sec !== null) {
      const e = sectionToEdit(sec);
      if (e !== null) edits.push(e);
      sec = null;
    }
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const m = line.match(/^diff --git a\/(.*) b\/(.*)$/);
      if (m === null) throw new ParseFail(i + 1);
      flush();
      sec = newSection(m[1].trim(), m[2].trim());
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
      if (sec !== null && sec.phase === 'header' && !sec.hasPair) {
        sec.pairOld = headerPath(line);
        sec.pairNew = headerPath(lines[i + 1]);
        sec.hasPair = true;
        i += 2;
        continue;
      }
      flush();
      sec = newSection(undefined, undefined);
      sec.pairOld = headerPath(line);
      sec.pairNew = headerPath(lines[i + 1]);
      sec.hasPair = true;
      i += 2;
      continue;
    }
    if (sec === null) {
      if (line.startsWith('@@')) throw new ParseFail(i + 1);
      i += 1;
      continue;
    }
    if (sec.phase === 'skip') {
      i += 1;
      continue;
    }
    if (sec.phase === 'header') {
      if (line.startsWith('@@')) {
        if (sec.delFlag || sec.pairNew === null) {
          // A deletion's hunks are not read.
          sec.phase = 'skip';
          i += 1;
          continue;
        }
        const h = parseHunk(lines, i);
        sec.hunks.push(h.hunk);
        sec.phase = 'hunk';
        i = h.next;
        continue;
      }
      if (line.startsWith('--- ')) throw new ParseFail(i + 2);
      if (line.startsWith('rename from ')) sec.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) sec.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) sec.createFlag = true;
      else if (line.startsWith('deleted file mode')) sec.delFlag = true;
      i += 1;
      continue;
    }
    // phase 'hunk': another hunk, or prose to ignore.
    if (line.startsWith('@@')) {
      const h = parseHunk(lines, i);
      sec.hunks.push(h.hunk);
      i = h.next;
      continue;
    }
    i += 1;
  }
  flush();
  return edits;
}

function parseSR(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i].trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j > prevReplaceEnd; j--) {
      const t = lines[j].trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new ParseFail(searchLine + 1);
    let k = searchLine + 1;
    while (k < lines.length && lines[k].trimEnd() !== '=======') k += 1;
    if (k >= lines.length) throw new ParseFail(searchLine + 1);
    const eqLine = k;
    k += 1;
    while (k < lines.length && lines[k].trimEnd() !== '>>>>>>> REPLACE') k += 1;
    if (k >= lines.length) throw new ParseFail(searchLine + 1);
    const repLine = k;
    const oldLines = lines.slice(searchLine + 1, eqLine);
    const newLines = lines.slice(eqLine + 1, repLine);
    if (oldLines.length === 0) {
      const text = newLines.length === 0 ? '' : newLines.join('\n') + '\n';
      edits.push({ kind: 'create', path, text });
    } else {
      edits.push({ kind: 'sr', path, oldLines, newLines });
    }
    prevPath = path;
    prevReplaceEnd = repLine;
    i = repLine + 1;
  }
  return edits;
}

function parseV4A(lines: string[]): Edit[] {
  let first = -1;
  let last = -1;
  for (let idx = 0; idx < lines.length; idx++) {
    if (lines[idx].trim() !== '') {
      if (first === -1) first = idx;
      last = idx;
    }
  }
  if (first === -1) throw new ParseFail(1);
  if (lines[first].trim() !== '*** Begin Patch') throw new ParseFail(first + 1);
  if (lines[last].trim() !== '*** End Patch') throw new ParseFail(lines.length + 1);
  const edits: Edit[] = [];
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  let i = first + 1;
  while (i < last) {
    const line = lines[i];
    if (line.trim() === '') {
      i += 1;
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      const body: string[] = [];
      i += 1;
      while (i < last) {
        const l = lines[i];
        if (isSectionStart(l) || l.trim() === '*** End Patch') break;
        if (l === '') {
          body.push('');
          i += 1;
          continue;
        }
        if (l.startsWith('+')) {
          body.push(l.slice(1));
          i += 1;
          continue;
        }
        throw new ParseFail(i + 1);
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      edits.push({ kind: 'create', path, text: body.length === 0 ? '' : body.join('\n') + '\n' });
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      i += 1;
      while (i < last) {
        const l = lines[i];
        if (isSectionStart(l) || l.trim() === '*** End Patch') break;
        if (l.trim() === '') {
          i += 1;
          continue;
        }
        throw new ParseFail(i + 1);
      }
      edits.push({ kind: 'delete', path });
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const path = line.slice('*** Update File: '.length).trim();
      const updateLine = i + 1;
      i += 1;
      let newPath: string | null = null;
      const chunks: Chunk[] = [];
      let cur: Chunk | null = null;
      let atStart = true;
      const closeChunk = (eof: boolean): void => {
        if (cur !== null) {
          cur.eof = eof;
          chunks.push(cur);
          cur = null;
        }
      };
      while (i < last) {
        const l = lines[i];
        if (isSectionStart(l) || l.trim() === '*** End Patch') break;
        if (atStart && l.startsWith('*** Move to: ')) {
          newPath = l.slice('*** Move to: '.length).trim();
          atStart = false;
          i += 1;
          continue;
        }
        if (l.startsWith('@@')) {
          closeChunk(false);
          const anchor = l.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, ops: [] };
          atStart = false;
          i += 1;
          continue;
        }
        if (l.trim() === '*** End of File') {
          if (cur === null) throw new ParseFail(i + 1);
          closeChunk(true);
          i += 1;
          continue;
        }
        if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
          if (cur === null) {
            // Blank lines with no chunk open are not part of any chunk:
            // they are the blank lines at the end of (or between) sections.
            if (l === '') {
              i += 1;
              continue;
            }
            if (chunks.length > 0) throw new ParseFail(i + 1);
            cur = { anchor: null, eof: false, ops: [] };
          }
          atStart = false;
          if (l === '') cur.ops.push({ t: 'ctx', text: '' });
          else if (l[0] === ' ') cur.ops.push({ t: 'ctx', text: l.slice(1) });
          else if (l[0] === '-') cur.ops.push({ t: 'del', text: l.slice(1) });
          else cur.ops.push({ t: 'add', text: l.slice(1) });
          i += 1;
          continue;
        }
        throw new ParseFail(i + 1);
      }
      const hadOpenChunk = cur !== null;
      closeChunk(false);
      if (chunks.length === 0 && newPath === null) throw new ParseFail(updateLine);
      if (hadOpenChunk && chunks.length > 0) {
        const lastChunk = chunks[chunks.length - 1];
        while (lastChunk.ops.length > 0) {
          const o = lastChunk.ops[lastChunk.ops.length - 1];
          if (o.t === 'ctx' && o.text === '') lastChunk.ops.pop();
          else break;
        }
      }
      edits.push({ kind: 'v4a', path, newPath, chunks });
      continue;
    }
    throw new ParseFail(i + 1);
  }
  return edits;
}

function jsonEdit(item: unknown, lineNo: number): Edit {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) throw new ParseFail(lineNo);
  const obj = item as Record<string, unknown>;
  if (typeof obj.path !== 'string') throw new ParseFail(lineNo);
  if (typeof obj.command !== 'string') throw new ParseFail(lineNo);
  const path = obj.path;
  if (obj.command === 'create') {
    if (typeof obj.file_text !== 'string') throw new ParseFail(lineNo);
    return { kind: 'json-create', path, text: obj.file_text };
  }
  if (obj.command === 'str_replace') {
    if (typeof obj.old_str !== 'string' || obj.old_str === '') throw new ParseFail(lineNo);
    let newStr = '';
    if ('new_str' in obj) {
      if (typeof obj.new_str !== 'string') throw new ParseFail(lineNo);
      newStr = obj.new_str;
    }
    return { kind: 'json-str-replace', path, oldStr: obj.old_str, newStr };
  }
  if (obj.command === 'insert') {
    if (!Number.isInteger(obj.insert_line)) throw new ParseFail(lineNo);
    if (typeof obj.new_str !== 'string') throw new ParseFail(lineNo);
    return { kind: 'json-insert', path, insertLine: obj.insert_line as number, newStr: obj.new_str };
  }
  throw new ParseFail(lineNo);
}

function parseJSON(lines: string[], text: string): Edit[] {
  let first = -1;
  for (let idx = 0; idx < lines.length; idx++) {
    if (lines[idx].trim() !== '') {
      first = idx;
      break;
    }
  }
  if (first === -1) throw new ParseFail(1);
  const startLine = first + 1;
  if (lines[first].trimStart().startsWith('[')) {
    let arr: unknown;
    try {
      arr = JSON.parse(text);
    } catch {
      throw new ParseFail(startLine);
    }
    if (!Array.isArray(arr)) throw new ParseFail(startLine);
    const edits: Edit[] = [];
    for (const item of arr) edits.push(jsonEdit(item, startLine));
    if (edits.length === 0) throw new ParseFail(1);
    return edits;
  }
  const edits: Edit[] = [];
  for (let idx = 0; idx < lines.length; idx++) {
    if (lines[idx].trim() === '') continue;
    let obj: unknown;
    try {
      obj = JSON.parse(lines[idx]);
    } catch {
      throw new ParseFail(idx + 1);
    }
    edits.push(jsonEdit(obj, idx + 1));
  }
  if (edits.length === 0) throw new ParseFail(1);
  return edits;
}

const FORMAT_PARSERS: Record<FormatName, (lines: string[], text: string) => Edit[]> = {
  unified: (lines) => parseUnified(lines),
  'search-replace': (lines) => parseSR(lines),
  v4a: (lines) => parseV4A(lines),
  json: (lines, text) => parseJSON(lines, text),
};

function detectFormat(lines: string[]): FormatName | null {
  let first = -1;
  for (let idx = 0; idx < lines.length; idx++) {
    if (lines[idx].trim() !== '') {
      first = idx;
      break;
    }
  }
  if (first === -1) return null;
  if (lines[first].trim() === '*** Begin Patch') return 'v4a';
  const head = lines[first].trimStart();
  if (head.startsWith('[') || head.startsWith('{')) return 'json';
  for (const l of lines) {
    if (l.trimEnd() === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let idx = 0; idx < lines.length; idx++) {
    if (lines[idx].startsWith('diff --git ')) return 'unified';
    if (lines[idx].startsWith('--- ') && idx + 1 < lines.length && lines[idx + 1].startsWith('+++ ')) return 'unified';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Appliers. Each takes the state and one tagged edit record, mutates the
// in-memory tree only on success, and returns a failure or null.
// ---------------------------------------------------------------------------

function checkSafe(path: string): Fail | null {
  return isSafe(path) ? null : { code: 'unsafe', path };
}

function applyCreate(st: State, e: Extract<Edit, { kind: 'create' }>): Fail | null {
  const bad = checkSafe(e.path);
  if (bad !== null) return bad;
  if (st.files.has(e.path)) return { code: 'exists', path: e.path };
  st.files.set(e.path, parseFile(e.text));
  return null;
}

function applyDelete(st: State, e: Extract<Edit, { kind: 'delete' }>): Fail | null {
  const bad = checkSafe(e.path);
  if (bad !== null) return bad;
  if (!st.files.has(e.path)) return { code: 'missing', path: e.path };
  st.files.delete(e.path);
  return null;
}

function applyUnified(st: State, e: Extract<Edit, { kind: 'unified' }>): Fail | null {
  const bad = checkSafe(e.oldPath) ?? (e.newPath !== null ? checkSafe(e.newPath) : null);
  if (bad !== null) return bad;
  const doc = st.files.get(e.oldPath);
  if (doc === undefined) return { code: 'missing', path: e.oldPath };
  if (e.newPath !== null && st.files.has(e.newPath)) return { code: 'exists', path: e.newPath };
  let lines = [...doc.lines];
  let ends = doc.ends;
  let d = 0;
  for (const h of e.hunks) {
    const oLen = h.ops.filter((op) => op.t !== 'add').length;
    const nLen = h.ops.filter((op) => op.t !== 'del').length;
    const o = h.ops.filter((op) => op.t !== 'add').map((op) => op.text);
    if (o.length > 0) {
      const found = findTier(lines, o, st.strict, 0);
      if (found === null) return { code: 'no-match', path: e.oldPath };
      const target = h.a - 1 + d;
      let best = found.positions[0];
      let bestDist = Math.abs(best - target);
      for (const p of found.positions) {
        const dist = Math.abs(p - target);
        if (dist < bestDist) {
          best = p;
          bestDist = dist;
        }
      }
      const seg = replaceSegment(lines, best, h.ops, found.tier);
      const runsToEnd = best + o.length === lines.length;
      lines = [...lines.slice(0, best), ...seg, ...lines.slice(best + o.length)];
      if (runsToEnd) ends = !h.noBreak;
    } else {
      const preLen = lines.length;
      const at = Math.min(h.a + d, preLen);
      const ins = h.ops.filter((op) => op.t === 'add').map((op) => op.text);
      lines = [...lines.slice(0, at), ...ins, ...lines.slice(at)];
      if (at === preLen) ends = !h.noBreak;
    }
    d += nLen - oLen;
  }
  const out: FileDoc = { lines, ends, br: doc.br };
  if (e.newPath !== null) {
    st.files.delete(e.oldPath);
    st.files.set(e.newPath, out);
    st.moves.push({ old: e.oldPath, nw: e.newPath });
  } else {
    st.files.set(e.oldPath, out);
  }
  return null;
}

function applySR(st: State, e: Extract<Edit, { kind: 'sr' }>): Fail | null {
  const bad = checkSafe(e.path);
  if (bad !== null) return bad;
  const doc = st.files.get(e.path);
  if (doc === undefined) return { code: 'missing', path: e.path };
  const found = findTier(doc.lines, e.oldLines, st.strict, 0);
  if (found === null) return { code: 'no-match', path: e.path };
  if (found.positions.length > 1) return { code: 'ambiguous', path: e.path };
  const ops: Op[] = [
    ...e.oldLines.map((t): Op => ({ t: 'del', text: t })),
    ...e.newLines.map((t): Op => ({ t: 'add', text: t })),
  ];
  const pos = found.positions[0];
  const seg = replaceSegment(doc.lines, pos, ops, found.tier);
  const lines = [...doc.lines.slice(0, pos), ...seg, ...doc.lines.slice(pos + e.oldLines.length)];
  st.files.set(e.path, { lines, ends: doc.ends, br: doc.br });
  return null;
}

function applyV4A(st: State, e: Extract<Edit, { kind: 'v4a' }>): Fail | null {
  const bad = checkSafe(e.path) ?? (e.newPath !== null ? checkSafe(e.newPath) : null);
  if (bad !== null) return bad;
  const doc = st.files.get(e.path);
  if (doc === undefined) return { code: 'missing', path: e.path };
  if (e.newPath !== null && st.files.has(e.newPath)) return { code: 'exists', path: e.newPath };
  let lines = [...doc.lines];
  let cursor = 0;
  for (const chunk of e.chunks) {
    if (chunk.anchor !== null) {
      const found = findTier(lines, [chunk.anchor], st.strict, cursor);
      if (found === null) return { code: 'no-match', path: e.path };
      cursor = found.positions[0] + 1;
    }
    const o = chunk.ops.filter((op) => op.t !== 'add').map((op) => op.text);
    if (o.length > 0) {
      const found = findTier(lines, o, st.strict, cursor);
      if (found === null) return { code: 'no-match', path: e.path };
      let pos = found.positions[0];
      if (chunk.eof) {
        const ok = found.positions.find((p) => p + o.length === lines.length);
        if (ok === undefined) return { code: 'no-match', path: e.path };
        pos = ok;
      }
      const seg = replaceSegment(lines, pos, chunk.ops, found.tier);
      lines = [...lines.slice(0, pos), ...seg, ...lines.slice(pos + o.length)];
      cursor = pos + seg.length;
    } else {
      const at = chunk.eof ? lines.length : cursor;
      const ins = chunk.ops.filter((op) => op.t === 'add').map((op) => op.text);
      lines = [...lines.slice(0, at), ...ins, ...lines.slice(at)];
      cursor = at + ins.length;
    }
  }
  const out: FileDoc = { lines, ends: doc.ends, br: doc.br };
  if (e.newPath !== null) {
    st.files.delete(e.path);
    st.files.set(e.newPath, out);
    st.moves.push({ old: e.path, nw: e.newPath });
  } else {
    st.files.set(e.path, out);
  }
  return null;
}

function applyJsonCreate(st: State, e: Extract<Edit, { kind: 'json-create' }>): Fail | null {
  const bad = checkSafe(e.path);
  if (bad !== null) return bad;
  if (st.files.has(e.path)) return { code: 'exists', path: e.path };
  st.files.set(e.path, parseFile(e.text));
  return null;
}

function countOccurrences(text: string, sub: string): number {
  let n = 0;
  let idx = 0;
  for (;;) {
    const at = text.indexOf(sub, idx);
    if (at === -1) return n;
    n += 1;
    idx = at + 1;
  }
}

function applyJsonStrReplace(st: State, e: Extract<Edit, { kind: 'json-str-replace' }>): Fail | null {
  const bad = checkSafe(e.path);
  if (bad !== null) return bad;
  const doc = st.files.get(e.path);
  if (doc === undefined) return { code: 'missing', path: e.path };
  const text = serialize(doc);
  let hay = text;
  let oldStr = e.oldStr;
  let newStr = e.newStr;
  if (doc.br === '\r\n') {
    hay = text.replaceAll('\r\n', '\n');
    oldStr = oldStr.replaceAll('\r\n', '\n');
    newStr = newStr.replaceAll('\r\n', '\n');
  }
  const n = countOccurrences(hay, oldStr);
  if (n === 0) return { code: 'no-match', path: e.path };
  if (n > 1) return { code: 'ambiguous', path: e.path };
  let replaced = hay.replace(oldStr, newStr);
  if (doc.br === '\r\n') replaced = replaced.replaceAll('\n', '\r\n');
  st.files.set(e.path, parseFile(replaced));
  return null;
}

function applyJsonInsert(st: State, e: Extract<Edit, { kind: 'json-insert' }>): Fail | null {
  const bad = checkSafe(e.path);
  if (bad !== null) return bad;
  const doc = st.files.get(e.path);
  if (doc === undefined) return { code: 'missing', path: e.path };
  if (e.insertLine < 0 || e.insertLine > doc.lines.length) return { code: 'no-match', path: e.path };
  const ins = e.newStr === '' ? [] : splitPatch(e.newStr);
  const lines = [...doc.lines.slice(0, e.insertLine), ...ins, ...doc.lines.slice(e.insertLine)];
  st.files.set(e.path, { lines, ends: doc.ends, br: doc.br });
  return null;
}

const APPLY: Record<Edit['kind'], (st: State, e: Edit) => Fail | null> = {
  create: (st, e) => applyCreate(st, e as Extract<Edit, { kind: 'create' }>),
  delete: (st, e) => applyDelete(st, e as Extract<Edit, { kind: 'delete' }>),
  unified: (st, e) => applyUnified(st, e as Extract<Edit, { kind: 'unified' }>),
  sr: (st, e) => applySR(st, e as Extract<Edit, { kind: 'sr' }>),
  v4a: (st, e) => applyV4A(st, e as Extract<Edit, { kind: 'v4a' }>),
  'json-create': (st, e) => applyJsonCreate(st, e as Extract<Edit, { kind: 'json-create' }>),
  'json-str-replace': (st, e) => applyJsonStrReplace(st, e as Extract<Edit, { kind: 'json-str-replace' }>),
  'json-insert': (st, e) => applyJsonInsert(st, e as Extract<Edit, { kind: 'json-insert' }>),
};

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usageError(): never {
  process.stdout.write('error: usage\n');
  process.exitCode = 2;
  throw new Error('usage');
}

function main(argv: string[]): void {
  let format: FormatName | 'auto' = 'auto';
  let check = false;
  let strict = false;
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  let endOpts = false;
  const positionals: string[] = [];
  for (const arg of argv) {
    if (!endOpts && arg === '--') {
      endOpts = true;
      continue;
    }
    if (!endOpts && arg.startsWith('-') && arg !== '-') {
      if (arg.startsWith('--format=')) {
        if (seenFormat) usageError();
        seenFormat = true;
        const v = arg.slice('--format='.length);
        if (v !== 'unified' && v !== 'search-replace' && v !== 'v4a' && v !== 'json' && v !== 'auto') usageError();
        format = v;
      } else if (arg === '--check') {
        if (seenCheck) usageError();
        seenCheck = true;
        check = true;
      } else if (arg === '--strict') {
        if (seenStrict) usageError();
        seenStrict = true;
        strict = true;
      } else {
        usageError();
      }
    } else {
      positionals.push(arg);
    }
  }
  if (positionals.length > 1) usageError();

  let patchText: string;
  if (positionals.length === 0 || positionals[0] === '-') {
    patchText = readFileSync(0, 'utf8');
  } else {
    try {
      patchText = readFileSync(positionals[0], 'utf8');
    } catch {
      process.stdout.write('error: no-patch\n');
      process.exitCode = 2;
      return;
    }
  }

  const lines = splitPatch(patchText);
  const fmt: FormatName | null = format === 'auto' ? detectFormat(lines) : format;
  if (fmt === null) {
    process.stdout.write('error: format\n');
    process.exitCode = 2;
    return;
  }
  let edits: Edit[];
  try {
    edits = FORMAT_PARSERS[fmt](lines, patchText);
    if (edits.length === 0) throw new ParseFail(1);
  } catch (err) {
    if (err instanceof ParseFail) {
      process.stdout.write('error: parse ' + err.line + '\n');
      process.exitCode = 2;
      return;
    }
    throw err;
  }

  const initial = new Map<string, string>();
  readTree('.', '', initial);
  const st: State = { files: new Map(), initial, moves: [], strict };
  for (const [p, text] of initial) st.files.set(p, parseFile(text));

  const failures: Fail[] = [];
  for (const e of edits) {
    const fail = APPLY[e.kind](st, e);
    if (fail !== null) failures.push(fail);
  }
  if (failures.length > 0) {
    const out = failures.map((f) => 'error: ' + f.code + ' ' + f.path).join('\n');
    process.stdout.write(out + '\nfailed: ' + failures.length + ' of ' + edits.length + ' edits\n');
    process.exitCode = 1;
    return;
  }

  const finalTexts = new Map<string, string>();
  for (const [p, doc] of st.files) finalTexts.set(p, serialize(doc));
  const changed: { key: string; line: string }[] = [];
  const suppressed = new Set<string>();
  for (const m of st.moves) {
    if (initial.has(m.old) && !finalTexts.has(m.old) && !initial.has(m.nw) && finalTexts.has(m.nw)) {
      changed.push({ key: m.nw, line: 'R ' + m.old + ' -> ' + m.nw });
      suppressed.add(m.old);
      suppressed.add(m.nw);
    }
  }
  for (const p of new Set([...initial.keys(), ...finalTexts.keys()])) {
    const before = initial.get(p);
    const after = finalTexts.get(p);
    if (before === after) continue;
    if (suppressed.has(p)) continue;
    if (before === undefined) changed.push({ key: p, line: 'A ' + p });
    else if (after === undefined) changed.push({ key: p, line: 'D ' + p });
    else changed.push({ key: p, line: 'M ' + p });
  }
  changed.sort((a, b) => byteCompare(a.key, b.key));

  if (!check) {
    for (const [p, after] of finalTexts) {
      if (initial.get(p) !== after) {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, after);
      }
    }
    for (const p of initial.keys()) {
      if (!finalTexts.has(p)) unlinkSync(p);
    }
  }
  const outLines = changed.map((c) => c.line);
  outLines.push('ok: ' + changed.length + (changed.length === 1 ? ' file' : ' files'));
  process.stdout.write(outLines.join('\n') + '\n');
  process.exitCode = 0;
}

// Trial hand-over: when the kit runs a trial, hand control to its runner.
const envUrl = process.env.MAKEFUN_ENV_URL;
if (typeof envUrl === 'string' && envUrl !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(envUrl);
} else {
  try {
    main(process.argv.slice(2));
  } catch (err) {
    if (err instanceof Error && err.message === 'usage') {
      // usageError already wrote the line and set the exit code.
    } else {
      throw err;
    }
  }
}
