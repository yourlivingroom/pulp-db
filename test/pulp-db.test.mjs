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
    const removed = await db.edit('a.json', (doc, { remove }) => {
        remove();
    });

    // The document is gone, so newValue reports it gone — even though immer
    // handed back the old reference.
    assert.deepEqual(removed.oldValue, { title: 'Alpha' });
    assert.equal(removed.newValue, undefined);

    assert.equal(await db.get('a.json'), undefined);
    assert.deepEqual(await collect(db.list()), []);
});

test('delete is idempotent', async (t) => {
    const db = makeDb(t);

    // Unguarded: the caller should not have to check whether it exists first.
    const absent = await db.edit('gone.json', (doc, { remove }) => {
        remove();
    });
    assert.equal(absent.oldValue, undefined);
    assert.equal(absent.newValue, undefined);
    assert.deepEqual(await collect(db.list()), []);

    // And deleting the same document twice is equally fine.
    await db.edit('doc.json', () => ({ title: 'Alpha' }));
    await db.edit('doc.json', (doc, { remove }) => remove());
    const again = await db.edit('doc.json', (doc, { remove }) => remove());
    assert.equal(again.oldValue, undefined);
    assert.equal(again.newValue, undefined);
    assert.deepEqual(await collect(db.list()), []);
});

test('delete wins over a returned value', async (t) => {
    const db = makeDb(t);

    await db.edit('a.json', () => ({ n: 1 }));
    const result = await db.edit('a.json', (doc, { remove }) => {
        remove();
        return { n: 2 };
    });

    assert.equal(result.newValue, undefined);
    assert.equal(await db.get('a.json'), undefined);
});

test('a delete that fails for a real reason still reports it', async (t) => {
    const db = makeDb(t);
    await db.edit('a.json', () => ({ title: 'Alpha' }));

    const realUnlink = fs.promises.unlink;
    fs.promises.unlink = async () => {
        throw Object.assign(new Error('denied'), { code: 'EACCES' });
    };
    t.after(() => {
        fs.promises.unlink = realUnlink;
    });

    await assert.rejects(
        () => db.edit('a.json', (doc, { remove }) => remove()),
        { code: 'EACCES' },
    );
    fs.promises.unlink = realUnlink;
});

// --- construction ----------------------------------------------------------

