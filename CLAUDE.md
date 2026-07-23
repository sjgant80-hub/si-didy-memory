# CLAUDE.md — agent working notes for si-didy-memory

Guidance for an AI agent editing this repository. Full design rationale lives in
[`SPEC.md`](SPEC.md).

## What this is

A boot-time context-warming module. It encodes task-hint text through a fixed
16-dimension encoder, runs an exhaustive cosine nearest-neighbour scan over a
SQLite token store, and returns the best prior tokens as a `<prior-context>`
text block to prepend to the first model message. The reverse path,
`remember`, compresses a completed turn back into token rows.

- [`si-didy-memory.js`](si-didy-memory.js) — Node entry. Driver auto-detect:
  `node:sqlite` then `better-sqlite3`.
- [`browser-adapter.js`](browser-adapter.js) — browser build over sql.js +
  IndexedDB, same schema.
- [`index.html`](index.html) — local dashboard for poking the store.
- [`test.mjs`](test.mjs) — the suite.

## Invariants to preserve

Do not change these without bumping the spec and updating the tests:

1. `HIDDEN === 16`; every stored vector has `dim === HIDDEN`.
2. `encode(text)` is deterministic and total, output length always `HIDDEN`,
   char slots are `charCode / 128`, input truncated to `HIDDEN` characters.
3. `forward(x)` is deterministic per seed and passes through `tanh`, so every
   component is strictly within `(-1, 1)`.
4. `cosine(a, b)` returns `0` when either vector has zero norm; `cosine(v, v)`
   is `1` for any non-zero `v`.
5. `ingest(text)` is idempotent per `(namespace, text)` — same id, single row.
6. `warmUp` returns at most `k` rows and never a negatively scored token.
7. The `vec` BLOB is the raw little-endian `Float32Array` image and must
   round-trip byte-for-byte between write and read.

The token table schema (`id, namespace, text, vec, dim, cube_id, vertex, meta,
created_at`) is a compatibility contract shared with the browser build; keep
both in step.

## How to run the tests

```
npm test
```

That runs `node test.mjs`. The pure-function tests (encoder, cosine,
rendering) run in any environment. The end-to-end store tests register only
when a SQLite driver is available; where none is present they are not created
(no skip markers), and the pure suite still fully exercises the algorithms.

A non-zero exit means a real behavioural change — investigate the assertion
against the observed value before touching the source.

## Boundaries

- Keep changes engineering-only: data model, algorithms, invariants, API,
  determinism.
- Every assertion in `test.mjs` mirrors a value observed from running the code.
  If you change behaviour, update the assertion to the new observed value; do
  not weaken it into a tautology.
