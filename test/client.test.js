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
