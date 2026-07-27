// Type-level tests, checked by `npm run typecheck` (tsc --noEmit) rather than
// executed. A compile error here is a failing test, and negative cases use the
// ts-expect-error directive, which is itself an error when the line below it
// stops failing — so the assertions hold in both directions.
//
// This lives in test-d/, NOT test/: Node's runner treats every file under
// test/ as a test file and strips TypeScript natively, so it would be run, and
// the deliberately-invalid calls below would throw.
import pulpDb from '../index.mjs';
import type {
    AnyIndexConfig,
    EditResult,
    ListEntry,
    ListPathEntry,
    Match,
    PulpDb,
    PulpIndex,
} from '../index.mjs';

type Equal<A, B> =
    (<G>() => G extends A ? 1 : 2) extends <G>() => G extends B ? 1 : 2
        ? true
        : false;
type Expect<T extends true> = T;

// --- construction ----------------------------------------------------------

const db = pulpDb(
    {
        byTag: {
            valueEncoding: 'json',
            process: (content, emit, context) => {
                type _Content = Expect<Equal<typeof content, Buffer>>;
                type _Path = Expect<Equal<typeof context.path, string>>;
                emit(['tag', 'x'], 'title');
            },
        },
    },
    { dataPath: './db', indexPath: './index', inline: false },
);

// Every argument is optional.
pulpDb();
pulpDb({});
pulpDb({}, {});
pulpDb({}, { inline: true });

// @ts-expect-error - process is required on an index config
pulpDb({ byTag: {} });

// @ts-expect-error - unknown option
pulpDb({}, { datapath: './db' });

// @ts-expect-error - dataPath is a string
pulpDb({}, { dataPath: 5 });

const asPulpDb: PulpDb = db;
void asPulpDb;

// --- index names are tracked ----------------------------------------------

type _Names = Expect<Equal<keyof typeof db.indexes, 'byTag'>>;

db.indexes.byTag;

// @ts-expect-error - no such index
db.indexes.nope;

// The full cardcatalog surface, in both modes.
db.indexes.byTag.getRange({});
db.indexes.byTag.getRange({ gte: ['tag'], reverse: true, limit: 2 });
db.indexes.byTag.problems();

// @ts-expect-error - limit is a number
db.indexes.byTag.getRange({ limit: 'two' });

// --- documents -------------------------------------------------------------

async function documents() {
    const doc = await db.get('a.json');
    // Doc defaults to any, so reading fields needs no cast.
    doc?.anything;

    const result = await db.edit('a.json', (draft) => ({ title: 'Alpha' }));
    type _Result = Expect<Equal<typeof result, EditResult<any>>>;

    // A draft may not exist yet, and an updater may return nothing.
    await db.edit('a.json', (draft, { remove }) => {
        if (draft === undefined) return;
        remove();
    });

    // The handle is named so it can be destructured; `delete` is reserved.
    await db.edit('a.json', (draft, context) => {
        context.remove();
        // @ts-expect-error - renamed to remove
        context.delete();
    });

    await db.edit('a.json', (draft) => draft, { awaitIndex: true });

    // @ts-expect-error - unknown edit option
    await db.edit('a.json', (draft) => draft, { await: true });

    const reindexed = await db.reindex('a.json');
    type _Reindex = Expect<Equal<typeof reindexed, boolean>>;

    type _DataPath = Expect<Equal<typeof db.dataPath, string>>;
    type _IndexPath = Expect<Equal<typeof db.indexPath, string | undefined>>;

    const closed = await db.close();
    type _Close = Expect<Equal<typeof closed, void>>;
}

// --- list overloads --------------------------------------------------------

async function listing() {
    for await (const entry of db.list()) {
        type _Default = Expect<Equal<typeof entry, ListEntry<any>>>;
        entry.value;
        entry.path.trim();
    }

    for await (const entry of db.list({ values: true })) {
        type _Explicit = Expect<Equal<typeof entry, ListEntry<any>>>;
        entry.value;
    }

    for await (const entry of db.list({ values: false })) {
        type _PathsOnly = Expect<Equal<typeof entry, ListPathEntry>>;
        entry.path.trim();

        // @ts-expect-error - no value when values: false
        entry.value;
    }
}

// --- queries ---------------------------------------------------------------

async function queries() {
    const one = await db.indexes.byTag.get(['tag', 'x']);
    type _One = Expect<Equal<typeof one, Match<unknown> | null>>;

    // Keys accept every charwise-encodable shape.
    await db.indexes.byTag.get('scalar');
    await db.indexes.byTag.get(42);
    await db.indexes.byTag.get(null);
    await db.indexes.byTag.get(['tag', ['nested', 1]]);

    // @ts-expect-error - undefined is cardcatalog's reserved range sentinel
    await db.indexes.byTag.get(undefined);

    for await (const match of db.indexes.byTag.getMany(['tag'])) {
        type _Path = Expect<Equal<typeof match.path, string>>;
        const raw = await match.read();
        type _Raw = Expect<Equal<typeof raw, Buffer>>;
        const text = await match.read('utf8');
        type _Text = Expect<Equal<typeof text, string>>;
    }
}

// --- typed documents -------------------------------------------------------

interface Book {
    title: string;
    tags?: string[];
}

async function typedDocuments() {
    const typed = pulpDb<Record<string, AnyIndexConfig>, Book>();

    const book = await typed.get('a.json');
    type _Book = Expect<Equal<typeof book, Book | undefined>>;
    book?.title.trim();

    for await (const entry of typed.list()) {
        type _Entries = Expect<Equal<typeof entry, ListEntry<Book>>>;
        entry.value.title.trim();
    }

    const edited = await typed.edit('a.json', (draft) => ({ title: 'Alpha' }));

    // Checked field by field: comparing the whole result against
    // EditResult<Book> would pass no matter what EditResult contained.
    type _Old = Expect<Equal<typeof edited.oldValue, Book | undefined>>;
    type _New = Expect<Equal<typeof edited.newValue, Book | undefined>>;

    // A deleted document is reported as gone, so newValue must be narrowed.
    // @ts-expect-error - possibly undefined
    edited.newValue.title;

    // The draft may not exist yet either.
    await typed.edit('a.json', (draft) => {
        // @ts-expect-error - possibly undefined
        draft.title = 'Beta';
    });

    // @ts-expect-error - a Book has a title
    await typed.edit('a.json', (draft) => ({ nope: true }));
}

// --- the declared index surface --------------------------------------------

const surface: PulpIndex = db.indexes.byTag;
void surface;

export {};
