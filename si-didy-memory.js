// si-didy-memory · L1 upgrade for NiceAssOS
// ◊·κ=φ⁴ · FallMind v2 boot-time context load · 16-dim FemtoLLM cosine NN
// Simon Gant 2026 · PRIVATE · MIT
//
// Purpose: on si-didy boot, load prior-context tokens from fallmind-v2's cube.db
// keyed on the current task hints. Prepend as warm-context to first Claude message.
// Zero-cost multi-day workflow continuity.
//
// Architecture faithful to teslasolar/MianoCube · Thomas Frumkin.
// Falls through node:sqlite → better-sqlite3 → sql.js (browser) automatically.

const HIDDEN = 16;
const DEFAULT_K = 20;
const DEFAULT_NAMESPACE = 'work';

// ---------------------------------------------------------------------------
// 16-dim FemtoLLM · faithful vendor from fallmind-v2/core_femtollm.js
// Same shape: encode → first HIDDEN chars, ord/128 · deterministic PRNG init.
// ---------------------------------------------------------------------------

class FemtoLLM {
  constructor(seed = 42) {
    const rng = mulberry32(seed >>> 0);
    this.W = new Float32Array(HIDDEN * HIDDEN);
    this.b = new Float32Array(HIDDEN);
    for (let i = 0; i < this.W.length; i++) this.W[i] = (rng() * 2 - 1) * 0.1;
  }

  encode(text) {
    const vec = new Float32Array(HIDDEN);
    const t = String(text || '');
    const n = Math.min(t.length, HIDDEN);
    for (let i = 0; i < n; i++) vec[i] = t.charCodeAt(i) / 128.0;
    return vec;
  }

  forward(x) {
    const y = new Float32Array(HIDDEN);
    for (let i = 0; i < HIDDEN; i++) {
      let sum = this.b[i];
      const row = i * HIDDEN;
      for (let j = 0; j < HIDDEN; j++) sum += this.W[row + j] * x[j];
      y[i] = Math.tanh(sum);
    }
    return y;
  }
}

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6D2B79F5) | 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Cosine similarity over Float32Array vectors (dim=HIDDEN)
// ---------------------------------------------------------------------------

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

// Buffer → Float32Array (handles Node Buffer, Uint8Array, ArrayBuffer)
function bufToFloat32(buf) {
  if (buf instanceof Float32Array) return buf;
  if (buf && buf.buffer) {
    return new Float32Array(buf.buffer, buf.byteOffset || 0, Math.floor(buf.byteLength / 4));
  }
  if (buf instanceof ArrayBuffer) return new Float32Array(buf);
  return new Float32Array(0);
}

// Float32Array → Buffer for BLOB storage
function float32ToBuf(vec) {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
  }
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
}

// sha256 → hex id (works in Node + browser via subtle crypto)
async function sha256Hex(text) {
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle) {
    const bytes = new TextEncoder().encode(text);
    const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(hash))
      .map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  // Node fallback
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(text).digest('hex');
}

// ---------------------------------------------------------------------------
// SQLite driver auto-detect · node:sqlite (Node 22.5+) → better-sqlite3 → sql.js
// ---------------------------------------------------------------------------

async function openDb(dbPath) {
  // Try node:sqlite (built-in)
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(dbPath);
    return { kind: 'node-sqlite', db };
  } catch (_) { /* fall through */ }

  // Try better-sqlite3
  try {
    const Better = (await import('better-sqlite3')).default;
    const db = new Better(dbPath);
    return { kind: 'better-sqlite3', db };
  } catch (_) { /* fall through */ }

  // sql.js browser path handled separately in browser-adapter.js
  throw new Error(
    'si-didy-memory: no SQLite driver available. ' +
    'Need Node 22.5+ (node:sqlite) or `npm i better-sqlite3`. ' +
    'For browsers use browser-adapter.js (sql.js + IndexedDB).'
  );
}

