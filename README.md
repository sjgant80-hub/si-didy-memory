# si-didy-memory

**Live:** [sjgant80-hub.github.io/si-didy-memory](https://sjgant80-hub.github.io/si-didy-memory/)

> ◊·κ=φ⁴ · **PRIVATE · L1 upgrade for NiceAssOS**
> Warm si-didy from FallMind v2's `cube.db` on boot · 16-dim FemtoLLM cosine NN
> Architecture: **Thomas Frumkin** (MianoCube). Implementation: **Simon Gant**.

## What this is

si-didy today boots cold. Every new session Claude rebuilds context via the
first few exchanges, burning tokens on things si-didy already knew yesterday.

This module fixes it. On boot, `si-didy-memory` takes the current task hints,
encodes them through a 16-dim FemtoLLM, runs a brute-force cosine NN over
`cube.db`'s `tokens` table, and returns the top-k most relevant prior tokens
as a `<prior-context>` block. si-didy prepends that block to Claude's first
message. Continuity, refill cost = 0.

Every subsequent turn, `remember(prompt, response)` summarises the exchange
back into the same cube for tomorrow.

```
si-didy boot
    ↓
si-didy-memory.warmUp(taskHints)
    · encode taskHints → 16-dim vec via FemtoLLM
    · brute-force cosine NN over cube.db tokens (namespace='work')
    · retrieve top-k (default k=20)
    · format as <prior-context> block
    ↓
si-didy prepends warm-context to first Claude message
    ↓
Claude sees continuity · no rebuild
```

## Files

| File | Role |
|---|---|
| `si-didy-memory.js` | Node module · `node:sqlite` → `better-sqlite3` fall-through |
| `browser-adapter.js` | Browser module · `sql.js` + IndexedDB persistence |
| `index.html` | Local dashboard · live query · seed · remember · logs |
| `sw.js` | Service worker · offline shell |
| `manifest.webmanifest` | PWA manifest |
| `LICENSE` | MIT |

## FallMind v2 dependency

Faithful to the tokens table shape in
[`fallmind-v2/schema.sql`](../fallmind-v2/schema.sql):

```sql
tokens (id, namespace, text, vec BLOB, dim, cube_id, vertex, meta, created_at)
```

`vec` is a raw Float32Array BLOB of length `dim × 4` bytes. This module reads
and writes exactly that layout, so a `cube.db` produced by `fallmind-v2` is
directly queryable here, and vice versa. Namespace scoping keeps si-didy
tokens (`namespace='work'`) from colliding with other consumers of the same cube.

## Integration hook

Inside si-didy-agent's boot sequence:

```js
import SiDidyMemory from '@sjgant80-hub/si-didy-memory';

const memory = new SiDidyMemory({
  dbPath: process.env.CUBE_DB || './cube.db',
  namespace: 'work',
  cubeId: 'si-didy',
  k: 20
});

// on boot · before first Claude call
const warm = await memory.warmUp(taskHints);   // taskHints from CLI arg / config / recent files
firstClaudeMessage = warm + '\n' + firstClaudeMessage;

// after every Claude turn
await memory.remember(userPrompt, claudeResponse, { task: currentTask });
```

Task hints can be anything you have at boot time: the current git branch, the
directory name, the last N filenames touched, an explicit `--task` flag.
Whatever the string, the FemtoLLM encodes it and the cube returns its best
neighbours.

## Warm-up shape

The block prepended to Claude looks like:

```
<!-- si-didy-memory · prior-context block · FallMind v2 cube.db -->
<prior-context origin="fallmind-v2" namespace="work" k="12" hint="fallreach outreach queue">
 1. [0.884] Q: How do we score outreach prospects across lanes?
 2. [0.871] # LinkedIn swipe queue
 3. [0.842] - fallscout puppeteer-stealth for LinkedIn scrape
 ...
</prior-context>
```

Claude reads this the same way it reads any other user turn. No special
instruction needed — the tokens carry their own semantic weight.

## Why 16-dim, why brute force

- **16-dim FemtoLLM**: Thomas's spec. The nodes are deliberately stupid.
  Intelligence emerges from arrangement (cube topology + retrieval), not
  compute. ~4KB per model, ~0.1ms per encode.
- **Brute-force cosine**: at working-memory scale (thousands of tokens, not
  millions) a full scan is faster than any index and adds zero deps. The
  MianoCube spec is a nervous system, not a vector database.

If you cross ~50k tokens per namespace and want faster retrieval, add an
IVF index over the BLOB column — the schema is unchanged.

## Ship

```bash
# Node 22.5+
import SiDidyMemory from './si-didy-memory.js';

# Older Node
npm i better-sqlite3
```

## Dashboard

Open `index.html` in Chrome to poke the cube directly:
- type task hints, see top-k matches with cosine scores
- seed with sample tokens
- simulate a turn (remember)
- watch warm-up hit rate live

The dashboard runs entirely in-browser via sql.js + IndexedDB. Same schema,
so a cube built here can be exported and dropped straight onto a Node
si-didy-agent host.

## License

MIT · Simon Gant 2026
Architecture: Thomas Frumkin (see `teslasolar/MianoCube`).

◊·κ=φ⁴ · prime 1289 · the body is the receipt
