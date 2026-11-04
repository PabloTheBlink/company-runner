import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { AgentClient, RunnerClient, normalizeServerUrl } from '../src/client.js';
import { ConfigStore } from '../src/config.js';

async function withTemporaryDirectory(runTest) {
    const directory = await mkdtemp(path.join(process.cwd(), '.mycompanies-runner-test-'));

    try {
        await runTest(directory);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

async function listen(server) {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    return `http://127.0.0.1:${server.address().port}`;
}

test('enrollment and heartbeat use the API token and never send the local workspace path', async () => {
    await withTemporaryDirectory(async (directory) => {
        const workspacePath = path.join(directory, 'workspace');
        await mkdir(workspacePath);
        const configStore = new ConfigStore(path.join(directory, 'config', 'runner.json'));
        let enrollmentCalls = 0;
        let heartbeatCalls = 0;
        const server = createServer(async (request, response) => {
            if (request.url === '/api/v1/runner/enrollments/exchange') {
                enrollmentCalls++;
                let body = '';
                for await (const chunk of request) body += chunk;
                assert.equal(JSON.parse(body).code, 'C'.repeat(64));
                response.writeHead(201, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ runner_id: 7, api_token: 'T'.repeat(80) }));
                return;
            }

            if (request.url === '/api/v1/runner/heartbeat') {
                heartbeatCalls++;
                assert.equal(request.headers.authorization, `Bearer ${'T'.repeat(80)}`);
                let body = '';
                for await (const chunk of request) body += chunk;
                assert.equal(body.includes(workspacePath), false);
                response.writeHead(200, { 'content-type': 'application/json' });
                response.end(JSON.stringify({
                    runner_id: 7,
                    runner_name: 'Runner devetty',
                    company_name: 'Devetty',
                    status: 'online',
                    last_seen_at: '2026-11-04T10:00:00Z',
                    workspaces: [{ id: 9, name: 'Contenido y Dev.to' }],
                }));
                return;
            }

            response.writeHead(404);
            response.end();
        });
        const serverUrl = await listen(server);

        try {
            const client = new RunnerClient(configStore);
            const runnerId = await client.enroll(serverUrl, 'C'.repeat(64), workspacePath, true);
            const heartbeat = await client.heartbeat(workspacePath);

            assert.equal(runnerId, 7);
            assert.equal(heartbeat.runner_id, 7);
            assert.equal(heartbeat.company_name, 'Devetty');
            assert.deepEqual(heartbeat.workspaces, [{ id: 9, name: 'Contenido y Dev.to' }]);
            assert.equal(enrollmentCalls, 1);
            assert.equal(heartbeatCalls, 1);
        } finally {
            server.close();
            await once(server, 'close');
        }
    });
});

test('server URLs require HTTPS except explicitly allowed loopback', () => {
    assert.equal(normalizeServerUrl('https://example.com'), 'https://example.com');
    assert.equal(normalizeServerUrl('http://127.0.0.1:8150', true), 'http://127.0.0.1:8150');
    assert.throws(() => normalizeServerUrl('http://example.com', true), /Usa HTTPS/);
    assert.throws(() => normalizeServerUrl('http://127.0.0.1:8150'), /Usa HTTPS/);
    assert.throws(() => normalizeServerUrl('https://example.com/path'), /URL base/);
});

test('agent login verifies identity before storing its credential separately from Runner', async () => {
    await withTemporaryDirectory(async (directory) => {
        const companyRoot = path.join(directory, 'company');
        const nestedProject = path.join(companyRoot, 'repo');
        await mkdir(nestedProject, { recursive: true });
        const configStore = new ConfigStore(path.join(directory, 'config', 'runner.json'));
        const token = 'A'.repeat(80);
        const server = createServer((request, response) => {
            assert.equal(request.url, '/api/v1/agent/me');
            assert.equal(request.headers.authorization, `Bearer ${token}`);
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({
                agent: { id: 12, uuid: 'c376a06b-8b47-4b50-9438-3a522af9f1fa', name: 'Vera', role: 'CEO' },
                company: { id: 4, name: 'Devetty' },
                permissions: [{ name: 'tasks.read', scope: 'company', workspace_id: null, workspace_name: null }],
            }));
        });
        const serverUrl = await listen(server);

        try {
            const client = new AgentClient(configStore);
            const identity = await client.login(serverUrl, token, companyRoot, true);
            assert.equal(identity.agent.name, 'Vera');
            assert.equal(identity.company.name, 'Devetty');
            assert.deepEqual(await client.identity(nestedProject), identity);
            assert.equal((await configStore.readRegistrations()).length, 0);
        } finally {
            server.close();
            await once(server, 'close');
        }
    });
});

test('agent task listing uses the Agent credential, cursor and company scope returned by MyCompanies', async () => {
    await withTemporaryDirectory(async (directory) => {
        const companyRoot = path.join(directory, 'company');
        await mkdir(companyRoot);
        const configStore = new ConfigStore(path.join(directory, 'config', 'runner.json'));
        const token = 'A'.repeat(80);
        let requestCount = 0;
        const server = createServer((request, response) => {
            requestCount++;
            assert.equal(request.url, '/api/v1/agent/tasks?after_id=25');
            assert.equal(request.headers.authorization, `Bearer ${token}`);
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({
                tasks: [{
                    id: 26,
                    title: 'Revisar informe',
                    status: 'in_progress',
                    priority: 'high',
                    due_date: null,
                    assignee: { type: 'agent', name: 'Vera' },
                    workspace: null,
                }],
                has_more: false,
                next_after: null,
            }));
        });
        const serverUrl = await listen(server);
        await configStore.saveAgent({
            server_url: serverUrl,
            agent_id: 12,
            agent_name: 'Vera',
            company_id: 4,
            company_name: 'Devetty',
            company_root_path: companyRoot,
            allow_insecure_localhost: true,
            api_token: token,
        });

        try {
            const tasks = await new AgentClient(configStore).listTasks(companyRoot, 25);
            assert.equal(tasks.tasks[0].id, 26);
            assert.equal(tasks.tasks[0].workspace, null);
            assert.equal(requestCount, 1);
        } finally {
            server.close();
            await once(server, 'close');
        }
    });
});

test('agent task detail retrieves only the requested task and accepts a company-level task without Workspace', async () => {
    await withTemporaryDirectory(async (directory) => {
        const companyRoot = path.join(directory, 'company');
        await mkdir(companyRoot);
        const configStore = new ConfigStore(path.join(directory, 'config', 'runner.json'));
        const token = 'A'.repeat(80);
        const server = createServer((request, response) => {
            assert.equal(request.url, '/api/v1/agent/tasks/26');
            assert.equal(request.headers.authorization, `Bearer ${token}`);
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({
                task: {
                    id: 26,
                    title: 'Revisar informe',
                    description: 'Comparar resultados con los objetivos acordados.',
                    status: 'open',
                    priority: 'normal',
                    due_date: null,
                    assignee: null,
                    workspace: null,
                },
            }));
        });
        const serverUrl = await listen(server);
        await configStore.saveAgent({
            server_url: serverUrl,
            agent_id: 12,
            agent_name: 'Vera',
            company_id: 4,
            company_name: 'Devetty',
            company_root_path: companyRoot,
            allow_insecure_localhost: true,
            api_token: token,
        });

        try {
            const task = await new AgentClient(configStore).getTask(26, companyRoot);
            assert.equal(task.description, 'Comparar resultados con los objetivos acordados.');
            assert.equal(task.workspace, null);
            await assert.rejects(new AgentClient(configStore).getTask(0, companyRoot), /entero positivo/);
        } finally {
            server.close();
            await once(server, 'close');
        }
    });
});

