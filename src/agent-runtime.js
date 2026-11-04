import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

const MAX_PROVIDER_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_PROVIDER_DIAGNOSTIC_BYTES = 128 * 1024;
const MAX_RUNTIME_MS = 15 * 60 * 1000;
const PROVIDER_PROMPT = 'Lee el contexto estructurado enviado por MyCompanies en stdin y trabaja en la tarea indicada. Devuelve un resumen final.';
const CODEX_PROMPT = 'Lee el contexto estructurado enviado por MyCompanies en stdin y trabaja únicamente con los archivos del workspace aislado. Devuelve un resumen final.';
const RUNTIME_SETTINGS = Object.freeze({
    agentMode: 'accept-edits',
    allowNonWorkspaceAccess: false,
    enableTerminalSandbox: true,
    toolPermission: 'proceed-in-sandbox',
    permissions: {
        deny: ['command(*)', 'unsandboxed(*)', 'read_url(*)', 'execute_url(*)', 'mcp(*)'],
    },
});
const RUNTIME_ENVIRONMENT_KEYS = [
    'PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'COLORTERM', 'NO_COLOR',
    'XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'GEMINI_API_KEY',
    'CODEX_HOME', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
];

export function buildAntigravityInvocation({ prompt, timeoutMs }) {
    if (typeof prompt !== 'string' || prompt.length === 0) {
        throw new Error('Falta el contexto de la tarea para iniciar el proveedor.');
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > MAX_RUNTIME_MS) {
        throw new Error('El límite del runtime debe estar entre 1 segundo y 15 minutos.');
    }

    const timeoutSeconds = Math.ceil(timeoutMs / 1_000);
    return {
        command: 'agy',
        args: [
            '--mode=accept-edits',
            '--sandbox',
            '--disable-slash-commands',
            '--settings',
            JSON.stringify(RUNTIME_SETTINGS),
            '--output-format=json',
            `--print-timeout=${timeoutSeconds}s`,
            '--print',
            PROVIDER_PROMPT,
        ],
        input: prompt,
    };
}

export function buildCodexInvocation({ prompt, cwd, timeoutMs, allowNetwork = false }) {
    if (typeof prompt !== 'string' || prompt.length === 0) {
        throw new Error('Falta el contexto de la tarea para iniciar el proveedor.');
    }
    if (typeof cwd !== 'string' || cwd.length === 0) {
        throw new Error('Falta la carpeta temporal aislada para el proveedor.');
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > MAX_RUNTIME_MS) {
        throw new Error('El límite del runtime debe estar entre 1 segundo y 15 minutos.');
    }

    return {
        command: 'codex',
        args: [
            'exec',
            '--sandbox', 'workspace-write',
            '--ephemeral',
            '--json',
            '--skip-git-repo-check',
            '--ignore-user-config',
            '--ignore-rules',
            '-c', `sandbox_workspace_write.network_access=${allowNetwork ? 'true' : 'false'}`,
            '-',
        ],
        cwd,
        input: `${CODEX_PROMPT}\n${prompt}`,
    };
}

