# pulp-db

[![CI](https://github.com/yourlivingroom/pulp-db/actions/workflows/ci.yml/badge.svg)](https://github.com/yourlivingroom/pulp-db/actions/workflows/ci.yml)
[![Coverage](https://raw.githubusercontent.com/yourlivingroom/pulp-db/badges/coverage.svg)](https://github.com/yourlivingroom/pulp-db/actions/workflows/ci.yml)

A JSON document store over a directory of files.

Documents are ordinary `.json` files on disk, so you can read them, diff them,
grep them, and commit them. `pulp-db` adds what a directory of files lacks:
atomic read-modify-write edits, per-document serialization so concurrent
writers cannot clobber each other, and persistent secondary indexes via
[@yourlivingroom/cardcatalog].

[@yourlivingroom/cardcatalog]: https://github.com/yourlivingroom/cardcatalog
[immer]: https://immerjs.github.io/immer/

## Quick start

```js
import pulpDb from '@yourlivingroom/pulp-db';

const books = pulpDb(
    {
        byAuthor: {
            valueEncoding: 'json',
            process: (content, emit) => {
                const doc = JSON.parse(content.toString('utf8'));
                for (const author of doc.authors ?? []) {
                    emit(author, doc.title);
                }
            },
        },
    },
    { dataPath: './books', indexPath: './books-index' },
);

await books.edit('earthsea.json', () => ({
    title: 'A Wizard of Earthsea',
    authors: ['Le Guin'],
}));

// Mutate in place; the draft is an immer draft.
await books.edit('earthsea.json', (draft) => {
    draft.year = 1968;
});

console.log(await books.get('earthsea.json'));

for await (const match of books.indexes.byAuthor.getMany('Le Guin')) {
    console.log(match.path, '->', match.indexValue);
}

await books.close();
```

## Usage

### Editing

`edit(path, updater)` reads the document, hands it to your `updater`, and
writes the result back atomically. The updater either mutates the draft (via
[immer], so you write plain assignments) or returns a replacement value. A
draft is `undefined` when the document does not exist yet, so creating one
means returning a value.

Updaters must be synchronous. Doing async work inside one cannot be applied
atomically, so it is rejected rather than silently misapplied; fetch what you
need before calling `edit`.

Edits to the same document are serialized, so two callers incrementing a
counter both land. Edits to different documents proceed in parallel.

To remove a document, call the `delete` handle:

```js
await books.edit('earthsea.json', (draft, { delete: del }) => {
    if (draft) del();
});
```

`edit` resolves to `{ oldValue, newValue }`. After a delete, `newValue` is
`undefined`.

### Indexes

Indexes are [cardcatalog] indexes: each index's `process(content, emit)` runs
over every document, and each `emit(key, value)` files an entry pointing back
at it. Query with `get(key)` for a unique match or `getMany(key)` for all of
them, including compound keys the query prefixes.

[cardcatalog]: https://github.com/yourlivingroom/cardcatalog

Indexes are maintained in the background, so a document written a moment ago
may not be queryable yet. Two ways to get read-your-writes:

```js
// Wait for this write to reach the index.
await books.edit('a.json', (draft) => ({ title: 'New' }), {
    awaitIndex: true,
});

// Or fold in a document written past pulp-db entirely.
await books.reindex('dropped-in-by-hand.json');
```

`list()` reads the directory directly rather than the index, so it always
reflects what is on disk.

### Live and inline modes

By default an index is **live**: cardcatalog maintains it in a LevelDB beside
your documents, watching for changes. That is fast to query, but it runs a
watcher and holds an exclusive lock on the index.

Passing `inline: true` keeps no persistent index at all. Each query scans the
collection and runs `process()` in memory. No LevelDB, no watcher, no lock,
so a short-lived utility (a CLI, a migration script) can run alongside a live
server. Queries return the same results either way.

Inline mode implements `get` and `getMany`. Live mode's index objects are
cardcatalog's, which also offer `getRange` and `problems`; using those ties
that code to live mode.

### Nested documents

Documents may live in subdirectories. `edit('a/b/doc.json', updater)` creates the
directories it needs, and documents placed in the collection by any other
means are picked up just the same. Paths are always reported relative to
`dataPath` with forward slashes, on every platform, and are exactly what
`get`, `edit`, and `reindex` accept.

## API

### `pulpDb(indexes?, opts?) => db`

`indexes` is a `{ [indexName]: <indexConfig> }` map, where each config
provides:

- `process(content, emit, { path })` - required, may be async. `content` is a
  `Buffer`; call `emit(key, value)` any number of times.
- `valueEncoding` - how emitted values are stored (default `'utf8'`; `'json'`
  is handy).

`opts`:

- `dataPath` - directory holding the documents (default `'./db'`).
- `indexPath` - where live indexes are stored (default `'./index'`). Must not
  be inside `dataPath`, since the collection is scanned recursively.
- `inline` - answer queries by scanning instead of maintaining an index.

### `db`

- `db.edit(path, updater, { awaitIndex? })` - atomic read-modify-write.
  Resolves `{ oldValue, newValue }`.
- `db.get(path)` - the document, or `undefined`.
- `db.list({ values? })` - every document in the collection, at any depth, as
  `{ path, value }` (or just `{ path }` with `values: false`). Reads from
  disk, so it is never stale.
- `db.indexes.<name>.get(key)` - the single match, or `null`. Throws if
  several documents match.
- `db.indexes.<name>.getMany(key)` - async iterable of every match.
- `db.reindex(path)` - fold a document into a live index now. Resolves `true`
  if it was processed, `false` if it was filtered out. A no-op in inline mode.
- `db.close()` - stop watching and close the index databases.
- `db.dataPath` / `db.indexPath` - resolved locations; `indexPath` is
  `undefined` in inline mode.

Matches from `get`/`getMany` carry `{ key, path, indexValue, read, readSync }`,
where `path` is the document's `dataPath`-relative path.

## TypeScript

Types ship with the package. Index names are tracked through the factory, so
`db.indexes.byAuthor` is known and a typo is a compile error. Document values
default to `any`, since documents are arbitrary JSON; supply a type to narrow
them:

```ts
import pulpDb from '@yourlivingroom/pulp-db';
import type { AnyIndexConfig } from '@yourlivingroom/pulp-db';

interface Book {
    title: string;
    authors?: string[];
}

const books = pulpDb<Record<string, AnyIndexConfig>, Book>();

const book = await books.get('earthsea.json');
book?.title; // string
```

## License

[ISC](./LICENSE)