test('agent bet list and detail use Agent auth and validate returned evidence', async () => {
    await withTemporaryDirectory(async (directory) => {
        const companyRoot = path.join(directory, 'company');
        await mkdir(companyRoot);
        const configStore = new ConfigStore(path.join(directory, 'config', 'runner.json'));
        const token = 'A'.repeat(80);
        const server = createServer((request, response) => {
            assert.equal(request.headers.authorization, `Bearer ${token}`);
            response.writeHead(200, { 'content-type': 'application/json' });
            if (request.url === '/api/v1/agent/bets?after_id=5') {
                response.end(JSON.stringify({
                    bets: [{ id: 6, title: 'Informe', status: 'investigating' }],
                    has_more: false,
                    next_after: null,
                }));
                return;
            }
            assert.equal(request.url, '/api/v1/agent/bets/6');
            response.end(JSON.stringify({
                bet: {
                    id: 6,
                    title: 'Informe',
                    hypothesis: 'La demanda es suficiente.',
                    description: null,
                    status: 'investigating',
                    evidences: [{
                        id: 3,
                        title: 'Entrevistas',
                        details: 'Cinco conversaciones positivas.',
                        assessment: 'supports',
                        source_url: null,
                        recorded_by: null,
                    }],
                },
            }));
        });
        const serverUrl = await listen(server);
        await configStore.saveAgent({
            server_url: serverUrl,
            agent_id: 12,
            agent_name: 'Vera',
            company_id: 4,
            company_name: 'Devetty',
            company_root_path: companyRoot,
            allow_insecure_localhost: true,
            api_token: token,
        });

        try {
            const client = new AgentClient(configStore);
            const bets = await client.listBets(companyRoot, 5);
            const bet = await client.getBet(6, companyRoot);
            assert.equal(bets.bets[0].id, 6);
            assert.equal(bet.evidences[0].assessment, 'supports');
            await assert.rejects(client.getBet(0, companyRoot), /entero positivo/);
        } finally {
            server.close();
            await once(server, 'close');
        }
    });
});

test('agent offer list and detail use the company-scoped read API', async () => {
    await withTemporaryDirectory(async (directory) => {
        const companyRoot = path.join(directory, 'company');
        await mkdir(companyRoot);
        const configStore = new ConfigStore(path.join(directory, 'config', 'runner.json'));
        const token = 'A'.repeat(80);
        const server = createServer((request, response) => {
            assert.equal(request.headers.authorization, `Bearer ${token}`);
            response.writeHead(200, { 'content-type': 'application/json' });
            if (request.url === '/api/v1/agent/offers?after_id=25') {
                response.end(JSON.stringify({
                    offers: [{ id: 26, name: 'Informe mensual', type: 'service', status: 'preparing', bet_id: 7 }],
                    has_more: false,
                    next_after: null,
                }));
                return;
            }
            assert.equal(request.url, '/api/v1/agent/offers/26');
            response.end(JSON.stringify({
                offer: {
                    id: 26,
                    name: 'Informe mensual',
                    type: 'service',
                    description: 'Informe sobre el mercado.',
                    status: 'preparing',
                    bet_id: 7,
                },
            }));
        });
        const serverUrl = await listen(server);
        await configStore.saveAgent({
            server_url: serverUrl,
            agent_id: 12,
            agent_name: 'Vera',
            company_id: 4,
            company_name: 'Devetty',
            company_root_path: companyRoot,
            allow_insecure_localhost: true,
            api_token: token,
        });

        try {
            const client = new AgentClient(configStore);
            const list = await client.listOffers(companyRoot, 25);
            assert.equal(list.offers[0].bet_id, 7);
            const detail = await client.getOffer(26, companyRoot);
            assert.equal(detail.description, 'Informe sobre el mercado.');
        } finally {
            server.close();
            await once(server, 'close');
        }
    });
});

test('agent goal list and detail use the company-scoped read API', async () => {
    await withTemporaryDirectory(async (directory) => {
        const companyRoot = path.join(directory, 'company');
        await mkdir(companyRoot);
        const configStore = new ConfigStore(path.join(directory, 'config', 'runner.json'));
        const token = 'A'.repeat(80);
        const server = createServer((request, response) => {
            assert.equal(request.headers.authorization, `Bearer ${token}`);
            response.writeHead(200, { 'content-type': 'application/json' });
            if (request.url === '/api/v1/agent/goals?after_id=25') {
                response.end(JSON.stringify({
                    goals: [{ id: 26, title: 'Validar Dev.to', status: 'active', target_date: '2026-12-01' }],
                    has_more: false,
                    next_after: null,
                }));
                return;
            }
            assert.equal(request.url, '/api/v1/agent/goals/26');
            response.end(JSON.stringify({
                goal: {
                    id: 26,
                    title: 'Validar Dev.to',
                    description: 'Probar publicaciones.',
                    success_criteria: 'Conseguir contactos cualificados.',
                    status: 'active',
                    target_date: '2026-12-01',
                },
            }));
        });
        const serverUrl = await listen(server);
        await configStore.saveAgent({
            server_url: serverUrl,
            agent_id: 12,
            agent_name: 'Vera',
            company_id: 4,
            company_name: 'Devetty',
            company_root_path: companyRoot,
            allow_insecure_localhost: true,
            api_token: token,
        });

        try {
            const client = new AgentClient(configStore);
            const list = await client.listGoals(companyRoot, 25);
            assert.equal(list.goals[0].target_date, '2026-12-01');
            const detail = await client.getGoal(26, companyRoot);
            assert.equal(detail.success_criteria, 'Conseguir contactos cualificados.');
        } finally {
            server.close();
            await once(server, 'close');
        }
    });
});

