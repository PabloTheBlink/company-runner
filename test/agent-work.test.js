import assert from 'node:assert/strict';
import test from 'node:test';
import { loadAgentTaskContext, parseAgentWorkResponse, runAgentWorkOnce, shouldApplyAgentTaskWrites } from '../src/agent-work.js';

test('local Agent file writes are applied only for completed task outcomes', () => {
    assert.equal(shouldApplyAgentTaskWrites({ status: 'completed' }), true);
    assert.equal(shouldApplyAgentTaskWrites({ status: 'blocked' }), false);
    assert.equal(shouldApplyAgentTaskWrites({ status: 'open' }), false);
    assert.equal(shouldApplyAgentTaskWrites(null), false);
});

test('Agent task context loads only explicitly requested company data through scoped clients', async () => {
    const requests = [];
    const memory = Array.from({ length: 6 }, (_, index) => ({ id: index + 1, title: `Memoria ${index + 1}` }));
    const identity = { permissions: [{ name: 'memory.read' }] };
    const task = { title: 'Decidir próximos pasos', description: 'Revisar evidencia interna.' };
    const agentClient = {
        async searchMemory(options, directory) {
            requests.push({ type: 'memory', options, directory });
            return { memory };
        },
        async getCompanyContext(receivedIdentity, directory) {
            requests.push({ type: 'company', identity: receivedIdentity, directory });
            return { sections: { bets: { access: 'granted', items: [] } } };
        },
    };

    const context = await loadAgentTaskContext({
        identity,
        task,
        agentClient,
        currentDirectory: '/company/root',
        includeMemory: true,
        includeCompanyContext: true,
    });

    assert.equal(context.memory.length, 5);
    assert.equal(context.companyContext.sections.bets.access, 'granted');
    assert.deepEqual(requests, [
        {
            type: 'memory',
            options: { query: 'Decidir próximos pasos\nRevisar evidencia interna.' },
            directory: '/company/root',
        },
        { type: 'company', identity, directory: '/company/root' },
    ]);
});

test('Agent task memory context refuses to search without the memory.read grant', async () => {
    let searchCount = 0;
    await assert.rejects(loadAgentTaskContext({
        identity: { permissions: [] },
        task: { title: 'Revisar', description: null },
        agentClient: { async searchMemory() { searchCount += 1; return { memory: [] }; } },
        currentDirectory: '/company/root',
        includeMemory: true,
        includeCompanyContext: false,
    }), /memory\.read/);
    assert.equal(searchCount, 0);
});

test('parses only a bounded structured task result with an allowed final state', () => {
    assert.deepEqual(parseAgentWorkResponse('{"status":"completed","summary":"Informe preparado."}'), {
        status: 'completed',
        summary: 'Informe preparado.',
    });
    for (const invalid of [
        'not JSON',
        '{"status":"completed","summary":"ok","command":"rm -rf /"}',
        '{"status":"cancelled","summary":"ok"}',
        '{"status":"completed","summary":""}',
    ]) {
        assert.throws(() => parseAgentWorkResponse(invalid));
    }
    assert.throws(() => parseAgentWorkResponse('x'.repeat(16_385)), /supera el límite/);
    assert.throws(() => parseAgentWorkResponse(JSON.stringify({ status: 'completed', summary: 'x'.repeat(4001) })), /formato estructurado/);
});

