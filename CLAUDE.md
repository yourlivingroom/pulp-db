# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`@yourlivingroom/pulp-db` is a JSON document store over a directory of files: documents are ordinary `.json` files, and it adds atomic read-modify-write edits, per-document serialization, and secondary indexes. The entire implementation is `index.mjs` (a single default-exported factory). Indexing is not implemented here — it is delegated wholesale to `@yourlivingroom/cardcatalog`, which this package wraps.

Before changing the API, check the change against a real consumer rather than only against the tests: every ergonomic problem found so far surfaced from how calling code actually reads, not from the test suite.

## Commands

- Test: `npm test` (node:test over `test/`); single file: `node --test test/pulp-db.test.mjs`; single test: add `--test-name-pattern="<name>"`. Note `node --test` with no path argument — passing `test/` makes Node try to load the directory as a module.
- Coverage: `npm run coverage` (c8, enforces 100% on every metric via `--100`)
- Typecheck: `npm run typecheck` (tsc --noEmit over `index.d.mts` + `test-d/index.test-d.ts`)
- Format: `npm run format` (prettier; check-only via `npm run format:check`)
- Lint: `npm run lint` (eslint, zero warnings tolerated; `npx eslint . --fix` autofixes import order)
- Debug logging: set `PULP_DB_DEBUG=1` to log absorbed index errors

Tooling config (prettier, eslint including the import-order rules and the local `imports-first` rule, tsconfig, CI workflow, coverage badge script) is copied from cardcatalog and should stay in sync with it.

## Testing approach

Tests run against real temp directories (`fs.mkdtemp`), because the index underneath uses chokidar's native watchers, which do not see fake filesystems. `makeDb(t, indexes, opts)` builds a catalog whose `t.after` closes it and removes the tree; `collect()` drains an async iterable; `eventually()` polls for watcher-driven state. Most tests avoid the watcher entirely by using `reindex()`, which is deterministic.

`test/debug-logging.test.mjs` is a separate file because the `PULP_DB_DEBUG` logger binds `console.log` at module load, so it needs its own process to set the env var and stub the logger before import.

Parity between live and inline mode is pinned by a `for (const inline of [false, true])` loop that runs the same assertions against both. Any divergence fails the suite twice. That loop exists because inline mode was previously reimplemented here and drifted from cardcatalog's semantics repeatedly; keep it.

## Types

Hand-written `index.d.mts` (`.d.mts`, not `.d.ts` — node16 resolution pairs declarations to `index.mjs` by extension), reusing cardcatalog's exported `Key`/`Match`/`IndexConfig`/`Index` types rather than restating them. Checked three ways, all of which must stay:

1. `test-d/index.test-d.ts` — compile-time assertions via `Expect<Equal<>>` plus ts-expect-error for negative cases. It lives in `test-d/`, NOT `test/`: Node's runner treats every file under `test/` as a test file and strips TypeScript natively, so it would be executed, and its deliberately-invalid calls throw.
2. `skipLibCheck` is deliberately **false**, so errors inside `index.d.mts` surface directly rather than only where a test touches them.
3. `runtime surface matches the type declarations` in the test suite enumerates actual object keys — the only guard against declarations drifting from the implementation.

When asserting on a value's type, check fields individually rather than comparing the whole value against its own alias (`Equal<typeof result, EditResult<any>>` passes no matter what `EditResult` contains).

Documents are typed by a second generic parameter defaulting to `any`, since they are arbitrary JSON and `get()` is the primary operation.

## Architecture

`pulpDb(indexes, opts)` returns `{ edit, get, list, reindex, close, indexes, dataPath, indexPath }`. `opts` is `{ dataPath, indexPath, inline }`.

Indexing is entirely cardcatalog's: `opts.inline` is passed straight through, and `db.indexes` is `cc.indexes` unmodified. Do not reimplement query behavior here — that was tried and produced six divergences (nested documents, `===` prefix comparison, result ordering, single-element key unwrapping, duplicate-key collapse, relative-vs-absolute `dataPath`). If inline and live disagree about anything, the fix belongs in cardcatalog.

`shouldIndex` is fixed to `path.endsWith('.json')` and is load-bearing: `write-file-atomic` leaves transient `<id>.json.<number>` files, and indexing those would file entries for half-written documents. It also means `reindex()` resolves `true` for any `*.json` path and `false` otherwise, regardless of whether the document exists — a missing one is de-indexed, which is equally "handled".

`edit(path, updater, opts)`:

- Reads the document, runs `updater(draft, { remove })` through immer, writes the result with `write-file-atomic`.
- **Updaters must be synchronous.** immer returns a promise when the recipe does, and it cannot be applied atomically here — without the explicit check, `JSON.stringify` would write `"{}"` over the document. Detected by testing the produced value for `then`.
- **The handle is `remove`, not `delete`** — `delete` is reserved, so `{ delete }` is a syntax error and every caller had to alias it.
- **Removal is idempotent**: ENOENT from the unlink is absorbed. Every consumer call site was independently guarding against it before this.
- `newValue` is `undefined` after a removal. immer hands back the same reference when the recipe returns nothing, so the removal is tracked by a separate `deleted` flag rather than inferred from the value — the same flag also drives `awaitIndex`, which would otherwise skip removals entirely.
- `opts.awaitIndex` awaits `cc.reindex()` so a following query sees the change.

Concurrency: `pathQueue` serializes edits per path through a `Map` of p-queues. The map entry is retired in a `finally` only when the queue is genuinely idle **and** still the registered one. An earlier version registered an `onIdle()` callback at queue creation; `onIdle` resolves immediately on an empty queue, so the entry was dropped before the first task ran and every later edit built a fresh queue — a lost update. `Promise.all` hid this, since all its calls land in one synchronous tick.

Windows: `write-file-atomic` finishes by renaming over the target, and Windows refuses that while another handle has it open — routinely the index watcher, reading a document moments after it changed. `retryingLockErrors` retries EPERM/EBUSY with backoff around both the write and the unlink. POSIX never takes the retry path.

Errors: `rewrapError` rebuilds errors to restore a usable stack trace (`write-file-atomic` throws without one) while copying `code` across, so callers can still distinguish EACCES from EISDIR. cardcatalog reports infrastructure failures on an `'error'` event whose unhandled case is fatal by EventEmitter convention, so a listener is installed at construction: ordinary failures are absorbed and logged under `PULP_DB_DEBUG`, while failures meaning the index itself is unusable (`LEVEL_*`, ENOSPC, EROFS) are rethrown asynchronously.

`list()` is an async generator, and `walkJsonFiles` is one too, so neither the values nor the path list is materialized. Paths are assembled from entry names rather than taken from `readdir`, so separators are `/` on every platform, matching cardcatalog's portable keys; directories are recognized before the `.json` suffix is considered, so a directory named like a document is not mistaken for one. `list()` reads the directory rather than the index, so it is strongly consistent.

`indexPath` inside `dataPath` is rejected at construction: the collection is walked recursively, so an index living inside it would be walked as documents and handed to the watcher.