test('agent asset list and detail use the company-scoped read API', async () => {
    await withTemporaryDirectory(async (directory) => {
        const companyRoot = path.join(directory, 'company');
        await mkdir(companyRoot);
        const configStore = new ConfigStore(path.join(directory, 'config', 'runner.json'));
        const token = 'A'.repeat(80);
        const server = createServer((request, response) => {
            assert.equal(request.headers.authorization, `Bearer ${token}`);
            response.writeHead(200, { 'content-type': 'application/json' });
            if (request.url === '/api/v1/agent/assets?after_id=25') {
                response.end(JSON.stringify({
                    assets: [{ id: 26, name: 'devetty.es', type: 'domain', url: 'https://devetty.es' }],
                    has_more: false,
                    next_after: null,
                }));
                return;
            }
            assert.equal(request.url, '/api/v1/agent/assets/26');
            response.end(JSON.stringify({
                asset: {
                    id: 26,
                    name: 'devetty.es',
                    type: 'domain',
                    description: 'Dominio principal.',
                    url: 'https://devetty.es',
                },
            }));
        });
        const serverUrl = await listen(server);
        await configStore.saveAgent({
            server_url: serverUrl,
            agent_id: 12,
            agent_name: 'Vera',
            company_id: 4,
            company_name: 'Devetty',
            company_root_path: companyRoot,
            allow_insecure_localhost: true,
            api_token: token,
        });

        try {
            const client = new AgentClient(configStore);
            const list = await client.listAssets(companyRoot, 25);
            assert.equal(list.assets[0].url, 'https://devetty.es');
            const detail = await client.getAsset(26, companyRoot);
            assert.equal(detail.description, 'Dominio principal.');
        } finally {
            server.close();
            await once(server, 'close');
        }
    });
});

test('agent workspace list and detail use the company-scoped read API', async () => {
    await withTemporaryDirectory(async (directory) => {
        const companyRoot = path.join(directory, 'company');
        await mkdir(companyRoot);
        const configStore = new ConfigStore(path.join(directory, 'config', 'runner.json'));
        const token = 'A'.repeat(80);
        const server = createServer((request, response) => {
            assert.equal(request.headers.authorization, `Bearer ${token}`);
            response.writeHead(200, { 'content-type': 'application/json' });
            if (request.url === '/api/v1/agent/workspaces?after_id=25') {
                response.end(JSON.stringify({
                    workspaces: [{ id: 26, uuid: '6b7a2b59-1e1b-4e42-b658-ffb2212f3f56', name: 'Web Devetty', status: 'active' }],
                    has_more: false,
                    next_after: null,
                }));
                return;
            }
            assert.equal(request.url, '/api/v1/agent/workspaces/26');
            response.end(JSON.stringify({
                workspace: {
                    id: 26,
                    uuid: '6b7a2b59-1e1b-4e42-b658-ffb2212f3f56',
                    name: 'Web Devetty',
                    description: 'Web y contenidos.',
                    status: 'active',
                },
            }));
        });
        const serverUrl = await listen(server);
        await configStore.saveAgent({
            server_url: serverUrl,
            agent_id: 12,
            agent_name: 'Vera',
            company_id: 4,
            company_name: 'Devetty',
            company_root_path: companyRoot,
            allow_insecure_localhost: true,
            api_token: token,
        });

        try {
            const client = new AgentClient(configStore);
            const list = await client.listWorkspaces(companyRoot, 25);
            assert.equal(list.workspaces[0].uuid, '6b7a2b59-1e1b-4e42-b658-ffb2212f3f56');
            const detail = await client.getWorkspace(26, companyRoot);
            assert.equal(detail.description, 'Web y contenidos.');
        } finally {
            server.close();
            await once(server, 'close');
        }
    });
});

test('agent lists direct reports and only their active permissions', async () => {
    await withTemporaryDirectory(async (directory) => {
        const companyRoot = path.join(directory, 'company');
        await mkdir(companyRoot);
        const configStore = new ConfigStore(path.join(directory, 'config', 'runner.json'));
        const token = 'A'.repeat(80);
        const server = createServer((request, response) => {
            assert.equal(request.url, '/api/v1/agent/agents?after_id=25');
            assert.equal(request.headers.authorization, `Bearer ${token}`);
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({
                agents: [{
                    id: 26,
                    uuid: '6b7a2b59-1e1b-4e42-b658-ffb2212f3f56',
                    name: 'Directora marketing',
                    role: 'Marketing',
                    status: 'active',
                    permissions: [{ name: 'bets.read', scope: 'company' }],
                }],
                has_more: false,
                next_after: null,
            }));
        });
        const serverUrl = await listen(server);
        await configStore.saveAgent({
            server_url: serverUrl,
            agent_id: 12,
            agent_name: 'Vera',
            company_id: 4,
            company_name: 'Devetty',
            company_root_path: companyRoot,
            allow_insecure_localhost: true,
            api_token: token,
        });

        try {
            const client = new AgentClient(configStore);
            const result = await client.listAgents(companyRoot, 25);
            assert.equal(result.agents[0].permissions[0].name, 'bets.read');
        } finally {
            server.close();
            await once(server, 'close');
        }
    });
});

test('agent creates a direct report without assigning permissions or a credential', async () => {
    await withTemporaryDirectory(async (directory) => {
        const companyRoot = path.join(directory, 'company');
        await mkdir(companyRoot);
        const configStore = new ConfigStore(path.join(directory, 'config', 'runner.json'));
        const token = 'A'.repeat(80);
        const server = createServer(async (request, response) => {
            assert.equal(request.method, 'POST');
            assert.equal(request.url, '/api/v1/agent/agents');
            assert.equal(request.headers.authorization, `Bearer ${token}`);
            let body = '';
            for await (const chunk of request) body += chunk;
            assert.deepEqual(JSON.parse(body), {
                name: 'Directora marketing',
                role: 'Marketing',
                instructions: 'Investiga canales y comparte fuentes.',
            });
            response.writeHead(201, { 'content-type': 'application/json' });
            response.end(JSON.stringify({
                agent: {
                    id: 26,
                    uuid: '6b7a2b59-1e1b-4e42-b658-ffb2212f3f56',
                    name: 'Directora marketing',
                    role: 'Marketing',
                    status: 'active',
                    reports_to_agent_id: 12,
                    permissions: [],
                },
            }));
        });
        const serverUrl = await listen(server);
        await configStore.saveAgent({
            server_url: serverUrl,
            agent_id: 12,
            agent_name: 'Vera',
            company_id: 4,
            company_name: 'Devetty',
            company_root_path: companyRoot,
            allow_insecure_localhost: true,
            api_token: token,
        });

        try {
            const client = new AgentClient(configStore);
            const agent = await client.createAgent({
                name: 'Directora marketing',
                role: 'Marketing',
                instructions: 'Investiga canales y comparte fuentes.',
            }, companyRoot);
            assert.equal(agent.reports_to_agent_id, 12);
            assert.deepEqual(agent.permissions, []);
        } finally {
            server.close();
            await once(server, 'close');
        }
    });
});

test('agent delegates a held grant to a direct report within the API scope', async () => {
    await withTemporaryDirectory(async (directory) => {
        const companyRoot = path.join(directory, 'company');
        await mkdir(companyRoot);
        const configStore = new ConfigStore(path.join(directory, 'config', 'runner.json'));
        const token = 'A'.repeat(80);
        const server = createServer(async (request, response) => {
            assert.equal(request.method, 'POST');
            assert.equal(request.url, '/api/v1/agent/agents/26/permissions');
            assert.equal(request.headers.authorization, `Bearer ${token}`);
            let body = '';
            for await (const chunk of request) body += chunk;
            assert.deepEqual(JSON.parse(body), { permission: 'tasks.read', workspace_id: 8 });
            response.writeHead(201, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ grant: { id: 91, permission: 'tasks.read', scope: 'workspace:8', granted_by: 'Vera' } }));
        });
        const serverUrl = await listen(server);
        await configStore.saveAgent({
            server_url: serverUrl,
            agent_id: 12,
            agent_name: 'Vera',
            company_id: 4,
            company_name: 'Devetty',
            company_root_path: companyRoot,
            allow_insecure_localhost: true,
            api_token: token,
        });

        try {
            const result = await new AgentClient(configStore).grantAgentPermission(26, 'tasks.read', 8, companyRoot);
            assert.equal(result.id, 91);
            assert.equal(result.scope, 'workspace:8');
        } finally {
            server.close();
            await once(server, 'close');
        }
    });
});

