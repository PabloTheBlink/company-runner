import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ConfigStore } from '../src/config.js';

async function withTemporaryConfig(runTest) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'mycompanies-runner-test-'));
    const store = new ConfigStore(path.join(directory, 'private', 'runner.json'));

    try {
        await runTest(store, directory);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

test('configuration is private, readable by the owner and removable', async () => {
    await withTemporaryConfig(async (store, directory) => {
        const configuration = {
            server_url: 'https://mycompanies.example',
            runner_id: 7,
            workspace_path: directory,
            allow_insecure_localhost: false,
            api_token: 'private-token',
        };

        await store.saveNew(configuration);

        assert.deepEqual(await store.load(), configuration);
        assert.equal((await stat(store.path)).mode & 0o777, 0o600);
        assert.equal((await stat(path.dirname(store.path))).mode & 0o777, 0o700);
        await assert.rejects(store.saveNew(configuration), /Ya existe una configuración Runner/);
        await store.forget();
        await assert.rejects(store.load(), /No hay una configuración Runner/);
    });
});

test('configuration load rejects group-readable files and symbolic links', async () => {
    await withTemporaryConfig(async (store, directory) => {
        await mkdir(path.dirname(store.path), { recursive: true });
        await writeFile(store.path, JSON.stringify({ runner_id: 7 }), { mode: 0o644 });
        await assert.rejects(store.load(), /permite acceso a otros usuarios/);

        const linkedPath = path.join(directory, 'linked.json');
        await symlink(store.path, linkedPath);
        await assert.rejects(new ConfigStore(linkedPath).load(), /enlace simbólico/);
    });
});