export async function runCodexAgent({
    prompt,
    cwd,
    timeoutMs,
    signal,
    spawnImplementation = spawn,
    sandboxVerifier = verifyLinuxSandbox,
    commandResolver = resolveCodexCommand,
    allowNetwork = false,
    environment = process.env,
}) {
    if (signal?.aborted) throw new Error('La ejecución del agente fue interrumpida.');

    const invocation = buildCodexInvocation({ prompt, cwd, timeoutMs, allowNetwork });
    await sandboxVerifier();
    if (signal?.aborted) throw new Error('La ejecución del agente fue interrumpida.');
    const command = commandResolver(environment);

    return new Promise((resolve, reject) => {
        let child;
        let outputBytes = 0;
        let diagnosticBytes = 0;
        const outputChunks = [];
        let failure = null;
        let escalationTimer;
        const timeoutTimer = setTimeout(() => {
            failure = new Error('El proveedor superó el límite de tiempo; no se aplicaron cambios locales.');
            terminateChild(child, 'SIGTERM');
            escalationTimer = setTimeout(() => terminateChild(child, 'SIGKILL'), 1_000);
            escalationTimer.unref?.();
        }, timeoutMs + 5_000);
        timeoutTimer.unref?.();

        const cleanup = () => {
            clearTimeout(timeoutTimer);
            clearTimeout(escalationTimer);
            signal?.removeEventListener('abort', abortHandler);
        };
        const abortHandler = () => {
            failure = new Error('La ejecución del agente fue interrumpida; no se aplicaron cambios locales.');
            terminateChild(child, 'SIGTERM');
            escalationTimer = setTimeout(() => terminateChild(child, 'SIGKILL'), 1_000);
            escalationTimer.unref?.();
        };

        try {
            child = spawnImplementation(command, invocation.args, {
                cwd: invocation.cwd,
                env: selectCodexEnvironment(environment),
                shell: false,
                windowsHide: true,
                detached: process.platform !== 'win32',
                stdio: ['pipe', 'pipe', 'pipe'],
            });
        } catch {
            cleanup();
            reject(new Error('No se pudo iniciar Codex CLI.'));
            return;
        }

        signal?.addEventListener('abort', abortHandler, { once: true });
        child.stdout.on('data', (chunk) => {
            outputBytes += chunk.length;
            if (outputBytes > MAX_PROVIDER_OUTPUT_BYTES) {
                failure = new Error('La respuesta del proveedor superó el límite; no se aplicaron cambios locales.');
                terminateChild(child, 'SIGTERM');
                escalationTimer = setTimeout(() => terminateChild(child, 'SIGKILL'), 1_000);
                escalationTimer.unref?.();
                return;
            }
            outputChunks.push(chunk);
        });
        child.stderr.on('data', (chunk) => {
            diagnosticBytes += chunk.length;
            if (diagnosticBytes > MAX_PROVIDER_DIAGNOSTIC_BYTES && failure === null) {
                failure = new Error('El proveedor generó demasiados mensajes de diagnóstico.');
                terminateChild(child, 'SIGTERM');
                escalationTimer = setTimeout(() => terminateChild(child, 'SIGKILL'), 1_000);
                escalationTimer.unref?.();
            }
        });
        child.once('error', () => {
            cleanup();
            reject(new Error('No se pudo iniciar Codex CLI.'));
        });
        child.once('close', (exitCode) => {
            cleanup();
            if (failure !== null) {
                reject(failure);
                return;
            }
            if (exitCode !== 0) {
                reject(new Error('Codex CLI no completó la tarea correctamente.'));
                return;
            }

            const response = parseCodexResponse(Buffer.concat(outputChunks).toString('utf8'));
            if (response === null) {
                reject(new Error('Codex CLI no devolvió una respuesta satisfactoria.'));
                return;
            }
            resolve({ response });
        });
        child.stdin.on('error', () => {});
        child.stdin.end(invocation.input, 'utf8');
    });
}

export async function runAntigravityAgent({
    prompt,
    cwd,
    timeoutMs,
    signal,
    spawnImplementation = spawn,
    sandboxVerifier = verifyLinuxSandbox,
    environment = process.env,
}) {
    if (typeof cwd !== 'string' || cwd.length === 0) {
        throw new Error('Falta la carpeta temporal aislada para el proveedor.');
    }
    if (signal?.aborted) throw new Error('La ejecución del agente fue interrumpida.');

    const invocation = buildAntigravityInvocation({ prompt, timeoutMs });
    await sandboxVerifier();
    if (signal?.aborted) throw new Error('La ejecución del agente fue interrumpida.');

    return new Promise((resolve, reject) => {
        let child;
        let outputBytes = 0;
        let diagnosticBytes = 0;
        const outputChunks = [];
        let failure = null;
        let escalationTimer;
        const timeoutTimer = setTimeout(() => {
            failure = new Error('El proveedor superó el límite de tiempo; no se aplicaron cambios locales.');
            terminateChild(child, 'SIGTERM');
            escalationTimer = setTimeout(() => terminateChild(child, 'SIGKILL'), 1_000);
            escalationTimer.unref?.();
        }, timeoutMs + 5_000);
        timeoutTimer.unref?.();

        const cleanup = () => {
            clearTimeout(timeoutTimer);
            clearTimeout(escalationTimer);
            signal?.removeEventListener('abort', abortHandler);
        };
        const abortHandler = () => {
            failure = new Error('La ejecución del agente fue interrumpida; no se aplicaron cambios locales.');
            terminateChild(child, 'SIGTERM');
            escalationTimer = setTimeout(() => terminateChild(child, 'SIGKILL'), 1_000);
            escalationTimer.unref?.();
        };

        try {
            child = spawnImplementation(invocation.command, invocation.args, {
                cwd,
                env: selectProviderEnvironment(environment),
                shell: false,
                windowsHide: true,
                detached: process.platform !== 'win32',
                stdio: ['pipe', 'pipe', 'pipe'],
            });
        } catch {
            cleanup();
            reject(new Error('No se pudo iniciar Antigravity CLI.'));
            return;
        }

        signal?.addEventListener('abort', abortHandler, { once: true });
        child.stdout.on('data', (chunk) => {
            outputBytes += chunk.length;
            if (outputBytes > MAX_PROVIDER_OUTPUT_BYTES) {
                failure = new Error('La respuesta del proveedor superó el límite; no se aplicaron cambios locales.');
                terminateChild(child, 'SIGTERM');
                escalationTimer = setTimeout(() => terminateChild(child, 'SIGKILL'), 1_000);
                escalationTimer.unref?.();
                return;
            }
            outputChunks.push(chunk);
        });
        child.stderr.on('data', (chunk) => {
            diagnosticBytes += chunk.length;
            if (diagnosticBytes > MAX_PROVIDER_DIAGNOSTIC_BYTES && failure === null) {
                failure = new Error('El proveedor generó demasiados mensajes de diagnóstico.');
                terminateChild(child, 'SIGTERM');
                escalationTimer = setTimeout(() => terminateChild(child, 'SIGKILL'), 1_000);
                escalationTimer.unref?.();
            }
        });
        child.once('error', () => {
            cleanup();
            reject(new Error('No se pudo iniciar Antigravity CLI.'));
        });
        child.once('close', (exitCode) => {
            cleanup();
            if (failure !== null) {
                reject(failure);
                return;
            }
            if (exitCode !== 0) {
                reject(new Error('Antigravity CLI no completó la tarea correctamente.'));
                return;
            }

            let result;
            try {
                result = JSON.parse(Buffer.concat(outputChunks).toString('utf8'));
            } catch {
                reject(new Error('Antigravity CLI devolvió una respuesta no válida.'));
                return;
            }
            if (result?.status !== 'SUCCESS'
                || typeof result.response !== 'string'
                || Buffer.byteLength(result.response, 'utf8') > MAX_PROVIDER_OUTPUT_BYTES) {
                reject(new Error('Antigravity CLI no devolvió un resultado satisfactorio.'));
                return;
            }

            resolve({ response: result.response });
        });
        child.stdin.on('error', () => {});
        child.stdin.end(invocation.input, 'utf8');
    });
}