test('agent revokes a direct report permission and returns the descendant count', async () => {
    await withTemporaryDirectory(async (directory) => {
        const companyRoot = path.join(directory, 'company');
        await mkdir(companyRoot);
        const configStore = new ConfigStore(path.join(directory, 'config', 'runner.json'));
        const token = 'A'.repeat(80);
        const server = createServer((request, response) => {
            assert.equal(request.method, 'DELETE');
            assert.equal(request.url, '/api/v1/agent/agents/26/permissions/91');
            assert.equal(request.headers.authorization, `Bearer ${token}`);
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ revoked_count: 3 }));
        });
        const serverUrl = await listen(server);
        await configStore.saveAgent({
            server_url: serverUrl,
            agent_id: 12,
            agent_name: 'Vera',
            company_id: 4,
            company_name: 'Devetty',
            company_root_path: companyRoot,
            allow_insecure_localhost: true,
            api_token: token,
        });

        try {
            assert.deepEqual(await new AgentClient(configStore).revokeAgentPermission(26, 91, companyRoot), { revoked_count: 3 });
        } finally {
            server.close();
            await once(server, 'close');
        }
    });
});

test('agent offer status update uses the management endpoint and confirms its actor', async () => {
    await withTemporaryDirectory(async (directory) => {
        const companyRoot = path.join(directory, 'company');
        await mkdir(companyRoot);
        const configStore = new ConfigStore(path.join(directory, 'config', 'runner.json'));
        const token = 'A'.repeat(80);
        const server = createServer(async (request, response) => {
            assert.equal(request.method, 'PATCH');
            assert.equal(request.url, '/api/v1/agent/offers/26/status');
            assert.equal(request.headers.authorization, `Bearer ${token}`);
            let body = '';
            for await (const chunk of request) body += chunk;
            assert.deepEqual(JSON.parse(body), { status: 'available' });
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({
                offer: {
                    id: 26,
                    status: 'available',
                    changed: true,
                    changed_by: { type: 'agent', id: 12, name: 'Vera' },
                },
            }));
        });
        const serverUrl = await listen(server);
        await configStore.saveAgent({
            server_url: serverUrl,
            agent_id: 12,
            agent_name: 'Vera',
            company_id: 4,
            company_name: 'Devetty',
            company_root_path: companyRoot,
            allow_insecure_localhost: true,
            api_token: token,
        });

        try {
            const result = await new AgentClient(configStore).updateOfferStatus(26, 'available', companyRoot);
            assert.equal(result.changed_by.name, 'Vera');
        } finally {
            server.close();
            await once(server, 'close');
        }
    });
});

test('agent publishes one selected company report and reads its artifact list', async () => {
    await withTemporaryDirectory(async (directory) => {
        const companyRoot = path.join(directory, 'company');
        const reportDirectory = path.join(companyRoot, 'reports');
        await mkdir(reportDirectory, { recursive: true });
        const reportPath = path.join(reportDirectory, 'daily.md');
        await writeFile(reportPath, '# Daily report\nThree opportunities.');
        const configStore = new ConfigStore(path.join(directory, 'config', 'runner.json'));
        const token = 'A'.repeat(80);
        const server = createServer(async (request, response) => {
            assert.equal(request.headers.authorization, `Bearer ${token}`);
            if (request.method === 'POST') {
                assert.equal(request.url, '/api/v1/agent/artifacts');
                assert.match(request.headers['content-type'], /^multipart\/form-data; boundary=/);
                const chunks = [];
                for await (const chunk of request) chunks.push(chunk);
                const body = Buffer.concat(chunks).toString();
                assert.match(body, /name="title"\r\n\r\nInforme diario/);
                assert.match(body, /filename="daily\.md"/);
                assert.match(body, /Three opportunities\./);
                response.writeHead(201, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ artifact: {
                    id: 32,
                    title: 'Informe diario',
                    description: null,
                    source: 'script mercado',
                    original_filename: 'daily.md',
                    mime_type: 'text/plain',
                    size_bytes: 34,
                    sha256: 'a'.repeat(64),
                    created_at: '2026-11-04T12:00:00.000000Z',
                    uploaded_by: { type: 'agent', id: 12, name: 'Analista' },
                } }));
                return;
            }
            assert.equal(request.url, '/api/v1/agent/artifacts?after_id=30');
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ artifacts: [{
                id: 32,
                title: 'Informe diario',
                description: null,
                source: 'script mercado',
                original_filename: 'daily.md',
                mime_type: 'text/plain',
                size_bytes: 34,
                sha256: 'a'.repeat(64),
                created_at: '2026-11-04T12:00:00.000000Z',
                uploaded_by: { type: 'agent', id: 12, name: 'Analista' },
            }], has_more: false, next_after: null }));
        });
        const serverUrl = await listen(server);
        await configStore.saveAgent({
            server_url: serverUrl,
            agent_id: 12,
            agent_name: 'Analista',
            company_id: 4,
            company_name: 'Devetty',
            company_root_path: companyRoot,
            allow_insecure_localhost: true,
            api_token: token,
        });

        try {
            const client = new AgentClient(configStore);
            const published = await client.publishArtifact('reports/daily.md', {
                title: 'Informe diario',
                source: 'script mercado',
            }, companyRoot);
            assert.equal(published.id, 32);
            const list = await client.listArtifacts(companyRoot, 30);
            assert.equal(list.artifacts[0].uploaded_by.name, 'Analista');
        } finally {
            server.close();
            await once(server, 'close');
        }
    });
});

