# si-didy-memory — design specification

Status: Accepted
Spec version: 1.0.0
Applies to: `si-didy-memory` v1.0.0

A boot-time context-warming module: encode the current task hints, run a
brute-force cosine nearest-neighbour scan over a token store, and return the
best prior tokens as a text block to prepend to the first model message. This
document records the data model, algorithms, invariants, public API,
determinism guarantees, and versioning policy so the implementation can be
assessed against a written intent rather than a discarded prompt.

## 1. Purpose

Each new session starts without prior working context. This module retrieves
the most relevant previously stored tokens for a given set of task hints and
formats them as a `<prior-context>` block, so continuity is restored without
re-deriving it turn by turn.

Two operations make up the loop:

- `warmUp(taskHints)` — read path. Encode hints, score every candidate token,
  return the top matches formatted for prepending.
- `remember(prompt, response)` — write path. Compress a completed turn into
  short token rows and persist them for future warm-ups.

## 2. Data model

Tokens live in a single SQLite table. The implementation in
[`si-didy-memory.js`](si-didy-memory.js) bootstraps it if absent:

```sql
tokens (
  id          TEXT PRIMARY KEY,   -- sha256 hex identity (see §5)
  namespace   TEXT NOT NULL,      -- logical partition, default 'work'
  text        TEXT NOT NULL,      -- the stored token text
  vec         BLOB NOT NULL,      -- Float32Array, dim * 4 bytes, little-endian
  dim         INTEGER NOT NULL,   -- vector width; always HIDDEN (16)
  cube_id     TEXT,               -- store grouping tag
  vertex      TEXT,               -- optional positional tag
  meta        TEXT,               -- JSON blob of provenance
  created_at  TEXT NOT NULL       -- datetime('now') default
)
```

`vec` is the raw little-endian byte image of a `Float32Array` of length `dim`.
Read back, `dim * 4` bytes reinterpret to the identical vector, so a store
written by one process is queryable by another that agrees on this layout. The
browser build in [`browser-adapter.js`](browser-adapter.js) uses the same
schema over sql.js + IndexedDB, so a store can move between the two.

Indexes on `namespace` and `dim` keep the candidate scan scoped to comparable
rows.

## 3. The encoder (FemtoLLM)

A fixed 16-dimension encoder (`HIDDEN = 16`). Two stages:

1. `encode(text)` — the first `HIDDEN` characters of the input map to
   `charCode / 128` in successive vector slots; unfilled slots stay `0`. Input
   longer than `HIDDEN` characters is truncated; an empty string yields the
   zero vector.
2. `forward(x)` — a single dense layer `tanh(W·x + b)`, where `W` and `b` are
   filled once from a seeded `mulberry32` PRNG at construction.

Because the weights are seeded and the arithmetic is pure, the same
`(seed, text)` pair always produces the same vector, on any machine.

## 4. Retrieval

`warmUp` scores each candidate token by cosine similarity between the query
vector and the token's stored vector:

```
cosine(a, b) = (a · b) / (|a| · |b|)   with a guard: 0 when either norm is 0
```

Candidates are the rows matching `(namespace, dim = HIDDEN)`. They are scored,
sorted descending, sliced to `k`, and filtered to strictly positive scores.
The scan is exhaustive (no index over `vec`): at working-memory scale a full
pass is simpler and dependency-free, and the schema is unchanged if an
approximate index is added later.

## 5. Identity and idempotence

- `ingest(text)` derives `id = sha256(namespace + '::' + text)`. Re-ingesting
  the same text under the same namespace produces the same id, and the
  `INSERT OR REPLACE` write keeps a single row — ingest is idempotent per
  `(namespace, text)`.
- `remember(prompt, response)` derives ids that also fold in a timestamp, so
  repeated turns are recorded as distinct rows rather than collapsed.

## 6. Public API

Exported from the module entry:

| Symbol | Kind | Contract |
|---|---|---|
| `SiDidyMemory` (default) | class | The store. Construct with `{ dbPath, namespace, cubeId, k, seed }`. |
| `FemtoLLM` | class | `encode(text) -> Float32Array(16)`, `forward(x) -> Float32Array(16)`. |
| `HIDDEN` | const | `16`, the model and vector width. |
| `cosine` | fn | `cosine(a, b) -> number` in `[-1, 1]`, `0` if either norm is `0`. |

`SiDidyMemory` methods:

- `open()` — resolve a SQLite driver and bootstrap the schema. Idempotent.
- `warmUp(taskHints)` — `Promise<string>`; the block to prepend (or an
  empty-context comment when nothing scores positive).
- `remember(prompt, response, meta?)` — `Promise<number>`; rows written.
- `ingest(text, meta?)` — `Promise<string>`; the row id.
- `count()` — rows in the active namespace.
- `getStats()` — counters plus `hitRate = hits / warmups`.
- `close()` — release the driver handle.

Driver resolution order: `node:sqlite` (Node >= 22.5), then `better-sqlite3`,
then a thrown error directing browser callers to the adapter build.

## 7. Invariants

1. `HIDDEN === 16`, and every stored vector has `dim === HIDDEN`.
2. `encode` is deterministic and total; output length is always `HIDDEN`.
3. `forward` is deterministic per seed; every component lies in `(-1, 1)`.
4. `cosine(v, v) === 1` for any non-zero `v`; `cosine` returns `0` whenever
   either input has zero norm.
5. `ingest` is idempotent per `(namespace, text)`.
6. `warmUp` never returns negative-scored tokens, and returns at most `k` rows.
7. The `vec` BLOB round-trips: bytes written equal bytes read, so a retrieved
   token scores `1.000` against a query encoding the same text.

The suite in [`test.mjs`](test.mjs) exercises invariants 1–7 against observed
return values.

## 8. Determinism

Given a fixed seed and a fixed store, `warmUp` is a pure function of its input:
same hints and same rows yield the same block and the same scores. This is what
makes the retrieval reproducible and the tests exact.

## 9. Versioning

This spec is versioned independently of the code and tracks it by semver. A
change to the schema, the encoder arithmetic, the scoring rule, or any method
contract is a breaking change: bump the major version here and in
[`package.json`](package.json). Additive, backward-compatible changes bump the
minor version.

## 10. Non-goals

- Not an approximate-nearest-neighbour index; the scan is exhaustive by design.
- Not a general vector database; it is a single-table working-memory store.
- No network transport; persistence is a local SQLite file or IndexedDB.