test('worker skips tasks assigned elsewhere and active leases, then finishes only the claimed task', async () => {
    const claims = [];
    const finished = [];
    const executed = [];
    const pages = new Map([
        ['open', { tasks: [
            { id: 1, title: 'Otra persona', status: 'open', assignee: { type: 'user', name: 'Pablo' } },
            { id: 2, title: 'Ya reservada', status: 'open', assignee: { type: 'agent', id: 9, name: 'Vera' } },
            { id: 3, title: 'Disponible', status: 'open', assignee: { type: 'agent', id: 9, name: 'Vera' } },
        ], has_more: false, next_after: null }],
        ['in_progress', { tasks: [], has_more: false, next_after: null }],
    ]);

    const result = await runAgentWorkOnce({
        agentId: 9,
        provider: 'codex',
        listTasks: async (_directory, afterId, status) => pages.get(status),
        getTask: async (taskId) => ({ ...pages.get('open').tasks.find(({ id }) => id === taskId), description: 'Do the work.' }),
        claimTask: async (taskId, token) => {
            claims.push({ taskId, token });
            if (taskId === 2) {
                const conflict = new Error('occupied');
                conflict.status = 409;
                throw conflict;
            }
            return { task_id: taskId, claim_token: token, lease_expires_at: '2026-11-05T12:02:00Z' };
        },
        heartbeatTaskClaim: async () => ({ renewed: true }),
        finishTaskClaim: async (taskId, token, status, summary) => {
            finished.push({ taskId, token, status, summary });
            return { task: { id: taskId, status }, replayed: false };
        },
        executeTask: async ({ task, provider, signal }) => {
            executed.push({ task, provider, signal, keys: Object.keys({ task, provider, signal }) });
            return { status: 'completed', summary: 'Informe listo.' };
        },
        createClaimToken: () => 'C'.repeat(80),
        heartbeatIntervalMs: 60_000,
    });

    assert.equal(result.task.id, 3);
    assert.equal(result.finish.task.status, 'completed');
    assert.deepEqual(claims.map(({ taskId }) => taskId), [2, 3]);
    assert.equal(claims[0].token.length, 80);
    assert.deepEqual(finished, [{ taskId: 3, token: 'C'.repeat(80), status: 'completed', summary: 'Informe listo.' }]);
    assert.equal(executed.length, 1);
    assert.equal(executed[0].task.id, 3);
    assert.equal(executed[0].provider, 'codex');
    assert.deepEqual(executed[0].keys.sort(), ['provider', 'signal', 'task']);
});

test('worker returns no work when no active task is assigned to this Agent', async () => {
    let claimCount = 0;
    const result = await runAgentWorkOnce({
        agentId: 9,
        provider: 'codex',
        listTasks: async (_directory, _afterId, status) => ({
            tasks: status === 'open' ? [{ id: 1, title: 'Sin asignar', status, assignee: null }] : [],
            has_more: false,
            next_after: null,
        }),
        getTask: async (taskId) => ({ id: taskId, title: 'Disponible', status: 'open', assignee: { type: 'agent', id: 9, name: 'Vera' } }),
        claimTask: async () => { claimCount++; },
        heartbeatTaskClaim: async () => {},
        finishTaskClaim: async () => {},
        executeTask: async () => { throw new Error('must not execute'); },
    });

    assert.equal(result, null);
    assert.equal(claimCount, 0);
});

test('CEO worker skips a parent task until all delegated children are completed', async () => {
    let claimCount = 0;
    let eligibleCount = 0;
    const result = await runAgentWorkOnce({
        agentId: 9,
        provider: 'codex',
        listTasks: async (_directory, _afterId, status) => ({
            tasks: status === 'open' ? [{ id: 22, title: 'Coordinar', status, assignee: { type: 'agent', id: 9, name: 'Vera' } }] : [],
            has_more: false,
            next_after: null,
        }),
        getTask: async () => ({ id: 22, status: 'open', assignee: { type: 'agent', id: 9, name: 'Vera' } }),
        isCandidateEligible: async () => { eligibleCount++; return false; },
        claimTask: async () => { claimCount++; },
        heartbeatTaskClaim: async () => {},
        finishTaskClaim: async () => {},
        executeTask: async () => { throw new Error('must not execute'); },
    });

    assert.equal(result, null);
    assert.equal(eligibleCount, 1);
    assert.equal(claimCount, 0);
});

test('blocked outcomes record that staged local changes were discarded', async () => {
    let recordedSummary = null;
    const result = await runAgentWorkOnce({
        agentId: 9,
        provider: 'codex',
        listTasks: async (_directory, _afterId, status) => ({
            tasks: status === 'open' ? [{
                id: 8,
                title: 'Gather evidence',
                status: 'open',
                assignee: { type: 'agent', id: 9, name: 'Vera' },
            }] : [],
            has_more: false,
            next_after: null,
        }),
        getTask: async () => ({
            id: 8,
            status: 'in_progress',
            assignee: { type: 'agent', id: 9, name: 'Vera' },
        }),
        claimTask: async (taskId, claimToken) => ({ task_id: taskId, claim_token: claimToken }),
        heartbeatTaskClaim: async () => ({ renewed: true }),
        finishTaskClaim: async (_taskId, _claimToken, _status, summary) => {
            recordedSummary = summary;
            return { task: { id: 8, status: 'blocked' }, replayed: false };
        },
        executeTask: async () => ({ status: 'blocked', summary: 'Falta permiso de lectura.' }),
        createClaimToken: () => 'D'.repeat(80),
        heartbeatIntervalMs: 60_000,
    });

    assert.equal(recordedSummary, 'Resultado blocked; cambios locales descartados. Falta permiso de lectura.');
    assert.equal(result.outcome.summary, recordedSummary);
});