test('agent retrieves company-scoped report metadata by ID', async () => {
    await withTemporaryDirectory(async (directory) => {
        const companyRoot = path.join(directory, 'company');
        await mkdir(companyRoot);
        const configStore = new ConfigStore(path.join(directory, 'config', 'runner.json'));
        const token = 'A'.repeat(80);
        const artifact = {
            id: 32,
            title: 'Informe diario',
            description: 'Tendencias y oportunidades.',
            source: 'devto-stats',
            original_filename: 'daily.md',
            mime_type: 'text/plain',
            size_bytes: 34,
            sha256: 'a'.repeat(64),
            created_at: '2026-11-04T12:00:00.000000Z',
            uploaded_by: { type: 'agent', id: 12, name: 'Informe Dev.to' },
        };
        const server = createServer((request, response) => {
            assert.equal(request.method, 'GET');
            assert.equal(request.headers.authorization, `Bearer ${token}`);
            if (request.url === '/api/v1/agent/artifacts/99') {
                response.writeHead(404, { 'content-type': 'application/json' });
                response.end('{}');
                return;
            }
            assert.equal(request.url, '/api/v1/agent/artifacts/32');
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ artifact }));
        });
        const serverUrl = await listen(server);
        await configStore.saveAgent({
            server_url: serverUrl,
            agent_id: 12,
            agent_name: 'Informe Dev.to',
            company_id: 4,
            company_name: 'Devetty',
            company_root_path: companyRoot,
            allow_insecure_localhost: true,
            api_token: token,
        });

        try {
            const result = await new AgentClient(configStore).getArtifact(32, companyRoot);
            assert.deepEqual(result, artifact);
            await assert.rejects(new AgentClient(configStore).getArtifact(0, companyRoot), /entero positivo/);
            await assert.rejects(new AgentClient(configStore).getArtifact(99, companyRoot), /no existe o no pertenece/);
        } finally {
            server.close();
            await once(server, 'close');
        }
    });
});

test('agent downloads reports only inside the company root without overwriting files', async () => {
    await withTemporaryDirectory(async (directory) => {
        const companyRoot = path.join(directory, 'company');
        const reportDirectory = path.join(companyRoot, 'reports');
        await mkdir(reportDirectory, { recursive: true });
        const configStore = new ConfigStore(path.join(directory, 'config', 'runner.json'));
        const token = 'A'.repeat(80);
        const server = createServer((request, response) => {
            assert.equal(request.method, 'GET');
            assert.equal(request.url, '/api/v1/agent/artifacts/32/download');
            assert.equal(request.headers.authorization, `Bearer ${token}`);
            response.writeHead(200, { 'content-type': 'text/plain' });
            response.end('Shared report.');
        });
        const serverUrl = await listen(server);
        await configStore.saveAgent({
            server_url: serverUrl,
            agent_id: 12,
            agent_name: 'Analista',
            company_id: 4,
            company_name: 'Devetty',
            company_root_path: companyRoot,
            allow_insecure_localhost: true,
            api_token: token,
        });

        try {
            const client = new AgentClient(configStore);
            const result = await client.downloadArtifact(32, 'reports/shared.txt', companyRoot);
            assert.equal(await readFile(result.outputPath, 'utf8'), 'Shared report.');
            assert.equal((await stat(result.outputPath)).mode & 0o777, 0o600);
            await assert.rejects(client.downloadArtifact(32, 'reports/shared.txt', companyRoot), /no se sobrescribe/);
            await assert.rejects(client.downloadArtifact(32, '../../outside.txt', companyRoot), /dentro de la carpeta/);
        } finally {
            server.close();
            await once(server, 'close');
        }
    });
});

test('agent can post evidence to its bet endpoint and receives the recorded actor', async () => {
    await withTemporaryDirectory(async (directory) => {
        const companyRoot = path.join(directory, 'company');
        await mkdir(companyRoot);
        const configStore = new ConfigStore(path.join(directory, 'config', 'runner.json'));
        const token = 'A'.repeat(80);
        const server = createServer(async (request, response) => {
            assert.equal(request.method, 'POST');
            assert.equal(request.url, '/api/v1/agent/bets/42/evidences');
            assert.equal(request.headers.authorization, `Bearer ${token}`);
            let body = '';
            for await (const chunk of request) body += chunk;
            assert.deepEqual(JSON.parse(body), {
                title: 'Entrevistas',
                details: 'Cuatro respuestas coinciden.',
                assessment: 'supports',
            });
            response.writeHead(201, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ evidence: {
                id: 8,
                title: 'Entrevistas',
                details: 'Cuatro respuestas coinciden.',
                assessment: 'supports',
                source_url: null,
                recorded_by: { type: 'agent', id: 12, name: 'Vera' },
            } }));
        });
        const serverUrl = await listen(server);
        await configStore.saveAgent({
            server_url: serverUrl,
            agent_id: 12,
            agent_name: 'Vera',
            company_id: 4,
            company_name: 'Devetty',
            company_root_path: companyRoot,
            allow_insecure_localhost: true,
            api_token: token,
        });

        try {
            const evidence = await new AgentClient(configStore).addBetEvidence(42, {
                title: 'Entrevistas',
                details: 'Cuatro respuestas coinciden.',
                assessment: 'supports',
            }, companyRoot);
            assert.equal(evidence.recorded_by.name, 'Vera');
        } finally {
            server.close();
            await once(server, 'close');
        }
    });
});

test('agent bet status update uses the separate endpoint and validates the recorded actor', async () => {
    await withTemporaryDirectory(async (directory) => {
        const companyRoot = path.join(directory, 'company');
        await mkdir(companyRoot);
        const configStore = new ConfigStore(path.join(directory, 'config', 'runner.json'));
        const token = 'A'.repeat(80);
        const server = createServer(async (request, response) => {
            assert.equal(request.method, 'PATCH');
            assert.equal(request.url, '/api/v1/agent/bets/42/status');
            assert.equal(request.headers.authorization, `Bearer ${token}`);
            let body = '';
            for await (const chunk of request) body += chunk;
            assert.deepEqual(JSON.parse(body), { status: 'investigating' });
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({
                bet: {
                    id: 42,
                    status: 'investigating',
                    changed: true,
                    changed_by: { type: 'agent', id: 12, name: 'Revisor' },
                },
            }));
        });
        const serverUrl = await listen(server);
        await configStore.saveAgent({
            server_url: serverUrl,
            agent_id: 12,
            agent_name: 'Revisor',
            company_id: 4,
            company_name: 'Devetty',
            company_root_path: companyRoot,
            allow_insecure_localhost: true,
            api_token: token,
        });

        try {
            const result = await new AgentClient(configStore).updateBetStatus(42, 'investigating', companyRoot);
            assert.equal(result.changed_by.name, 'Revisor');
        } finally {
            server.close();
            await once(server, 'close');
        }
    });
});

test('agent bet status update reports that converted bets are locked', async () => {
    await withTemporaryDirectory(async (directory) => {
        const companyRoot = path.join(directory, 'company');
        await mkdir(companyRoot);
        const configStore = new ConfigStore(path.join(directory, 'config', 'runner.json'));
        const token = 'A'.repeat(80);
        const server = createServer((request, response) => {
            response.writeHead(409, { 'content-type': 'application/json' });
            response.end('{}');
        });
        const serverUrl = await listen(server);
        await configStore.saveAgent({
            server_url: serverUrl,
            agent_id: 12,
            agent_name: 'Revisor',
            company_id: 4,
            company_name: 'Devetty',
            company_root_path: companyRoot,
            allow_insecure_localhost: true,
            api_token: token,
        });

        try {
            await assert.rejects(
                new AgentClient(configStore).updateBetStatus(42, 'archived', companyRoot),
                /convertida/,
            );
        } finally {
            server.close();
            await once(server, 'close');
        }
    });
});

