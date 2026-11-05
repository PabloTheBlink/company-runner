import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { buildAntigravityInvocation, buildClaudeInvocation, buildCodexInvocation, runAgentRuntime, runAntigravityAgent, runClaudeAgent, runCodexAgent } from '../src/agent-runtime.js';

test('Codex invocation uses reviewed workspace-write, is ephemeral, and disables network', () => {
    const invocation = buildCodexInvocation({ prompt: 'private task text', cwd: '/private/staging', timeoutMs: 60_000 });

    assert.equal(invocation.command, 'codex');
    assert.ok(invocation.args.includes('exec'));
    assert.ok(invocation.args.includes('--approve-for-me'));
    assert.equal(invocation.args.includes('--sandbox'), false);
    assert.ok(invocation.args.includes('--ephemeral'));
    assert.ok(invocation.args.includes('--json'));
    assert.ok(invocation.args.includes('--ignore-user-config'));
    assert.ok(invocation.args.includes('--ignore-rules'));
    assert.ok(invocation.args.includes('sandbox_workspace_write.network_access=false'));
    assert.equal(invocation.args.includes('private task text'), false);
    assert.equal(invocation.cwd, '/private/staging');
    assert.match(invocation.input, /private task text/);

    const networkInvocation = buildCodexInvocation({
        prompt: 'research task',
        cwd: '/private/staging',
        timeoutMs: 60_000,
        allowNetwork: true,
    });
    assert.ok(networkInvocation.args.includes('sandbox_workspace_write.network_access=true'));
});

test('Codex process receives task input over stdin and parses only the final agent message', async () => {
    let receivedOptions;
    let receivedInput = '';
    const spawnImplementation = (command, args, options) => {
        assert.equal(command, '/usr/local/bin/codex');
        assert.ok(args.includes('--approve-for-me'));
        assert.equal(args.includes('--sandbox'), false);
        receivedOptions = { command, args, ...options };
        const child = createFakeChild();
        child.stdin.on('data', (chunk) => { receivedInput += chunk.toString(); });
        setImmediate(() => {
            child.stdout.end([
                JSON.stringify({ type: 'thread.started', thread_id: 'private-id' }),
                JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Informe redactado' } }),
                JSON.stringify({ type: 'turn.completed' }),
            ].join('\n'));
            child.emit('close', 0, null);
        });
        return child;
    };

    const result = await runAgentRuntime({
        provider: 'codex',
        prompt: 'contexto privado',
        cwd: '/private/staging',
        timeoutMs: 60_000,
        spawnImplementation,
        sandboxVerifier: async () => true,
        commandResolver: () => '/usr/local/bin/codex',
        allowNetwork: true,
        environment: { PATH: '/usr/bin', HOME: '/home/test', OPENAI_API_KEY: 'do-not-pass', GEMINI_API_KEY: 'do-not-pass' },
    });

    assert.equal(receivedOptions.cwd, '/private/staging');
    assert.equal(receivedOptions.command, '/usr/local/bin/codex');
    assert.equal(receivedOptions.shell, false);
    assert.equal(receivedOptions.detached, true);
    assert.equal(receivedOptions.env.OPENAI_API_KEY, undefined);
    assert.equal(receivedOptions.env.GEMINI_API_KEY, undefined);
    assert.ok(receivedOptions.args.includes('sandbox_workspace_write.network_access=true'));
    assert.match(receivedInput, /contexto privado/);
    assert.deepEqual(result, { response: 'Informe redactado' });
});

test('Codex runtime rejects a response without a completed turn', async () => {
    const spawnImplementation = () => {
        const child = createFakeChild();
        setImmediate(() => {
            child.stdout.end(JSON.stringify({
                type: 'item.completed',
                item: { type: 'agent_message', text: 'Respuesta parcial' },
            }));
            child.emit('close', 0, null);
        });
        return child;
    };

    await assert.rejects(runCodexAgent({
        prompt: 'contexto',
        cwd: '/private/staging',
        timeoutMs: 60_000,
        spawnImplementation,
        sandboxVerifier: async () => true,
        commandResolver: () => '/usr/local/bin/codex',
    }), /respuesta satisfactoria/);
});

