import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import test from 'node:test';
import { parseAgentAssetId, parseAgentAssetsOptions, parseAgentAssignmentOptions, parseAgentBetConversionOptions, parseAgentBetEvidenceOptions, parseAgentBetStatusOptions, parseAgentBetsOptions, parseAgentCreateOptions, parseAgentGoalId, parseAgentGoalsOptions, parseAgentLoginOptions, parseAgentOfferId, parseAgentOfferStatusOptions, parseAgentOffersOptions, parseAgentPermissionGrantOptions, parseAgentPermissionRevokeOptions, parseAgentPermissionsOptions, parseAgentProfileEditOptions, parseAgentProfileId, parseAgentRuntimeFileAccessOptions, parseAgentRuntimePlanOptions, parseAgentRuntimeRunOptions, parseAgentStatusOptions, parseAgentTaskCreateOptions, parseAgentTaskEditOptions, parseAgentTasksOptions, parseAgentWorkspaceId, parseAgentWorkspacesOptions, parseAgentAgentsOptions, parseAgentCredentialIssueOptions, parseAgentCredentialListOptions, parseAgentCredentialRevokeOptions, parseAgentMemoryOptions, parseArtifactDownloadOptions, parseArtifactId, parseArtifactListOptions, parseArtifactPublishOptions, parseEnrollOptions, parseTaskId, parseTasksOptions, readHiddenCode, run } from '../src/cli.js';
import { formatAssignee } from '../src/client.js';
import { ConfigStore } from '../src/config.js';
import { listLocalAgentRuntimes } from '../src/runtime.js';

test('task assignee labels distinguish people and agents and sanitize terminal controls', () => {
    assert.equal(formatAssignee(null), 'sin asignar');
    assert.equal(formatAssignee({ type: 'user', name: 'Ana' }), 'Persona: Ana');
    assert.equal(formatAssignee({ type: 'agent', name: 'Vera\u001B[31m' }), 'Agente: Vera [31m');
});

test('enrollment options use the current directory without a path option', () => {
    assert.deepEqual(parseEnrollOptions([
        '--server=https://mycompanies.example',
        '--allow-insecure-localhost',
    ]), {
        server: 'https://mycompanies.example',
        allowInsecureLocalhost: true,
    });
    assert.deepEqual(parseEnrollOptions(['--server=https://mycompanies.example']), {
        server: 'https://mycompanies.example',
        allowInsecureLocalhost: false,
    });
    assert.throws(() => parseEnrollOptions(['--server=https://mycompanies.example', '--workspace-path=/work']), /Opción desconocida/);
    assert.throws(() => parseEnrollOptions(['--server=https://mycompanies.example', '--token=secret']), /Opción desconocida/);
});

test('agent login requires a server and supports explicit loopback HTTP only', () => {
    assert.deepEqual(parseAgentLoginOptions(['--server=https://mycompanies.example']), {
        server: 'https://mycompanies.example',
        allowInsecureLocalhost: false,
    });
    assert.deepEqual(parseAgentLoginOptions(['--server=http://127.0.0.1:8150', '--allow-insecure-localhost']), {
        server: 'http://127.0.0.1:8150',
        allowInsecureLocalhost: true,
    });
    assert.throws(() => parseAgentLoginOptions([]), /Falta el servidor/);
    assert.throws(() => parseAgentLoginOptions(['--server=https://example.com', '--token=secret']), /Opción desconocida/);
});

test('agent runtime reports installed providers without loading credentials or starting a session', async () => {
    const output = { value: '', write(chunk) { this.value += chunk; } };
    const runtimes = await listLocalAgentRuntimes();

    assert.equal(await run(['agent', 'runtime'], { stdout: output }, process.cwd(), {}), 0);
    assert.match(output.value, /Diagnóstico local: no conecta con MyCompanies, no lee tareas ni credenciales y no inicia ninguna sesión/);
    assert.match(output.value, /agent runtime run ID --provider=codex\|agy/);
    for (const runtime of runtimes) {
        assert.match(output.value, new RegExp(`${runtime.provider} \\(${runtime.command}\\)`));
    }
    await assert.rejects(run(['agent', 'runtime', '--provider=codex'], { stdout: output }, process.cwd(), {}), /Uso:/);
});

test('agent runtime plan requires a positive task ID and explicit supported provider', () => {
    assert.deepEqual(parseAgentRuntimePlanOptions(['42', '--provider=codex']), { taskId: 42, provider: 'codex' });
    assert.deepEqual(parseAgentRuntimePlanOptions(['42', '--provider=claude']), { taskId: 42, provider: 'claude' });
    assert.deepEqual(parseAgentRuntimePlanOptions(['42', '--provider=agy']), { taskId: 42, provider: 'agy' });
    assert.throws(() => parseAgentRuntimePlanOptions(['42']), /provider/);
    assert.throws(() => parseAgentRuntimePlanOptions(['0', '--provider=codex']), /positivo/);
    assert.throws(() => parseAgentRuntimePlanOptions(['42', '--provider=other']), /proveedor/);
    assert.throws(() => parseAgentRuntimePlanOptions(['42', '--provider=codex', '--provider=claude']), /Uso:/);
});

test('agent runtime run requires a valid task, supported provider, and bounded timeout', () => {
    assert.deepEqual(parseAgentRuntimeRunOptions(['42', '--provider=agy']), {
        taskId: 42,
        provider: 'agy',
        timeoutSeconds: 300,
        publishPath: null,
        allowNetwork: false,
    });
    assert.deepEqual(parseAgentRuntimeRunOptions(['42', '--timeout=600', '--provider=agy']), {
        taskId: 42,
        provider: 'agy',
        timeoutSeconds: 600,
        publishPath: null,
        allowNetwork: false,
    });
    assert.deepEqual(parseAgentRuntimeRunOptions(['42', '--provider=agy', '--publish=reports/daily.md']), {
        taskId: 42,
        provider: 'agy',
        timeoutSeconds: 300,
        publishPath: 'reports/daily.md',
        allowNetwork: false,
    });
    assert.deepEqual(parseAgentRuntimeRunOptions(['42', '--provider=codex']), {
        taskId: 42,
        provider: 'codex',
        timeoutSeconds: 300,
        publishPath: null,
        allowNetwork: false,
    });
    assert.equal(parseAgentRuntimeRunOptions(['42', '--provider=codex', '--allow-network']).allowNetwork, true);
    assert.throws(() => parseAgentRuntimeRunOptions(['0', '--provider=agy']), /positivo/);
    assert.throws(() => parseAgentRuntimeRunOptions(['42', '--provider=other']), /Opción desconocida/);
    assert.throws(() => parseAgentRuntimeRunOptions(['42', '--provider=agy', '--timeout=9']), /entre 10 y 900/);
    assert.throws(() => parseAgentRuntimeRunOptions(['42', '--provider=agy', '--timeout=901']), /entre 10 y 900/);
    assert.throws(() => parseAgentRuntimeRunOptions(['42', '--provider=agy', '--timeout=300', '--timeout=400']), /Uso:/);
    assert.throws(() => parseAgentRuntimeRunOptions(['42', '--provider=agy', '--publish=']), /ruta/);
    assert.throws(() => parseAgentRuntimeRunOptions(['42', '--provider=agy', '--publish=reports/a.md', '--publish=reports/b.md']), /repetida/);
    assert.throws(() => parseAgentRuntimeRunOptions(['42', '--provider=agy', '--allow-network']), /solo está disponible para Codex/);
});