test('agent converts a validated bet through the offers.manage endpoint', async () => {
    await withTemporaryDirectory(async (directory) => {
        const companyRoot = path.join(directory, 'company');
        await mkdir(companyRoot);
        const configStore = new ConfigStore(path.join(directory, 'config', 'runner.json'));
        const token = 'A'.repeat(80);
        const server = createServer(async (request, response) => {
            assert.equal(request.method, 'POST');
            assert.equal(request.url, '/api/v1/agent/bets/42/conversion');
            assert.equal(request.headers.authorization, `Bearer ${token}`);
            let body = '';
            for await (const chunk of request) body += chunk;
            assert.deepEqual(JSON.parse(body), { type: 'service' });
            response.writeHead(201, { 'content-type': 'application/json' });
            response.end(JSON.stringify({
                offer: {
                    id: 51,
                    bet_id: 42,
                    name: 'Informe de mercado',
                    type: 'service',
                    description: null,
                    status: 'preparing',
                    created_by: { type: 'agent', id: 12, name: 'Directora' },
                },
                bet: { id: 42, status: 'converted', changed: true, changed_by: { type: 'agent', id: 12, name: 'Directora' } },
            }));
        });
        const serverUrl = await listen(server);
        await configStore.saveAgent({
            server_url: serverUrl,
            agent_id: 12,
            agent_name: 'Directora',
            company_id: 4,
            company_name: 'Devetty',
            company_root_path: companyRoot,
            allow_insecure_localhost: true,
            api_token: token,
        });

        try {
            const result = await new AgentClient(configStore).convertBet(42, 'service', companyRoot);
            assert.equal(result.offer.created_by.name, 'Directora');
            assert.equal(result.bet.status, 'converted');
        } finally {
            server.close();
            await once(server, 'close');
        }
    });
});

test('agent status update sends the explicit status to the scoped Agent endpoint', async () => {
    await withTemporaryDirectory(async (directory) => {
        const companyRoot = path.join(directory, 'company');
        await mkdir(companyRoot);
        const configStore = new ConfigStore(path.join(directory, 'config', 'runner.json'));
        const token = 'A'.repeat(80);
        const server = createServer(async (request, response) => {
            assert.equal(request.method, 'PATCH');
            assert.equal(request.url, '/api/v1/agent/tasks/26/status');
            assert.equal(request.headers.authorization, `Bearer ${token}`);
            let requestBody = '';
            for await (const chunk of request) requestBody += chunk;
            assert.deepEqual(JSON.parse(requestBody), { status: 'in_progress' });
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ task: { id: 26, status: 'in_progress' } }));
        });
        const serverUrl = await listen(server);
        await configStore.saveAgent({
            server_url: serverUrl,
            agent_id: 12,
            agent_name: 'Vera',
            company_id: 4,
            company_name: 'Devetty',
            company_root_path: companyRoot,
            allow_insecure_localhost: true,
            api_token: token,
        });

        try {
            assert.deepEqual(await new AgentClient(configStore).updateTaskStatus(26, 'in_progress', companyRoot), {
                id: 26,
                status: 'in_progress',
            });
            await assert.rejects(new AgentClient(configStore).updateTaskStatus(26, 'unknown', companyRoot), /estado no es válido/);
        } finally {
            server.close();
            await once(server, 'close');
        }
    });
});

test('agent task creation sends a stable idempotency key and returns the server result', async () => {
    await withTemporaryDirectory(async (directory) => {
        const companyRoot = path.join(directory, 'company');
        await mkdir(companyRoot);
        const configStore = new ConfigStore(path.join(directory, 'config', 'runner.json'));
        const token = 'A'.repeat(80);
        const idempotencyKey = '94030b4e-0580-42f6-96d6-cb2b2fe7b457';
        const server = createServer(async (request, response) => {
            assert.equal(request.method, 'POST');
            assert.equal(request.url, '/api/v1/agent/tasks');
            assert.equal(request.headers.authorization, `Bearer ${token}`);
            assert.equal(request.headers['idempotency-key'], idempotencyKey);
            let requestBody = '';
            for await (const chunk of request) requestBody += chunk;
            assert.deepEqual(JSON.parse(requestBody), {
                title: 'Revisar el informe',
                description: null,
                priority: 'high',
                due_date: null,
                workspace_id: null,
            });
            response.writeHead(201, { 'content-type': 'application/json' });
            response.end(JSON.stringify({
                task: {
                    id: 27,
                    title: 'Revisar el informe',
                    description: null,
                    status: 'open',
                    priority: 'high',
                    due_date: null,
                    workspace: null,
                },
                created_by: { type: 'agent', id: 12, name: 'Vera' },
                replayed: false,
            }));
        });
        const serverUrl = await listen(server);
        await configStore.saveAgent({
            server_url: serverUrl,
            agent_id: 12,
            agent_name: 'Vera',
            company_id: 4,
            company_name: 'Devetty',
            company_root_path: companyRoot,
            allow_insecure_localhost: true,
            api_token: token,
        });

        try {
            const result = await new AgentClient(configStore).createTask({ title: 'Revisar el informe', priority: 'high' }, idempotencyKey, companyRoot);
            assert.equal(result.task.id, 27);
            assert.equal(result.replayed, false);
            await assert.rejects(new AgentClient(configStore).createTask({ title: 'Otra' }, 'bad-key', companyRoot), /UUID/);
        } finally {
            server.close();
            await once(server, 'close');
        }
    });
});

test('agent assignment sends a target Agent ID through the dedicated scoped endpoint', async () => {
    await withTemporaryDirectory(async (directory) => {
        const companyRoot = path.join(directory, 'company');
        await mkdir(companyRoot);
        const configStore = new ConfigStore(path.join(directory, 'config', 'runner.json'));
        const token = 'A'.repeat(80);
        const server = createServer(async (request, response) => {
            assert.equal(request.method, 'PATCH');
            assert.equal(request.url, '/api/v1/agent/tasks/27/assignee');
            assert.equal(request.headers.authorization, `Bearer ${token}`);
            let requestBody = '';
            for await (const chunk of request) requestBody += chunk;
            assert.deepEqual(JSON.parse(requestBody), { assignee_agent_id: 13 });
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ task: { id: 27, assignee: { type: 'agent', name: 'Marketing' } } }));
        });
        const serverUrl = await listen(server);
        await configStore.saveAgent({
            server_url: serverUrl,
            agent_id: 12,
            agent_name: 'Vera',
            company_id: 4,
            company_name: 'Devetty',
            company_root_path: companyRoot,
            allow_insecure_localhost: true,
            api_token: token,
        });

        try {
            assert.deepEqual(await new AgentClient(configStore).assignTask(27, 13, companyRoot), {
                id: 27,
                assignee: { type: 'agent', name: 'Marketing' },
            });
        } finally {
            server.close();
            await once(server, 'close');
        }
    });
});