test('CEO delegation can keep a parent open without describing discarded local writes', async () => {
    let recordedSummary = null;
    await runAgentWorkOnce({
        agentId: 9,
        provider: 'codex',
        listTasks: async (_directory, _afterId, status) => ({
            tasks: status === 'open' ? [{
                id: 23,
                title: 'Coordinar análisis',
                status: 'open',
                assignee: { type: 'agent', id: 9, name: 'Vera' },
            }] : [],
            has_more: false,
            next_after: null,
        }),
        getTask: async () => ({
            id: 23,
            status: 'in_progress',
            assignee: { type: 'agent', id: 9, name: 'Vera' },
        }),
        claimTask: async (taskId, claimToken) => ({ task_id: taskId, claim_token: claimToken }),
        heartbeatTaskClaim: async () => ({ renewed: true }),
        finishTaskClaim: async (_taskId, _claimToken, _status, summary) => {
            recordedSummary = summary;
            return { task: { id: 23, status: 'open' }, replayed: false };
        },
        executeTask: async () => ({
            status: 'open',
            summary: 'Delegué dos subtareas a Gala y Marta.',
            localWrites: false,
        }),
        createClaimToken: () => 'E'.repeat(80),
        heartbeatIntervalMs: 60_000,
    });

    assert.equal(recordedSummary, 'Delegué dos subtareas a Gala y Marta.');
});

test('worker validates structured outcomes and aborts execution if the lease heartbeat is lost', async () => {
    await assert.rejects(runAgentWorkOnce({
        agentId: 9,
        provider: 'codex',
        listTasks: async (_directory, _afterId, status) => ({
            tasks: status === 'open' ? [{ id: 3, title: 'Disponible', status, assignee: { type: 'agent', id: 9, name: 'Vera' } }] : [],
            has_more: false,
            next_after: null,
        }),
        getTask: async (taskId) => ({ id: taskId, title: 'Disponible', status: 'open', assignee: { type: 'agent', id: 9, name: 'Vera' } }),
        claimTask: async (taskId, claimToken) => ({ task_id: taskId, claim_token: claimToken }),
        heartbeatTaskClaim: async () => { throw new Error('lease lost'); },
        finishTaskClaim: async () => { throw new Error('must not finish'); },
        executeTask: async () => ({ status: 'unexpected', summary: 'x' }),
        createClaimToken: () => 'C'.repeat(80),
    }), /resultado estructurado/);

    await assert.rejects(runAgentWorkOnce({
        agentId: 9,
        provider: 'codex',
        listTasks: async (_directory, _afterId, status) => ({
            tasks: status === 'open' ? [{ id: 3, title: 'Disponible', status, assignee: { type: 'agent', id: 9, name: 'Vera' } }] : [],
            has_more: false,
            next_after: null,
        }),
        getTask: async (taskId) => ({ id: taskId, title: 'Disponible', status: 'open', assignee: { type: 'agent', id: 9, name: 'Vera' } }),
        claimTask: async (taskId, claimToken) => ({ task_id: taskId, claim_token: claimToken }),
        heartbeatTaskClaim: async () => { throw new Error('lease lost'); },
        finishTaskClaim: async () => { throw new Error('must not finish'); },
        executeTask: async ({ signal }) => new Promise((resolve) => {
            const timer = setTimeout(() => resolve({ status: 'completed', summary: 'done' }), 50);
            signal.addEventListener('abort', () => {
                clearTimeout(timer);
                resolve({ status: 'completed', summary: 'done' });
            }, { once: true });
        }),
        createClaimToken: () => 'C'.repeat(80),
        heartbeatIntervalMs: 1_000,
        setIntervalImplementation: (callback) => {
            queueMicrotask(callback);
            return { unref() {} };
        },
        clearIntervalImplementation: () => {},
    }), /lease lost/);
});
