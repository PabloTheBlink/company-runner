import { randomBytes } from 'node:crypto';

const ACTIVE_STATUSES = ['open', 'in_progress'];
const TOKEN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function parseAgentWorkResponse(response) {
    if (typeof response !== 'string' || Buffer.byteLength(response, 'utf8') > 16_384) {
        throw new Error('La respuesta estructurada del Agent supera el límite permitido.');
    }

    let parsed;
    try {
        parsed = JSON.parse(response);
    } catch {
        throw new Error('El proveedor no devolvió JSON válido para finalizar la tarea.');
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)
        || Object.keys(parsed).length !== 2
        || Object.keys(parsed).some((key) => !['status', 'summary'].includes(key))
        || !['completed', 'blocked', 'open'].includes(parsed.status)
        || typeof parsed.summary !== 'string'
        || parsed.summary.trim().length < 1
        || Buffer.byteLength(parsed.summary, 'utf8') > 4_000) {
        throw new Error('El proveedor no devolvió el formato estructurado de tarea esperado.');
    }

    return { status: parsed.status, summary: parsed.summary.trim() };
}

export async function runAgentWorkOnce({
    agentId,
    taskId = null,
    provider,
    currentDirectory = process.cwd(),
    listTasks,
    getTask,
    claimTask,
    heartbeatTaskClaim,
    finishTaskClaim,
    executeTask,
    createClaimToken = createRandomClaimToken,
    heartbeatIntervalMs = 30_000,
    setIntervalImplementation = setInterval,
    clearIntervalImplementation = clearInterval,
}) {
    if (!Number.isSafeInteger(agentId) || agentId < 1
        || !(taskId === null || Number.isSafeInteger(taskId) && taskId > 0)
        || !['codex', 'claude', 'agy'].includes(provider)
        || typeof listTasks !== 'function'
        || typeof getTask !== 'function'
        || typeof claimTask !== 'function'
        || typeof heartbeatTaskClaim !== 'function'
        || typeof finishTaskClaim !== 'function'
        || typeof executeTask !== 'function'
        || !Number.isSafeInteger(heartbeatIntervalMs) || heartbeatIntervalMs < 1_000) {
        throw new Error('La configuración de trabajo Agent no es válida.');
    }

    const candidates = [];
    for (const status of ACTIVE_STATUSES) {
        let afterId = null;
        while (true) {
            const page = await listTasks(currentDirectory, afterId, status);
            candidates.push(...page.tasks.filter((task) => task.status === status
                && task.assignee?.type === 'agent'
                && task.assignee.id === agentId
                && (taskId === null || task.id === taskId)));
            if (!page.has_more) break;
            afterId = page.next_after;
        }
    }

    candidates.sort((left, right) => left.id - right.id);
    for (const candidate of candidates) {
        const claimToken = createClaimToken();
        if (typeof claimToken !== 'string' || !/^[A-Za-z0-9]{80}$/.test(claimToken)) {
            throw new Error('No se pudo crear un token seguro para la reserva de tarea.');
        }

        let claim;
        try {
            claim = await claimTask(candidate.id, claimToken, currentDirectory);
        } catch (error) {
            if (error?.status === 409) continue;
            throw error;
        }
        if (claim?.task_id !== candidate.id || claim.claim_token !== claimToken) {
            throw new Error('MyCompanies no confirmó la reserva de tarea solicitada.');
        }

        const task = await getTask(candidate.id, currentDirectory);
        if (task.id !== candidate.id
            || task.assignee?.type !== 'agent'
            || task.assignee.id !== agentId
            || !ACTIVE_STATUSES.includes(task.status)) {
            throw new Error('La tarea cambió de responsable o estado tras reclamarla.');
        }

        const controller = new AbortController();
        let leaseFailure = null;
        let heartbeatPending = false;
        const heartbeat = setIntervalImplementation(async () => {
            if (heartbeatPending || leaseFailure !== null) return;
            heartbeatPending = true;
            try {
                await heartbeatTaskClaim(candidate.id, claimToken, currentDirectory);
            } catch (error) {
                leaseFailure = error instanceof Error ? error : new Error('Se perdió la reserva de tarea.');
                controller.abort(leaseFailure);
            } finally {
                heartbeatPending = false;
            }
        }, heartbeatIntervalMs);
        heartbeat.unref?.();

        try {
            const outcome = await executeTask({
                task,
                provider,
                signal: controller.signal,
                renewLease: () => heartbeatTaskClaim(candidate.id, claimToken, currentDirectory),
            });
            if (leaseFailure !== null) throw leaseFailure;
            if (outcome === null || typeof outcome !== 'object'
                || !['completed', 'blocked', 'open'].includes(outcome.status)
                || typeof outcome.summary !== 'string'
                || outcome.summary.trim().length < 1
                || Buffer.byteLength(outcome.summary, 'utf8') > 4_000) {
                throw new Error('El proveedor no devolvió un resultado estructurado válido.');
            }

            await heartbeatTaskClaim(candidate.id, claimToken, currentDirectory);
            const finish = await finishTaskClaim(candidate.id, claimToken, outcome.status, outcome.summary, currentDirectory);
            return { task, outcome, finish };
        } finally {
            clearIntervalImplementation(heartbeat);
        }
    }

    return null;
}

function createRandomClaimToken() {
    let token = '';
    while (token.length < 80) {
        for (const byte of randomBytes(120)) {
            if (byte < 248) token += TOKEN_ALPHABET[byte % TOKEN_ALPHABET.length];
            if (token.length === 80) break;
        }
    }

    return token;
}