export async function runAgentRuntime(request) {
    if (request?.provider === 'codex') return runCodexAgent(request);
    if (request?.provider === 'agy') return runAntigravityAgent(request);
    throw new Error('El runtime integrado de Claude Code aún no está disponible.');
}

async function verifyLinuxSandbox() {
    if (process.platform !== 'linux') {
        throw new Error('El runtime local aún requiere sandbox Linux comprobable.');
    }

    const verification = spawnSync(
        'unshare',
        ['--user', '--map-root-user', '--mount', '--pid', '--fork', 'true'],
        { shell: false, stdio: 'ignore', timeout: 3_000, windowsHide: true },
    );
    if (verification.error || verification.status !== 0) {
        throw new Error('El kernel no permite el sandbox Linux requerido; el proveedor no se inició.');
    }
}

function selectProviderEnvironment(environment) {
    return Object.fromEntries(RUNTIME_ENVIRONMENT_KEYS
        .filter((key) => typeof environment[key] === 'string')
        .map((key) => [key, environment[key]]));
}

function selectCodexEnvironment(environment) {
    return Object.fromEntries(RUNTIME_ENVIRONMENT_KEYS
        .filter((key) => key !== 'GEMINI_API_KEY' && !['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'].includes(key)
            && typeof environment[key] === 'string')
        .map((key) => [key, environment[key]]));
}

function resolveCodexCommand(environment) {
    const mise = spawnSync('mise', ['which', 'codex'], {
        encoding: 'utf8',
        env: selectCodexEnvironment(environment),
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 3_000,
        windowsHide: true,
    });
    const resolvedPath = typeof mise.stdout === 'string' ? mise.stdout.trim() : '';

    return mise.status === 0 && path.isAbsolute(resolvedPath) ? resolvedPath : 'codex';
}

function parseCodexResponse(output) {
    let response = null;
    let turnCompleted = false;
    for (const line of output.split(/\r?\n/)) {
        if (line.length === 0) continue;
        let event;
        try {
            event = JSON.parse(line);
        } catch {
            return null;
        }
        if (event?.type === 'item.completed' && event.item?.type === 'agent_message'
            && typeof event.item.text === 'string') {
            response = event.item.text;
        }
        if (event?.type === 'turn.completed') turnCompleted = true;
    }

    return turnCompleted && typeof response === 'string' && response.length > 0
        && Buffer.byteLength(response, 'utf8') <= MAX_PROVIDER_OUTPUT_BYTES
        ? response
        : null;
}

function terminateChild(child, signal) {
    if (child?.pid && process.platform !== 'win32') {
        try {
            process.kill(-child.pid, signal);
            return;
        } catch {
            // Fall through to the direct child when no process group remains.
        }
    }
    child?.kill(signal);
}
