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
    await db.edit('a.json', (doc, { delete: del }) => {
        del();
    });

    assert.equal(await db.get('a.json'), undefined);
    assert.deepEqual(await db.list(), []);
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