test('an invalid config is rejected identically in both modes', async () => {
    for (const inline of [false, true]) {
        const opts = { dataPath: './nowhere', inline };
        const label = `inline=${inline}`;

        assert.throws(
            () => pulpDb({ words: {} }, opts),
            {
                name: 'TypeError',
                message: /index "words" needs a process function/,
            },
            label,
        );
        assert.throws(
            () => pulpDb({ words: { process: 5 } }, opts),
            { name: 'TypeError' },
            label,
        );
        assert.throws(
            () => pulpDb(null, opts),
            { name: 'TypeError', message: /indexes must be an object/ },
            label,
        );

        // Index names become directory names under indexPath.
        for (const name of ['', '.', '..', '../evil', 'a/b', 'a\\b']) {
            assert.throws(
                () => pulpDb({ [name]: { process: () => {} } }, opts),
                { name: 'TypeError', message: /invalid index name/ },
                `${label} ${JSON.stringify(name)}`,
            );
        }
    }
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

test('a transient Windows lock error is retried', async (t) => {
    const db = makeDb(t);
    await db.edit('a.json', () => ({ title: 'Alpha' }));

    // Windows reports EPERM while another handle (routinely the watcher) has
    // the file open, then stops once it closes.
    const realUnlink = fs.promises.unlink;
    let attempts = 0;
    fs.promises.unlink = async (...args) => {
        if (++attempts < 3) {
            throw Object.assign(new Error('locked'), { code: 'EPERM' });
        }
        return realUnlink(...args);
    };
    t.after(() => {
        fs.promises.unlink = realUnlink;
    });

    await db.edit('a.json', (doc, { remove }) => {
        remove();
    });

    fs.promises.unlink = realUnlink;
    assert.equal(attempts, 3, 'should have retried twice before succeeding');
    assert.equal(await db.get('a.json'), undefined);
});

test('a persistent lock error is reported', async (t) => {
    const db = makeDb(t);
    await db.edit('a.json', () => ({ title: 'Alpha' }));

    const realUnlink = fs.promises.unlink;
    fs.promises.unlink = async () => {
        throw Object.assign(new Error('locked'), { code: 'EBUSY' });
    };
    t.after(() => {
        fs.promises.unlink = realUnlink;
    });

    await assert.rejects(
        () =>
            db.edit('a.json', (doc, { remove }) => {
                remove();
            }),
        { code: 'EBUSY' },
    );

    fs.promises.unlink = realUnlink;
});

test('an unreadable document does not take the process down', async (t) => {
    const db = makeDb(t, tagIndex);

    // cardcatalog emits infrastructure failures on 'error', and an unhandled
    // 'error' is fatal by EventEmitter convention. pulp-db has to absorb them.
    const uncaught = [];
    const onUncaught = (e) => uncaught.push(e);
    process.on('uncaughtException', onUncaught);

    const realRead = fs.promises.readFile;
    fs.promises.readFile = async (...args) => {
        if (String(args[0]).endsWith('boom.json')) {
            throw Object.assign(new Error('denied'), { code: 'EACCES' });
        }
        return realRead(...args);
    };
    t.after(() => {
        fs.promises.readFile = realRead;
        process.removeListener('uncaughtException', onUncaught);
    });

    // Written past pulp-db so the watcher, not edit(), drives the read.
    fs.writeFileSync(pathLib.join(db.dataPath, 'boom.json'), '{}');
    await new Promise((r) => setTimeout(r, 800));

    fs.promises.readFile = realRead;
    process.removeListener('uncaughtException', onUncaught);
    assert.deepEqual(uncaught, []);

    // The catalog still works afterwards.
    await db.edit('ok.json', () => ({ title: 'Ok', tags: ['x'] }), {
        awaitIndex: true,
    });
    assert.equal(
        (await collect(db.indexes.byTag.getMany(['tag', 'x']))).length,
        1,
    );
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
    assert.deepEqual(await collect(db.list()), []);
    assert.deepEqual(await collect(db.indexes.byTag.getMany(['tag', 'x'])), []);
});

test('list() surfaces non-ENOENT failures with their code', async (t) => {
    // Inline mode, so nothing pre-creates dataPath as a directory.
    const db = makeDb(t, tagIndex, { inline: true });

    fs.mkdirSync(pathLib.dirname(db.dataPath), { recursive: true });
    fs.writeFileSync(db.dataPath, 'not a directory');

    await assert.rejects(() => collect(db.list()), { code: 'ENOTDIR' });

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

    const withValues = await collect(db.list());
    assert.deepEqual(withValues.map((e) => e.path).sort(), [
        'a.json',
        'b.json',
    ]);
    assert.deepEqual(withValues.find((e) => e.path === 'a.json').value, {
        title: 'Alpha',
    });

    const namesOnly = await collect(db.list({ values: false }));
    assert.deepEqual(namesOnly.map((e) => e.path).sort(), ['a.json', 'b.json']);
    assert.ok(!('value' in namesOnly[0]));
});

test('list() of a collection that was never written is empty', async (t) => {
    const db = makeDb(t);
    assert.deepEqual(await collect(db.list()), []);
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

    assert.deepEqual(
        (await collect(db.list())).map((e) => e.path).sort(),
        NESTED,
    );
    assert.deepEqual(
        (await collect(db.list({ values: false }))).map((e) => e.path).sort(),
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
        (await collect(inline.list())).map((e) => e.path).sort(),
        (await collect(live.list())).map((e) => e.path).sort(),
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
        (await collect(db.list())).map((e) => e.path),
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

// --- declared surface ------------------------------------------------------

// Guards index.d.mts against drifting from what the implementation exposes;
// the type tests can only check the declarations' own consistency.
test('runtime surface matches the type declarations', async (t) => {
    const db = makeDb(t, tagIndex);

    assert.deepEqual(Object.keys(db).sort(), [
        'close',
        'dataPath',
        'edit',
        'get',
        'indexPath',
        'indexes',
        'list',
        'reindex',
    ]);

    assert.equal(typeof db.dataPath, 'string');
    assert.equal(pathLib.isAbsolute(db.dataPath), true);
    assert.equal(typeof db.indexPath, 'string');
    assert.deepEqual(Object.keys(db.indexes), ['byTag']);

    // The full cardcatalog query surface.
    for (const method of ['get', 'getMany', 'getRange', 'problems']) {
        assert.equal(typeof db.indexes.byTag[method], 'function', method);
    }

    const edited = await db.edit('a.json', () => ({ title: 'Alpha' }), {
        awaitIndex: true,
    });
    assert.deepEqual(Object.keys(edited).sort(), ['newValue', 'oldValue']);

    const [entry] = await collect(db.list());
    assert.deepEqual(Object.keys(entry).sort(), ['path', 'value']);
    assert.deepEqual(
        Object.keys((await collect(db.list({ values: false })))[0]),
        ['path'],
    );

    assert.equal(typeof (await db.reindex('a.json')), 'boolean');
    assert.equal(await db.close(), undefined);
});

test('inline mode exposes the same surface, minus a live index path', async (t) => {
    const db = makeDb(t, tagIndex, { inline: true });

    assert.deepEqual(Object.keys(db).sort(), [
        'close',
        'dataPath',
        'edit',
        'get',
        'indexPath',
        'indexes',
        'list',
        'reindex',
    ]);
    assert.equal(db.indexPath, undefined);

    // Same surface as live, not a subset.
    for (const method of ['get', 'getMany', 'getRange', 'problems']) {
        assert.equal(typeof db.indexes.byTag[method], 'function', method);
    }
});

// --- mode parity -----------------------------------------------------------

// Every assertion below runs against both modes from one fixture, so any
// divergence between the stored index and the in-memory scan fails the test.
for (const inline of [false, true]) {
    const mode = inline ? 'inline' : 'live';

    async function seedParity(t) {
        const db = makeDb(
            t,
            {
                byTag: {
                    valueEncoding: 'json',
                    process: (content, emit) => {
                        const doc = JSON.parse(content.toString('utf8'));
                        if (doc.broken) throw new Error('cannot process');
                        for (const tag of doc.tags ?? []) {
                            emit(['tag', tag], doc.title);
                        }
                        emit(doc.title, doc.title); // a scalar key too
                    },
                },
            },
            { inline },
        );

        for (const [name, doc] of [
            ['a.json', { title: 'Alpha', tags: ['blue', 'red'] }],
            ['b.json', { title: 'Beta', tags: ['red'] }],
            ['sub/c.json', { title: 'Gamma', tags: ['zebra'] }],
        ]) {
            await db.edit(name, () => doc, { awaitIndex: true });
        }
        return db;
    }

    test(`${mode}: getRange walks bounds in charwise order`, async (t) => {
        const db = await seedParity(t);
        const keys = async (range) =>
            (await collect(db.indexes.byTag.getRange(range))).map((m) => m.key);

        // Whole index, ascending.
        assert.deepEqual(await keys({}), [
            'Alpha',
            'Beta',
            'Gamma',
            ['tag', 'blue'],
            ['tag', 'red'],
            ['tag', 'red'],
            ['tag', 'zebra'],
        ]);

        // A bound addresses a key's whole subtree.
        assert.deepEqual(await keys({ gte: ['tag'] }), [
            ['tag', 'blue'],
            ['tag', 'red'],
            ['tag', 'red'],
            ['tag', 'zebra'],
        ]);
        assert.deepEqual(await keys({ gt: ['tag'] }), []);
        assert.deepEqual(
            await keys({ gte: ['tag', 'red'], lte: ['tag', 'zebra'] }),
            [
                ['tag', 'red'],
                ['tag', 'red'],
                ['tag', 'zebra'],
            ],
        );
        assert.deepEqual(
            await keys({ gt: ['tag', 'red'], lt: ['tag', 'z'] }),
            [],
        );
        assert.deepEqual(await keys({ lt: ['tag'] }), [
            'Alpha',
            'Beta',
            'Gamma',
        ]);
    });

    test(`${mode}: getRange honours reverse and limit`, async (t) => {
        const db = await seedParity(t);
        const keys = async (range) =>
            (await collect(db.indexes.byTag.getRange(range))).map((m) => m.key);

        assert.deepEqual(await keys({ limit: 2 }), ['Alpha', 'Beta']);
        assert.deepEqual(await keys({ reverse: true, limit: 2 }), [
            ['tag', 'zebra'],
            ['tag', 'red'],
        ]);
        // limit applies after reversal, so this is "last one in the subtree".
        assert.deepEqual(
            await keys({ gte: ['tag'], reverse: true, limit: 1 }),
            [['tag', 'zebra']],
        );
    });

    test(`${mode}: getMany matches prefixes and scalars alike`, async (t) => {
        const db = await seedParity(t);
        const paths = async (key) =>
            (await collect(db.indexes.byTag.getMany(key)))
                .map((m) => m.path)
                .sort();

        assert.deepEqual(await paths(['tag', 'red']), ['a.json', 'b.json']);

        // a.json carries two tags, so it contributes two entries.
        assert.deepEqual(await paths(['tag']), [
            'a.json',
            'a.json',
            'b.json',
            'sub/c.json',
        ]);
        assert.deepEqual(await paths('Alpha'), ['a.json']);
        assert.deepEqual(await paths(['Alpha']), ['a.json']);
        assert.deepEqual(await paths('absent'), []);
    });

    test(`${mode}: problems reports documents that cannot be processed`, async (t) => {
        const db = await seedParity(t);
        await db.edit('bad.json', () => ({ broken: true }), {
            awaitIndex: true,
        });

        const problems = await collect(db.indexes.byTag.problems());
        assert.deepEqual(
            problems.map((p) => p.path),
            ['bad.json'],
        );
        assert.equal(problems[0].message, 'cannot process');
        assert.equal(typeof problems[0].at, 'string');
        assert.equal(typeof problems[0].stack, 'string');

        // A quarantined document contributes nothing to the index.
        assert.deepEqual(
            (await collect(db.indexes.byTag.getRange({}))).filter(
                (m) => m.path === 'bad.json',
            ),
            [],
        );
    });

    test(`${mode}: undefined is rejected in query keys and bounds`, async (t) => {
        const db = await seedParity(t);

        await assert.rejects(
            () => collect(db.indexes.byTag.getMany(['tag', undefined])),
            /reserved as the range-scan sentinel/,
        );
        await assert.rejects(
            () =>
                collect(db.indexes.byTag.getRange({ gte: ['tag', undefined] })),
            /reserved as the range-scan sentinel/,
        );

        // A top-level undefined bound just means "omitted".
        assert.equal(
            (await collect(db.indexes.byTag.getRange({ gte: undefined })))
                .length,
            7,
        );
    });

    test(`${mode}: a repeated key from one document keeps its last value`, async (t) => {
        const db = makeDb(
            t,
            {
                twice: {
                    valueEncoding: 'json',
                    process: (content, emit) => {
                        emit('dup', 'first');
                        emit('dup', 'second');
                    },
                },
            },
            { inline },
        );
        await db.edit('a.json', () => ({ any: 'thing' }), {
            awaitIndex: true,
        });

        // Both emits become the same stored key, so there is one entry.
        const hits = await collect(db.indexes.twice.getMany('dup'));
        assert.equal(hits.length, 1);
        assert.equal(hits[0].indexValue, 'second');
    });

    test(`${mode}: get throws a message naming the collision`, async (t) => {
        const db = await seedParity(t);

        await assert.rejects(
            () => db.indexes.byTag.get(['tag', 'red']),
            /Multiple matches for .*"tag","red".* in index "byTag": a\.json, b\.json/,
        );
    });
}

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
        (doc, { remove }) => {
            remove();
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
        (await collect(db.list())).map((e) => e.path),
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

    // Resolved, not echoed back: cardcatalog resolves dataPath in both modes,
    // so inline no longer reports a relative path where live reports absolute.
    assert.equal(db.dataPath, pathLib.resolve('./db'));
    assert.equal(db.indexPath, undefined);
});

test('paths default to ./db and ./index relative to the cwd', async (t) => {
    const root = fs.mkdtempSync(pathLib.join(os.tmpdir(), 'pulp-db-'));
    const originalCwd = process.cwd();
    process.chdir(root);

    // Ask for the cwd *after* chdir rather than reusing the mkdtemp path:
    // chdir canonicalizes, so os.tmpdir()'s spelling and the process's differ
    // (/var vs /private/var on macOS, RUNNER~1 vs runneradmin on Windows),
    // and the library resolves relative paths against the latter.
    const cwd = process.cwd();

    const db = pulpDb({});
    t.after(async () => {
        await db.close();
        process.chdir(originalCwd);
        fs.rmSync(root, {
            recursive: true,
            force: true,
            maxRetries: 10,
            retryDelay: 50,
        });
    });

    // Both defaults resolve against the cwd, and being siblings they satisfy
    // the containment guard.
    //
    // Compared as real paths rather than strings: cardcatalog expands the
    // watch root with realpath on win32 (its workaround for libuv crashing on
    // 8.3 short names), so dataPath comes back as C:\Users\runneradmin\...
    // while process.cwd() still reports C:\Users\RUNNER~1\....
    const sameFile = (a, b) =>
        fs.realpathSync.native(a) === fs.realpathSync.native(b);

    assert.ok(pathLib.isAbsolute(db.dataPath));
    assert.ok(fs.existsSync(db.dataPath));
    assert.ok(sameFile(db.dataPath, pathLib.join(cwd, 'db')));

    // cardcatalog hands indexPath back as given, so check it on disk.
    assert.ok(fs.existsSync(pathLib.join(cwd, 'index')));
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
