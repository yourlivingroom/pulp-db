import cardcatalog from '@yourlivingroom/cardcatalog';
import fs from 'fs';
import PQueue from 'p-queue';
import pathLib from 'path';
import writeFileAtomic from 'write-file-atomic';

import { produce as immerProduce } from 'immer';

export default function pulpDb(indexes = {}, opts = {}) {
    // Two ways to back an index:
    //  - live (default): cardcatalog maintains it in a watched LevelDB — fast,
    //    but holds an exclusive lock and runs a background watcher.
    //  - inline (opts.inline): no persistent structure. Index queries scan the
    //    collection and run each index's process() in memory to answer a single
    //    question, then discard. No LevelDB, no watcher, no lock — usable by a
    //    short-lived utility (e.g. the CLI) beside a live server, and a fine fit
    //    for low-frequency lookups. The query API is identical either way.
    const cc = opts.inline
        ? null
        : cardcatalog(indexes, {
              dataPath: opts.dataPath,
              indexPath: opts.indexPath,
              // We store <id>.json and write atomically (write-file-atomic leaves
              // transient <id>.json.<number> temp files); index only settled docs.
              shouldIndex: (path) => path.endsWith('.json'),
          });
    const dataPath = cc ? cc.dataPath : (opts.dataPath ?? './db');
    const catalogs = cc ? cc.indexes : inlineCatalogs(indexes, dataPath);

    // writeFileAtomic already martials requests to a single path, but we also
    // need to martial deletes, so we implement our own per-path-martialing.
    const pathQueues = new Map();

    async function pathQueue(p, fn) {
        let q = pathQueues.get(p);
        if (!q) {
            q = new PQueue({ concurrency: 1 });
            pathQueues.set(p, q);
        }

        try {
            return await q.add(fn);
        } finally {
            // Retire the queue only once it is genuinely finished and still
            // the one registered for this path. Dropping it earlier (as an
            // onIdle() callback registered at creation time does, since
            // onIdle resolves immediately on an empty queue) means the next
            // edit builds a fresh queue and runs concurrently with work
            // still in flight — a lost update.
            if (q.size === 0 && q.pending === 0 && pathQueues.get(p) === q) {
                pathQueues.delete(p);
            }
        }
    }

    return {
        async close() {
            if (cc) await cc.close();
        },
        async edit(path, updater, opts = {}) {
            path = pathLib.join(dataPath, path);

            const result = await pathQueue(path, async () => {
                let curJsonValue;
                try {
                    curJsonValue = JSON.parse(
                        await fs.promises.readFile(path, 'utf8'),
                    );
                } catch (e) {
                    if (e.code === 'ENOENT') {
                        curJsonValue = undefined;
                    } else {
                        const e2 = new Error(e.message);
                        e2.cause = e;
                        throw e2;
                    }
                }

                let shouldDelete = false;
                const newJsonValue = immerProduce(curJsonValue, (draft) =>
                    updater(draft, {
                        delete: () => {
                            shouldDelete = true;
                        },
                    }),
                );

                // immer returns a promise when the recipe does, and we have
                // no way to apply an async result atomically here — without
                // this check the promise itself would be serialized, writing
                // "{}" over the document.
                if (typeof newJsonValue?.then === 'function') {
                    newJsonValue.catch(() => {}); // don't leak a rejection
                    throw new TypeError(
                        'pulp-db updaters must be synchronous; ' +
                            'do async work before calling edit()',
                    );
                }

                if (shouldDelete) {
                    await fs.promises.unlink(path);
                } else if (curJsonValue !== newJsonValue) {
                    try {
                        await fs.promises.mkdir(pathLib.dirname(path), {
                            recursive: true,
                        });
                        await writeFileAtomic(
                            path,
                            JSON.stringify(newJsonValue, null, 4),
                        );
                    } catch (e) {
                        // writeFileAtomic() helpfully throws erros without
                        // stack traces.
                        const e2 = new Error(e.message);
                        e2.cause = e;
                        throw e2;
                    }
                }

                return {
                    oldValue: curJsonValue,
                    newValue: newJsonValue,
                    deleted: shouldDelete,
                };
            });

            // Strong-consistency escape hatch: block until the live index
            // reflects this write. No-op when inline (queries scan live) or when
            // nothing happened. Handy for tests and read-after-write.
            //
            // Deletes have to be checked separately: immer hands back the same
            // reference when the recipe returns nothing, so a delete usually
            // leaves oldValue === newValue and would otherwise be skipped here,
            // leaving the document queryable until the watcher caught up.
            const changed =
                result.deleted || result.oldValue !== result.newValue;
            if (opts.awaitIndex && cc && changed) {
                await cc.reindex(path);
            }

            return {
                oldValue: result.oldValue,
                newValue: result.newValue,
            };
        },
        async get(path) {
            path = pathLib.join(dataPath, path);

            try {
                return JSON.parse(await fs.promises.readFile(path, 'utf8'));
            } catch (e) {
                if (e.code === 'ENOENT') {
                    return undefined;
                }

                const e2 = new Error(e.message);
                e2.cause = e;
                throw e2;
            }
        },

        // Directly enumerate a collection from disk (bypasses the index, so it
        // is strongly consistent — a just-written record always appears). Each
        // entry is { path, value }; `path` is relative to the collection's
        // dataPath, matching what get()/edit() accept.
        async list({ values = true } = {}) {
            let names;
            try {
                names = await fs.promises.readdir(dataPath);
            } catch (e) {
                if (e.code === 'ENOENT') {
                    return [];
                }

                const e2 = new Error(e.message);
                e2.cause = e;
                throw e2;
            }

            names = names.filter((n) => n.endsWith('.json'));

            if (!values) {
                return names.map((name) => ({ path: name }));
            }

            return await Promise.all(
                names.map(async (name) => ({
                    path: name,
                    value: JSON.parse(
                        await fs.promises.readFile(
                            pathLib.join(dataPath, name),
                            'utf8',
                        ),
                    ),
                })),
            );
        },
        indexes: catalogs,

        // Where documents live. Absolute in live mode (cardcatalog resolves
        // it); as supplied in inline mode.
        dataPath,

        // Where the live index databases live; undefined when inline, since
        // inline mode keeps no persistent index.
        indexPath: cc ? cc.indexPath : undefined,
    };
}

