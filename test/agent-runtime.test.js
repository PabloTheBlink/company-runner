import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { buildAntigravityInvocation, runAntigravityAgent } from '../src/agent-runtime.js';

test('Antigravity invocation forces an isolated, tool-limited session', () => {
    const invocation = buildAntigravityInvocation({ prompt: 'private task text', timeoutMs: 60_000 });

    assert.equal(invocation.command, 'agy');
    assert.deepEqual(invocation.args.slice(0, 3), ['--mode=accept-edits', '--sandbox', '--disable-slash-commands']);
    assert.equal(invocation.args.includes('private task text'), false);
    const settingsIndex = invocation.args.indexOf('--settings');
    const settings = JSON.parse(invocation.args[settingsIndex + 1]);
    assert.equal(settings.allowNonWorkspaceAccess, false);
    assert.equal(settings.enableTerminalSandbox, true);
    assert.equal(settings.agentMode, 'accept-edits');
    assert.equal(settings.toolPermission, 'proceed-in-sandbox');
    assert.deepEqual(settings.permissions.deny, [
        'command(*)',
        'unsandboxed(*)',
        'read_url(*)',
        'execute_url(*)',
        'mcp(*)',
    ]);
    assert.ok(invocation.args.includes('--output-format=json'));
    assert.ok(invocation.args.includes('--print-timeout=60s'));
});

test('Antigravity process runs without a shell in the staged directory and returns only validated response text', async () => {
    let receivedOptions;
    let receivedInput = '';
    const spawnImplementation = (command, args, options) => {
        assert.equal(command, 'agy');
        assert.ok(args.includes('--sandbox'));
        receivedOptions = options;
        const child = createFakeChild();
        child.stdin.on('data', (chunk) => { receivedInput += chunk.toString(); });
        setImmediate(() => {
            child.stdout.end(JSON.stringify({ status: 'SUCCESS', response: 'Resumen completado', duration_seconds: 1 }));
            child.emit('close', 0, null);
        });
        return child;
    };

    const result = await runAntigravityAgent({
        prompt: 'contexto privado',
        cwd: '/private/staging',
        timeoutMs: 60_000,
        spawnImplementation,
        sandboxVerifier: async () => true,
        environment: { PATH: '/usr/bin', HOME: '/home/test', GEMINI_API_KEY: 'secret' },
    });

    assert.equal(receivedOptions.cwd, '/private/staging');
    assert.equal(receivedOptions.shell, false);
    assert.equal(receivedOptions.detached, true);
    assert.equal(receivedInput, 'contexto privado');
    assert.equal(receivedOptions.env.GEMINI_API_KEY, 'secret');
    assert.deepEqual(result, { response: 'Resumen completado' });
});

test('cancelling an Antigravity run terminates the child process and returns no result', async () => {
    const controller = new AbortController();
    let child;
    const spawnImplementation = () => {
        child = createFakeChild();
        return child;
    };
    const pendingRun = runAntigravityAgent({
        prompt: 'contexto',
        cwd: '/private/staging',
        timeoutMs: 60_000,
        signal: controller.signal,
        spawnImplementation,
        sandboxVerifier: async () => true,
    });

    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();

    await assert.rejects(pendingRun, /interrumpida/);
    assert.equal(child.killed, true);
});

test('Antigravity does not start if the host sandbox cannot be verified', async () => {
    let providerStarted = false;

    await assert.rejects(runAntigravityAgent({
        prompt: 'contexto',
        cwd: '/private/staging',
        timeoutMs: 60_000,
        spawnImplementation: () => { providerStarted = true; },
        sandboxVerifier: async () => { throw new Error('sandbox unavailable'); },
    }), /sandbox unavailable/);
    assert.equal(providerStarted, false);
});

function createFakeChild() {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = () => {
        child.killed = true;
        setImmediate(() => child.emit('close', null, 'SIGTERM'));
    };

    return child;
}
