import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentRuntimePlan, isLocalFileOperationAllowed, listLocalAgentRuntimes } from '../src/runtime.js';

test('allows only an explicitly granted Agent, operation, and exact local path', () => {
    const grants = [
        { agentId: 12, path: '.env', operations: ['read', 'write'] },
        { agentId: 12, path: 'reports/daily.md', operations: ['read'] },
    ];

    assert.equal(isLocalFileOperationAllowed(12, grants, 'read', '.env'), true);
    assert.equal(isLocalFileOperationAllowed(12, grants, 'write', '.env'), true);
    assert.equal(isLocalFileOperationAllowed(12, grants, 'write', 'reports/daily.md'), false);
    assert.equal(isLocalFileOperationAllowed(13, grants, 'read', '.env'), false);
    assert.equal(isLocalFileOperationAllowed(12, grants, 'read', '.env.local'), false);
});

test('rejects unsafe paths and unsupported local file operations', () => {
    const grants = [{ agentId: 12, path: '.env', operations: ['read', 'write'] }];

    assert.equal(isLocalFileOperationAllowed(12, grants, 'read', '../.env'), false);
    assert.equal(isLocalFileOperationAllowed(12, grants, 'read', '/etc/passwd'), false);
    assert.equal(isLocalFileOperationAllowed(12, grants, 'read', '.env\nAUTORIZAR'), false);
    assert.equal(isLocalFileOperationAllowed(12, grants, 'read', 'reports/'), false);
    assert.equal(isLocalFileOperationAllowed(12, grants, 'delete', '.env'), false);
    assert.equal(isLocalFileOperationAllowed(12, grants, 'read', ''), false);
});

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
