import pulpDb from '../index.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import pathLib from 'node:path';

import { test } from 'node:test';

const tagIndex = {
    byTag: {
        valueEncoding: 'json',
        process: (content, emit) => {
            const doc = JSON.parse(content.toString('utf8'));
            for (const tag of doc.tags ?? []) {
                emit(['tag', tag], doc.title);
            }
        },
    },
};

function makeDb(t, indexes = {}, opts = {}) {
    const root = fs.mkdtempSync(pathLib.join(os.tmpdir(), 'pulp-db-'));
    const db = pulpDb(indexes, {
        dataPath: pathLib.join(root, 'db'),
        indexPath: pathLib.join(root, 'index'),
        ...opts,
    });

    t.after(async () => {
        await db.close();
        fs.rmSync(root, {
            recursive: true,
            force: true,
            maxRetries: 10,
            retryDelay: 50,
        });
    });

    return db;
}

async function collect(iter) {
    const result = [];
    for await (const x of iter) {
        result.push(x);
    }
    return result;
}

// A document created behind pulp-db's back reaches a live index only when the
// watcher notices, which happens on the filesystem's schedule.
async function eventually(fn, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try {
            return await fn();
        } catch (e) {
            if (Date.now() > deadline) {
                throw e;
            }
            await new Promise((r) => setTimeout(r, 50));
        }
    }
}

// --- edit / get / list -----------------------------------------------------

test('edit() creates, reads back, and reports old and new values', async (t) => {
    const db = makeDb(t);

    const created = await db.edit('a.json', () => ({ title: 'Alpha' }));
    assert.equal(created.oldValue, undefined);
    assert.deepEqual(created.newValue, { title: 'Alpha' });
    assert.deepEqual(await db.get('a.json'), { title: 'Alpha' });

    const updated = await db.edit('a.json', (doc) => {
        doc.title = 'Beta';
    });
    assert.deepEqual(updated.oldValue, { title: 'Alpha' });
    assert.deepEqual(updated.newValue, { title: 'Beta' });
    assert.deepEqual(await db.get('a.json'), { title: 'Beta' });
});

test('get() of a missing document is undefined', async (t) => {
    const db = makeDb(t);
    assert.equal(await db.get('nope.json'), undefined);
});

test('edit() can delete a document', async (t) => {
    const db = makeDb(t);

    await db.edit('a.json', () => ({ title: 'Alpha' }));
    const removed = await db.edit('a.json', (doc, { delete: del }) => {
        del();
    });

    // The document is gone, so newValue reports it gone — even though immer
    // handed back the old reference.
    assert.deepEqual(removed.oldValue, { title: 'Alpha' });
    assert.equal(removed.newValue, undefined);

    assert.equal(await db.get('a.json'), undefined);
    assert.deepEqual(await db.list(), []);
});

test('deleting an absent document is a no-op', async (t) => {
    const db = makeDb(t);

    const result = await db.edit('gone.json', (doc, { delete: del }) => {
        if (doc !== undefined) del();
    });

    assert.equal(result.oldValue, undefined);
    assert.equal(result.newValue, undefined);
    assert.deepEqual(await db.list(), []);
});

// --- error reporting -------------------------------------------------------

test('failures keep their fs error code', async (t) => {
    const db = makeDb(t);

    // A directory where a document should be: reads fail EISDIR, not ENOENT.
    fs.mkdirSync(pathLib.join(db.dataPath, 'dir.json'), { recursive: true });

    await assert.rejects(() => db.get('dir.json'), { code: 'EISDIR' });
    await assert.rejects(() => db.edit('dir.json', (d) => d), {
        code: 'EISDIR',
    });

    // The original error is still reachable, and the wrapper has a stack.
    const err = await db.get('dir.json').catch((e) => e);
    assert.equal(err.cause.code, 'EISDIR');
    assert.match(err.stack, /pulp-db\.test\.mjs/);
});

test('a value that cannot be serialized fails the edit', async (t) => {
    const db = makeDb(t);

    await assert.rejects(
        () =>
            db.edit('a.json', () => {
                const circular = {};
                circular.self = circular;
                return circular;
            }),
        /circular/i,
    );

    // Nothing was written.
    assert.equal(await db.get('a.json'), undefined);
});