function schemaBootstrap(handle) {
  const stmt = `
    CREATE TABLE IF NOT EXISTS tokens (
      id          TEXT PRIMARY KEY,
      namespace   TEXT NOT NULL DEFAULT 'default',
      text        TEXT NOT NULL,
      vec         BLOB NOT NULL,
      dim         INTEGER NOT NULL,
      cube_id     TEXT,
      vertex      TEXT,
      meta        TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tokens_ns ON tokens(namespace);
    CREATE INDEX IF NOT EXISTS idx_tokens_dim ON tokens(dim);
  `;
  if (handle.kind === 'node-sqlite') {
    handle.db.exec(stmt);
  } else if (handle.kind === 'better-sqlite3') {
    handle.db.exec(stmt);
  }
}

function selectTokens(handle, namespace, dim) {
  const sql = 'SELECT id, text, vec, meta, created_at FROM tokens WHERE namespace = ? AND dim = ?';
  if (handle.kind === 'node-sqlite') {
    return handle.db.prepare(sql).all(namespace, dim);
  }
  return handle.db.prepare(sql).all(namespace, dim);
}

function insertToken(handle, row) {
  const sql = `
    INSERT OR REPLACE INTO tokens (id, namespace, text, vec, dim, cube_id, vertex, meta)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `;
  const args = [
    row.id, row.namespace, row.text, row.vec, row.dim,
    row.cube_id || null, row.vertex || null, row.meta || null
  ];
  if (handle.kind === 'node-sqlite') {
    handle.db.prepare(sql).run(...args);
  } else {
    handle.db.prepare(sql).run(...args);
  }
}

function countTokens(handle, namespace) {
  const sql = 'SELECT COUNT(*) as n FROM tokens WHERE namespace = ?';
  if (handle.kind === 'node-sqlite') {
    return handle.db.prepare(sql).get(namespace).n;
  }
  return handle.db.prepare(sql).get(namespace).n;
}

// ---------------------------------------------------------------------------
// SiDidyMemory · public class
// ---------------------------------------------------------------------------

export class SiDidyMemory {
  /**
   * @param {object} opts
   * @param {string} [opts.dbPath='./cube.db']
   * @param {string} [opts.namespace='work']
   * @param {string} [opts.cubeId='c1']
   * @param {number} [opts.k=20]
   * @param {number} [opts.seed=42]
   */
  constructor({
    dbPath = './cube.db',
    namespace = DEFAULT_NAMESPACE,
    cubeId = 'c1',
    k = DEFAULT_K,
    seed = 42
  } = {}) {
    this.dbPath = dbPath;
    this.namespace = namespace;
    this.cubeId = cubeId;
    this.k = k;
    this.femto = new FemtoLLM(seed);
    this.handle = null;
    this.stats = { warmups: 0, hits: 0, misses: 0, remembers: 0 };
  }

  async open() {
    if (this.handle) return;
    this.handle = await openDb(this.dbPath);
    schemaBootstrap(this.handle);
  }

  /**
   * Warm-up: encode task hints, brute-force cosine NN, format context.
   * @param {string|string[]} taskHints
   * @returns {Promise<string>} formatted "prior context" block for prepending
   */
  async warmUp(taskHints) {
    await this.open();
    const hintText = Array.isArray(taskHints) ? taskHints.join(' · ') : String(taskHints || '');
    const query = this.femto.forward(this.femto.encode(hintText));

    const rows = selectTokens(this.handle, this.namespace, HIDDEN);
    this.stats.warmups++;

    if (!rows.length) {
      this.stats.misses++;
      return this._formatContext([], hintText);
    }

    const scored = rows.map((row) => {
      const vec = bufToFloat32(row.vec);
      return {
        id: row.id,
        text: row.text,
        meta: row.meta,
        created_at: row.created_at,
        score: cosine(query, vec)
      };
    });

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, this.k).filter((r) => r.score > 0);
    if (top.length) this.stats.hits++; else this.stats.misses++;

