import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';

const SUPPORTED_PROVIDERS = [
    { provider: 'codex', command: 'codex' },
    { provider: 'claude', command: 'claude' },
];

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
