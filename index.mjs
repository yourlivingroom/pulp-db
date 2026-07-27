import cardcatalog from '@yourlivingroom/cardcatalog';
import fs from 'fs';
import PQueue from 'p-queue';
import pathLib from 'path';
import writeFileAtomic from 'write-file-atomic';

import { produce as immerProduce } from 'immer';

// Depth-first walk yielding dataPath-relative, '/'-separated paths of the
// collection's documents. Paths are assembled from entry names rather than
// taken from readdir, so separators match cardcatalog's portable keys on every
// platform. Directories are recognized before the .json suffix is considered,
// so a directory that happens to be named like a document is not mistaken for
// one. A collection that does not exist yet is simply empty.
async function listJsonFiles(dir, prefix = '') {
    let entries;
    try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch (e) {
        if (e.code === 'ENOENT') {
            return [];
        }
        throw e;
    }

    const found = [];
    for (const entry of entries) {
        const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;

        if (entry.isDirectory()) {
            found.push(
                ...(await listJsonFiles(
                    pathLib.join(dir, entry.name),
                    relPath,
                )),
            );
        } else if (entry.name.endsWith('.json')) {
            found.push(relPath);
        }
    }
    return found;
}

export default function pulpDb(indexes = {}, opts = {}) {
    const dataPathOpt = opts.dataPath ?? './db';
    const indexPathOpt = opts.indexPath ?? './index';

    // The collection is scanned recursively, so an index database living
    // inside it would be walked on every list() and inline query — and, worse,
    // handed to cardcatalog as documents to watch.
    if (!opts.inline) {
        const resolvedData = pathLib.resolve(dataPathOpt);
        const resolvedIndex = pathLib.resolve(indexPathOpt);
        const rel = pathLib.relative(resolvedData, resolvedIndex);

        if (rel === '' || (!rel.startsWith('..') && !pathLib.isAbsolute(rel))) {
            throw new Error(
                'indexPath must not be inside dataPath: ' +
                    `${resolvedIndex} is inside ${resolvedData}`,
            );
        }
    }

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
              dataPath: dataPathOpt,
              indexPath: indexPathOpt,
              // We store <id>.json and write atomically (write-file-atomic leaves
              // transient <id>.json.<number> temp files); index only settled docs.
              shouldIndex: (path) => path.endsWith('.json'),
          });
    const dataPath = cc ? cc.dataPath : dataPathOpt;
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
                        throw rewrapError(e);
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
                        // writeFileAtomic() throws without a usable stack
                        // trace; rewrapping restores one.
                        throw rewrapError(e);
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
                newValue: result.deleted ? undefined : result.newValue,
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

                throw rewrapError(e);
            }
        },

        // Directly enumerate a collection from disk (bypasses the index, so it
        // is strongly consistent — a just-written record always appears). Each
        // entry is { path, value }; `path` is relative to the collection's
        // dataPath, matching what get()/edit() accept.
        async list({ values = true } = {}) {
            let names;
            try {
                names = await listJsonFiles(dataPath);
            } catch (e) {
                throw rewrapError(e);
            }

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

// fs and write-file-atomic both throw errors whose stack traces point into
// library internals rather than at the caller. Rewrapping fixes that, but the
// code has to come along or callers lose the ability to tell EACCES from
// EISDIR without digging through .cause.
function rewrapError(e) {
    const wrapped = new Error(e.message, { cause: e });
    if (e.code !== undefined) {
        wrapped.code = e.code;
    }
    return wrapped;
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
                        names = await listJsonFiles(dataPath);
                    } catch (e) {
                        throw rewrapError(e);
                    }

                    for (const relPath of names) {
                        const full = pathLib.join(dataPath, relPath);
                        const content = await fs.promises.readFile(full);

                        const emitted = [];
                        try {
                            // cardcatalog hands process() a dataPath-relative
                            // path, so match that rather than an absolute one.
                            await config.process(
                                content,
                                (k, v) => emitted.push([k, v]),
                                { path: relPath },
                            );
                        } catch {
                            continue; // skip docs this index can't process
                        }

                        for (const [k, v] of emitted) {
                            if (keyHasPrefix(queryKey, k)) {
                                yield {
                                    key: k,
                                    path: relPath,
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
