import cardcatalog from '@yourlivingroom/cardcatalog';
import fs from 'fs';
import PQueue from 'p-queue';
import pathLib from 'path';
import writeFileAtomic from 'write-file-atomic';

import { produce as immerProduce } from 'immer';

// Index bookkeeping is chatty; keep it off unless debugging.
const debug = process.env.PULP_DB_DEBUG ? console.log.bind(console) : () => {};

// Failures that mean the index itself is unusable, as opposed to one document
// being momentarily unreadable. Continuing past these would quietly serve
// stale or empty results forever, which is worse than stopping.
const FATAL_CODES = new Set(['ENOSPC', 'EROFS']);

function isFatalIndexError(e) {
    const code = e?.code;
    return (
        typeof code === 'string' &&
        (code.startsWith('LEVEL_') || FATAL_CODES.has(code))
    );
}

// Windows refuses to rename over or unlink a file while another handle has it
// open, reporting EPERM (occasionally EBUSY). That happens routinely here: the
// index watcher reads a document moments after it changes, so an atomic write
// landing at the wrong instant fails through no fault of the caller. The
// condition clears on its own, so retry briefly before giving up. POSIX has no
// such restriction and never takes the retry path.
async function retryingLockErrors(op) {
    for (let attempt = 0; ; attempt++) {
        try {
            return await op();
        } catch (e) {
            if ((e.code !== 'EPERM' && e.code !== 'EBUSY') || attempt >= 5) {
                throw e;
            }
            await new Promise((r) => setTimeout(r, 10 * 2 ** attempt));
        }
    }
}

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
    const cc = cardcatalog(indexes, {
        dataPath: dataPathOpt,
        indexPath: indexPathOpt,
        // We store <id>.json and write atomically (write-file-atomic leaves
        // transient <id>.json.<number> temp files); index only settled docs.
        shouldIndex: (path) => path.endsWith('.json'),
        inline: opts.inline,
    });
    // cardcatalog reports infrastructure failures on an 'error' event with
    // EventEmitter's usual contract: unhandled means the process dies. One
    // unreadable document should not take a server down with it, so absorb
    // those and log them. A broken index database is not survivable in the
    // same way, so it is rethrown — asynchronously, because throwing from
    // inside emit() would surface as an unhandled rejection rather than the
    // crash it is.
    {
        cc.on('error', (e) => {
            /* c8 ignore start -- reaching this needs a LevelDB failure during
               a watcher-driven update, which cannot be provoked from outside
               without an escape hatch into the catalog. */
            if (isFatalIndexError(e)) {
                setImmediate(() => {
                    throw e;
                });
                return;
            }
            /* c8 ignore stop */
            debug('pulp-db: index error, continuing:', e);
        });
    }

    const dataPath = cc.dataPath;

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
            await cc.close();
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
                    try {
                        await retryingLockErrors(() =>
                            fs.promises.unlink(path),
                        );
                    } catch (e) {
                        // Deleting a document that is not there is not a
                        // failure: the end state the caller asked for already
                        // holds. Without this every call site has to guard,
                        // which is exactly what every call site was doing.
                        if (e.code !== 'ENOENT') {
                            throw rewrapError(e);
                        }
                    }
                } else if (curJsonValue !== newJsonValue) {
                    try {
                        await fs.promises.mkdir(pathLib.dirname(path), {
                            recursive: true,
                        });
                        const serialized = JSON.stringify(
                            newJsonValue,
                            null,
                            4,
                        );
                        await retryingLockErrors(() =>
                            writeFileAtomic(path, serialized),
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
        // "This document changed on disk; fold it into the index now." For
        // documents written past pulp-db — dropped in by hand, synced, or
        // restored from a backup — rather than waiting for the watcher to
        // notice. Resolves true if the document was processed, false if it
        // was filtered out (anything not named *.json). Inline mode keeps no
        // persistent index and rescans on every query, so this is a no-op
        // there and resolves true.
        async reindex(path) {
            return await cc.reindex(pathLib.join(dataPath, path));
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
        indexes: cc.indexes,

        // Where documents live. Absolute in live mode (cardcatalog resolves
        // it); as supplied in inline mode.
        dataPath,

        // Where the live index databases live; undefined when inline, since
        // inline mode keeps no persistent index.
        indexPath: cc.indexPath,
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