test('list() and inline queries tolerate a missing collection', async (t) => {
    // Inline mode never creates dataPath, so it genuinely does not exist.
    const db = makeDb(t, tagIndex, { inline: true });

    assert.equal(fs.existsSync(db.dataPath), false);
    assert.deepEqual(await db.list(), []);
    assert.deepEqual(await collect(db.indexes.byTag.getMany(['tag', 'x'])), []);
});

test('list() surfaces non-ENOENT failures with their code', async (t) => {
    // Inline mode, so nothing pre-creates dataPath as a directory.
    const db = makeDb(t, tagIndex, { inline: true });

    fs.mkdirSync(pathLib.dirname(db.dataPath), { recursive: true });
    fs.writeFileSync(db.dataPath, 'not a directory');

    await assert.rejects(() => db.list(), { code: 'ENOTDIR' });

    // An inline index query over the same broken collection propagates too,
    // rather than quietly reporting no matches.
    await assert.rejects(
        () => collect(db.indexes.byTag.getMany(['tag', 'x'])),
        { code: 'ENOTDIR' },
    );
});

test('list() enumerates the collection, with or without values', async (t) => {
    const db = makeDb(t);

    await db.edit('a.json', () => ({ title: 'Alpha' }));
    await db.edit('b.json', () => ({ title: 'Beta' }));

    const withValues = await db.list();
    assert.deepEqual(withValues.map((e) => e.path).sort(), [
        'a.json',
        'b.json',
    ]);
    assert.deepEqual(withValues.find((e) => e.path === 'a.json').value, {
        title: 'Alpha',
    });

    const namesOnly = await db.list({ values: false });
    assert.deepEqual(namesOnly.map((e) => e.path).sort(), ['a.json', 'b.json']);
    assert.ok(!('value' in namesOnly[0]));
});

test('list() of a collection that was never written is empty', async (t) => {
    const db = makeDb(t);
    assert.deepEqual(await db.list(), []);
});

// --- nested documents ------------------------------------------------------

// Populate a collection with documents at three depths, one of them written
// behind pulp-db's back the way a person with a file manager would.
async function seedNested(db) {
    await db.edit('top.json', () => ({ title: 'Top', tags: ['x'] }), {
        awaitIndex: true,
    });
    await db.edit('sub/mid.json', () => ({ title: 'Mid', tags: ['x'] }), {
        awaitIndex: true,
    });

    fs.mkdirSync(pathLib.join(db.dataPath, 'deep', 'er'), { recursive: true });
    fs.writeFileSync(
        pathLib.join(db.dataPath, 'deep', 'er', 'hand.json'),
        JSON.stringify({ title: 'Hand', tags: ['x'] }),
    );

    // Nothing told a live index about that one. reindex() folds it in
    // deterministically; in inline mode it is a no-op that resolves true,
    // since queries rescan anyway.
    await db.reindex('deep/er/hand.json');
}

const NESTED = ['deep/er/hand.json', 'sub/mid.json', 'top.json'];

test('list() finds documents at any depth, slash-separated', async (t) => {
    const db = makeDb(t, tagIndex);
    await seedNested(db);

    assert.deepEqual((await db.list()).map((e) => e.path).sort(), NESTED);
    assert.deepEqual(
        (await db.list({ values: false })).map((e) => e.path).sort(),
        NESTED,
    );

    // The paths list() reports are the ones get() and edit() accept.
    assert.equal((await db.get('sub/mid.json')).title, 'Mid');
});

test('live and inline modes see identical documents', async (t) => {
    const live = makeDb(t, tagIndex);
    await seedNested(live);

    const inline = makeDb(t, tagIndex, { inline: true });
    await seedNested(inline);

    const paths = async (db) =>
        (await collect(db.indexes.byTag.getMany(['tag', 'x'])))
            .map((m) => m.path)
            .sort();

    const livePaths = await paths(live);
    assert.deepEqual(livePaths, NESTED);
    assert.deepEqual(await paths(inline), livePaths);

    assert.deepEqual(
        (await inline.list()).map((e) => e.path).sort(),
        (await live.list()).map((e) => e.path).sort(),
    );
});