// Answer index queries without any persistent structure: for each query, scan
// the collection and run the index's process() in memory. Mirrors the subset of
// cardcatalog's catalog API that consumers use (get / getMany).
function inlineCatalogs(indexes, dataPath) {
    return Object.fromEntries(
        Object.entries(indexes).map(([name, config]) => [
            name,
            {
                async *getMany(queryKey) {
                    let names;
                    try {
                        names = await fs.promises.readdir(dataPath);
                    } catch (e) {
                        if (e.code === 'ENOENT') return;
                        throw e;
                    }

                    for (const fileName of names) {
                        if (!fileName.endsWith('.json')) continue;
                        const full = pathLib.join(dataPath, fileName);
                        const content = await fs.promises.readFile(full);

                        const emitted = [];
                        try {
                            await config.process(
                                content,
                                (k, v) => emitted.push([k, v]),
                                { path: full },
                            );
                        } catch {
                            continue; // skip docs this index can't process
                        }

                        for (const [k, v] of emitted) {
                            if (keyHasPrefix(queryKey, k)) {
                                yield {
                                    key: k,
                                    path: fileName,
                                    indexValue: v,
                                    read: (...args) =>
                                        fs.promises.readFile(full, ...args),
                                    readSync: (...args) =>
                                        fs.readFileSync(full, ...args),
                                };
                            }
                        }
                    }
                },
                async get(queryKey) {
                    let result = null;
                    for await (const match of this.getMany(queryKey)) {
                        if (result) throw new Error('Multiple matches');
                        result = match;
                    }
                    return result;
                },
            },
        ]),
    );
}

// A query key matches an emitted key when it is a prefix of it — mirrors
// cardcatalog's range query over composite keys.
function keyHasPrefix(queryKey, emittedKey) {
    const q = Array.isArray(queryKey) ? queryKey : [queryKey];
    const k = Array.isArray(emittedKey) ? emittedKey : [emittedKey];
    if (q.length > k.length) return false;
    return q.every((part, i) => part === k[i]);
}