test('agent runtime file access commands require one safe path and one explicit operation', () => {
    assert.deepEqual(parseAgentRuntimeFileAccessOptions(['list']), { action: 'list' });
    assert.deepEqual(parseAgentRuntimeFileAccessOptions(['grant', '.env', '--operation=read']), {
        action: 'grant',
        path: '.env',
        operation: 'read',
    });
    assert.deepEqual(parseAgentRuntimeFileAccessOptions(['revoke', 'reports/daily.md', '--operation=write']), {
        action: 'revoke',
        path: 'reports/daily.md',
        operation: 'write',
    });
    assert.throws(() => parseAgentRuntimeFileAccessOptions(['grant', '../.env', '--operation=read']), /ruta segura/);
    assert.throws(() => parseAgentRuntimeFileAccessOptions(['grant', '.env\nAUTORIZAR', '--operation=read']), /ruta segura/);
    assert.throws(() => parseAgentRuntimeFileAccessOptions(['grant', '.env']), /Uso:/);
    assert.throws(() => parseAgentRuntimeFileAccessOptions(['grant', '.env', '--operation=delete']), /read o write/);
    assert.throws(() => parseAgentRuntimeFileAccessOptions(['grant', '.env', '--operation=read', '--operation=write']), /Uso:/);
    assert.throws(() => parseAgentRuntimeFileAccessOptions(['list', '.env']), /Uso:/);
});

test('agent runtime file grant changes require confirmation and stay in local configuration', async () => {
    const companyRoot = '/companies/devetty';
    const output = { value: '', write(chunk) { this.value += chunk; } };
    const configurationChanges = [];
    const confirmations = [];
    const configStore = {
        async loadAgentForDirectory(directory) {
            assert.equal(directory, companyRoot);
            return { agent_id: 12, agent_name: 'Vera', company_id: 4, company_name: 'Devetty' };
        },
        async grantAgentFileAccessForDirectory(...argumentsList) {
            configurationChanges.push(argumentsList);
            return { path: '.env', operations: ['read'], changed: true };
        },
    };
    const confirm = async (request) => {
        confirmations.push(request);
        return true;
    };

    assert.equal(await run(
        ['agent', 'runtime', 'files', 'grant', '.env', '--operation=read'],
        { stdout: output, stderr: output, stdin: { isTTY: true } },
        companyRoot,
        configStore,
        undefined,
        confirm,
    ), 0);
    assert.deepEqual(configurationChanges, [[companyRoot, '.env', 'read', 12]]);
    assert.equal(confirmations[0].agentId, 12);
    assert.equal(confirmations[0].companyName, 'Devetty');
    assert.match(output.value, /Permiso local concedido/);
});

test('agent runtime file grant is not saved when human confirmation is declined', async () => {
    let changeCount = 0;
    const configStore = {
        async loadAgentForDirectory() {
            return { agent_id: 12, agent_name: 'Vera', company_id: 4, company_name: 'Devetty' };
        },
        async grantAgentFileAccessForDirectory() {
            changeCount++;
        },
    };
    const confirm = async () => false;

    await assert.rejects(run(
        ['agent', 'runtime', 'files', 'grant', '.env', '--operation=write'],
        { stdout: { write() {} }, stderr: { write() {} }, stdin: { isTTY: true } },
        '/companies/devetty',
        configStore,
        undefined,
        confirm,
    ), /confirmación/);
    assert.equal(changeCount, 0);
});

