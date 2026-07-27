/// <reference types="node" />

import type {
    AnyIndexConfig,
    Key,
    Match,
    ValueOf,
} from '@yourlivingroom/cardcatalog';

export type {
    AnyIndexConfig,
    IndexConfig,
    Key,
    Match,
} from '@yourlivingroom/cardcatalog';

/** Handed to an updater so it can remove the document it is editing. */
export interface UpdaterContext {
    /** Delete this document instead of writing it back. */
    delete(): void;
}

/**
 * Produces the document's next value. Mutate `draft` in place, or return a
 * replacement. `draft` is `undefined` when the document does not exist yet, so
 * creating one means returning a value.
 *
 * Must be synchronous: an async updater is rejected rather than applied, since
 * its result could not be written atomically. Do async work before calling
 * `edit`.
 */
export type Updater<Doc> = (
    draft: Doc | undefined,
    context: UpdaterContext,
) => Doc | void;

export interface EditOptions {
    /**
     * Wait for a live index to reflect this change before resolving, so a
     * following query is guaranteed to see it. No-op in inline mode, where
     * queries rescan the collection anyway.
     */
    awaitIndex?: boolean;
}

export interface EditResult<Doc> {
    /** The document before this edit, or `undefined` if it did not exist. */
    oldValue: Doc | undefined;

    /** The document after this edit, or `undefined` if it was deleted. */
    newValue: Doc | undefined;
}

/** A document as reported by `list()`. */
export interface ListEntry<Doc> {
    /** `dataPath`-relative, always `/`-separated; accepted by `get`/`edit`. */
    path: string;
    value: Doc;
}

/** A document as reported by `list({ values: false })`. */
export interface ListPathEntry {
    path: string;
}

/**
 * The query surface pulp-db guarantees in both modes.
 *
 * In live mode these are cardcatalog `Index` objects, which additionally offer
 * `getRange` and `problems`; inline mode implements only what is declared
 * here, so reaching for the extras ties you to live mode.
 */
export interface PulpIndex<Value = unknown> {
    /**
     * The single document matching `key`, or `null` if there is none.
     *
     * @throws if several documents match.
     */
    get(key: Key): Promise<Match<Value> | null>;

    /**
     * Every document matching `key`, including compound keys it prefixes:
     * given `emit(['tag', t], …)`, `getMany(['tag'])` yields every tag entry.
     */
    getMany(key: Key): AsyncGenerator<Match<Value>, void, undefined>;
}

export interface PulpDbOptions {
    /** Directory holding the collection's documents. Default `'./db'`. */
    dataPath?: string;

    /**
     * Where the live index databases live. Default `'./index'`. Must not be
     * inside `dataPath`, which is rejected at construction. Unused when
     * `inline` is set.
     */
    indexPath?: string;

    /**
     * Answer index queries by scanning the collection instead of maintaining
     * a persistent index. No LevelDB, no watcher, and no exclusive lock, so a
     * short-lived utility can run beside a live server.
     */
    inline?: boolean;
}

export interface PulpDb<
    T extends Record<string, AnyIndexConfig> = Record<string, AnyIndexConfig>,
    Doc = any,
> {
    /** The query surface, keyed by index name. */
    readonly indexes: { [K in keyof T]: PulpIndex<ValueOf<T[K]>> };

    /** Absolute path to the collection's documents. */
    readonly dataPath: string;

    /** Where the live index lives; `undefined` in inline mode. */
    readonly indexPath: string | undefined;

    /**
     * Read a document, transform it, and write the result back atomically.
     * Edits to one path are serialized, so concurrent callers cannot lose
     * each other's writes.
     */
    edit(
        path: string,
        updater: Updater<Doc>,
        opts?: EditOptions,
    ): Promise<EditResult<Doc>>;

    /** Read a document, or `undefined` if it does not exist. */
    get(path: string): Promise<Doc | undefined>;

    /**
     * Enumerate the collection straight from disk at any depth, bypassing the
     * index — so a just-written document always appears.
     */
    list(opts?: { values?: true }): Promise<ListEntry<Doc>[]>;
    list(opts: { values: false }): Promise<ListPathEntry[]>;

    /**
     * Fold a document written past pulp-db into a live index now, rather than
     * waiting for the watcher. Resolves `true` if it was processed, `false`
     * if it was filtered out. A no-op resolving `true` in inline mode.
     */
    reindex(path: string): Promise<boolean>;

    /** Stop watching, drain pending work, and close the index databases. */
    close(): Promise<void>;
}

/**
 * Builds a document store over a directory of JSON files.
 *
 * `Doc` defaults to `any` because documents are arbitrary JSON; supply it to
 * type a collection's contents.
 *
 * @throws TypeError on an invalid index config, or Error if `indexPath` is
 * inside `dataPath`.
 */
export default function pulpDb<
    T extends Record<string, AnyIndexConfig> = Record<string, AnyIndexConfig>,
    Doc = any,
>(indexes?: T, opts?: PulpDbOptions): PulpDb<T, Doc>;
