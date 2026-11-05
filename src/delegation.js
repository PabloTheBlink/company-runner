import { createHash } from 'node:crypto';

const ALLOWED_TASK_KEYS = new Set(['title', 'description', 'assignee_agent_id', 'priority']);
const ALLOWED_PRIORITIES = new Set(['low', 'normal', 'high']);

export function parseDelegationResponse(response, { workspaceId, reports, allowEmpty = false }) {
    if (typeof response !== 'string' || Buffer.byteLength(response, 'utf8') > 64 * 1024) {
        throw new Error('El plan de delegación supera el límite permitido.');
    }
    let parsed;
    try {
        parsed = JSON.parse(response);
    } catch {
        throw new Error('El agente no devolvió un plan JSON válido.');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)
        || Object.keys(parsed).length !== 1 || !Array.isArray(parsed.tasks)
        || parsed.tasks.length > 3 || (!allowEmpty && parsed.tasks.length < 1)) {
        throw new Error(allowEmpty ? 'El plan debe contener entre 0 y 3 tareas.' : 'El plan debe contener entre 1 y 3 tareas.');
    }
    if (!Number.isSafeInteger(workspaceId) || workspaceId < 1 || !Array.isArray(reports)) {
        throw new Error('El contexto de delegación no es válido.');
    }

    const eligibleReports = new Set(reports
        .filter((report) => report?.status === 'active'
            && Array.isArray(report.permissions)
            && report.permissions.some((permission) => permission?.name === 'tasks.read'
                && (permission.scope === 'company' || permission.scope === `workspace:${workspaceId}`)))
        .map((report) => report.id));
    const titles = new Set();

    return parsed.tasks.map((task) => {
        if (task === null || typeof task !== 'object' || Array.isArray(task)
            || Object.keys(task).some((key) => !ALLOWED_TASK_KEYS.has(key))) {
            throw new Error('Cada subtarea solo puede incluir título, descripción, responsable y prioridad.');
        }
        if (typeof task.title !== 'string' || task.title.trim().length < 3 || task.title.length > 160
            || typeof task.description !== 'string' || task.description.trim().length < 10 || task.description.length > 4000
            || !Number.isSafeInteger(task.assignee_agent_id) || !eligibleReports.has(task.assignee_agent_id)
            || !ALLOWED_PRIORITIES.has(task.priority)) {
            throw new Error('La subtarea no es válida o el responsable carece de tasks.read para el Workspace.');
        }
        const titleKey = task.title.trim().toLocaleLowerCase('es');
        if (titles.has(titleKey)) throw new Error('El plan contiene títulos duplicados.');
        titles.add(titleKey);

        return {
            title: task.title.trim(),
            description: task.description.trim(),
            assigneeAgentId: task.assignee_agent_id,
            priority: task.priority,
            workspaceId,
        };
    });
}

export function createDelegationPlan(parentTaskId, tasks) {
    if (!Number.isSafeInteger(parentTaskId) || parentTaskId < 1 || !Array.isArray(tasks) || tasks.length > 3) {
        throw new Error('La referencia de delegación no es válida.');
    }
    return tasks.map((task, index) => ({
        ...task,
        idempotencyKey: deterministicUuid(`mycompanies-delegation:${parentTaskId}:${index}`),
    }));
}

export async function applyDelegationPlan({ parentTaskId, tasks, createTask, assignTask }) {
    const plannedTasks = createDelegationPlan(parentTaskId, tasks);
    const applied = [];
    for (const plannedTask of plannedTasks) {
        const created = await createTask({
            title: plannedTask.title,
            description: `Subtarea de MyCompanies #${parentTaskId}.\n\n${plannedTask.description}`,
            priority: plannedTask.priority,
            workspace_id: plannedTask.workspaceId,
            parent_task_id: parentTaskId,
        }, plannedTask.idempotencyKey);
        const task = created?.task ?? created;
        if (!Number.isSafeInteger(task?.id) || task.id < 1) {
            throw new Error('La API no devolvió la subtarea creada; no se intentó asignarla.');
        }
        const assignedTask = await assignTask(task.id, plannedTask.assigneeAgentId);
        if (assignedTask?.assignee?.type !== 'agent' || assignedTask.assignee.id !== plannedTask.assigneeAgentId) {
            throw new Error('MyCompanies no confirmó el responsable Agent solicitado.');
        }
        applied.push({ task: assignedTask, assigneeAgentId: plannedTask.assigneeAgentId });
    }
    return applied;
}

function deterministicUuid(value) {
    const bytes = createHash('sha256').update(value).digest().subarray(0, 16);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
