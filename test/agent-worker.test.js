import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { startAgentWorker, getAgentWorkerStatus, requestAgentWorkerStop, runAgentWorkerService, updateAgentWorkerState } from '../src/agent-worker.js';

async function withTemporaryDirectory(callback) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'mycompany-worker-'));
    try {
        await callback(directory);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

test('worker start is idempotent and status and stop use the persisted process state', async () => {
    await withTemporaryDirectory(async (directory) => {
        const statePath = path.join(directory, 'workers', 'identity', 'state.json');
        const child = new EventEmitter();
        child.pid = 4242;
        child.unref = () => {};
        const launches = [];
        const options = {
            statePath,
            agentId: 12,
            command: process.execPath,
            args: ['worker.js'],
            cwd: directory,
            spawnImplementation: (...argumentsList) => {
                launches.push(argumentsList);
                return child;
            },
            processAlive: (pid) => pid === 4242,
            now: () => '2026-11-05T18:00:00.000Z',
        };

        const started = await startAgentWorker(options);
        assert.equal(started.status, 'starting');
        assert.equal(started.pid, 4242);
        assert.equal(launches.length, 1);
        assert.equal(launches[0][2].detached, true);
        assert.equal(launches[0][2].stdio, 'ignore');
        assert.equal(launches[0][2].env.MYCOMPANY_WORKER_STATE_PATH, statePath);
        assert.equal(launches[0][2].env.MYCOMPANY_AGENT_ID, '12');
        assert.equal(launches[0][2].env.DEVTO_API_KEY, undefined);

        const repeatedStart = await startAgentWorker(options);
        assert.equal(repeatedStart.status, 'starting');
        assert.equal(repeatedStart.already_running, true);
        assert.equal(launches.length, 1);

        await updateAgentWorkerState(statePath, { status: 'running', heartbeat_at: '2026-11-05T18:00:05.000Z' });
        assert.equal((await getAgentWorkerStatus(statePath, () => true)).status, 'running');

        const stopping = await requestAgentWorkerStop(statePath, () => true, () => '2026-11-05T18:00:10.000Z');
        assert.equal(stopping.status, 'stopping');
        assert.equal(stopping.stop_requested_at, '2026-11-05T18:00:10.000Z');
        assert.equal(JSON.parse(await readFile(statePath, 'utf8')).status, 'stopping');
    });
});

test('worker status marks crashed processes stopped and stop on an absent worker is harmless', async () => {
    await withTemporaryDirectory(async (directory) => {
        const statePath = path.join(directory, 'state.json');
        assert.equal((await getAgentWorkerStatus(statePath, () => false)).status, 'stopped');
        await startAgentWorker({
            statePath,
            agentId: 21,
            command: process.execPath,
            args: [],
            cwd: directory,
            spawnImplementation: () => Object.assign(new EventEmitter(), { pid: 5151, unref() {} }),
            processAlive: () => true,
        });
        const stopped = await getAgentWorkerStatus(statePath, () => false);
        assert.equal(stopped.status, 'stopped');
        assert.equal(stopped.exit_reason, 'process_not_running');
        assert.equal((await requestAgentWorkerStop(path.join(directory, 'missing.json'), () => false)).status, 'stopped');
    });
});

test('worker stop waits for its current task, then does not claim another one', async () => {
    await withTemporaryDirectory(async (directory) => {
        const statePath = path.join(directory, 'state.json');
        const child = Object.assign(new EventEmitter(), { pid: 6262, unref() {} });
        await startAgentWorker({
            statePath,
            agentId: 22,
            command: process.execPath,
            args: [],
            cwd: directory,
            spawnImplementation: () => child,
            processAlive: () => true,
            metadata: { provider: 'codex' },
        });
        let workCount = 0;
        const result = await runAgentWorkerService({
            statePath,
            pid: child.pid,
            provider: 'codex',
            runWorkOnce: async () => {
                workCount += 1;
                await requestAgentWorkerStop(statePath, () => true);
                return 0;
            },
            sleep: async () => assert.fail('No debe iniciar otra espera ni reclamar otro trabajo tras la parada.'),
        });

        assert.deepEqual(result, { status: 'stopped', exit_code: 0, exit_reason: 'stop_requested' });
        assert.equal(workCount, 1);
        assert.equal((await getAgentWorkerStatus(statePath, () => true)).status, 'stopped');
    });
});

test('worker stops after a task worker error without retrying it automatically', async () => {
    await withTemporaryDirectory(async (directory) => {
        const statePath = path.join(directory, 'state.json');
        await startAgentWorker({
            statePath,
            agentId: 23,
            command: process.execPath,
            args: [],
            cwd: directory,
            spawnImplementation: () => Object.assign(new EventEmitter(), { pid: 7373, unref() {} }),
            processAlive: () => true,
            metadata: { provider: 'agy' },
        });
        let workCount = 0;
        const result = await runAgentWorkerService({
            statePath,
            pid: 7373,
            provider: 'agy',
            runWorkOnce: async () => {
                workCount += 1;
                return 1;
            },
        });

        assert.deepEqual(result, { status: 'failed', exit_code: 1, exit_reason: 'task_worker_failed' });
        assert.equal(workCount, 1);
        assert.equal((await getAgentWorkerStatus(statePath, () => true)).status, 'failed');
    });
});