test('agent runtime plan checks the selected Agent and assigned task without starting a provider', async () => {
    const token = 'P'.repeat(80);
    const requests = [];
    const server = createServer((request, response) => {
        requests.push(request.url);
        assert.equal(request.headers.authorization, `Bearer ${token}`);
        response.writeHead(200, { 'content-type': 'application/json' });
        if (request.url === '/api/v1/agent/me') {
            response.end(JSON.stringify({
                agent: { id: 12, uuid: 'agent-uuid', name: 'Vera', role: 'CEO' },
                company: { id: 4, name: 'Devetty' },
                permissions: [{ name: 'tasks.read', scope: 'company', workspace_id: null, workspace_name: null }],
            }));
            return;
        }
        assert.equal(request.url, '/api/v1/agent/tasks/42');
        response.end(JSON.stringify({ task: {
            id: 42,
            title: 'Investigar canales',
            description: 'No debe copiarse al plan.',
            status: 'in_progress',
            priority: 'normal',
            due_date: null,
            assignee: { type: 'agent', id: 12, name: 'Vera' },
            workspace: { id: 5, name: 'Marketing' },
        } }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const configStore = {
        async loadAgentForDirectory(directory) {
            assert.equal(directory, '/company');
            return {
                server_url: `http://127.0.0.1:${server.address().port}`,
                agent_id: 12,
                company_id: 4,
                allow_insecure_localhost: true,
                api_token: token,
            };
        },
    };
    const stdout = { value: '', write(chunk) { this.value += chunk; } };
    const detectRuntime = async () => [{ provider: 'codex', command: 'codex' }];

    try {
        assert.equal(await run(
            ['agent', 'runtime', 'plan', '42', '--provider=codex'],
            { stdout },
            '/company',
            configStore,
            detectRuntime,
        ), 0);
        assert.deepEqual(requests, ['/api/v1/agent/me', '/api/v1/agent/tasks/42']);
        assert.match(stdout.value, /Plan de ejecución local \(no iniciado\)/);
        assert.match(stdout.value, /Agent: Vera \(#12\)/);
        assert.match(stdout.value, /Tarea: #42 · Investigar canales \(en curso\)/);
        assert.match(stdout.value, /Proveedor: Codex/);
        assert.doesNotMatch(stdout.value, /No debe copiarse|api_token|Bearer/);
    } finally {
        server.close();
        await once(server, 'close');
    }
});

test('agent runtime run stages only granted files, applies only authorized writes, and cleans staging', async () => {
    const testRoot = await mkdtemp(path.join(process.cwd(), '.mycompany-agent-run-test-'));
    const companyRoot = path.join(testRoot, 'company');
    const configRoot = path.join(testRoot, 'config');
    const token = 'P'.repeat(80);
    const requests = [];
    const server = createServer((request, response) => {
        requests.push(request.url);
        assert.equal(request.headers.authorization, `Bearer ${token}`);
        response.writeHead(200, { 'content-type': 'application/json' });
        if (request.url === '/api/v1/agent/me') {
            response.end(JSON.stringify({
                agent: { id: 12, uuid: 'agent-uuid', name: 'Vera', role: 'CEO' },
                company: { id: 4, name: 'Devetty' },
                permissions: [
                    { name: 'tasks.read', scope: 'company', workspace_id: null, workspace_name: null },
                    { name: 'artifacts.publish', scope: 'company', workspace_id: null, workspace_name: null },
                ],
            }));
            return;
        }
        assert.equal(request.url, '/api/v1/agent/tasks/42');
        response.end(JSON.stringify({ task: {
            id: 42,
            title: 'Preparar informe',
            description: 'Revisa los archivos autorizados y resume el estado.',
            status: 'in_progress',
            priority: 'normal',
            due_date: null,
            assignee: { type: 'agent', id: 12, name: 'Vera' },
            workspace: { id: 5, name: 'Operaciones' },
        } }));
    });
    await mkdir(companyRoot);
    await mkdir(path.join(configRoot), { mode: 0o700 });
    await mkdir(path.join(companyRoot, 'reports'));
    await writeFile(path.join(companyRoot, '.env'), 'KEY=original\n', { mode: 0o600 });
    const taskRunnerCalls = [];
    const confirmations = [];
    const publishedArtifacts = [];
    const configStore = {
        localAgentFilePolicyPath: path.join(configRoot, 'agent-file-access.json'),
        async loadAgentForDirectory() {
            return {
                server_url: `http://127.0.0.1:${server.address().port}`,
                agent_id: 12,
                company_id: 4,
                allow_insecure_localhost: true,
                api_token: token,
            };
        },
        async listAgentFileAccessForDirectory(directory, agentId) {
            assert.equal(directory, companyRoot);
            assert.equal(agentId, 12);
            return [
                { path: '.env', operations: ['read', 'write'] },
                { path: 'reports/daily.md', operations: ['write'] },
            ];
        },
    };
    const runtimeDetector = async () => [
        { provider: 'agy', command: 'agy' },
        { provider: 'codex', command: 'codex' },
    ];
    const agentRuntimeRunner = async (request) => {
        taskRunnerCalls.push(request);
        assert.notEqual(request.cwd, companyRoot);
        assert.match(request.prompt, /Preparar informe/);
        assert.match(request.prompt, /Revisa los archivos autorizados/);
        assert.equal(await readFile(path.join(request.cwd, '.env'), 'utf8'), 'KEY=original\n');
        assert.equal(await readFile(path.join(request.cwd, 'reports', 'daily.md'), 'utf8'), '');
        await writeFile(path.join(request.cwd, '.env'), 'KEY=updated\n');
        await writeFile(path.join(request.cwd, 'reports', 'daily.md'), 'Resumen\n');
        await writeFile(path.join(request.cwd, 'unapproved.md'), 'No aplicar\n');
        return { response: 'Informe listo' };
    };
    const agentRuntimeConfirmer = async (request) => {
        confirmations.push(request);
        return true;
    };
    const artifactPublisher = async (filePath, metadata, directory) => {
        publishedArtifacts.push({ filePath, metadata, directory });
        return { id: 77, title: metadata.title, original_filename: path.basename(filePath) };
    };
    const output = { value: '', write(chunk) { this.value += chunk; } };
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    try {
        assert.equal(await run(
            ['agent', 'runtime', 'run', '42', '--provider=codex', '--allow-network', '--publish=reports/daily.md'],
            { stdout: output, stderr: output },
            companyRoot,
            configStore,
            runtimeDetector,
            undefined,
            agentRuntimeRunner,
            agentRuntimeConfirmer,
            artifactPublisher,
        ), 0);
        assert.deepEqual(requests, ['/api/v1/agent/me', '/api/v1/agent/tasks/42', '/api/v1/agent/tasks/42']);
        assert.equal(taskRunnerCalls.length, 1);
        assert.equal(taskRunnerCalls[0].provider, 'codex');
        assert.equal(taskRunnerCalls[0].allowNetwork, true);
        assert.equal(taskRunnerCalls[0].timeoutMs, 300_000);
        assert.deepEqual(confirmations[0].fileSummary, {
            read: ['.env'],
            write: ['.env', 'reports/daily.md'],
        });
        assert.equal(confirmations[0].publishPath, 'reports/daily.md');
        assert.equal(confirmations[0].allowNetwork, true);
        assert.deepEqual(publishedArtifacts, [{
            filePath: 'reports/daily.md',
            metadata: { title: 'Preparar informe', source: 'MyCompanies task #42' },
            directory: companyRoot,
        }]);
        assert.equal(await readFile(path.join(companyRoot, '.env'), 'utf8'), 'KEY=updated\n');
        assert.equal(await readFile(path.join(companyRoot, 'reports', 'daily.md'), 'utf8'), 'Resumen\n');
        await assert.rejects(stat(path.join(companyRoot, 'unapproved.md')), { code: 'ENOENT' });
        assert.match(output.value, /Informe listo/);
        assert.match(output.value, /Archivos actualizados: \.env, reports\/daily\.md/);
        assert.match(output.value, /Informe #77 publicado para Preparar informe \(daily\.md\)/);
        await assert.rejects(stat(taskRunnerCalls[0].cwd), { code: 'ENOENT' });
    } finally {
        server.close();
        await once(server, 'close');
        await rm(testRoot, { recursive: true, force: true });
    }
});

test('agent runtime run discards staged output if task instructions change while the provider is working', async () => {
    const testRoot = await mkdtemp(path.join(process.cwd(), '.mycompany-agent-run-stale-task-test-'));
    const companyRoot = path.join(testRoot, 'company');
    const configRoot = path.join(testRoot, 'config');
    const requestPaths = [];
    let taskRequestCount = 0;
    let publishCalls = 0;
    const server = createServer((request, response) => {
        requestPaths.push(request.url);
        response.writeHead(200, { 'content-type': 'application/json' });
        if (request.url === '/api/v1/agent/me') {
            response.end(JSON.stringify({
                agent: { id: 12, uuid: 'agent-uuid', name: 'Vera', role: null },
                company: { id: 4, name: 'Devetty' },
                permissions: [
                    { name: 'tasks.read', scope: 'company', workspace_id: null, workspace_name: null },
                    { name: 'artifacts.publish', scope: 'company', workspace_id: null, workspace_name: null },
                ],
            }));
            return;
        }
        taskRequestCount += 1;
        response.end(JSON.stringify({ task: {
            id: 42,
            title: taskRequestCount === 1 ? 'Prepare weekly report' : 'Prepare a different report',
            description: 'Use the approved source material.',
            status: 'in_progress',
            priority: 'normal',
            due_date: null,
            assignee: { type: 'agent', id: 12, name: 'Vera' },
            workspace: null,
        } }));
    });
    await mkdir(path.join(companyRoot, 'reports'), { recursive: true });
    await mkdir(configRoot, { mode: 0o700 });
    await writeFile(path.join(companyRoot, 'reports', 'weekly.md'), 'Original approved report\n');
    const configStore = {
        localAgentFilePolicyPath: path.join(configRoot, 'agent-file-access.json'),
        async loadAgentForDirectory() {
            return {
                server_url: `http://127.0.0.1:${server.address().port}`,
                agent_id: 12, company_id: 4, allow_insecure_localhost: true, api_token: 'P'.repeat(80),
            };
        },
        async listAgentFileAccessForDirectory() {
            return [{ path: 'reports/weekly.md', operations: ['read', 'write'] }];
        },
    };
    const output = { write() {} };
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    try {
        await assert.rejects(run(
            ['agent', 'runtime', 'run', '42', '--provider=agy', '--publish=reports/weekly.md'],
            { stdout: output, stderr: output },
            companyRoot,
            configStore,
            async () => [{ provider: 'agy', command: 'agy' }],
            undefined,
            async ({ cwd }) => {
                await writeFile(path.join(cwd, 'reports', 'weekly.md'), 'Output based on stale task instructions\n');
                return { response: 'The report is complete.' };
            },
            async () => true,
            async () => { publishCalls += 1; },
        ), /La tarea cambió mientras el proveedor trabajaba/);
        assert.equal(await readFile(path.join(companyRoot, 'reports', 'weekly.md'), 'utf8'), 'Original approved report\n');
        assert.equal(publishCalls, 0);
        assert.deepEqual(requestPaths, ['/api/v1/agent/me', '/api/v1/agent/tasks/42', '/api/v1/agent/tasks/42']);
    } finally {
        server.close();
        await once(server, 'close');
        await rm(testRoot, { recursive: true, force: true });
    }
});

test('agent runtime run refuses artifact publication without a matching server grant and local write grant', async () => {
    const companyRoot = await mkdtemp(path.join(process.cwd(), '.mycompany-agent-run-publish-denied-test-'));
    const permissions = [{ name: 'tasks.read', scope: 'company', workspace_id: null, workspace_name: null }];
    const localGrants = [{ path: 'reports/daily.md', operations: ['write'] }];
    const server = createServer((request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        if (request.url === '/api/v1/agent/me') {
            response.end(JSON.stringify({
                agent: { id: 12, uuid: 'agent-uuid', name: 'Vera', role: null },
                company: { id: 4, name: 'Devetty' },
                permissions,
            }));
            return;
        }
        response.end(JSON.stringify({ task: {
            id: 42, title: 'Preparar informe', description: null, status: 'open', priority: 'normal', due_date: null,
            assignee: { type: 'agent', id: 12, name: 'Vera' }, workspace: null,
        } }));
    });
    let runtimeStarted = false;
    const configStore = {
        async loadAgentForDirectory() {
            return {
                server_url: `http://127.0.0.1:${server.address().port}`,
                agent_id: 12, company_id: 4, allow_insecure_localhost: true, api_token: 'P'.repeat(80),
            };
        },
        async listAgentFileAccessForDirectory() { return localGrants; },
    };
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    try {
        await assert.rejects(run(
            ['agent', 'runtime', 'run', '42', '--provider=agy', '--publish=reports/daily.md'],
            { stdout: { write() {} }, stderr: { write() {} } },
            companyRoot,
            configStore,
            async () => [{ provider: 'agy', command: 'agy' }],
            undefined,
            async () => { runtimeStarted = true; },
            async () => true,
            async () => { throw new Error('must not publish'); },
        ), /artifacts.publish/);
        assert.equal(runtimeStarted, false);
        permissions.push({ name: 'artifacts.publish', scope: 'company', workspace_id: null, workspace_name: null });
        localGrants.length = 0;
        await assert.rejects(run(
            ['agent', 'runtime', 'run', '42', '--provider=agy', '--publish=reports/daily.md'],
            { stdout: { write() {} }, stderr: { write() {} } },
            companyRoot,
            configStore,
            async () => [{ provider: 'agy', command: 'agy' }],
            undefined,
            async () => { runtimeStarted = true; },
            async () => true,
            async () => { throw new Error('must not publish'); },
        ), /permiso local write/);
        assert.equal(runtimeStarted, false);
    } finally {
        server.close();
        await once(server, 'close');
        await rm(companyRoot, { recursive: true, force: true });
    }
});

test('agent runtime run does not start or stage files without typed confirmation', async () => {
    const companyRoot = await mkdtemp(path.join(process.cwd(), '.mycompany-agent-run-denied-test-'));
    const token = 'P'.repeat(80);
    const server = createServer((request, response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        if (request.url === '/api/v1/agent/me') {
            response.end(JSON.stringify({
                agent: { id: 12, uuid: 'agent-uuid', name: 'Vera', role: null },
                company: { id: 4, name: 'Devetty' },
                permissions: [{ name: 'tasks.read', scope: 'company', workspace_id: null, workspace_name: null }],
            }));
            return;
        }
        response.end(JSON.stringify({ task: {
            id: 42, title: 'Preparar informe', description: null, status: 'open', priority: 'normal', due_date: null,
            assignee: { type: 'agent', id: 12, name: 'Vera' }, workspace: null,
        } }));
    });
    let runtimeStarted = false;
    const configStore = {
        async loadAgentForDirectory() {
            return {
                server_url: `http://127.0.0.1:${server.address().port}`,
                agent_id: 12, company_id: 4, allow_insecure_localhost: true, api_token: token,
            };
        },
        async listAgentFileAccessForDirectory() { return []; },
    };
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');

    try {
        await assert.rejects(run(
            ['agent', 'runtime', 'run', '42', '--provider=agy'],
            { stdout: { write() {} }, stderr: { write() {} } },
            companyRoot,
            configStore,
            async () => [{ provider: 'agy', command: 'agy' }],
            undefined,
            async () => { runtimeStarted = true; },
            async () => false,
        ), /confirmación escrita/);
        assert.equal(runtimeStarted, false);
    } finally {
        server.close();
        await once(server, 'close');
        await rm(companyRoot, { recursive: true, force: true });
    }
});

test('agent runtime plan does not connect when the selected provider is unavailable', async () => {
    const configStore = {
        async loadAgentForDirectory() {
            throw new Error('No debe leer la credencial Agent.');
        },
    };

    await assert.rejects(run(
        ['agent', 'runtime', 'plan', '42', '--provider=codex'],
        { stdout: { write() {} } },
        '/company',
        configStore,
        async () => [],
    ), /no está instalado/);
});

test('agent task listing accepts a single positive cursor', () => {
    assert.deepEqual(parseAgentTasksOptions([]), { afterId: null, status: null });
    assert.deepEqual(parseAgentTasksOptions(['--after=25']), { afterId: 25, status: null });
    assert.throws(() => parseAgentTasksOptions(['--after=0']), /entero positivo/);
    assert.throws(() => parseAgentTasksOptions(['--after=25', '--after=50']), /Opción desconocida/);
    assert.deepEqual(parseAgentTasksOptions(['--status=blocked']), { afterId: null, status: 'blocked' });
    assert.deepEqual(parseAgentTasksOptions(['--status=in_progress', '--after=25']), { afterId: 25, status: 'in_progress' });
    assert.throws(() => parseAgentTasksOptions(['--status=completed']), /estado activo/);
    assert.throws(() => parseAgentTasksOptions(['--status=blocked', '--status=open']), /Opción desconocida/);
});

test('agent bet listing accepts a single positive cursor', () => {
    assert.deepEqual(parseAgentBetsOptions([]), { afterId: null });
    assert.deepEqual(parseAgentBetsOptions(['--after=25']), { afterId: 25 });
    assert.throws(() => parseAgentBetsOptions(['--after=0']), /entero positivo/);
    assert.throws(() => parseAgentBetsOptions(['--other']), /Opción desconocida/);
});

test('agent offer listing accepts a single positive cursor and detail ID', () => {
    assert.deepEqual(parseAgentOffersOptions([]), { afterId: null });
    assert.deepEqual(parseAgentOffersOptions(['--after=25']), { afterId: 25 });
    assert.throws(() => parseAgentOffersOptions(['--after=0']), /entero positivo/);
    assert.throws(() => parseAgentOffersOptions(['--other']), /Opción desconocida/);
    assert.equal(parseAgentOfferId(['25']), 25);
    assert.throws(() => parseAgentOfferId(['0']), /entero positivo/);
});

test('agent goal listing accepts a single positive cursor and detail ID', () => {
    assert.deepEqual(parseAgentGoalsOptions([]), { afterId: null });
    assert.deepEqual(parseAgentGoalsOptions(['--after=25']), { afterId: 25 });
    assert.throws(() => parseAgentGoalsOptions(['--after=0']), /entero positivo/);
    assert.throws(() => parseAgentGoalsOptions(['--other']), /Opción desconocida/);
    assert.equal(parseAgentGoalId(['25']), 25);
    assert.throws(() => parseAgentGoalId(['0']), /entero positivo/);
});

test('agent asset listing accepts a single positive cursor and detail ID', () => {
    assert.deepEqual(parseAgentAssetsOptions([]), { afterId: null });
    assert.deepEqual(parseAgentAssetsOptions(['--after=25']), { afterId: 25 });
    assert.throws(() => parseAgentAssetsOptions(['--after=0']), /entero positivo/);
    assert.throws(() => parseAgentAssetsOptions(['--other']), /Opción desconocida/);
    assert.equal(parseAgentAssetId(['25']), 25);
    assert.throws(() => parseAgentAssetId(['0']), /entero positivo/);
});

test('agent workspace listing accepts a single positive cursor and detail ID', () => {
    assert.deepEqual(parseAgentWorkspacesOptions([]), { afterId: null });
    assert.deepEqual(parseAgentWorkspacesOptions(['--after=25']), { afterId: 25 });
    assert.throws(() => parseAgentWorkspacesOptions(['--after=0']), /entero positivo/);
    assert.throws(() => parseAgentWorkspacesOptions(['--other']), /Opción desconocida/);
    assert.equal(parseAgentWorkspaceId(['25']), 25);
    assert.throws(() => parseAgentWorkspaceId(['0']), /entero positivo/);
});

test('agent direct report listing accepts a single positive cursor', () => {
    assert.deepEqual(parseAgentAgentsOptions([]), { afterId: null });
    assert.deepEqual(parseAgentAgentsOptions(['--after=25']), { afterId: 25 });
    assert.throws(() => parseAgentAgentsOptions(['--after=0']), /entero positivo/);
    assert.throws(() => parseAgentAgentsOptions(['--other']), /Opción desconocida/);
});

test('agent profile creation requires a name and only accepts profile fields', () => {
    assert.deepEqual(parseAgentCreateOptions(['--name=Marketing', '--role=Contenido', '--instructions=Investiga']), {
        name: 'Marketing',
        role: 'Contenido',
        instructions: 'Investiga',
    });
    assert.throws(() => parseAgentCreateOptions([]), /name/);
    assert.throws(() => parseAgentCreateOptions(['--name=Marketing', '--permission=tasks.manage']), /Opción desconocida/);
    assert.throws(() => parseAgentCreateOptions(['--name=Marketing', '--status=paused']), /Opción desconocida/);
});

test('agent permission grant and revoke commands require explicit direct report IDs', () => {
    assert.deepEqual(parseAgentPermissionGrantOptions(['26', 'tasks.read', '--workspace-id=8']), {
        agentId: 26,
        permission: 'tasks.read',
        workspaceId: 8,
    });
    assert.deepEqual(parseAgentPermissionGrantOptions(['26', 'bets.read']), {
        agentId: 26,
        permission: 'bets.read',
        workspaceId: null,
    });
    assert.throws(() => parseAgentPermissionGrantOptions(['0', 'tasks.read']), /entero positivo/);
    assert.throws(() => parseAgentPermissionGrantOptions(['26', 'tasks.read', '--workspace-id=0']), /entero positivo/);
    assert.throws(() => parseAgentPermissionGrantOptions(['26', 'tasks.read', '--unknown']), /Opción desconocida/);
    assert.deepEqual(parseAgentPermissionRevokeOptions(['26', '91']), { agentId: 26, grantId: 91 });
    assert.throws(() => parseAgentPermissionRevokeOptions(['26', '0']), /entero positivo/);
});

test('agent permissions command has no writable options', async () => {
    assert.deepEqual(parseAgentPermissionsOptions([]), {});
    assert.throws(() => parseAgentPermissionsOptions(['--grant']), /no admite opciones/);
});

test('agent pause and resume commands require a single direct report ID', () => {
    assert.equal(parseAgentProfileId(['26']), 26);
    assert.throws(() => parseAgentProfileId([]), /Uso:/);
    assert.throws(() => parseAgentProfileId(['0']), /entero positivo/);
    assert.throws(() => parseAgentProfileId(['26', '27']), /Uso:/);
});

test('agent profile edit accepts only role and instructions and can clear either field', () => {
    assert.deepEqual(parseAgentProfileEditOptions(['26', '--role=Marketing lead', '--instructions=Prioriza datos verificables.']), {
        agentId: 26,
        changes: { role: 'Marketing lead', instructions: 'Prioriza datos verificables.' },
    });
    assert.deepEqual(parseAgentProfileEditOptions(['26', '--instructions=none']), {
        agentId: 26,
        changes: { instructions: null },
    });
    assert.throws(() => parseAgentProfileEditOptions(['26']), /al menos un campo/);
    assert.throws(() => parseAgentProfileEditOptions(['26', '--status=paused']), /Opción desconocida/);
});

test('Agent credential issue and revoke require explicit target and validated name', () => {
    assert.deepEqual(parseAgentCredentialIssueOptions(['26', '--name=Marketing CLI']), { agentId: 26, name: 'Marketing CLI' });
    assert.deepEqual(parseAgentCredentialRevokeOptions(['26', '91']), { agentId: 26, credentialId: 91 });
    assert.throws(() => parseAgentCredentialIssueOptions(['0', '--name=Marketing']), /entero positivo/);
    assert.throws(() => parseAgentCredentialIssueOptions(['26']), /name/);
    assert.throws(() => parseAgentCredentialIssueOptions(['26', '--name=Marketing', '--token=secret']), /Opción desconocida/);
    assert.throws(() => parseAgentCredentialRevokeOptions(['26', '0']), /entero positivo/);
});

test('Agent credential listing accepts one report ID and an optional cursor', () => {
    assert.deepEqual(parseAgentCredentialListOptions(['26']), { agentId: 26, afterId: null });
    assert.deepEqual(parseAgentCredentialListOptions(['26', '--after=91']), { agentId: 26, afterId: 91 });
    assert.throws(() => parseAgentCredentialListOptions([]), /Uso:/);
    assert.throws(() => parseAgentCredentialListOptions(['26', '--after=0']), /entero positivo/);
    assert.throws(() => parseAgentCredentialListOptions(['26', '--after=91', '--after=92']), /Uso:/);
});

test('agent offer status accepts only supported lifecycle states', () => {
    assert.deepEqual(parseAgentOfferStatusOptions(['25', 'available']), { offerId: 25, status: 'available' });
    assert.throws(() => parseAgentOfferStatusOptions(['25', 'converted']), /estado no es válido/);
    assert.throws(() => parseAgentOfferStatusOptions(['0', 'available']), /entero positivo/);
});

test('artifact publish and download require explicit paths and valid metadata', () => {
    assert.deepEqual(parseArtifactPublishOptions([
        'reports/daily.md', '--title=Informe diario', '--description=Resumen de mercado.', '--source=market-script',
    ]), {
        filePath: 'reports/daily.md',
        metadata: { title: 'Informe diario', description: 'Resumen de mercado.', source: 'market-script' },
    });
    assert.throws(() => parseArtifactPublishOptions(['reports/daily.md']), /title/);
    assert.throws(() => parseArtifactPublishOptions(['reports/daily.md', '--title=Informe', '--unknown=x']), /Opción desconocida/);
    assert.deepEqual(parseArtifactListOptions(['--after=12']), { afterId: 12 });
    assert.equal(parseArtifactId(['42']), 42);
    assert.throws(() => parseArtifactId(['0']), /entero positivo/);
    assert.throws(() => parseArtifactId(['42', 'extra']), /Uso:/);
    assert.deepEqual(parseArtifactDownloadOptions(['42', '--output=reports/shared.md']), { artifactId: 42, outputPath: 'reports/shared.md' });
    assert.throws(() => parseArtifactDownloadOptions(['42']), /output/);
});

test('agent bet evidence command requires valid evidence fields and an HTTP source URL', () => {
    assert.deepEqual(parseAgentBetEvidenceOptions([
        '25',
        '--title=Entrevistas',
        '--details=Cuatro personas describen el problema.',
        '--assessment=supports',
        '--source-url=https://example.com/report',
    ]), {
        betId: 25,
        evidence: {
            title: 'Entrevistas',
            details: 'Cuatro personas describen el problema.',
            assessment: 'supports',
            source_url: 'https://example.com/report',
        },
    });
    assert.throws(() => parseAgentBetEvidenceOptions(['25', '--title=Fuente']), /details|assessment/i);
    assert.throws(() => parseAgentBetEvidenceOptions([
        '25', '--title=Fuente', '--details=Observación', '--assessment=verified',
    ]), /valoración/);
    assert.throws(() => parseAgentBetEvidenceOptions([
        '25', '--title=Fuente', '--details=Observación', '--assessment=neutral', '--source-url=javascript:alert(1)',
    ]), /HTTP o HTTPS/);
});

test('agent bet status command accepts only transitions outside automatic conversion', () => {
    assert.deepEqual(parseAgentBetStatusOptions(['25', 'investigating']), { betId: 25, status: 'investigating' });
    assert.deepEqual(parseAgentBetStatusOptions(['25', 'validated']), { betId: 25, status: 'validated' });
    assert.throws(() => parseAgentBetStatusOptions(['25', 'converted']), /estado no es válido/);
    assert.throws(() => parseAgentBetStatusOptions(['0', 'validated']), /entero positivo/);
});

test('agent bet conversion requires an explicit product or service type', () => {
    assert.deepEqual(parseAgentBetConversionOptions(['25', '--type=service']), { betId: 25, type: 'service' });
    assert.throws(() => parseAgentBetConversionOptions(['25']), /Uso:/);
    assert.throws(() => parseAgentBetConversionOptions(['25', '--type=subscription']), /producto o servicio/);
    assert.throws(() => parseAgentBetConversionOptions(['0', '--type=product']), /entero positivo/);
});

test('agent status command requires a task ID and supported target status', () => {
    assert.deepEqual(parseAgentStatusOptions(['26', 'in_progress']), { taskId: 26, status: 'in_progress' });
    assert.deepEqual(parseAgentStatusOptions(['26', 'completed']), { taskId: 26, status: 'completed' });
    assert.throws(() => parseAgentStatusOptions(['26']), /Uso:/);
    assert.throws(() => parseAgentStatusOptions(['26', 'unknown']), /estado no es válido/);
});

test('agent task creation requires an idempotency UUID and rejects unknown options', () => {
    const idempotencyKey = '94030b4e-0580-42f6-96d6-cb2b2fe7b457';
    assert.deepEqual(parseAgentTaskCreateOptions([
        '--title=Revisar informe',
        '--priority=high',
        `--idempotency-key=${idempotencyKey}`,
        '--workspace-id=12',
    ]), {
        idempotencyKey,
        task: { title: 'Revisar informe', priority: 'high', workspace_id: 12 },
    });
    assert.throws(() => parseAgentTaskCreateOptions(['--title=Revisar', '--idempotency-key=bad']), /UUID/);
    assert.throws(() => parseAgentTaskCreateOptions(['--title=Revisar']), /idempotency-key/);
    assert.throws(() => parseAgentTaskCreateOptions(['--title=Revisar', '--idempotency-key=' + idempotencyKey, '--command=rm']), /Opción desconocida/);
});

test('agent assignment command accepts a positive Agent ID or explicit unassignment', () => {
    assert.deepEqual(parseAgentAssignmentOptions(['27', '13']), { taskId: 27, assigneeAgentId: 13 });
    assert.deepEqual(parseAgentAssignmentOptions(['27', 'none']), { taskId: 27, assigneeAgentId: null });
    assert.throws(() => parseAgentAssignmentOptions(['27', '0']), /entero positivo/);
    assert.throws(() => parseAgentAssignmentOptions(['27']), /Uso:/);
});

test('agent task edit only accepts editable detail fields and requires at least one', () => {
    assert.deepEqual(parseAgentTaskEditOptions(['27', '--title=Actualizar métricas', '--priority=high']), {
        taskId: 27,
        changes: { title: 'Actualizar métricas', priority: 'high' },
    });
    assert.deepEqual(parseAgentTaskEditOptions(['27', '--due-date=none']), {
        taskId: 27,
        changes: { due_date: null },
    });
    assert.throws(() => parseAgentTaskEditOptions(['27']), /al menos un campo/);
    assert.throws(() => parseAgentTaskEditOptions(['27', '--status=completed']), /Opción desconocida/);
});

test('the executable command is named mycompany and help uses that name', async () => {
    const packagePath = fileURLToPath(new URL('../package.json', import.meta.url));
    const packageConfiguration = JSON.parse(await readFile(packagePath, 'utf8'));
    const output = { value: '', write(chunk) { this.value += chunk; } };

    assert.deepEqual(packageConfiguration.bin, { mycompany: './src/cli.js' });
    assert.equal(await run(['help'], { stdout: output }), 0);
    assert.match(output.value, /mycompany heartbeat/);
    assert.match(output.value, /mycompany init/);
    assert.match(output.value, /mycompany work/);
    assert.match(output.value, /mycompany execute/);
    assert.match(output.value, /mycompany capabilities/);
    const workHelp = output.value.split('mycompany work')[1].split('mycompany capabilities')[0];
    const capabilitiesHelp = output.value.split('mycompany capabilities')[1].split('mycompany tasks')[0];
    assert.match(workHelp, /comprobación autorizada/);
    assert.match(capabilitiesHelp, /localmente/);
    assert.match(capabilitiesHelp, /No conecta con MyCompanies, no inspecciona archivos de secretos/);
    const executeHelp = output.value.split('mycompany execute')[1].split('mycompany tasks')[0];
    assert.match(executeHelp, /después de que MyCompanies confirme \/start/);
    assert.match(executeHelp, /no hace polling/);
    assert.match(output.value, /mycompany tasks/);
    assert.match(output.value, /mycompany tasks \[--status=open\|in_progress\|blocked\] \[--after=ID\]/);
    assert.match(output.value, /mycompany task ID/);
    assert.match(output.value, /mycompany agent login/);
    assert.match(output.value, /mycompany agent identities/);
    assert.match(output.value, /mycompany agent credential list AGENT_ID/);
    assert.match(output.value, /mycompany agent runtime files list \| grant RUTA/);
    assert.match(output.value, /mycompany agent runtime run TASK_ID --provider=codex\|agy/);
    assert.match(output.value, /red está deshabilitada por defecto/);
    assert.match(output.value, /red abierta solo para Codex/);
    assert.match(output.value, /confirmación escrita en un terminal interactivo/);
    assert.match(output.value, /read expone el contenido al agente/);
    assert.doesNotMatch(output.value, /Dev\.to|devto/i);
    assert.match(output.value, /mycompany agent runtime plan TASK_ID --provider=codex\|claude\|agy/);
    assert.match(output.value, /Detecta Codex, Claude Code y Antigravity CLI/);
    assert.match(output.value, /mycompany agent me/);
    assert.match(output.value, /mycompany agent tasks/);
    assert.match(output.value, /mycompany agent bets/);
    assert.match(output.value, /mycompany agent bet ID/);
    assert.match(output.value, /mycompany agent bet evidence ID/);
    assert.match(output.value, /mycompany agent bet status ID ESTADO/);
    assert.match(output.value, /mycompany agent bet convert ID --type=product\|service/);
    assert.match(output.value, /mycompany agent offers/);
    assert.match(output.value, /mycompany agent goals/);
    assert.match(output.value, /mycompany agent goal ID/);
    assert.match(output.value, /mycompany agent assets/);
    assert.match(output.value, /mycompany agent asset ID/);
    assert.match(output.value, /mycompany agent workspaces/);
    assert.match(output.value, /mycompany agent workspace ID/);
    assert.match(output.value, /mycompany agent agents/);
    assert.match(output.value, /mycompany agent create/);
    assert.match(output.value, /mycompany agent pause AGENT_ID \| resume AGENT_ID/);
    assert.match(output.value, /mycompany agent permission grant/);
    assert.match(output.value, /mycompany agent permission revoke/);
    assert.match(output.value, /mycompany agent offer ID/);
    assert.match(output.value, /mycompany agent offer status ID ESTADO/);
    assert.match(output.value, /mycompany artifact publish FILE/);
    assert.match(output.value, /mycompany artifacts/);
    assert.match(output.value, /mycompany artifact show ID/);
    assert.match(output.value, /mycompany artifact download ID --output=FILE/);
    assert.match(output.value, /mycompany agent task ID/);
    assert.match(output.value, /mycompany agent task status ID ESTADO/);
    assert.match(output.value, /mycompany agent task create/);
    assert.match(output.value, /mycompany agent task assign ID/);
    assert.match(output.value, /mycompany agent task edit ID/);
    assert.match(output.value, /no hay sincronización automática/);
    assert.match(output.value, /no se crea una carpeta por Workspace/);
    assert.match(output.value, /no conecta con el servidor/);
    assert.match(output.value, /No reclama, modifica, marca como terminadas ni ejecuta/);
    assert.match(output.value, /No revoca el Runner en MyCompanies/);
    assert.doesNotMatch(output.value, /company-runner/);
});

test('execute rejects command options before contacting MyCompanies', async () => {
    const output = { value: '', write(chunk) { this.value += chunk; } };

    await assert.rejects(
        run(['execute', '--anything'], { stdout: output, stderr: output }, process.cwd()),
        /execute no admite opciones/,
    );
});

test('capabilities reports locally installed adapters without contacting MyCompanies', async () => {
    const companyRoot = await mkdtemp(path.join(process.cwd(), '.mycompany-capabilities-test-'));
    const nestedDirectory = path.join(companyRoot, 'automations', 'devto');
    const scriptPath = path.join(nestedDirectory, 'devto_stats.py');
    await mkdir(nestedDirectory, { recursive: true });
    await writeFile(scriptPath, '# fixture; never executed\n');
    const output = { value: '', write(chunk) { this.value += chunk; } };
    const requestedDirectories = [];
    const configStore = {
        async loadForDirectory(directory) {
            requestedDirectories.push(directory);
            return { workspace_path: companyRoot };
        },
    };

    try {
        assert.equal(await run(['capabilities'], { stdout: output, stderr: output }, companyRoot, configStore), 0);
        assert.match(output.value, /devto\.stats\.totals@1\.0\.0/);
        assert.match(output.value, /solo lectura/);
        assert.match(output.value, /No conecta con MyCompanies ni Dev\.to, no lee \.env/);
        assert.deepEqual(requestedDirectories, [companyRoot]);

        await rm(scriptPath);
        output.value = '';
        assert.equal(await run(['capabilities'], { stdout: output, stderr: output }, companyRoot, configStore), 0);
        assert.match(output.value, /No hay adaptadores locales disponibles/);
    } finally {
        await rm(companyRoot, { recursive: true, force: true });
    }
});

test('agent identities shows only local profiles and never prints tokens', async () => {
    const directory = await mkdtemp(path.join(process.cwd(), '.mycompany-identities-test-'));
    const companyRoot = path.join(directory, 'company');
    const configHome = path.join(directory, 'config');
    const previousConfigHome = process.env.XDG_CONFIG_HOME;
    const previousAgentId = process.env.MYCOMPANY_AGENT_ID;
    await mkdir(companyRoot, { recursive: true });
    const configStore = new ConfigStore(path.join(configHome, 'mycompanies', 'runner.json'));
    const createConfiguration = (agentId, agentName) => ({
        server_url: 'https://mycompanies.example', agent_id: agentId, agent_name: agentName,
        company_id: 4, company_name: 'Devetty', company_root_path: companyRoot,
        allow_insecure_localhost: false, api_token: String(agentId).repeat(80),
    });
    await configStore.saveAgent(createConfiguration(1, 'CEO'));
    await configStore.saveAgent(createConfiguration(12, 'Marketing'));
    process.env.XDG_CONFIG_HOME = configHome;
    process.env.MYCOMPANY_AGENT_ID = '12';
    const stdout = { value: '', write(chunk) { this.value += chunk; } };
    const stderr = { value: '', write(chunk) { this.value += chunk; } };

    try {
        assert.equal(await run(['agent', 'identities'], { stdout, stderr }, companyRoot), 0);
        assert.match(stdout.value, /#1 CEO · predeterminado/);
        assert.match(stdout.value, /#12 Marketing · seleccionado/);
        assert.doesNotMatch(stdout.value, /api_token|111111|121212/);
        assert.equal(stderr.value, '');
    } finally {
        if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = previousConfigHome;
        if (previousAgentId === undefined) delete process.env.MYCOMPANY_AGENT_ID;
        else process.env.MYCOMPANY_AGENT_ID = previousAgentId;
        await rm(directory, { recursive: true, force: true });
    }
});

test('credential listing shows actor type and names without printing token material', async () => {
    const directory = await mkdtemp(path.join(process.cwd(), '.mycompany-credential-audit-test-'));
    const companyRoot = path.join(directory, 'company');
    const configHome = path.join(directory, 'config');
    const previousConfigHome = process.env.XDG_CONFIG_HOME;
    const previousAgentId = process.env.MYCOMPANY_AGENT_ID;
    await mkdir(companyRoot, { recursive: true });
    const token = 'A'.repeat(80);
    const server = createServer((request, response) => {
        assert.equal(request.url, '/api/v1/agent/agents/12/credentials');
        assert.equal(request.headers.authorization, `Bearer ${token}`);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
            agent: { id: 12, name: 'Marketing', status: 'active' },
            credentials: [{
                id: 44, name: 'Runtime', issued_by_type: 'agent', issued_by_name: 'CEO Vera',
                created_at: '2026-11-04T10:00:00.000Z', revoked_by_type: 'user', revoked_by_name: 'Pablo',
                revoked_at: '2026-11-04T11:00:00.000Z',
            }],
            has_more: false, next_after: null,
        }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const serverUrl = `http://127.0.0.1:${server.address().port}`;
    const configStore = new ConfigStore(path.join(configHome, 'mycompanies', 'runner.json'));
    await configStore.saveAgent({
        server_url: serverUrl, agent_id: 1, agent_name: 'CEO', company_id: 4,
        company_name: 'Devetty', company_root_path: companyRoot, allow_insecure_localhost: true, api_token: token,
    });
    process.env.XDG_CONFIG_HOME = configHome;
    delete process.env.MYCOMPANY_AGENT_ID;
    const stdout = { value: '', write(chunk) { this.value += chunk; } };
    const stderr = { value: '', write(chunk) { this.value += chunk; } };

    try {
        assert.equal(await run(['agent', 'credential', 'list', '12'], { stdout, stderr }, companyRoot), 0);
        assert.match(stdout.value, /Emitida por agente: CEO Vera/);
        assert.match(stdout.value, /revocada .* · revocada por persona: Pablo/);
        assert.doesNotMatch(stdout.value, /api_token|token_hash|A{80}/);
        assert.equal(stderr.value, '');
    } finally {
        server.close();
        await once(server, 'close');
        if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = previousConfigHome;
        if (previousAgentId === undefined) delete process.env.MYCOMPANY_AGENT_ID;
        else process.env.MYCOMPANY_AGENT_ID = previousAgentId;
        await rm(directory, { recursive: true, force: true });
    }
});

test('tasks command requests and labels only the selected active status', async () => {
    const directory = await mkdtemp(path.join(process.cwd(), '.mycompany-task-filter-test-'));
    const companyRoot = path.join(directory, 'company');
    const configHome = path.join(directory, 'config');
    const previousConfigHome = process.env.XDG_CONFIG_HOME;
    await mkdir(companyRoot, { recursive: true });
    const token = 'B'.repeat(80);
    const server = createServer((request, response) => {
        assert.equal(request.url, '/api/v1/runner/tasks?status=blocked');
        assert.equal(request.headers.authorization, `Bearer ${token}`);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
            tasks: [{
                id: 18, title: 'Revisar bloqueo', status: 'blocked', priority: 'high', due_date: null,
                assignee: null, workspace: { id: 9, name: 'Operaciones' },
            }],
            has_more: false, next_after: null,
        }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const serverUrl = `http://127.0.0.1:${server.address().port}`;
    const configStore = new ConfigStore(path.join(configHome, 'mycompanies', 'runner.json'));
    await configStore.saveNew({
        server_url: serverUrl, runner_id: 7, workspace_path: companyRoot,
        allow_insecure_localhost: true, api_token: token,
    });
    process.env.XDG_CONFIG_HOME = configHome;
    const stdout = { value: '', write(chunk) { this.value += chunk; } };
    const stderr = { value: '', write(chunk) { this.value += chunk; } };

    try {
        assert.equal(await run(['tasks', '--status=blocked'], { stdout, stderr }, companyRoot), 0);
        assert.match(stdout.value, /Tareas activas · bloqueadas \(1\):/);
        assert.match(stdout.value, /Revisar bloqueo/);
        assert.equal(stderr.value, '');
    } finally {
        server.close();
        await once(server, 'close');
        if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = previousConfigHome;
        await rm(directory, { recursive: true, force: true });
    }
});

test('agent tasks command requests and labels only the selected active status', async () => {
    const directory = await mkdtemp(path.join(process.cwd(), '.mycompany-agent-task-filter-test-'));
    const companyRoot = path.join(directory, 'company');
    const configHome = path.join(directory, 'config');
    const previousConfigHome = process.env.XDG_CONFIG_HOME;
    const previousAgentId = process.env.MYCOMPANY_AGENT_ID;
    await mkdir(companyRoot, { recursive: true });
    const token = 'C'.repeat(80);
    const server = createServer((request, response) => {
        assert.equal(request.url, '/api/v1/agent/tasks?status=blocked');
        assert.equal(request.headers.authorization, `Bearer ${token}`);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
            tasks: [{
                id: 19, title: 'Resolver bloqueo', status: 'blocked', priority: 'normal', due_date: null,
                assignee: null, workspace: null,
            }],
            has_more: false, next_after: null,
        }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const configStore = new ConfigStore(path.join(configHome, 'mycompanies', 'runner.json'));
    await configStore.saveAgent({
        server_url: `http://127.0.0.1:${server.address().port}`, agent_id: 12, agent_name: 'Vera',
        company_id: 4, company_name: 'Devetty', company_root_path: companyRoot,
        allow_insecure_localhost: true, api_token: token,
    });
    process.env.XDG_CONFIG_HOME = configHome;
    delete process.env.MYCOMPANY_AGENT_ID;
    const stdout = { value: '', write(chunk) { this.value += chunk; } };
    const stderr = { value: '', write(chunk) { this.value += chunk; } };

    try {
        assert.equal(await run(['agent', 'tasks', '--status=blocked'], { stdout, stderr }, companyRoot), 0);
        assert.match(stdout.value, /Tareas del agente · bloqueadas \(1\):/);
        assert.match(stdout.value, /Resolver bloqueo/);
        assert.equal(stderr.value, '');
    } finally {
        server.close();
        await once(server, 'close');
        if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = previousConfigHome;
        if (previousAgentId === undefined) delete process.env.MYCOMPANY_AGENT_ID;
        else process.env.MYCOMPANY_AGENT_ID = previousAgentId;
        await rm(directory, { recursive: true, force: true });
    }
});

test('agent memory CLI lists company topics and hides unauthorized topics', async () => {
    const directory = await mkdtemp(path.join(process.cwd(), '.mycompany-agent-memory-test-'));
    const companyRoot = path.join(directory, 'company');
    const configHome = path.join(directory, 'config');
    const previousConfigHome = process.env.XDG_CONFIG_HOME;
    const previousAgentId = process.env.MYCOMPANY_AGENT_ID;
    await mkdir(companyRoot, { recursive: true });
    const token = 'M'.repeat(80);
    const server = createServer((request, response) => {
        assert.equal(request.url, '/api/v1/agent/memory/topics');
        assert.equal(request.headers.authorization, `Bearer ${token}`);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ topics: [{
            id: 7, name: 'Mercado', can_read: true, can_write: false,
            company_read: false, company_write: false,
            workspace_read_ids: [3], workspace_write_ids: [],
        }] }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const configStore = new ConfigStore(path.join(configHome, 'mycompanies', 'runner.json'));
    await configStore.saveAgent({
        server_url: `http://127.0.0.1:${server.address().port}`, agent_id: 12, agent_name: 'Vera',
        company_id: 4, company_name: 'Devetty', company_root_path: companyRoot,
        allow_insecure_localhost: true, api_token: token,
    });
    process.env.XDG_CONFIG_HOME = configHome;
    delete process.env.MYCOMPANY_AGENT_ID;
    const stdout = { value: '', write(chunk) { this.value += chunk; } };
    try {
        assert.equal(await run(['agent', 'memory', 'topics'], { stdout }, companyRoot, configStore), 0);
        assert.match(stdout.value, /#7 Mercado/);
        assert.match(stdout.value, /lectura workspaces 3/);
    } finally {
        server.close();
        await once(server, 'close');
        if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
        else process.env.XDG_CONFIG_HOME = previousConfigHome;
        if (previousAgentId === undefined) delete process.env.MYCOMPANY_AGENT_ID;
        else process.env.MYCOMPANY_AGENT_ID = previousAgentId;
        await rm(directory, { recursive: true, force: true });
    }
});

test('agent memory CLI validates filters, entries and source URLs', () => {
    assert.deepEqual(parseAgentMemoryOptions('search', ['--query=alertas', '--topic=7', '--workspace=3']), { query: 'alertas', topicId: 7, workspaceId: 3 });
    assert.deepEqual(parseAgentMemoryOptions('list', ['--topic=7', '--workspace=3', '--after=80']), { topicId: 7, workspaceId: 3, afterId: 80 });
    assert.deepEqual(parseAgentMemoryOptions('show', ['81']), { memoryId: 81 });
    assert.throws(() => parseAgentMemoryOptions('list', ['--topic=0']), /positivo/);
    assert.throws(() => parseAgentMemoryOptions('topics', ['unexpected']), /Uso/);
    assert.throws(() => parseAgentMemoryOptions('add', ['--topic=7', '--kind=observation', '--title=t', '--content=c', '--source-type=url']), /HTTP o HTTPS/);
    assert.equal(parseAgentMemoryOptions('add', ['--topic=7', '--kind=hypothesis', '--title=Hipótesis', '--content=Texto', '--source-type=url', '--source-reference=https://example.test']).entry.topicId, 7);
});

test('init prepares the selected company root without Runner enrollment', async () => {
    const directory = await mkdtemp(path.join(process.cwd(), '.mycompany-cli-test-'));
    try {
        const output = { value: '', write(chunk) { this.value += chunk; } };
        assert.equal(await run(['init'], { stdout: output }, directory), 0);
        assert.match(output.value, /8 archivos creados/);
        assert.equal((await stat(path.join(directory, 'AGENTS.md'))).isFile(), true);
        assert.equal((await stat(path.join(directory, 'CLAUDE.md'))).isFile(), true);

        output.value = '';
        await run(['init'], { stdout: output }, directory);
        assert.match(output.value, /0 archivos creados/);
        assert.match(output.value, /sin cambios/);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('task detail accepts only a positive numeric task ID', () => {
    assert.equal(parseTaskId('42'), 42);
    assert.throws(() => parseTaskId('0'), /entero positivo/);
    assert.throws(() => parseTaskId('4abc'), /entero positivo/);
    assert.throws(() => parseTaskId('9007199254740992'), /entero positivo/);
});

test('task listing accepts one positive after cursor', () => {
    assert.deepEqual(parseTasksOptions([]), { afterId: null, status: null });
    assert.deepEqual(parseTasksOptions(['--after=100']), { afterId: 100, status: null });
    assert.throws(() => parseTasksOptions(['--after=0']), /entero positivo/);
    assert.deepEqual(parseTasksOptions(['--status=blocked']), { afterId: null, status: 'blocked' });
    assert.deepEqual(parseTasksOptions(['--status=open', '--after=100']), { afterId: 100, status: 'open' });
    assert.throws(() => parseTasksOptions(['--status=completed']), /estado activo/);
    assert.throws(() => parseTasksOptions(['--status=blocked', '--status=open']), /Opción desconocida/);
    assert.throws(() => parseTasksOptions(['--all']), /Opción desconocida/);
});

test('enrollment code input disables terminal echo and restores the prior mode', async () => {
    const stdin = new EventEmitter();
    stdin.isTTY = true;
    stdin.isRaw = false;
    stdin.modes = [];
    stdin.setRawMode = (mode) => stdin.modes.push(mode);
    stdin.resume = () => {};
    stdin.pause = () => {};
    const output = { contents: '', write(value) { this.contents += value; } };

    const pendingCode = readHiddenCode(stdin, output);
    stdin.emit('data', Buffer.from(`${'C'.repeat(64)}\r`));

    assert.equal(await pendingCode, 'C'.repeat(64));
    assert.deepEqual(stdin.modes, [true, false]);
    assert.equal(output.contents.includes('C'.repeat(64)), false);
});

test('enrollment code input refuses non-interactive stdin', async () => {
    const stdin = new EventEmitter();
    stdin.isTTY = false;
    assert.rejects(readHiddenCode(stdin, { write() {} }), /terminal interactivo/);
});