test('the watcher notices a nested document created by hand', async (t) => {
    const db = makeDb(t, tagIndex);

    // No reindex() here: this is the end-to-end path, where cardcatalog's
    // watcher has to see a file appear in a subdirectory on its own.
    fs.mkdirSync(pathLib.join(db.dataPath, 'a', 'b'), { recursive: true });
    fs.writeFileSync(
        pathLib.join(db.dataPath, 'a', 'b', 'dropped.json'),
        JSON.stringify({ title: 'Dropped', tags: ['x'] }),
    );

    const hits = await eventually(async () => {
        const found = await collect(db.indexes.byTag.getMany(['tag', 'x']));
        assert.equal(found.length, 1, 'watcher has not caught up');
        return found;
    });

    assert.equal(hits[0].path, 'a/b/dropped.json');
});

test('a directory named like a document is not one', async (t) => {
    const db = makeDb(t, tagIndex, { inline: true });

    await db.edit('real.json', () => ({ title: 'Real', tags: ['x'] }));
    fs.mkdirSync(pathLib.join(db.dataPath, 'decoy.json'), { recursive: true });

    assert.deepEqual(
        (await db.list()).map((e) => e.path),
        ['real.json'],
    );
    assert.equal(
        (await collect(db.indexes.byTag.getMany(['tag', 'x']))).length,
        1,
    );
});

test('indexPath inside dataPath is rejected at construction', async (t) => {
    const root = fs.mkdtempSync(pathLib.join(os.tmpdir(), 'pulp-db-'));
    t.after(() =>
        fs.rmSync(root, {
            recursive: true,
            force: true,
            maxRetries: 10,
            retryDelay: 50,
        }),
    );

    const dataPath = pathLib.join(root, 'db');

    // A recursive scan would otherwise walk the index's own database files.
    assert.throws(
        () => pulpDb({}, { dataPath, indexPath: pathLib.join(dataPath, 'ix') }),
        /indexPath must not be inside dataPath/,
    );
    assert.throws(
        () => pulpDb({}, { dataPath, indexPath: dataPath }),
        /indexPath must not be inside dataPath/,
    );

    // Siblings are fine.
    const ok = pulpDb({}, { dataPath, indexPath: pathLib.join(root, 'ix') });
    t.after(() => ok.close());
});

// --- reindex ---------------------------------------------------------------

test('reindex() folds in a document written past pulp-db', async (t) => {
    const db = makeDb(t, tagIndex);

    fs.mkdirSync(pathLib.join(db.dataPath, 'sub'), { recursive: true });
    fs.writeFileSync(
        pathLib.join(db.dataPath, 'sub', 'hand.json'),
        JSON.stringify({ title: 'Hand', tags: ['x'] }),
    );

    assert.equal(await db.reindex('sub/hand.json'), true);

    // No polling: reindex resolves once the index reflects the document.
    const hits = await collect(db.indexes.byTag.getMany(['tag', 'x']));
    assert.deepEqual(
        hits.map((h) => h.path),
        ['sub/hand.json'],
    );
});

test('reindex() of a removed document drops its entries', async (t) => {
    const db = makeDb(t, tagIndex);

    await db.edit('a.json', () => ({ title: 'Alpha', tags: ['x'] }), {
        awaitIndex: true,
    });

    fs.unlinkSync(pathLib.join(db.dataPath, 'a.json'));
    assert.equal(await db.reindex('a.json'), true);

    assert.deepEqual(await collect(db.indexes.byTag.getMany(['tag', 'x'])), []);
});

test('reindex() reports false for a filtered document', async (t) => {
    const db = makeDb(t, tagIndex);

    // Only *.json is indexed, so write-file-atomic's temp files stay out.
    fs.writeFileSync(pathLib.join(db.dataPath, 'notes.txt'), 'not a document');
    assert.equal(await db.reindex('notes.txt'), false);
});