test('agent task edit sends only the permitted detail fields to the task endpoint', async () => {
    await withTemporaryDirectory(async (directory) => {
        const companyRoot = path.join(directory, 'company');
        await mkdir(companyRoot);
        const configStore = new ConfigStore(path.join(directory, 'config', 'runner.json'));
        const token = 'A'.repeat(80);
        const server = createServer(async (request, response) => {
            assert.equal(request.method, 'PATCH');
            assert.equal(request.url, '/api/v1/agent/tasks/27');
            assert.equal(request.headers.authorization, `Bearer ${token}`);
            let requestBody = '';
            for await (const chunk of request) requestBody += chunk;
            assert.deepEqual(JSON.parse(requestBody), { title: 'Actualizar métricas', priority: 'high' });
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({
                task: {
                    id: 27,
                    title: 'Actualizar métricas',
                    description: 'Verificar tendencias',
                    status: 'open',
                    priority: 'high',
                    due_date: null,
                    assignee: null,
                    workspace: null,
                },
            }));
        });
        const serverUrl = await listen(server);
        await configStore.saveAgent({
            server_url: serverUrl,
            agent_id: 12,
            agent_name: 'Vera',
            company_id: 4,
            company_name: 'Devetty',
            company_root_path: companyRoot,
            allow_insecure_localhost: true,
            api_token: token,
        });

        try {
            const task = await new AgentClient(configStore).editTask(27, { title: 'Actualizar métricas', priority: 'high' }, companyRoot);
            assert.equal(task.id, 27);
            assert.equal(task.status, 'open');
            await assert.rejects(new AgentClient(configStore).editTask(27, { status: 'completed' }, companyRoot), /solo permite/);
        } finally {
            server.close();
            await once(server, 'close');
        }
    });
});

test('heartbeat does not follow redirects or expose the token in errors', async () => {
    await withTemporaryDirectory(async (directory) => {
        const workspacePath = path.join(directory, 'workspace');
        await mkdir(workspacePath);
        const configStore = new ConfigStore(path.join(directory, 'config', 'runner.json'));
        const token = 'T'.repeat(80);
        let redirectedCalls = 0;
        const destination = createServer((_request, response) => {
            redirectedCalls++;
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end('{}');
        });
        const destinationUrl = await listen(destination);
        const redirecting = createServer((_request, response) => {
            response.writeHead(307, { location: destinationUrl });
            response.end(`secret ${token}`);
        });
        const redirectingUrl = await listen(redirecting);

        try {
            await configStore.saveNew({
                server_url: redirectingUrl,
                runner_id: 7,
                workspace_path: workspacePath,
                allow_insecure_localhost: true,
                api_token: token,
            });
            const client = new RunnerClient(configStore);
            await assert.rejects(client.heartbeat(workspacePath), (error) => {
                assert.match(error.message, /respuesta de heartbeat no válida/);
                assert.equal(error.message.includes(token), false);
                return true;
            });
            assert.equal(redirectedCalls, 0);
        } finally {
            redirecting.close();
            destination.close();
            await Promise.all([once(redirecting, 'close'), once(destination, 'close')]);
        }
    });
});

test('workspace check claims only the fixed capability and returns no local path or command', async () => {
    await withTemporaryDirectory(async (directory) => {
        const workspacePath = path.join(directory, 'workspace');
        await mkdir(workspacePath);
        const token = 'T'.repeat(80);
        const leaseToken = 'L'.repeat(80);
        const configStore = new ConfigStore(path.join(directory, 'config', 'runner.json'));
        let resultPayload;
        const server = createServer(async (request, response) => {
            assert.equal(request.headers.authorization, `Bearer ${token}`);
            if (request.url === '/api/v1/runner/workspace-checks/claim') {
                let requestBody = '';
                for await (const chunk of request) requestBody += chunk;
                assert.equal(requestBody, '{}');
                response.writeHead(200, { 'content-type': 'application/json' });
                response.end(JSON.stringify({
                    id: 23,
                    capability: 'workspace.check',
                    lease_token: leaseToken,
                    workspace: { id: 9, name: 'Devetty y microapps' },
                }));
                return;
            }
            if (request.url === '/api/v1/runner/workspace-checks/23/result') {
                let requestBody = '';
                for await (const chunk of request) requestBody += chunk;
                resultPayload = JSON.parse(requestBody);
                response.writeHead(200, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ status: 'completed', workspace_accessible: true }));
                return;
            }
            response.writeHead(404);
            response.end();
        });
        const serverUrl = await listen(server);
        await configStore.saveNew({
            server_url: serverUrl,
            runner_id: 7,
            workspace_path: workspacePath,
            allow_insecure_localhost: true,
            api_token: token,
        });

        try {
            const client = new RunnerClient(configStore);
            const result = await client.workOnce(workspacePath);

            assert.deepEqual(result, { workspace_name: 'Devetty y microapps', workspace_accessible: true });
            assert.deepEqual(resultPayload, { lease_token: leaseToken, workspace_accessible: true });
            assert.equal(JSON.stringify(resultPayload).includes(workspacePath), false);
            assert.equal(JSON.stringify(resultPayload).includes('command'), false);
        } finally {
            server.close();
            await once(server, 'close');
        }
    });
});

test('workspace check reports no work without sending a result', async () => {
    await withTemporaryDirectory(async (directory) => {
        const workspacePath = path.join(directory, 'workspace');
        await mkdir(workspacePath);
        const configStore = new ConfigStore(path.join(directory, 'config', 'runner.json'));
        let resultCalls = 0;
        const server = createServer((_request, response) => {
            response.writeHead(204);
            response.end();
            if (_request.url.endsWith('/result')) resultCalls++;
        });
        const serverUrl = await listen(server);
        await configStore.saveNew({
            server_url: serverUrl,
            runner_id: 7,
            workspace_path: workspacePath,
            allow_insecure_localhost: true,
            api_token: 'T'.repeat(80),
        });

        try {
            assert.equal(await new RunnerClient(configStore).workOnce(workspacePath), null);
            assert.equal(resultCalls, 0);
        } finally {
            server.close();
            await once(server, 'close');
        }
    });
});

test('workspace check rejects unknown capabilities without running or reporting them', async () => {
    await withTemporaryDirectory(async (directory) => {
        const workspacePath = path.join(directory, 'workspace');
        await mkdir(workspacePath);
        const configStore = new ConfigStore(path.join(directory, 'config', 'runner.json'));
        let resultCalls = 0;
        const server = createServer((_request, response) => {
            if (_request.url.endsWith('/claim')) {
                response.writeHead(200, { 'content-type': 'application/json' });
                response.end(JSON.stringify({ id: 1, capability: 'shell.execute', lease_token: 'L'.repeat(80) }));
            } else {
                resultCalls++;
                response.writeHead(200);
                response.end('{}');
            }
        });
        const serverUrl = await listen(server);
        await configStore.saveNew({
            server_url: serverUrl,
            runner_id: 7,
            workspace_path: workspacePath,
            allow_insecure_localhost: true,
            api_token: 'T'.repeat(80),
        });

        try {
            await assert.rejects(new RunnerClient(configStore).workOnce(workspacePath), /capacidad no permitida/);
            assert.equal(resultCalls, 0);
        } finally {
            server.close();
            await once(server, 'close');
        }
    });
});

