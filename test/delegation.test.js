import assert from 'node:assert/strict';
import test from 'node:test';
import { applyDelegationPlan, createDelegationPlan, parseDelegationResponse } from '../src/delegation.js';

const reports = [
    { id: 6, name: 'Gala', role: 'Marketing', status: 'active', permissions: [{ name: 'tasks.read', scope: 'workspace:4' }] },
    { id: 17, name: 'Marta', role: 'Market', status: 'active', permissions: [{ name: 'tasks.read', scope: 'workspace:4' }] },
];

test('parses one strict JSON delegation plan and accepts only direct reports with task access', () => {
    const plan = parseDelegationResponse(JSON.stringify({ tasks: [
        { title: 'Investigar alternativas', description: 'Comparar tres opciones.', assignee_agent_id: 17, priority: 'normal' },
    ] }), { workspaceId: 4, reports });

    assert.deepEqual(plan, [{
        title: 'Investigar alternativas',
        description: 'Comparar tres opciones.',
        assigneeAgentId: 17,
        priority: 'normal',
        workspaceId: 4,
    }]);
});

test('rejects malformed, oversized, duplicate, out-of-scope, and unauthorized delegation plans', () => {
    for (const response of [
        'not json',
        JSON.stringify({ tasks: [] }),
        JSON.stringify({ tasks: Array.from({ length: 4 }, (_, index) => ({ title: `Task ${index}`, description: 'x', assignee_agent_id: 6, priority: 'normal' })) }),
        JSON.stringify({ tasks: [{ title: 'Task', description: 'x', assignee_agent_id: 99, priority: 'normal' }] }),
        JSON.stringify({ tasks: [{ title: 'Task', description: 'x', assignee_agent_id: 6, priority: 'urgent', command: 'rm -rf /' }] }),
        JSON.stringify({ tasks: [{ title: 'Task', description: 'x', assignee_agent_id: 6, priority: 'normal', workspace_id: 99 }] }),
        JSON.stringify({ tasks: [
            { title: 'Same', description: 'x', assignee_agent_id: 6, priority: 'normal' },
            { title: 'Same', description: 'x', assignee_agent_id: 6, priority: 'normal' },
        ] }),
    ]) {
        assert.throws(() => parseDelegationResponse(response, { workspaceId: 4, reports }));
    }

    assert.throws(() => parseDelegationResponse(JSON.stringify({ tasks: [
        { title: 'No grant', description: 'x', assignee_agent_id: 6, priority: 'normal' },
    ] }), { workspaceId: 4, reports: [{ ...reports[0], permissions: [] }] }), /tasks.read/);
});

test('the CEO may choose to execute a task without delegation only when coordination explicitly allows it', () => {
    const response = JSON.stringify({ tasks: [] });
    assert.throws(() => parseDelegationResponse(response, { workspaceId: 4, reports }));
    assert.deepEqual(parseDelegationResponse(response, { workspaceId: 4, reports, allowEmpty: true }), []);
});

test('creates deterministic UUID idempotency keys per parent task and action index', () => {
    const first = createDelegationPlan(140, [{ title: 'Research', description: 'Check signal', assigneeAgentId: 6, priority: 'normal', workspaceId: 4 }]);
    const retry = createDelegationPlan(140, [{ title: 'Research', description: 'Check signal', assigneeAgentId: 6, priority: 'normal', workspaceId: 4 }]);
    const changedPlan = createDelegationPlan(140, [{ title: 'Different plan', description: 'Changed proposal', assigneeAgentId: 6, priority: 'high', workspaceId: 4 }]);
    const otherParent = createDelegationPlan(141, [{ title: 'Research', description: 'Check signal', assigneeAgentId: 6, priority: 'normal', workspaceId: 4 }]);

    assert.match(first[0].idempotencyKey, /^[0-9a-f-]{36}$/);
    assert.equal(first[0].idempotencyKey, retry[0].idempotencyKey);
    assert.equal(first[0].idempotencyKey, changedPlan[0].idempotencyKey);
    assert.notEqual(first[0].idempotencyKey, otherParent[0].idempotencyKey);
});

test('applies tasks sequentially through the authenticated client and stops on an API error', async () => {
    const calls = [];
    const applied = await applyDelegationPlan({
        parentTaskId: 140,
        tasks: [{ title: 'Investigar señal', description: 'Revisar datos disponibles.', assigneeAgentId: 17, priority: 'normal', workspaceId: 4 }],
        createTask: async (data, key) => {
            calls.push(['create', data, key]);
            return { id: 501 };
        },
        assignTask: async (taskId, agentId) => {
            calls.push(['assign', taskId, agentId]);
            return { id: taskId, assignee: { type: 'agent', id: agentId, name: 'Marta' } };
        },
    });

    assert.equal(applied[0].task.id, 501);
    assert.equal(calls[0][0], 'create');
    assert.equal(calls[0][1].workspace_id, 4);
    assert.equal(calls[0][1].parent_task_id, 140);
    assert.match(calls[0][1].description, /Subtarea de MyCompanies #140/);
    assert.deepEqual(calls[1], ['assign', 501, 17]);

    await assert.rejects(applyDelegationPlan({
        parentTaskId: 140,
        tasks: [{ title: 'Investigar señal', description: 'Revisar datos disponibles.', assigneeAgentId: 17, priority: 'normal', workspaceId: 4 }],
        createTask: async () => ({ id: 502 }),
        assignTask: async () => { throw new Error('API denegó la asignación'); },
    }), /API denegó/);

    await assert.rejects(applyDelegationPlan({
        parentTaskId: 140,
        tasks: [{ title: 'Investigar señal', description: 'Revisar datos disponibles.', assigneeAgentId: 17, priority: 'normal', workspaceId: 4 }],
        createTask: async () => ({ task: { id: 503 } }),
        assignTask: async (taskId) => ({ id: taskId, assignee: { type: 'agent', id: 6, name: 'Gala' } }),
    }), /no confirmó el responsable/);
});