    return this._formatContext(top, hintText);
  }

  /**
   * Remember: summarise (prompt, response) as short tokens, write to cube.db.
   * @param {string} prompt
   * @param {string} response
   * @param {object} [meta]
   */
  async remember(prompt, response, meta = {}) {
    await this.open();
    const summaries = this._summariseTurn(prompt, response);
    for (const s of summaries) {
      const vec = this.femto.forward(this.femto.encode(s));
      const id = await sha256Hex(this.namespace + '::' + s + '::' + Date.now());
      insertToken(this.handle, {
        id,
        namespace: this.namespace,
        text: s,
        vec: float32ToBuf(vec),
        dim: HIDDEN,
        cube_id: this.cubeId,
        vertex: 'CEN',
        meta: JSON.stringify({ ...meta, source: 'si-didy-memory' })
      });
      this.stats.remembers++;
    }
    return summaries.length;
  }

  /**
   * Direct ingest for a single explicit token · used by dashboard "seed" button.
   * @param {string} text
   * @param {object} [meta]
   */
  async ingest(text, meta = {}) {
    await this.open();
    const vec = this.femto.forward(this.femto.encode(text));
    const id = await sha256Hex(this.namespace + '::' + text);
    insertToken(this.handle, {
      id,
      namespace: this.namespace,
      text,
      vec: float32ToBuf(vec),
      dim: HIDDEN,
      cube_id: this.cubeId,
      vertex: 'CEN',
      meta: JSON.stringify({ ...meta, source: 'ingest' })
    });
    return id;
  }

  count() {
    if (!this.handle) return 0;
    return countTokens(this.handle, this.namespace);
  }

  getStats() {
    const total = this.stats.warmups || 1;
    return { ...this.stats, hitRate: this.stats.hits / total };
  }

  async close() {
    if (!this.handle) return;
    try { this.handle.db.close(); } catch (_) {}
    this.handle = null;
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  _formatContext(items, hintText) {
    if (!items.length) {
      return `<!-- si-didy-memory · warm-up empty · hints="${hintText}" -->\n`;
    }
    const lines = items.map((it, i) =>
      `${String(i + 1).padStart(2, ' ')}. [${it.score.toFixed(3)}] ${truncate(it.text, 180)}`
    );
    return [
      '<!-- si-didy-memory · prior-context block · FallMind v2 cube.db -->',
      `<prior-context origin="fallmind-v2" namespace="${this.namespace}" k="${items.length}" hint="${escape(hintText)}">`,
      ...lines,
      '</prior-context>',
      ''
    ].join('\n');
  }

  _summariseTurn(prompt, response) {
    // Cheap summarisation: pull first sentence of each, plus any header lines.
    // Faithful to fallmind-v2 tokens table shape · one summary = one row.
    const out = [];
    const p = String(prompt || '').trim();
    const r = String(response || '').trim();
    if (p) out.push(`Q: ${firstSentence(p)}`);
    if (r) out.push(`A: ${firstSentence(r)}`);
    // Also capture any markdown headers from response
    for (const line of r.split(/\r?\n/)) {
      const m = line.match(/^\s{0,3}#{1,3}\s+(.+)$/);
      if (m) out.push(`# ${m[1].trim()}`);
    }
    // Bullet takeaways
    for (const line of r.split(/\r?\n/)) {
      const m = line.match(/^\s*[-*]\s+(.+)$/);
      if (m && m[1].length > 8 && m[1].length < 200) out.push(`- ${m[1].trim()}`);
    }
    return dedupe(out).slice(0, 10);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(s, n) {
  const t = String(s || '');
  return t.length <= n ? t : t.slice(0, n - 1) + '…';
}

function escape(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function firstSentence(s) {
  const m = String(s).split(/(?<=[.!?])\s+/)[0] || String(s);
  return truncate(m, 200);
}

function dedupe(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    if (!seen.has(x)) { seen.add(x); out.push(x); }
  }
  return out;
}

// Named + default export for maximum consumer flexibility
export { FemtoLLM, HIDDEN, cosine };
export default SiDidyMemory;
