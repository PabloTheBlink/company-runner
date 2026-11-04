import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { RunnerClient, normalizeServerUrl } from '../src/client.js';
import { ConfigStore } from '../src/config.js';

async function withTemporaryDirectory(runTest) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'mycompanies-runner-test-'));

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
                    workspace: { id: 9, name: 'Operaciones' },
                }],
                has_more: false,
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
            assert.equal(tasks.tasks[0].title, 'Revisar métricas');
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
            response.end(JSON.stringify({ tasks: [{ id: 1, title: 'Tarea sin estado' }], has_more: false }));
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