test('Claude invocation runs restricted with only staged file tools and no shell, web, or MCP tools', () => {
    const invocation = buildClaudeInvocation({ prompt: 'private task context', cwd: '/private/staging', timeoutMs: 60_000 });

    assert.equal(invocation.command, 'claude');
    assert.equal(invocation.cwd, '/private/staging');
    assert.ok(invocation.args.includes('--restricted'));
    assert.ok(invocation.args.includes('--tools'));
    assert.ok(invocation.args.includes('Read,Write,Edit'));
    assert.ok(invocation.args.includes('--strict-mcp-config'));
    assert.ok(invocation.args.includes('--disable-slash-commands'));
    assert.ok(invocation.args.includes('--no-session-persistence'));
    assert.ok(invocation.args.includes('--permission-mode'));
    assert.ok(invocation.args.includes('acceptEdits'));
    assert.ok(invocation.args.includes('--permission-prompts'));
    assert.ok(invocation.args.includes('none'));
    assert.ok(invocation.args.includes('--output-format'));
    assert.ok(invocation.args.includes('json'));
    assert.ok(invocation.args.includes('--print'));
    assert.equal(invocation.args.includes('--dangerously-skip-permissions'), false);
    assert.equal(invocation.args.includes('private task context'), false);
    assert.match(invocation.input, /private task context/);
});

test('Claude process receives task context over stdin and returns only validated result text', async () => {
    let receivedOptions;
    let receivedInput = '';
    const spawnImplementation = (command, args, options) => {
        assert.equal(command, 'claude');
        assert.ok(args.includes('--restricted'));
        receivedOptions = { command, args, ...options };
        const child = createFakeChild();
        child.stdin.on('data', (chunk) => { receivedInput += chunk.toString(); });
        setImmediate(() => {
            child.stdout.end(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Informe redactado' }));
            child.emit('close', 0, null);
        });
        return child;
    };

    const result = await runClaudeAgent({
        prompt: 'contexto privado',
        cwd: '/private/staging',
        timeoutMs: 60_000,
        spawnImplementation,
        environment: {
            PATH: '/usr/bin', HOME: '/home/test', ANTHROPIC_API_KEY: 'provider-auth',
            GEMINI_API_KEY: 'must-not-pass', OPENAI_API_KEY: 'must-not-pass',
        },
    });

    assert.equal(receivedOptions.cwd, '/private/staging');
    assert.equal(receivedOptions.shell, false);
    assert.equal(receivedOptions.detached, true);
    assert.equal(receivedOptions.env.ANTHROPIC_API_KEY, 'provider-auth');
    assert.equal(receivedOptions.env.GEMINI_API_KEY, undefined);
    assert.equal(receivedOptions.env.OPENAI_API_KEY, undefined);
    assert.match(receivedInput, /contexto privado/);
    assert.deepEqual(result, { response: 'Informe redactado' });
});

test('Claude runtime rejects incomplete or malformed results and stops when interrupted', async () => {
    for (const output of [
        'not json',
        JSON.stringify({ type: 'result', subtype: 'error', is_error: true, result: 'partial' }),
        JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '' }),
    ]) {
        const spawnImplementation = () => {
            const child = createFakeChild();
            setImmediate(() => {
                child.stdout.end(output);
                child.emit('close', 0, null);
            });
            return child;
        };
        await assert.rejects(runClaudeAgent({
            prompt: 'contexto', cwd: '/private/staging', timeoutMs: 60_000, spawnImplementation,
        }), output === 'not json' ? /respuesta no válida/ : /respuesta satisfactoria/);
    }

    const controller = new AbortController();
    let child;
    const pendingRun = runClaudeAgent({
        prompt: 'contexto', cwd: '/private/staging', timeoutMs: 60_000, signal: controller.signal,
        spawnImplementation: () => { child = createFakeChild(); return child; },
    });
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await assert.rejects(pendingRun, /interrumpida/);
    assert.equal(child.killed, true);
});

test('Agent runtime refuses unknown providers', async () => {
    await assert.rejects(runAgentRuntime({ provider: 'unknown' }), /proveedor solicitado no está disponible/);
});

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
