import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const ACTIVE_STATUSES = new Set(['starting', 'running', 'stopping']);

export function agentWorkerStatePath(configStore, agentId, companyRoot) {
    if (!Number.isSafeInteger(agentId) || agentId < 1 || typeof companyRoot !== 'string' || !path.isAbsolute(companyRoot)) {
        throw new Error('La identidad local del Agent no es válida para gestionar su worker.');
    }

    const identity = `${agentId}\0${path.resolve(companyRoot)}`;
    const key = createHash('sha256').update(identity).digest('hex');

    return path.join(path.dirname(configStore.path), 'workers', key, 'state.json');
}

export async function startAgentWorker({
    statePath,
    agentId,
    command,
    args,
    cwd,
    spawnImplementation = spawn,
    processAlive = isProcessAlive,
    now = () => new Date().toISOString(),
    metadata = {},
}) {
    if (!Number.isSafeInteger(agentId) || agentId < 1) {
        throw new Error('El ID del Agent local debe ser un entero positivo.');
    }
    const directory = path.dirname(statePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await chmod(directory, 0o700);

    const lockPath = `${statePath}.lock`;
    let lock;
    try {
        lock = await open(lockPath, 'wx', 0o600);
    } catch (error) {
        if (error.code === 'EEXIST') throw new Error('Ya se está iniciando o administrando este worker.');
        throw new Error('No se pudo preparar el estado privado del worker.');
    }

    try {
        const previous = await readState(statePath);
        if (previous !== null && ACTIVE_STATUSES.has(previous.status) && processAlive(previous.pid)) {
            return { ...previous, already_running: true };
        }

        const child = spawnImplementation(command, args, {
            cwd,
            detached: true,
            stdio: 'ignore',
            env: workerEnvironment({
                MYCOMPANY_AGENT_ID: String(agentId),
                MYCOMPANY_WORKER_STATE_PATH: statePath,
            }),
        });
        if (!Number.isSafeInteger(child.pid) || child.pid < 1) {
            throw new Error('No se pudo iniciar el proceso worker.');
        }

        const state = {
            pid: child.pid,
            status: 'starting',
            started_at: now(),
            heartbeat_at: now(),
            stop_requested_at: null,
            exit_reason: null,
            ...metadata,
        };
        await writeState(statePath, state);
        child.unref();
        child.once?.('error', () => {
            updateAgentWorkerState(statePath, { status: 'stopped', exit_reason: 'process_error' }).catch(() => {});
        });
        child.once?.('exit', () => {
            updateAgentWorkerState(statePath, { status: 'stopped', exit_reason: 'process_exited' }).catch(() => {});
        });

        return { ...state, already_running: false };
    } finally {
        await lock.close();
        await unlink(lockPath).catch(() => {});
    }
}

export async function getAgentWorkerStatus(statePath, processAlive = isProcessAlive) {
    const state = await readState(statePath);
    if (state === null || state.status === 'stopped' || state.status === 'failed') return state ?? { status: 'stopped' };
    if (processAlive(state.pid)) return state;

    return updateAgentWorkerState(statePath, {
        status: 'stopped',
        exit_reason: 'process_not_running',
    });
}

export async function requestAgentWorkerStop(statePath, processAlive = isProcessAlive, now = () => new Date().toISOString()) {
    const state = await readState(statePath);
    if (state === null || state.status === 'stopped' || state.status === 'failed' || !processAlive(state.pid)) {
        if (state === null) return { status: 'stopped' };
        return updateAgentWorkerState(statePath, {
            status: 'stopped',
            exit_reason: state.status === 'stopped' ? state.exit_reason : 'process_not_running',
        });
    }

    return updateAgentWorkerState(statePath, {
        status: 'stopping',
        stop_requested_at: state.stop_requested_at ?? now(),
    });
}

export async function updateAgentWorkerState(statePath, changes) {
    return withStateLock(statePath, async () => {
        const state = await readState(statePath);
        if (state === null) throw new Error('No hay un worker registrado para esta identidad.');
        const nextChanges = state.status === 'stopping' && changes.status === 'running'
            ? { ...changes, status: 'stopping', stop_requested_at: state.stop_requested_at }
            : changes;
        const updated = { ...state, ...nextChanges };
        await writeState(statePath, updated);

        return updated;
    });
}

export function isAgentWorkerStopRequested(state) {
    return state !== null && state !== undefined
        && (state.status === 'stopping' || state.stop_requested_at !== null);
}

export async function runAgentWorkerService({
    statePath,
    pid,
    provider,
    runWorkOnce,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    now = () => new Date().toISOString(),
    intervalMs = 5_000,
}) {
    const initialState = await readState(statePath);
    if (initialState === null || initialState.pid !== pid || initialState.provider !== provider
        || typeof runWorkOnce !== 'function' || !Number.isSafeInteger(intervalMs) || intervalMs < 1_000) {
        throw new Error('La identidad del proceso worker no coincide con su estado local.');
    }

    let status = 'stopped';
    let exitReason = 'stop_requested';
    try {
        await updateAgentWorkerState(statePath, { status: 'running', heartbeat_at: now() });
        while (true) {
            const state = await readState(statePath);
            if (isAgentWorkerStopRequested(state)) break;
            await updateAgentWorkerState(statePath, { heartbeat_at: now() });
            if (await runWorkOnce() !== 0) {
                status = 'failed';
                exitReason = 'task_worker_failed';
                break;
            }
            const afterWork = await readState(statePath);
            if (isAgentWorkerStopRequested(afterWork)) break;
            await updateAgentWorkerState(statePath, { heartbeat_at: now() });
            await sleep(intervalMs);
        }
    } catch {
        status = 'failed';
        exitReason = 'worker_error';
    } finally {
        await updateAgentWorkerState(statePath, {
            status,
            stopped_at: now(),
            heartbeat_at: now(),
            exit_reason: exitReason,
        }).catch(() => {});
    }

    return { status, exit_code: status === 'failed' ? 1 : 0, exit_reason: exitReason };
}

async function readState(statePath) {
    try {
        const state = JSON.parse(await readFile(statePath, 'utf8'));
        if (state === null || typeof state !== 'object' || Array.isArray(state)
            || !Number.isSafeInteger(state.pid) || state.pid < 1
            || !['starting', 'running', 'stopping', 'stopped', 'failed'].includes(state.status)) {
            throw new Error('invalid');
        }

        return state;
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw new Error('El estado local del worker no es válido.');
    }
}

async function writeState(statePath, state) {
    const temporaryPath = `${statePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
        await open(temporaryPath, 'wx', 0o600).then(async (file) => {
            try {
                await file.writeFile(`${JSON.stringify(state)}\n`, 'utf8');
                await file.sync();
            } finally {
                await file.close();
            }
        });
        await rename(temporaryPath, statePath);
        if (process.platform !== 'win32') await chmod(statePath, 0o600);
    } catch {
        await unlink(temporaryPath).catch(() => {});
        throw new Error('No se pudo actualizar el estado privado del worker.');
    }
}

async function withStateLock(statePath, callback) {
    const lockPath = `${statePath}.update.lock`;
    const deadline = Date.now() + 5_000;
    let lock;
    while (lock === undefined) {
        try {
            lock = await open(lockPath, 'wx', 0o600);
        } catch (error) {
            if (error.code !== 'EEXIST') throw new Error('No se pudo bloquear el estado local del worker.');
            if (Date.now() >= deadline) throw new Error('El estado del worker está ocupado; inténtalo de nuevo.');
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
    }

    try {
        return await callback();
    } finally {
        await lock.close();
        await unlink(lockPath).catch(() => {});
    }
}

function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error.code === 'EPERM';
    }
}

function workerEnvironment(overrides) {
    const allowed = ['PATH', 'HOME', 'XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR'];
    return {
        ...Object.fromEntries(allowed
        .filter((name) => typeof process.env[name] === 'string')
        .map((name) => [name, process.env[name]])),
        ...overrides,
    };
}
