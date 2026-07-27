import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import pathLib from 'node:path';

import { test } from 'node:test';

// The debug logger is chosen at module load, so the env var must be set (and
// console.log stubbed, since debug binds it) before index.mjs is imported.
// That is why this lives in its own file: node:test gives it a fresh process.
process.env.PULP_DB_DEBUG = '1';

const logs = [];
console.log = (...args) => logs.push(args);

const { default: pulpDb } = await import('../index.mjs');

test('PULP_DB_DEBUG logs absorbed index errors', async (t) => {
    const root = fs.mkdtempSync(pathLib.join(os.tmpdir(), 'pulp-db-'));
    const db = pulpDb(
        { words: { process: (content, emit) => emit('k', '') } },
        {
            dataPath: pathLib.join(root, 'db'),
            indexPath: pathLib.join(root, 'index'),
        },
    );
    t.after(async () => {
        await db.close();
        fs.rmSync(root, {
            recursive: true,
            force: true,
            maxRetries: 10,
            retryDelay: 50,
        });
    });

    const realRead = fs.promises.readFile;
    fs.promises.readFile = async (...args) => {
        if (String(args[0]).endsWith('boom.json')) {
            throw Object.assign(new Error('denied'), { code: 'EACCES' });
        }
        return realRead(...args);
    };
    t.after(() => {
        fs.promises.readFile = realRead;
    });

    // Written past pulp-db so the watcher drives the failing read, which is
    // what reaches the catalog's 'error' event.
    fs.writeFileSync(pathLib.join(db.dataPath, 'boom.json'), '{}');
    await new Promise((r) => setTimeout(r, 800));
    fs.promises.readFile = realRead;

    const flat = logs.flat().map(String).join('\n');
    assert.match(flat, /index error, continuing/);
});
