import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';

const SUPPORTED_PROVIDERS = [
    { provider: 'codex', command: 'codex' },
    { provider: 'claude', command: 'claude' },
];

export function createAgentRuntimePlan(provider, installedProviders, identity, task) {
    if (!['codex', 'claude'].includes(provider) || !installedProviders.includes(provider)) {
        throw new Error(`El proveedor ${provider} no está instalado localmente.`);
    }
    if (!Number.isSafeInteger(identity?.agent?.id) || identity.agent.id < 1
        || typeof identity.agent.name !== 'string'
        || typeof identity.company?.name !== 'string') {
        throw new Error('La identidad Agent no es válida para preparar el plan.');
    }
    if (!['open', 'in_progress'].includes(task?.status)) {
        throw new Error('La tarea debe estar abierta o en curso para preparar el plan.');
    }
    if (task.assignee?.type !== 'agent' || task.assignee.id !== identity.agent.id) {
        throw new Error('La tarea debe estar asignada al Agent seleccionado.');
    }
    if (!Number.isSafeInteger(task.id) || task.id < 1 || typeof task.title !== 'string') {
        throw new Error('La tarea no es válida para preparar el plan.');
    }

    return {
        provider,
        agentId: identity.agent.id,
        agentName: identity.agent.name,
        companyName: identity.company.name,
        taskId: task.id,
        taskTitle: task.title,
        taskStatus: task.status,
    };
}

export async function listLocalAgentRuntimes(
    pathValue = process.env.PATH ?? '',
    platform = process.platform,
    isRunnable = isExecutableFile,
) {
    const delimiter = platform === 'win32' ? ';' : ':';
    const directories = pathValue.split(delimiter).filter((directory) => directory.length > 0);
    const runtimes = [];

    for (const runtime of SUPPORTED_PROVIDERS) {
        const available = await isAvailable(runtime.command, directories, platform, isRunnable);
        if (available) runtimes.push(runtime);
    }

    return runtimes;
}

async function isAvailable(command, directories, platform, isRunnable) {
    const executableNames = platform === 'win32'
        ? [`${command}.exe`, `${command}.cmd`, `${command}.bat`, `${command}.com`]
        : [command];

    for (const directory of directories) {
        for (const executableName of executableNames) {
            const executablePath = path.join(directory, executableName);
            if (await isRunnable(executablePath, platform)) return true;
        }
    }

    return false;
}

async function isExecutableFile(executablePath, platform) {
    try {
        const file = await stat(executablePath);
        if (!file.isFile()) return false;
        if (platform !== 'win32') await access(executablePath, constants.X_OK);

        return true;
    } catch {
        return false;
    }
}
