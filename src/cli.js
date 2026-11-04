#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ConfigStore } from './config.js';
import { RunnerClient } from './client.js';
import { initializeCompanyRoot } from './company-kit.js';

export async function run(argumentsList, streams = process, currentDirectory = process.cwd()) {
    const [command = 'help', ...argumentsAfterCommand] = argumentsList;
    if (['help', '--help', '-h'].includes(command)) {
        printHelp(streams.stdout);
        return 0;
    }

    if (command === 'init') {
        if (argumentsAfterCommand.length !== 0) throw new Error('init no admite opciones.');
        const result = await initializeCompanyRoot(currentDirectory);
        streams.stdout.write(`Carpeta de empresa preparada · ${result.created.length} archivos creados · ${result.updated.length} archivos actualizados · ${result.unchanged.length} sin cambios.\n`);
        return 0;
    }

    const configStore = new ConfigStore();
    const client = new RunnerClient(configStore);

    if (command === 'enroll') {
        const options = parseEnrollOptions(argumentsAfterCommand);
        streams.stderr.write('Código de alta (entrada oculta): ');
        const code = await readHiddenCode(streams.stdin, streams.stderr);
        const runnerId = await client.enroll(options.server, code, process.cwd(), options.allowInsecureLocalhost);
        streams.stdout.write(`Runner #${runnerId} registrado para esta carpeta de empresa. La credencial se guardó en configuración local privada.\n`);
        return 0;
    }

    if (command === 'heartbeat') {
        if (argumentsAfterCommand.length !== 0) throw new Error('heartbeat no admite opciones.');
        const result = await client.heartbeat();
        const workspaceNames = result.workspaces.map((workspace) => workspace.name);
        const workspaceSummary = workspaceNames.length === 0 ? 'sin workspaces asignados' : `workspaces: ${workspaceNames.join(', ')}`;
        streams.stdout.write(`${result.company_name} · ${result.runner_name} (#${result.runner_id}): online · ${workspaceSummary} · ${result.last_seen_at}\n`);
        return 0;
    }

    if (command === 'work') {
        if (argumentsAfterCommand.length !== 0) throw new Error('work no admite opciones.');
        const result = await client.workOnce();
        if (result === null) {
            streams.stdout.write('No hay comprobaciones autorizadas para este workspace.\n');
        } else {
            const status = result.workspace_accessible ? 'accesible' : 'no accesible';
            const workspaceName = result.workspace_name.replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ');
            streams.stdout.write(`Comprobación completada · ${workspaceName}: ${status}.\n`);
        }
        return 0;
    }

    if (command === 'tasks') {
        const options = parseTasksOptions(argumentsAfterCommand);
        const result = await client.listTasks(process.cwd(), options.afterId);
        if (result.tasks.length === 0) {
            streams.stdout.write('No hay tareas activas en los workspaces asignados.\n');
            return 0;
        }

        streams.stdout.write(`Tareas activas (${result.tasks.length}):\n`);
        for (const task of result.tasks) {
            const status = { open: 'abierta', in_progress: 'en curso', blocked: 'bloqueada' }[task.status];
            const priority = { low: 'baja', normal: 'normal', high: 'alta' }[task.priority];
            const dueDate = task.due_date === null ? '' : ` · vence ${task.due_date}`;
            streams.stdout.write(`#${task.id} [${status} · ${priority}] ${safeTerminalText(task.workspace.name)} · ${safeTerminalText(task.title)}${dueDate}\n`);
        }
        if (result.has_more) {
            streams.stdout.write(`Hay más tareas activas. Continúa con: mycompany tasks --after=${result.next_after}\n`);
        }
        return 0;
    }

    if (command === 'task') {
        if (argumentsAfterCommand.length !== 1) throw new Error('Uso: mycompany task ID.');
        const taskId = parseTaskId(argumentsAfterCommand[0]);
        const task = await client.getTask(taskId);
        const status = { open: 'abierta', in_progress: 'en curso', blocked: 'bloqueada' }[task.status];
        const priority = { low: 'baja', normal: 'normal', high: 'alta' }[task.priority];
        const dueDate = task.due_date === null ? 'sin fecha objetivo' : `vence ${task.due_date}`;
        streams.stdout.write(`#${task.id} · ${safeTerminalText(task.title)}\n`);
        streams.stdout.write(`Workspace: ${safeTerminalText(task.workspace.name)}\n`);
        streams.stdout.write(`Estado: ${status} · Prioridad: ${priority} · ${dueDate}\n`);
        if (task.description !== null && task.description !== '') {
            streams.stdout.write(`\n${safeTerminalText(task.description)}\n`);
        }
        return 0;
    }

    if (command === 'forget') {
        if (argumentsAfterCommand.length !== 0) throw new Error('forget no admite opciones.');
        await configStore.forget(process.cwd());
        streams.stdout.write('Configuración de esta carpeta eliminada. Revoca antes el Runner desde MyCompanies si aún está activo.\n');
        return 0;
    }

    throw new Error('Comando desconocido. Usa mycompany help.');
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
        if (!value || name !== 'server') {
            throw new Error('Opción desconocida o vacía. Usa mycompany help.');
        }
        options.server = value;
    }

    if (!options.server) {
        throw new Error('Falta el servidor. Usa enroll --server=URL.');
    }

    return options;
}

