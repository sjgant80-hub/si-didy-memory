// si-didy-memory · browser adapter
// ◊·κ=φ⁴ · sql.js + IndexedDB persistence · FallMind v2 cube.db compat
// Simon Gant 2026 · PRIVATE · MIT
//
// Loads sql.js from a CDN pin (only the wasm URL is external — no runtime tracking).
// Persists the entire cube.db as a single blob in IndexedDB under key 'cube.db'.
// Same tokens table shape as node:sqlite path · fully interop when synced.

const HIDDEN = 16;
const DEFAULT_K = 20;
const DEFAULT_NAMESPACE = 'work';
const IDB_NAME = 'si-didy-memory';
const IDB_STORE = 'cube';
const IDB_KEY = 'cube.db';

// sql.js pin · vendored CDN URL. Replace with a local wasm for full sovereignty.
const SQLJS_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/sql-wasm.js';
const SQLJS_WASM_LOCATOR = (file) =>
  `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/${file}`;

// ---------------------------------------------------------------------------
// FemtoLLM · faithful vendor · 16-dim
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

async function sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// IndexedDB helpers · single blob persistence
// ---------------------------------------------------------------------------

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet() {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(blob) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(blob, IDB_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbClear() {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(IDB_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---------------------------------------------------------------------------
// sql.js loader · lazy · one shot
// ---------------------------------------------------------------------------

let _sqljsPromise = null;
async function loadSqlJs() {
  if (_sqljsPromise) return _sqljsPromise;
  _sqljsPromise = new Promise((resolve, reject) => {
    if (globalThis.initSqlJs) return resolve(globalThis.initSqlJs);
    const s = document.createElement('script');
    s.src = SQLJS_CDN;
    s.onload = () => resolve(globalThis.initSqlJs);
    s.onerror = () => reject(new Error('sql.js load failed'));
    document.head.appendChild(s);
  }).then((initSqlJs) => initSqlJs({ locateFile: SQLJS_WASM_LOCATOR }));
  return _sqljsPromise;
}

// ---------------------------------------------------------------------------
// Browser SiDidyMemory · same interface as Node version
// ---------------------------------------------------------------------------

export class SiDidyMemory {
  constructor({
    namespace = DEFAULT_NAMESPACE,
    cubeId = 'c1',
    k = DEFAULT_K,
    seed = 42
  } = {}) {
    this.namespace = namespace;
    this.cubeId = cubeId;
    this.k = k;
    this.femto = new FemtoLLM(seed);
    this.SQL = null;
    this.db = null;
    this.stats = { warmups: 0, hits: 0, misses: 0, remembers: 0 };
  }

  async open() {
    if (this.db) return;
    this.SQL = await loadSqlJs();
    const existing = await idbGet();
    if (existing) {
      this.db = new this.SQL.Database(new Uint8Array(existing));
    } else {
      this.db = new this.SQL.Database();
    }
    this.db.run(`
      CREATE TABLE IF NOT EXISTS tokens (
        id TEXT PRIMARY KEY,
        namespace TEXT NOT NULL DEFAULT 'default',
        text TEXT NOT NULL,
        vec BLOB NOT NULL,
        dim INTEGER NOT NULL,
        cube_id TEXT,
        vertex TEXT,
        meta TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_tokens_ns ON tokens(namespace);
      CREATE INDEX IF NOT EXISTS idx_tokens_dim ON tokens(dim);
    `);
    await this._persist();
  }

  async _persist() {
    const bytes = this.db.export();
    await idbPut(bytes);
  }

  async warmUp(taskHints) {
    await this.open();
    const hintText = Array.isArray(taskHints) ? taskHints.join(' · ') : String(taskHints || '');
    const query = this.femto.forward(this.femto.encode(hintText));

    const res = this.db.exec(
      'SELECT id, text, vec, meta, created_at FROM tokens WHERE namespace = ? AND dim = ?',
      [this.namespace, HIDDEN]
    );
    this.stats.warmups++;

    const rows = res[0] ? res[0].values.map((v) => ({
      id: v[0], text: v[1], vec: v[2], meta: v[3], created_at: v[4]
    })) : [];

    if (!rows.length) {
      this.stats.misses++;
      return this._format([], hintText);
    }

    const scored = rows.map((row) => {
      const bytes = row.vec instanceof Uint8Array ? row.vec : new Uint8Array(row.vec);
      const vec = new Float32Array(bytes.buffer, bytes.byteOffset, HIDDEN);
      return { text: row.text, meta: row.meta, score: cosine(query, vec) };
    });
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, this.k).filter((r) => r.score > 0);
    if (top.length) this.stats.hits++; else this.stats.misses++;
    return this._format(top, hintText);
  }

  async remember(prompt, response, meta = {}) {
    await this.open();
    const items = this._summariseTurn(prompt, response);
    for (const s of items) {
      const vec = this.femto.forward(this.femto.encode(s));
      const bytes = new Uint8Array(vec.buffer.slice(vec.byteOffset, vec.byteOffset + vec.byteLength));
      const id = await sha256Hex(this.namespace + '::' + s + '::' + Date.now() + Math.random());
      this.db.run(
        `INSERT OR REPLACE INTO tokens (id, namespace, text, vec, dim, cube_id, vertex, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, this.namespace, s, bytes, HIDDEN, this.cubeId, 'CEN',
         JSON.stringify({ ...meta, source: 'si-didy-memory' })]
      );
      this.stats.remembers++;
    }
    await this._persist();
    return items.length;
  }

  async ingest(text, meta = {}) {
    await this.open();
    const vec = this.femto.forward(this.femto.encode(text));
    const bytes = new Uint8Array(vec.buffer.slice(vec.byteOffset, vec.byteOffset + vec.byteLength));
    const id = await sha256Hex(this.namespace + '::' + text);
    this.db.run(
      `INSERT OR REPLACE INTO tokens (id, namespace, text, vec, dim, cube_id, vertex, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, this.namespace, text, bytes, HIDDEN, this.cubeId, 'CEN',
       JSON.stringify({ ...meta, source: 'ingest' })]
    );
    await this._persist();
    return id;
  }

  count() {
    if (!this.db) return 0;
    const r = this.db.exec('SELECT COUNT(*) FROM tokens WHERE namespace = ?', [this.namespace]);
    return r[0] ? r[0].values[0][0] : 0;
  }

  getStats() {
    const total = this.stats.warmups || 1;
    return { ...this.stats, hitRate: this.stats.hits / total };
  }

  async clear() {
    if (this.db) { this.db.close(); this.db = null; }
    await idbClear();
  }

  async close() {
    if (this.db) { await this._persist(); this.db.close(); this.db = null; }
  }

  _format(items, hintText) {
    if (!items.length) {
      return `<!-- si-didy-memory · warm-up empty · hints="${hintText}" -->\n`;
    }
    const lines = items.map((it, i) =>
      `${String(i + 1).padStart(2, ' ')}. [${it.score.toFixed(3)}] ${trunc(it.text, 180)}`
    );
    return [
      '<!-- si-didy-memory · prior-context block · FallMind v2 cube.db -->',
      `<prior-context origin="fallmind-v2" namespace="${this.namespace}" k="${items.length}" hint="${esc(hintText)}">`,
      ...lines,
      '</prior-context>',
      ''
    ].join('\n');
  }

  _summariseTurn(prompt, response) {
    const out = [];
    const p = String(prompt || '').trim();
    const r = String(response || '').trim();
    if (p) out.push(`Q: ${firstSentence(p)}`);
    if (r) out.push(`A: ${firstSentence(r)}`);
    for (const line of r.split(/\r?\n/)) {
      const m = line.match(/^\s{0,3}#{1,3}\s+(.+)$/);
      if (m) out.push(`# ${m[1].trim()}`);
    }
    for (const line of r.split(/\r?\n/)) {
      const m = line.match(/^\s*[-*]\s+(.+)$/);
      if (m && m[1].length > 8 && m[1].length < 200) out.push(`- ${m[1].trim()}`);
    }
    return dedupe(out).slice(0, 10);
  }
}

function trunc(s, n) { const t = String(s || ''); return t.length <= n ? t : t.slice(0, n - 1) + '…'; }
function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function firstSentence(s) {
  const m = String(s).split(/(?<=[.!?])\s+/)[0] || String(s);
  return trunc(m, 200);
}
function dedupe(arr) {
  const seen = new Set(); const out = [];
  for (const x of arr) if (!seen.has(x)) { seen.add(x); out.push(x); }
  return out;
}

export { FemtoLLM, HIDDEN, cosine };
export default SiDidyMemory;