test('reindex() is a no-op in inline mode', async (t) => {
    const db = makeDb(t, tagIndex, { inline: true });

    await db.edit('a.json', () => ({ title: 'Alpha', tags: ['x'] }));

    // Nothing to update: inline queries rescan, so it is already current.
    assert.equal(await db.reindex('a.json'), true);
    assert.equal(
        (await collect(db.indexes.byTag.getMany(['tag', 'x']))).length,
        1,
    );
});

// --- concurrency -----------------------------------------------------------

test('concurrent edits to one path in the same tick do not lose writes', async (t) => {
    const db = makeDb(t);
    await db.edit('c.json', () => ({ n: 0 }));

    const inc = (doc) => ({ n: doc.n + 1 });
    await Promise.all([
        db.edit('c.json', inc),
        db.edit('c.json', inc),
        db.edit('c.json', inc),
    ]);

    assert.equal((await db.get('c.json')).n, 3);
});

test('concurrent edits to one path across ticks do not lose writes', async (t) => {
    const db = makeDb(t);
    await db.edit('c.json', () => ({ n: 0 }));

    // The read is async, so a second edit starting a tick later can otherwise
    // read the same value the first one did and overwrite its result.
    const inc = (doc) => ({ n: doc.n + 1 });
    const first = db.edit('c.json', inc);
    await new Promise((r) => setImmediate(r));
    const second = db.edit('c.json', inc);
    await Promise.all([first, second]);

    assert.equal((await db.get('c.json')).n, 2);
});

test('edits to different paths are independent', async (t) => {
    const db = makeDb(t);

    await Promise.all([
        db.edit('x.json', () => ({ v: 'x' })),
        db.edit('y.json', () => ({ v: 'y' })),
    ]);

    assert.deepEqual(await db.get('x.json'), { v: 'x' });
    assert.deepEqual(await db.get('y.json'), { v: 'y' });
});

// --- async updaters --------------------------------------------------------

test('an async updater is rejected rather than silently corrupting', async (t) => {
    const db = makeDb(t);
    await db.edit('a.json', () => ({ n: 0 }));

    await assert.rejects(
        () => db.edit('a.json', async (doc) => ({ n: doc.n + 1 })),
        /must be synchronous/,
    );

    // The document is untouched, not overwritten with a serialized promise.
    assert.deepEqual(await db.get('a.json'), { n: 0 });
});

// --- indexes ---------------------------------------------------------------

test('awaitIndex makes a write immediately visible to the index', async (t) => {
    const db = makeDb(t, tagIndex);

    await db.edit('a.json', () => ({ title: 'Alpha', tags: ['x'] }), {
        awaitIndex: true,
    });

    const hits = await collect(db.indexes.byTag.getMany(['tag', 'x']));
    assert.deepEqual(
        hits.map((h) => h.path),
        ['a.json'],
    );
    assert.equal(hits[0].indexValue, 'Alpha');
});

test('awaitIndex makes a delete immediately visible to the index', async (t) => {
    const db = makeDb(t, tagIndex);

    await db.edit('a.json', () => ({ title: 'Alpha', tags: ['x'] }), {
        awaitIndex: true,
    });
    assert.equal(
        (await collect(db.indexes.byTag.getMany(['tag', 'x']))).length,
        1,
    );

    // immer hands back the same reference when the recipe returns nothing, so
    // a delete must not be mistaken for "no change".
    await db.edit(
        'a.json',
        (doc, { delete: del }) => {
            del();
        },
        { awaitIndex: true },
    );

    assert.deepEqual(await collect(db.indexes.byTag.getMany(['tag', 'x'])), []);
});

test('index queries expose the matched document', async (t) => {
    const db = makeDb(t, tagIndex);

    await db.edit('a.json', () => ({ title: 'Alpha', tags: ['x', 'y'] }), {
        awaitIndex: true,
    });

    const match = await db.indexes.byTag.get(['tag', 'y']);
    assert.equal(match.path, 'a.json');
    assert.deepEqual(JSON.parse(await match.read('utf8')), {
        title: 'Alpha',
        tags: ['x', 'y'],
    });
});

// --- inline mode -----------------------------------------------------------

