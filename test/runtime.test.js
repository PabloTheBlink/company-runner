import assert from 'node:assert/strict';
import test from 'node:test';
import { listLocalAgentRuntimes } from '../src/runtime.js';

test('lists supported local providers without returning executable paths', async () => {
    const checkedPaths = [];
    const isRunnable = async (executablePath) => {
        checkedPaths.push(executablePath);

        return executablePath === '/tools/codex';
    };

    assert.deepEqual(await listLocalAgentRuntimes('/bin:/tools', 'linux', isRunnable), [
        { provider: 'codex', command: 'codex' },
    ]);
    assert.deepEqual(checkedPaths, ['/bin/codex', '/tools/codex', '/bin/claude', '/tools/claude']);
});

test('reports no local runtimes when PATH is empty', async () => {
    assert.deepEqual(await listLocalAgentRuntimes(''), []);
});