export function parseTaskId(value) {
    if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
        throw new Error('El ID de tarea debe ser un entero positivo.');
    }
    const taskId = Number(value);
    if (!Number.isSafeInteger(taskId)) {
        throw new Error('El ID de tarea debe ser un entero positivo.');
    }

    return taskId;
}

export function parseTasksOptions(argumentsList) {
    let afterId = null;
    for (const argument of argumentsList) {
        const match = /^--after=(.+)$/.exec(argument);
        if (match === null || afterId !== null) {
            throw new Error('Opción desconocida o repetida para tasks. Usa --after=ID.');
        }
        afterId = parseTaskId(match[1]);
    }

    return { afterId };
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
    stdout.write('MyCompany · CLI para la carpeta raíz local de una empresa\n');
    stdout.write('Ejecuta los comandos desde la carpeta de la empresa. Puede agrupar varios Workspaces lógicos; no se crea una carpeta por Workspace.\n');
    stdout.write('\nComandos:\n');
    stdout.write('  mycompany init\n');
    stdout.write('    Prepara AGENTS.md, CLAUDE.md y las carpetas agents/, architecture/, tasks/, automations/, reports/ y .mycompanies/.\n');
    stdout.write('    Actualiza solo los bloques que administra MyCompanies; conserva el resto del texto y los archivos existentes. No borra archivos.\n');
    stdout.write('    Solo trabaja en esta carpeta: no conecta con el servidor, no crea Workspaces remotos y no ejecuta automatizaciones.\n');
    stdout.write('  mycompany enroll --server=URL [--allow-insecure-localhost]\n');
    stdout.write('    Vincula esta carpeta raíz a un Runner de una empresa usando un código de alta de un solo uso, que se pide oculto en el terminal.\n');
    stdout.write('    Guarda la credencial en la configuración privada del usuario, asociada a esta ruta; no copia credenciales locales al servidor.\n');
    stdout.write('    El servidor debe usar HTTPS. La opción de HTTP solo se permite para pruebas en localhost.\n');
    stdout.write('  mycompany heartbeat\n');
    stdout.write('    Contacta con MyCompanies para confirmar que la credencial sigue activa y muestra empresa, Runner y Workspaces lógicos asignados.\n');
    stdout.write('    No escanea la carpeta local ni ejecuta trabajo.\n');
    stdout.write('  mycompany work\n');
    stdout.write('    Consulta si hay una comprobación autorizada de capacidad fija, comprueba acceso de lectura a la carpeta y devuelve solo ese resultado.\n');
    stdout.write('    No ejecuta código o comandos enviados por el servidor ni transmite la ruta local.\n');
    stdout.write('  mycompany tasks [--after=ID]\n');
    stdout.write('    Consulta y lista tareas activas de los Workspaces asignados. Usa --after=ID para continuar una lista larga.\n');
    stdout.write('    Solo las muestra. No reclama, modifica, marca como terminadas ni ejecuta sus descripciones.\n');
    stdout.write('  mycompany task ID\n');
    stdout.write('    Consulta una tarea por su ID y muestra sus datos como texto para lectura humana. MyCompanies valida el acceso.\n');
    stdout.write('    La descripción se presenta como texto; no se interpreta como instrucción ejecutable.\n');
    stdout.write('  mycompany forget\n');
    stdout.write('    Elimina de este usuario la credencial local asociada a la carpeta actual.\n');
    stdout.write('    No revoca el Runner en MyCompanies: revócalo allí por separado si quieres impedir futuras conexiones.\n');
    stdout.write('\nAlcance actual: no hay sincronización automática ni comando sync. init solo gestiona archivos locales; heartbeat, work y tasks consultan la API.\n');
    stdout.write('Los Workspaces son ámbitos lógicos del servidor. La raíz local de empresa puede contener varios proyectos y automatizaciones.\n');
}

function safeTerminalText(value) {
    return value.replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ');
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
    run(process.argv.slice(2)).then((exitCode) => {
        process.exitCode = exitCode;
    }).catch((error) => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    });
}
