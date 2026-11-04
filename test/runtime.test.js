import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentRuntimePlan, listLocalAgentRuntimes } from '../src/runtime.js';

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

test('builds a runtime plan only for a task assigned to the selected active Agent', () => {
    const identity = {
        agent: { id: 12, name: 'Vera' },
        company: { name: 'Devetty' },
    };
    const task = {
        id: 42,
        title: 'Investigar canales',
        status: 'open',
        assignee: { type: 'agent', id: 12, name: 'Vera' },
    };

    assert.deepEqual(createAgentRuntimePlan('codex', ['codex', 'claude'], identity, task), {
        provider: 'codex',
        agentId: 12,
        agentName: 'Vera',
        companyName: 'Devetty',
        taskId: 42,
        taskTitle: 'Investigar canales',
        taskStatus: 'open',
    });
    assert.throws(() => createAgentRuntimePlan('codex', ['claude'], identity, task), /no está instalado/);
    assert.throws(() => createAgentRuntimePlan('codex', ['codex'], identity, { ...task, assignee: { type: 'agent', id: 13, name: 'Otra' } }), /asignada/);
    assert.throws(() => createAgentRuntimePlan('codex', ['codex'], identity, { ...task, status: 'blocked' }), /abierta o en curso/);
});