test('task listing requests the authenticated runner tasks without sending local paths', async () => {
    await withTemporaryDirectory(async (directory) => {
        const workspacePath = path.join(directory, 'workspace');
        await mkdir(workspacePath);
        const token = 'T'.repeat(80);
        const configStore = new ConfigStore(path.join(directory, 'config', 'runner.json'));
        const server = createServer((request, response) => {
            assert.equal(request.method, 'GET');
            assert.equal(request.url, '/api/v1/runner/tasks');
            assert.equal(request.headers.authorization, `Bearer ${token}`);
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({
                tasks: [{
                    id: 42,
                    title: 'Revisar métricas',
                    status: 'in_progress',
                    priority: 'high',
                    due_date: '2026-11-30',
                    assignee: { type: 'agent', name: 'Vera' },
                    workspace: { id: 9, name: 'Operaciones' },
                }],
                has_more: false,
                next_after: null,
            }));
        });
        const serverUrl = await listen(server);
        await configStore.saveNew({
            server_url: serverUrl,
            runner_id: 7,
            workspace_path: workspacePath,
            allow_insecure_localhost: true,
            api_token: token,
        });

        try {
            const tasks = await new RunnerClient(configStore).listTasks(workspacePath);
            assert.equal(tasks.has_more, false);
            assert.equal(tasks.next_after, null);
            assert.equal(tasks.tasks[0].title, 'Revisar métricas');
            assert.deepEqual(tasks.tasks[0].assignee, { type: 'agent', name: 'Vera' });
            assert.equal(JSON.stringify(tasks).includes(workspacePath), false);
        } finally {
            server.close();
            await once(server, 'close');
        }
    });
});

test('task listing rejects unexpected or malformed task response data', async () => {
    await withTemporaryDirectory(async (directory) => {
        const workspacePath = path.join(directory, 'workspace');
        await mkdir(workspacePath);
        const configStore = new ConfigStore(path.join(directory, 'config', 'runner.json'));
        const server = createServer((_request, response) => {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ tasks: [{ id: 1, title: 'Tarea sin estado' }], has_more: false, next_after: null }));
        });
        const serverUrl = await listen(server);
        await configStore.saveNew({
            server_url: serverUrl,
            runner_id: 7,
            workspace_path: workspacePath,
            allow_insecure_localhost: true,
            api_token: 'T'.repeat(80),
        });

        try {
            await assert.rejects(new RunnerClient(configStore).listTasks(workspacePath), /respuesta de tareas no válida/);
        } finally {
            server.close();
            await once(server, 'close');
        }
    });
});

test('task listing rejects malformed assignee identity data', async () => {
    await withTemporaryDirectory(async (directory) => {
        const workspacePath = path.join(directory, 'workspace');
        await mkdir(workspacePath);
        const configStore = new ConfigStore(path.join(directory, 'config', 'runner.json'));
        const server = createServer((_request, response) => {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({
                tasks: [{
                    id: 1,
                    title: 'Tarea',
                    status: 'open',
                    priority: 'normal',
                    due_date: null,
                    assignee: { type: 'shell', name: 'unexpected' },
                    workspace: { id: 9, name: 'Operaciones' },
                }],
                has_more: false,
                next_after: null,
            }));
        });
        const serverUrl = await listen(server);
        await configStore.saveNew({
            server_url: serverUrl,
            runner_id: 7,
            workspace_path: workspacePath,
            allow_insecure_localhost: true,
            api_token: 'T'.repeat(80),
        });

        try {
            await assert.rejects(new RunnerClient(configStore).listTasks(workspacePath), /respuesta de tareas no válida/);
        } finally {
            server.close();
            await once(server, 'close');
        }
    });
});

test('task listing sends a validated cursor and checks the next cursor response', async () => {
    await withTemporaryDirectory(async (directory) => {
        const workspacePath = path.join(directory, 'workspace');
        await mkdir(workspacePath);
        const configStore = new ConfigStore(path.join(directory, 'config', 'runner.json'));
        const server = createServer((request, response) => {
            assert.equal(request.url, '/api/v1/runner/tasks?after_id=100');
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({
                tasks: [{
                    id: 101,
                    title: 'Tarea 101',
                    status: 'open',
                    priority: 'normal',
                    due_date: null,
                    workspace: { id: 9, name: 'Operaciones' },
                }],
                has_more: false,
                next_after: null,
            }));
        });
        const serverUrl = await listen(server);
        await configStore.saveNew({
            server_url: serverUrl,
            runner_id: 7,
            workspace_path: workspacePath,
            allow_insecure_localhost: true,
            api_token: 'T'.repeat(80),
        });

        try {
            const result = await new RunnerClient(configStore).listTasks(workspacePath, 100);
            assert.equal(result.tasks[0].id, 101);
            assert.equal(result.next_after, null);
        } finally {
            server.close();
            await once(server, 'close');
        }
    });
});

test('task detail fetches only the requested task through the authenticated runner API', async () => {
    await withTemporaryDirectory(async (directory) => {
        const workspacePath = path.join(directory, 'workspace');
        await mkdir(workspacePath);
        const token = 'T'.repeat(80);
        const configStore = new ConfigStore(path.join(directory, 'config', 'runner.json'));
        const server = createServer((request, response) => {
            assert.equal(request.method, 'GET');
            assert.equal(request.url, '/api/v1/runner/tasks/42');
            assert.equal(request.headers.authorization, `Bearer ${token}`);
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({
                task: {
                    id: 42,
                    title: 'Revisar informe',
                    description: 'Comparar con las fuentes originales.',
                    status: 'in_progress',
                    priority: 'high',
                    due_date: null,
                    assignee: { type: 'user', name: 'Ana' },
                    workspace: { id: 9, name: 'Operaciones' },
                },
            }));
        });
        const serverUrl = await listen(server);
        await configStore.saveNew({
            server_url: serverUrl,
            runner_id: 7,
            workspace_path: workspacePath,
            allow_insecure_localhost: true,
            api_token: token,
        });

        try {
            const task = await new RunnerClient(configStore).getTask(42, workspacePath);
            assert.equal(task.description, 'Comparar con las fuentes originales.');
            assert.deepEqual(task.assignee, { type: 'user', name: 'Ana' });
            assert.equal(task.workspace.name, 'Operaciones');
            assert.equal(JSON.stringify(task).includes(workspacePath), false);
        } finally {
            server.close();
            await once(server, 'close');
        }
    });
});

test('task detail rejects malformed response data', async () => {
    await withTemporaryDirectory(async (directory) => {
        const workspacePath = path.join(directory, 'workspace');
        await mkdir(workspacePath);
        const configStore = new ConfigStore(path.join(directory, 'config', 'runner.json'));
        const server = createServer((_request, response) => {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ task: { id: 42, title: 'Tarea sin estado' } }));
        });
        const serverUrl = await listen(server);
        await configStore.saveNew({
            server_url: serverUrl,
            runner_id: 7,
            workspace_path: workspacePath,
            allow_insecure_localhost: true,
            api_token: 'T'.repeat(80),
        });

        try {
            await assert.rejects(new RunnerClient(configStore).getTask(42, workspacePath), /respuesta de detalle no válida/);
        } finally {
            server.close();
            await once(server, 'close');
        }
    });
});