test('inline mode answers the same queries with no persistent index', async (t) => {
    const db = makeDb(t, tagIndex, { inline: true });

    await db.edit('a.json', () => ({ title: 'Alpha', tags: ['x'] }));
    await db.edit('b.json', () => ({ title: 'Beta', tags: ['x', 'z'] }));

    const hits = await collect(db.indexes.byTag.getMany(['tag', 'x']));
    assert.deepEqual(hits.map((h) => h.path).sort(), ['a.json', 'b.json']);

    const one = await db.indexes.byTag.get(['tag', 'z']);
    assert.equal(one.path, 'b.json');
    assert.equal(one.indexValue, 'Beta');

    // A prefix query matches every tag.
    assert.equal((await collect(db.indexes.byTag.getMany(['tag']))).length, 3);

    // No index directory is created.
    assert.equal(await db.indexes.byTag.get(['tag', 'absent']), null);
});

test('inline mode handles scalar keys and non-matching prefixes', async (t) => {
    const db = makeDb(
        t,
        {
            byWord: {
                process: (content, emit) => {
                    const doc = JSON.parse(content.toString('utf8'));
                    emit(doc.word, doc.word); // scalar key, not an array
                },
            },
        },
        { inline: true },
    );

    await db.edit('a.json', () => ({ word: 'alpha' }));

    const hit = await db.indexes.byWord.get('alpha');
    assert.equal(hit.path, 'a.json');
    assert.equal(hit.readSync('utf8').includes('alpha'), true);
    assert.deepEqual(JSON.parse(await hit.read('utf8')), { word: 'alpha' });

    // A query key longer than the emitted key cannot match.
    assert.equal(await db.indexes.byWord.get(['alpha', 'extra']), null);
    // Nor can a different key of the same length.
    assert.equal(await db.indexes.byWord.get('beta'), null);
});

test('non-.json files in the collection are ignored', async (t) => {
    const db = makeDb(t, tagIndex, { inline: true });

    await db.edit('a.json', () => ({ title: 'Alpha', tags: ['x'] }));
    fs.writeFileSync(pathLib.join(db.dataPath, 'notes.txt'), 'ignore me');

    assert.deepEqual(
        (await db.list()).map((e) => e.path),
        ['a.json'],
    );
    assert.equal(
        (await collect(db.indexes.byTag.getMany(['tag', 'x']))).length,
        1,
    );
});

test('dataPath defaults to ./db when not supplied', async (t) => {
    const db = pulpDb({}, { inline: true });
    t.after(() => db.close());
    assert.equal(db.dataPath, './db');
});

test('paths default to ./db and ./index relative to the cwd', async (t) => {
    const root = fs.mkdtempSync(pathLib.join(os.tmpdir(), 'pulp-db-'));
    const cwd = process.cwd();
    process.chdir(root);

    const db = pulpDb({});
    t.after(async () => {
        await db.close();
        process.chdir(cwd);
        fs.rmSync(root, {
            recursive: true,
            force: true,
            maxRetries: 10,
            retryDelay: 50,
        });
    });

    // Both defaults resolve against the cwd, and being siblings they satisfy
    // the containment guard. cardcatalog reports dataPath absolute but hands
    // indexPath back as given, so check the latter on disk instead.
    assert.equal(db.dataPath, pathLib.resolve(root, 'db'));
    assert.ok(fs.existsSync(db.dataPath));
    assert.ok(fs.existsSync(pathLib.join(root, 'index')));
});

test('inline get() throws when several documents match', async (t) => {
    const db = makeDb(t, tagIndex, { inline: true });

    await db.edit('a.json', () => ({ title: 'Alpha', tags: ['x'] }));
    await db.edit('b.json', () => ({ title: 'Beta', tags: ['x'] }));

    await assert.rejects(
        () => db.indexes.byTag.get(['tag', 'x']),
        /Multiple matches/,
    );
});

test('inline mode skips documents its index cannot process', async (t) => {
    const db = makeDb(t, tagIndex, { inline: true });

    await db.edit('good.json', () => ({ title: 'Good', tags: ['x'] }));
    fs.writeFileSync(pathLib.join(db.dataPath, 'bad.json'), 'not json');

    const hits = await collect(db.indexes.byTag.getMany(['tag', 'x']));
    assert.deepEqual(
        hits.map((h) => h.path),
        ['good.json'],
    );
});
