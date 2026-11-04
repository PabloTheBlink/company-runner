#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ConfigStore } from './config.js';
import { RunnerClient } from './client.js';

export async function run(argumentsList, streams = process) {
    const [command = 'help', ...argumentsAfterCommand] = argumentsList;
    if (['help', '--help', '-h'].includes(command)) {
        printHelp(streams.stdout);
        return 0;
    }

    const configStore = new ConfigStore();
    const client = new RunnerClient(configStore);

    if (command === 'enroll') {
        const options = parseEnrollOptions(argumentsAfterCommand);
        streams.stderr.write('Código de alta (entrada oculta): ');
        const code = await readHiddenCode(streams.stdin, streams.stderr);
        const runnerId = await client.enroll(options.server, code, options.workspacePath, options.allowInsecureLocalhost);
        streams.stdout.write(`Runner #${runnerId} registrado. La credencial se guardó en configuración local privada.\n`);
        return 0;
    }

    if (command === 'heartbeat') {
        if (argumentsAfterCommand.length !== 0) throw new Error('heartbeat no admite opciones.');
        const result = await client.heartbeat();
        const workspaceNames = result.workspaces.map((workspace) => workspace.name);
        const workspaceSummary = workspaceNames.length === 0 ? 'sin workspaces asignados' : `workspaces: ${workspaceNames.join(', ')}`;
        streams.stdout.write(`Runner #${result.runner_id}: online · ${workspaceSummary} · ${result.last_seen_at}\n`);
        return 0;
    }

    if (command === 'forget') {
        if (argumentsAfterCommand.length !== 0) throw new Error('forget no admite opciones.');
        await configStore.forget();
        streams.stdout.write('Configuración local eliminada. Revoca antes el Runner desde MyCompanies si aún está activo.\n');
        return 0;
    }

    throw new Error('Comando desconocido. Usa company-runner help.');
}

export function parseEnrollOptions(argumentsList) {
    const options = { allowInsecureLocalhost: false };

    for (const argument of argumentsList) {
        if (argument === '--allow-insecure-localhost') {
            options.allowInsecureLocalhost = true;
            continue;
        }
        const separator = argument.indexOf('=');
        if (!argument.startsWith('--') || separator < 3) {
            throw new Error('Usa opciones con formato --nombre=valor.');
        }
        const name = argument.slice(2, separator);
        const value = argument.slice(separator + 1);
        if (!value || !['server', 'workspace-path'].includes(name)) {
            throw new Error('Opción desconocida o vacía. Usa company-runner help.');
        }
        if (name === 'server') options.server = value;
        if (name === 'workspace-path') options.workspacePath = value;
    }

    if (!options.server || !options.workspacePath) {
        throw new Error('Faltan opciones. Usa enroll --server=URL --workspace-path=RUTA.');
    }

    return options;
}

export function readHiddenCode(stdin, stderr) {
    if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
        return Promise.reject(new Error('El código debe introducirse desde un terminal interactivo para ocultarlo.'));
    }

    const previousRawMode = stdin.isRaw;
    stderr.write('');
    stdin.setRawMode(true);
    stdin.resume();

    return new Promise((resolve, reject) => {
        let code = '';
        let finished = false;

        const finish = (error = null) => {
            if (finished) return;
            finished = true;
            stdin.off('data', onData);
            stdin.off('end', onEnd);
            stdin.off('error', onError);
            try {
                stdin.setRawMode(previousRawMode);
            } catch {
                error ??= new Error('No se pudo restaurar el modo del terminal.');
            }
            stdin.pause();
            stderr.write('\n');
            if (error) reject(error);
            else resolve(code);
        };

        const onData = (chunk) => {
            for (const character of chunk.toString('utf8')) {
                if (character === '\u0003') {
                    finish(new Error('Entrada cancelada.'));
                    return;
                }
                if (character === '\u0004') {
                    finish(new Error('No se pudo leer el código de alta.'));
                    return;
                }
                if (character === '\r' || character === '\n') {
                    finish();
                    return;
                }
                if (character === '\u007f' || character === '\b') {
                    code = code.slice(0, -1);
                } else {
                    code += character;
                }
            }
        };

        const onEnd = () => finish(new Error('No se pudo leer el código de alta.'));
        const onError = () => finish(new Error('No se pudo leer el código de alta.'));

        stdin.on('data', onData);
        stdin.once('end', onEnd);
        stdin.once('error', onError);
    });
}

function printHelp(stdout) {
    stdout.write('Company Runner\n');
    stdout.write('  company-runner enroll --server=URL --workspace-path=RUTA [--allow-insecure-localhost]\n');
    stdout.write('  company-runner heartbeat\n');
    stdout.write('  company-runner forget\n');
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
    run(process.argv.slice(2)).then((exitCode) => {
        process.exitCode = exitCode;
    }).catch((error) => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    });
}
