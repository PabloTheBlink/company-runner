import assert from 'node:assert/strict';
import test from 'node:test';
import { startAgentDirectReports } from '../src/agent-team.js';

test('team startup launches only active direct reports with task access and local credentials', async () => {
    const starts = [];
    const identity = {
        agent: { id: 25, name: 'Vera' },
        company: { id: 4, name: 'Dev' },
        permissions: [{ name: 'agents.permissions.manage', scope: 'company' }],
    };
    const reports = [
        { id: 6, name: 'Gala', status: 'active', permissions: [{ name: 'tasks.read', scope: 'workspace:4' }] },
        { id: 7, name: 'Pausado', status: 'paused', permissions: [{ name: 'tasks.read', scope: 'company' }] },
        { id: 8, name: 'Sin acceso', status: 'active', permissions: [] },
    ];
    const configStore = {
        async listAgentIdentitiesForDirectory(directory, selectedAgentId) {
            assert.equal(directory, '/company');
            assert.equal(selectedAgentId, '25');
            return [{ id: 6, name: 'Gala' }];
        },
        async loadAgentForDirectory(directory, selectedAgentId) {
            assert.equal(selectedAgentId, '6');
            return { agent_id: 6, company_id: 4, company_root_path: directory };
        },
    };
    const agentClient = {
        async listAgents() { return { agents: reports, has_more: false, next_after: null }; },
    };

    const started = await startAgentDirectReports({
        identity,
        provider: 'codex',
        includeCompanyContext: true,
        includeMemory: true,
        currentDirectory: '/company',
        companyRootPath: '/company',
        configStore,
        agentClient,
        command: '/usr/bin/node',
        scriptPath: '/runner/src/cli.js',
        statePathForAgent: (agentId) => `/config/workers/${agentId}/state.json`,
        startWorker: async (options) => {
            starts.push(options);
            return { ...options.metadata, status: 'starting' };
        },
    });

    assert.deepEqual(started.map(({ agent_id, status }) => ({ agent_id, status })), [{ agent_id: 6, status: 'starting' }]);
    assert.equal(starts.length, 1);
    assert.equal(starts[0].statePath, '/config/workers/6/state.json');
    assert.deepEqual(starts[0].args, [
        '/runner/src/cli.js', 'agent', 'service', '--provider=codex', '--include-company-context',
    ]);
    assert.equal(starts[0].metadata.agent_id, 6);
    assert.equal(starts[0].metadata.include_memory, false);
});

test('team startup issues a child credential only when the parent grant permits it', async () => {
    let identityReads = 0;
    let issuedCredentials = 0;
    const starts = [];
    const identity = {
        agent: { id: 25, name: 'Vera' },
        company: { id: 4, name: 'Dev' },
        permissions: [
            { name: 'agents.permissions.manage', scope: 'company' },
            { name: 'agents.credentials.manage', scope: 'company' },
        ],
    };
    const configStore = {
        async listAgentIdentitiesForDirectory() {
            identityReads++;
            return identityReads === 1 ? [] : [{ id: 6, name: 'Gala' }];
        },
        async loadAgentForDirectory() { return { agent_id: 6, company_id: 4, company_root_path: '/company' }; },
    };
    const agentClient = {
        async listAgents() {
            return { agents: [{ id: 6, name: 'Gala', status: 'active', permissions: [{ name: 'tasks.read', scope: 'company' }] }], has_more: false, next_after: null };
        },
        async issueCredential(agentId, name) {
            assert.equal(agentId, 6);
            assert.match(name, /Gala/);
            issuedCredentials++;
        },
    };

    await startAgentDirectReports({
        identity,
        provider: 'claude',
        currentDirectory: '/company',
        companyRootPath: '/company',
        configStore,
        agentClient,
        command: '/usr/bin/node',
        scriptPath: '/runner/src/cli.js',
        statePathForAgent: (agentId) => `/config/workers/${agentId}/state.json`,
        startWorker: async (options) => { starts.push(options); return { ...options.metadata, status: 'starting' }; },
    });

    assert.equal(issuedCredentials, 1);
    assert.equal(starts.length, 1);
    assert.equal(starts[0].metadata.provider, 'claude');
});

test('team startup does not inspect or launch reports without the parent management grant', async () => {
    let listCount = 0;
    const started = await startAgentDirectReports({
        identity: { agent: { id: 25 }, permissions: [] },
        provider: 'codex',
        currentDirectory: '/company',
        companyRootPath: '/company',
        configStore: {},
        agentClient: { async listAgents() { listCount++; } },
        command: '/usr/bin/node',
        scriptPath: '/runner/src/cli.js',
        statePathForAgent: () => '/config/state.json',
        startWorker: async () => { throw new Error('must not start'); },
    });

    assert.deepEqual(started, []);
    assert.equal(listCount, 0);
});
