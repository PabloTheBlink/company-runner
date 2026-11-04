#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ConfigStore } from './config.js';
import { AgentClient, formatAssignee, RunnerClient } from './client.js';
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

    if (command === 'artifacts' || command === 'artifact') {
        const agentClient = new AgentClient(new ConfigStore());
        if (command === 'artifacts') {
            const options = parseArtifactListOptions(argumentsAfterCommand);
            const result = await agentClient.listArtifacts(currentDirectory, options.afterId);
            if (result.artifacts.length === 0) {
                streams.stdout.write('No hay informes compartidos para esta empresa.\n');
                return 0;
            }
            streams.stdout.write(`Informes compartidos (${result.artifacts.length}):\n`);
            for (const artifact of result.artifacts) {
                const size = `${(artifact.size_bytes / 1024).toFixed(1)} KB`;
                streams.stdout.write(`#${artifact.id} ${safeTerminalText(artifact.title)} · ${safeTerminalText(artifact.original_filename)} · ${size}\n`);
            }
            if (result.has_more) {
                streams.stdout.write(`Hay más informes. Continúa con: mycompany artifacts --after=${result.next_after}\n`);
            }
            return 0;
        }

        const [artifactCommand, ...artifactArguments] = argumentsAfterCommand;
        if (artifactCommand === 'publish') {
            const options = parseArtifactPublishOptions(artifactArguments);
            const artifact = await agentClient.publishArtifact(options.filePath, options.metadata, currentDirectory);
            streams.stdout.write(`Informe #${artifact.id} publicado para ${safeTerminalText(artifact.title)} (${safeTerminalText(artifact.original_filename)}).\n`);
            return 0;
        }
        if (artifactCommand === 'show') {
            const artifactId = parseArtifactId(artifactArguments);
            const artifact = await agentClient.getArtifact(artifactId, currentDirectory);
            streams.stdout.write(`Informe #${artifact.id}: ${safeTerminalText(artifact.title)}\n`);
            streams.stdout.write(`Archivo: ${safeTerminalText(artifact.original_filename)} · ${(artifact.size_bytes / 1024).toFixed(1)} KB · ${safeTerminalText(artifact.mime_type)}\n`);
            streams.stdout.write(`Fecha: ${safeTerminalText(artifact.created_at)}\n`);
            if (artifact.description !== null) streams.stdout.write(`Descripción: ${safeTerminalText(artifact.description)}\n`);
            if (artifact.source !== null) streams.stdout.write(`Origen: ${safeTerminalText(artifact.source)}\n`);
            if (artifact.uploaded_by !== null) streams.stdout.write(`Publicado por: Agente ${safeTerminalText(artifact.uploaded_by.name)}\n`);
            streams.stdout.write(`SHA-256: ${artifact.sha256}\n`);
            return 0;
        }
        if (artifactCommand === 'download') {
            const options = parseArtifactDownloadOptions(artifactArguments);
            const result = await agentClient.downloadArtifact(options.artifactId, options.outputPath, currentDirectory);
            streams.stdout.write(`Informe #${options.artifactId} descargado en ${safeTerminalText(result.outputPath)}.\n`);
            return 0;
        }
        throw new Error('Uso: mycompany artifact show ID | mycompany artifact publish FILE --title=TEXTO | mycompany artifact download ID --output=FILE.');
    }

    const configStore = new ConfigStore();
    const client = new RunnerClient(configStore);

    if (command === 'agent') {
        const [agentCommand, ...agentArguments] = argumentsAfterCommand;
        const agentClient = new AgentClient(configStore);
        if (agentCommand === 'login') {
            const options = parseAgentLoginOptions(agentArguments);
            streams.stderr.write('Credencial Agent (entrada oculta): ');
            const apiToken = await readHiddenCode(streams.stdin, streams.stderr);
            const identity = await agentClient.login(options.server, apiToken, currentDirectory, options.allowInsecureLocalhost);
            streams.stdout.write(`Agente ${safeTerminalText(identity.agent.name)} · ${safeTerminalText(identity.company.name)}: credencial validada y guardada en configuración privada local.\n`);
            return 0;
        }
        if (agentCommand === 'me' && agentArguments.length === 0) {
            const identity = await agentClient.identity(currentDirectory);
            streams.stdout.write(`Agente: ${safeTerminalText(identity.agent.name)} (${safeTerminalText(identity.agent.role)}) · Empresa: ${safeTerminalText(identity.company.name)}\n`);
            streams.stdout.write(`Permisos vigentes: ${identity.permissions.length === 0 ? 'ninguno' : identity.permissions.map((permission) => `${safeTerminalText(permission.name)} (${permission.scope}${permission.workspace_name ? `: ${safeTerminalText(permission.workspace_name)}` : ''})`).join(', ')}\n`);
            return 0;
        }
        if (agentCommand === 'tasks') {
            const options = parseAgentTasksOptions(agentArguments);
            const result = await agentClient.listTasks(currentDirectory, options.afterId);
            if (result.tasks.length === 0) {
                streams.stdout.write('El agente no tiene tareas activas en su ámbito.\n');
                return 0;
            }
            streams.stdout.write(`Tareas del agente (${result.tasks.length}):\n`);
            for (const task of result.tasks) {
                const status = { open: 'abierta', in_progress: 'en curso', blocked: 'bloqueada' }[task.status];
                const priority = { low: 'baja', normal: 'normal', high: 'alta' }[task.priority];
                const dueDate = task.due_date === null ? '' : ` · vence ${task.due_date}`;
                const workspaceName = task.workspace === null ? 'Empresa' : safeTerminalText(task.workspace.name);
                streams.stdout.write(`#${task.id} [${status} · ${priority}] ${workspaceName} · ${safeTerminalText(task.title)}${dueDate} · responsable ${formatAssignee(task.assignee)}\n`);
            }
            if (result.has_more) {
                streams.stdout.write(`Hay más tareas dentro del ámbito del agente. Continúa con: mycompany agent tasks --after=${result.next_after}\n`);
            }
            return 0;
        }
        if (agentCommand === 'bets') {
            const options = parseAgentBetsOptions(agentArguments);
            const result = await agentClient.listBets(currentDirectory, options.afterId);
            if (result.bets.length === 0) {
                streams.stdout.write('No hay apuestas registradas para esta empresa.\n');
                return 0;
            }
            streams.stdout.write(`Apuestas de la empresa (${result.bets.length}):\n`);
            for (const bet of result.bets) {
                const status = { proposed: 'propuesta', investigating: 'investigando', validated: 'validada', discarded: 'descartada', converted: 'convertida', archived: 'archivada' }[bet.status];
                streams.stdout.write(`#${bet.id} [${status}] ${safeTerminalText(bet.title)}\n`);
            }
            if (result.has_more) {
                streams.stdout.write(`Hay más apuestas. Continúa con: mycompany agent bets --after=${result.next_after}\n`);
            }
            return 0;
        }
        if (agentCommand === 'offers') {
            const options = parseAgentOffersOptions(agentArguments);
            const result = await agentClient.listOffers(currentDirectory, options.afterId);
            if (result.offers.length === 0) {
                streams.stdout.write('No hay ofertas registradas para esta empresa.\n');
                return 0;
            }
            streams.stdout.write(`Ofertas de la empresa (${result.offers.length}):\n`);
            for (const offer of result.offers) {
                const type = offer.type === 'product' ? 'producto' : 'servicio';
                const status = { preparing: 'en preparación', available: 'disponible', withdrawn: 'retirada' }[offer.status];
                streams.stdout.write(`#${offer.id} [${type} · ${status}] ${safeTerminalText(offer.name)}${offer.bet_id === null ? '' : ` · apuesta #${offer.bet_id}`}\n`);
            }
            if (result.has_more) {
                streams.stdout.write(`Hay más ofertas. Continúa con: mycompany agent offers --after=${result.next_after}\n`);
            }
            return 0;
        }
        if (agentCommand === 'goals') {
            const options = parseAgentGoalsOptions(agentArguments);
            const result = await agentClient.listGoals(currentDirectory, options.afterId);
            if (result.goals.length === 0) {
                streams.stdout.write('No hay objetivos registrados para esta empresa.\n');
                return 0;
            }
            streams.stdout.write(`Objetivos de la empresa (${result.goals.length}):\n`);
            for (const goal of result.goals) {
                const status = { planned: 'previsto', active: 'activo', completed: 'completado', cancelled: 'cancelado' }[goal.status];
                const targetDate = goal.target_date === null ? '' : ` · fecha objetivo ${goal.target_date}`;
                streams.stdout.write(`#${goal.id} [${status}] ${safeTerminalText(goal.title)}${targetDate}\n`);
            }
            if (result.has_more) {
                streams.stdout.write(`Hay más objetivos. Continúa con: mycompany agent goals --after=${result.next_after}\n`);
            }
            return 0;
        }
        if (agentCommand === 'assets') {
            const options = parseAgentAssetsOptions(agentArguments);
            const result = await agentClient.listAssets(currentDirectory, options.afterId);
            if (result.assets.length === 0) {
                streams.stdout.write('No hay activos registrados para esta empresa.\n');
                return 0;
            }
            streams.stdout.write(`Activos de la empresa (${result.assets.length}):\n`);
            for (const asset of result.assets) {
                const url = asset.url === null ? '' : ` · ${safeTerminalText(asset.url)}`;
                streams.stdout.write(`#${asset.id} [${safeTerminalText(asset.type)}] ${safeTerminalText(asset.name)}${url}\n`);
            }
            if (result.has_more) {
                streams.stdout.write(`Hay más activos. Continúa con: mycompany agent assets --after=${result.next_after}\n`);
            }
            return 0;
        }
        if (agentCommand === 'workspaces') {
            const options = parseAgentWorkspacesOptions(agentArguments);
            const result = await agentClient.listWorkspaces(currentDirectory, options.afterId);
            if (result.workspaces.length === 0) {
                streams.stdout.write('No hay Workspaces registrados para esta empresa.\n');
                return 0;
            }
            streams.stdout.write(`Workspaces de la empresa (${result.workspaces.length}):\n`);
            for (const workspace of result.workspaces) {
                streams.stdout.write(`#${workspace.id} ${safeTerminalText(workspace.name)} [${safeTerminalText(workspace.status)}] · ${workspace.uuid}\n`);
            }
            if (result.has_more) {
                streams.stdout.write(`Hay más Workspaces. Continúa con: mycompany agent workspaces --after=${result.next_after}\n`);
            }
            return 0;
        }
        if (agentCommand === 'workspace') {
            const workspace = await agentClient.getWorkspace(parseAgentWorkspaceId(agentArguments), currentDirectory);
            streams.stdout.write(`#${workspace.id} · ${safeTerminalText(workspace.name)}\nUUID: ${workspace.uuid}\nEstado: ${safeTerminalText(workspace.status)}\n`);
            if (workspace.description !== null && workspace.description !== '') streams.stdout.write(`Descripción: ${safeTerminalText(workspace.description)}\n`);
            streams.stdout.write('Este Workspace es una identidad lógica; MyCompanies no expone una ruta local de archivos.\n');
            return 0;
        }
        if (agentCommand === 'asset') {
            const asset = await agentClient.getAsset(parseAgentAssetId(agentArguments), currentDirectory);
            streams.stdout.write(`#${asset.id} · ${safeTerminalText(asset.name)}\nTipo: ${safeTerminalText(asset.type)}\n`);
            if (asset.url !== null) streams.stdout.write(`URL: ${safeTerminalText(asset.url)}\n`);
            if (asset.description !== null && asset.description !== '') streams.stdout.write(`Descripción: ${safeTerminalText(asset.description)}\n`);
            return 0;
        }
        if (agentCommand === 'goal') {
            const goal = await agentClient.getGoal(parseAgentGoalId(agentArguments), currentDirectory);
            const status = { planned: 'Previsto', active: 'Activo', completed: 'Completado', cancelled: 'Cancelado' }[goal.status];
            streams.stdout.write(`#${goal.id} · ${safeTerminalText(goal.title)}\nEstado: ${status}\n`);
            if (goal.target_date !== null) streams.stdout.write(`Fecha objetivo: ${goal.target_date}\n`);
            if (goal.description !== null && goal.description !== '') streams.stdout.write(`Descripción: ${safeTerminalText(goal.description)}\n`);
            streams.stdout.write(`Criterio de éxito: ${safeTerminalText(goal.success_criteria)}\n`);
            return 0;
        }
        if (agentCommand === 'offer' && agentArguments[0] === 'status') {
            const options = parseAgentOfferStatusOptions(agentArguments.slice(1));
            const result = await agentClient.updateOfferStatus(options.offerId, options.status, currentDirectory);
            const status = { preparing: 'en preparación', available: 'disponible', withdrawn: 'retirada' }[result.status];
            streams.stdout.write(result.changed
                ? `Oferta #${result.id}: estado actualizado a ${status} por ${safeTerminalText(result.changed_by.name)}.\n`
                : `Oferta #${result.id}: ya estaba en estado ${status}; no se añadió historial.\n`);
            return 0;
        }
        if (agentCommand === 'offer') {
            const offerId = parseAgentOfferId(agentArguments);
            const offer = await agentClient.getOffer(offerId, currentDirectory);
            const type = offer.type === 'product' ? 'Producto' : 'Servicio';
            const status = { preparing: 'En preparación', available: 'Disponible', withdrawn: 'Retirada' }[offer.status];
            streams.stdout.write(`#${offer.id} · ${safeTerminalText(offer.name)}\nTipo: ${type}\nEstado: ${status}\n`);
            if (offer.description !== null && offer.description !== '') {
                streams.stdout.write(`Descripción: ${safeTerminalText(offer.description)}\n`);
            }
            if (offer.bet_id !== null) {
                streams.stdout.write(`Apuesta de origen: #${offer.bet_id}\n`);
            }
            return 0;
        }
        if (agentCommand === 'bet' && agentArguments[0] === 'evidence') {
            const options = parseAgentBetEvidenceOptions(agentArguments.slice(1));
            const evidence = await agentClient.addBetEvidence(options.betId, options.evidence, currentDirectory);
            const assessment = { supports: 'apoya', challenges: 'cuestiona', neutral: 'neutral' }[evidence.assessment];
            streams.stdout.write(`Evidencia #${evidence.id} registrada en la apuesta #${options.betId} [${assessment}] por ${safeTerminalText(evidence.recorded_by.name)}.\n`);
            return 0;
        }
        if (agentCommand === 'bet' && agentArguments[0] === 'status') {
            const options = parseAgentBetStatusOptions(agentArguments.slice(1));
            const result = await agentClient.updateBetStatus(options.betId, options.status, currentDirectory);
            const status = { proposed: 'propuesta', investigating: 'investigando', validated: 'validada', discarded: 'descartada', archived: 'archivada' }[result.status];
            streams.stdout.write(result.changed
                ? `Apuesta #${result.id}: estado actualizado a ${status} por ${safeTerminalText(result.changed_by.name)}.\n`
                : `Apuesta #${result.id}: ya estaba en estado ${status}; no se añadió historial.\n`);
            return 0;
        }
        if (agentCommand === 'bet' && agentArguments[0] === 'convert') {
            const options = parseAgentBetConversionOptions(agentArguments.slice(1));
            const result = await agentClient.convertBet(options.betId, options.type, currentDirectory);
            streams.stdout.write(result.bet.changed
                ? `Apuesta #${options.betId} convertida en oferta ${result.offer.type === 'product' ? 'producto' : 'servicio'}: ${safeTerminalText(result.offer.name)}.\n`
                : `Apuesta #${options.betId} ya estaba convertida en oferta: ${safeTerminalText(result.offer.name)}.\n`);
            return 0;
        }
        if (agentCommand === 'bet' && agentArguments.length === 1) {
            const bet = await agentClient.getBet(parseTaskId(agentArguments[0]), currentDirectory);
            const status = { proposed: 'propuesta', investigating: 'investigando', validated: 'validada', discarded: 'descartada', converted: 'convertida', archived: 'archivada' }[bet.status];
            streams.stdout.write(`#${bet.id} · ${safeTerminalText(bet.title)}\n`);
            streams.stdout.write(`Estado: ${status}\nHipótesis: ${safeTerminalText(bet.hypothesis)}\n`);
            if (bet.description !== null && bet.description !== '') {
                streams.stdout.write(`Descripción: ${safeTerminalText(bet.description)}\n`);
            }
            streams.stdout.write(`Evidencias (${bet.evidences.length}):\n`);
            for (const evidence of bet.evidences) {
                const assessment = { supports: 'apoya', challenges: 'cuestiona', neutral: 'neutral' }[evidence.assessment];
                streams.stdout.write(`- ${safeTerminalText(evidence.title)} [${assessment}]: ${safeTerminalText(evidence.details)}\n`);
                if (evidence.source_url !== null) streams.stdout.write(`  Fuente: ${safeTerminalText(evidence.source_url)}\n`);
            }
            return 0;
        }
        if (agentCommand === 'task' && agentArguments.length === 1) {
            const taskId = parseTaskId(agentArguments[0]);
            const task = await agentClient.getTask(taskId, currentDirectory);
            const status = { open: 'abierta', in_progress: 'en curso', blocked: 'bloqueada' }[task.status];
            const priority = { low: 'baja', normal: 'normal', high: 'alta' }[task.priority];
            const dueDate = task.due_date === null ? 'sin fecha objetivo' : `vence ${task.due_date}`;
            const workspaceName = task.workspace === null ? 'Empresa' : safeTerminalText(task.workspace.name);
            streams.stdout.write(`#${task.id} · ${safeTerminalText(task.title)}\n`);
            streams.stdout.write(`Workspace: ${workspaceName}\n`);
            streams.stdout.write(`Responsable: ${formatAssignee(task.assignee)}\n`);
            streams.stdout.write(`Estado: ${status} · Prioridad: ${priority} · ${dueDate}\n`);
            if (task.description !== null && task.description !== '') {
                streams.stdout.write(`\n${safeTerminalText(task.description)}\n`);
            }
            return 0;
        }
        if (agentCommand === 'task' && agentArguments[0] === 'status') {
            const options = parseAgentStatusOptions(agentArguments.slice(1));
            const result = await agentClient.updateTaskStatus(options.taskId, options.status, currentDirectory);
            const status = { open: 'abierta', in_progress: 'en curso', completed: 'completada', blocked: 'bloqueada', cancelled: 'cancelada' }[result.status];
            streams.stdout.write(`Tarea #${result.id}: estado actualizado a ${status}.\n`);
            return 0;
        }
        if (agentCommand === 'task' && agentArguments[0] === 'create') {
            const options = parseAgentTaskCreateOptions(agentArguments.slice(1));
            const result = await agentClient.createTask(options.task, options.idempotencyKey, currentDirectory);
            const replay = result.replayed ? ' (petición repetida; se devuelve la tarea original)' : '';
            streams.stdout.write(`Tarea #${result.task.id} creada · ${safeTerminalText(result.task.title)}${replay}.\n`);
            return 0;
        }
        if (agentCommand === 'task' && agentArguments[0] === 'assign') {
            const options = parseAgentAssignmentOptions(agentArguments.slice(1));
            const result = await agentClient.assignTask(options.taskId, options.assigneeAgentId, currentDirectory);
            const responsible = result.assignee === null ? 'sin asignar' : safeTerminalText(result.assignee.name);
            streams.stdout.write(`Tarea #${result.id}: responsable ${responsible}.\n`);
            return 0;
        }
        if (agentCommand === 'task' && agentArguments[0] === 'edit') {
            const options = parseAgentTaskEditOptions(agentArguments.slice(1));
            const task = await agentClient.editTask(options.taskId, options.changes, currentDirectory);
            streams.stdout.write(`Tarea #${task.id} actualizada · ${safeTerminalText(task.title)}.\n`);
            return 0;
        }
        if (agentCommand === 'forget' && agentArguments.length === 0) {
            await agentClient.forget(currentDirectory);
            streams.stdout.write('Credencial Agent local eliminada. Revócala también en MyCompanies para invalidarla en el servidor.\n');
            return 0;
        }
        throw new Error('Uso: mycompany agent login|me|forget. Usa mycompany help.');
    }

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
            streams.stdout.write(`#${task.id} [${status} · ${priority}] ${safeTerminalText(task.workspace.name)} · ${safeTerminalText(task.title)}${dueDate} · responsable ${formatAssignee(task.assignee)}\n`);
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
        streams.stdout.write(`Responsable: ${formatAssignee(task.assignee)}\n`);
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

export function parseAgentLoginOptions(argumentsList) {
    const options = { allowInsecureLocalhost: false };
    for (const argument of argumentsList) {
        if (argument === '--allow-insecure-localhost') {
            options.allowInsecureLocalhost = true;
            continue;
        }
        const separator = argument.indexOf('=');
        if (!argument.startsWith('--') || separator < 3) throw new Error('Usa opciones con formato --nombre=valor.');
        const name = argument.slice(2, separator);
        const value = argument.slice(separator + 1);
        if (!value || name !== 'server') throw new Error('Opción desconocida o vacía. Usa mycompany help.');
        options.server = value;
    }
    if (!options.server) throw new Error('Falta el servidor. Usa agent login --server=URL.');
    return options;
}

export function parseAgentTasksOptions(argumentsList) {
    if (argumentsList.length === 0) return { afterId: null };
    if (argumentsList.length !== 1) throw new Error('Opción desconocida o repetida para agent tasks. Usa --after=ID.');
    const match = /^--after=(.+)$/.exec(argumentsList[0]);
    if (match === null) throw new Error('Opción desconocida para agent tasks. Usa --after=ID.');
    return { afterId: parseTaskId(match[1]) };
}

export function parseAgentBetsOptions(argumentsList) {
    if (argumentsList.length === 0) return { afterId: null };
    if (argumentsList.length !== 1) throw new Error('Opción desconocida o repetida para agent bets. Usa --after=ID.');
    const match = /^--after=(.+)$/.exec(argumentsList[0]);
    if (match === null) throw new Error('Opción desconocida para agent bets. Usa --after=ID.');
    return { afterId: parseTaskId(match[1]) };
}

export function parseAgentOffersOptions(argumentsList) {
    if (argumentsList.length === 0) return { afterId: null };
    if (argumentsList.length !== 1) throw new Error('Opción desconocida o repetida para agent offers. Usa --after=ID.');
    const match = /^--after=(.+)$/.exec(argumentsList[0]);
    if (match === null) throw new Error('Opción desconocida para agent offers. Usa --after=ID.');
    return { afterId: parseTaskId(match[1]) };
}

export function parseAgentGoalsOptions(argumentsList) {
    if (argumentsList.length === 0) return { afterId: null };
    if (argumentsList.length !== 1) throw new Error('Opción desconocida o repetida para agent goals. Usa --after=ID.');
    const match = /^--after=(.+)$/.exec(argumentsList[0]);
    if (match === null) throw new Error('Opción desconocida para agent goals. Usa --after=ID.');
    return { afterId: parseTaskId(match[1]) };
}

export function parseAgentGoalId(argumentsList) {
    if (argumentsList.length !== 1) throw new Error('Uso: mycompany agent goal ID.');
    return parseTaskId(argumentsList[0]);
}

export function parseAgentAssetsOptions(argumentsList) {
    if (argumentsList.length === 0) return { afterId: null };
    if (argumentsList.length !== 1) throw new Error('Opción desconocida o repetida para agent assets. Usa --after=ID.');
    const match = /^--after=(.+)$/.exec(argumentsList[0]);
    if (match === null) throw new Error('Opción desconocida para agent assets. Usa --after=ID.');
    return { afterId: parseTaskId(match[1]) };
}

export function parseAgentAssetId(argumentsList) {
    if (argumentsList.length !== 1) throw new Error('Uso: mycompany agent asset ID.');
    return parseTaskId(argumentsList[0]);
}

export function parseAgentWorkspacesOptions(argumentsList) {
    if (argumentsList.length === 0) return { afterId: null };
    if (argumentsList.length !== 1) throw new Error('Opción desconocida o repetida para agent workspaces. Usa --after=ID.');
    const match = /^--after=(.+)$/.exec(argumentsList[0]);
    if (match === null) throw new Error('Opción desconocida para agent workspaces. Usa --after=ID.');
    return { afterId: parseTaskId(match[1]) };
}

export function parseAgentWorkspaceId(argumentsList) {
    if (argumentsList.length !== 1) throw new Error('Uso: mycompany agent workspace ID.');
    return parseTaskId(argumentsList[0]);
}

export function parseAgentOfferId(argumentsList) {
    if (argumentsList.length !== 1) throw new Error('Uso: mycompany agent offer ID.');
    return parseTaskId(argumentsList[0]);
}

export function parseAgentOfferStatusOptions(argumentsList) {
    if (argumentsList.length !== 2) throw new Error('Uso: mycompany agent offer status ID ESTADO.');
    const [offerId, status] = argumentsList;
    if (!['preparing', 'available', 'withdrawn'].includes(status)) {
        throw new Error('El estado no es válido; usa preparing, available o withdrawn.');
    }

    return { offerId: parseTaskId(offerId), status };
}

export function parseArtifactPublishOptions(argumentsList) {
    if (argumentsList.length < 2 || argumentsList[0].startsWith('--')) {
        throw new Error('Uso: mycompany artifact publish FILE --title=TEXTO [--description=TEXTO] [--source=TEXTO].');
    }
    const filePath = argumentsList[0];
    const fields = new Set(['title', 'description', 'source']);
    const metadata = {};
    for (const argument of argumentsList.slice(1)) {
        const separator = argument.indexOf('=');
        if (!argument.startsWith('--') || separator < 3) throw new Error('Usa opciones con formato --nombre=valor.');
        const key = argument.slice(2, separator);
        const value = argument.slice(separator + 1);
        if (!fields.has(key) || value === '' || Object.hasOwn(metadata, key)) {
            throw new Error('Opción desconocida, vacía o repetida para publicar un informe.');
        }
        metadata[key] = value;
    }
    if (typeof metadata.title !== 'string' || metadata.title.length > 160) {
        throw new Error('El título es obligatorio y admite hasta 160 caracteres.');
    }
    if (metadata.description !== undefined && metadata.description.length > 2000) {
        throw new Error('La descripción admite hasta 2000 caracteres.');
    }
    if (metadata.source !== undefined && metadata.source.length > 160) {
        throw new Error('El origen admite hasta 160 caracteres.');
    }

    return { filePath, metadata };
}

export function parseArtifactListOptions(argumentsList) {
    if (argumentsList.length === 0) return { afterId: null };
    if (argumentsList.length !== 1) throw new Error('Opción desconocida o repetida para artifacts. Usa --after=ID.');
    const match = /^--after=(.+)$/.exec(argumentsList[0]);
    if (match === null) throw new Error('Opción desconocida para artifacts. Usa --after=ID.');
    return { afterId: parseArtifactNumericId(match[1]) };
}

export function parseArtifactDownloadOptions(argumentsList) {
    if (argumentsList.length !== 2 || !argumentsList[1].startsWith('--output=')) {
        throw new Error('Uso: mycompany artifact download ID --output=FILE.');
    }
    const artifactId = parseArtifactNumericId(argumentsList[0]);
    const outputPath = argumentsList[1].slice('--output='.length);
    if (outputPath === '') throw new Error('Indica la ruta de salida con --output=FILE.');

    return { artifactId, outputPath };
}

export function parseArtifactId(argumentsList) {
    if (argumentsList.length !== 1) {
        throw new Error('Uso: mycompany artifact show ID.');
    }

    return parseArtifactNumericId(argumentsList[0]);
}

function parseArtifactNumericId(value) {
    if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
        throw new Error('El ID de informe debe ser un entero positivo.');
    }

    return Number(value);
}

export function parseAgentBetEvidenceOptions(argumentsList) {
    if (argumentsList.length < 4) {
        throw new Error('Uso: mycompany agent bet evidence ID --title=TEXTO --details=TEXTO --assessment=supports|challenges|neutral [--source-url=URL].');
    }
    const betId = parseTaskId(argumentsList[0]);
    const options = {};
    const fieldNames = {
        title: 'title',
        details: 'details',
        assessment: 'assessment',
        'source-url': 'source_url',
    };
    for (const argument of argumentsList.slice(1)) {
        const separator = argument.indexOf('=');
        if (!argument.startsWith('--') || separator < 3) throw new Error('Usa opciones con formato --nombre=valor.');
        const optionName = argument.slice(2, separator);
        const field = fieldNames[optionName];
        const value = argument.slice(separator + 1);
        if (field === undefined || value === '' || field in options) {
            throw new Error('Opción desconocida, vacía o repetida para registrar evidencia.');
        }
        options[field] = value;
    }
    if (!options.title || options.title.length > 160) throw new Error('El título de la evidencia es obligatorio y admite hasta 160 caracteres.');
    if (!options.details || options.details.length > 2000) throw new Error('Los detalles de la evidencia son obligatorios y admiten hasta 2000 caracteres.');
    if (!['supports', 'challenges', 'neutral'].includes(options.assessment)) throw new Error('La valoración de la evidencia debe ser supports, challenges o neutral.');
    if (options.source_url !== undefined) {
        try {
            if (!['http:', 'https:'].includes(new URL(options.source_url).protocol) || options.source_url.length > 2048) {
                throw new Error();
            }
        } catch {
            throw new Error('La fuente debe ser una URL HTTP o HTTPS de hasta 2048 caracteres.');
        }
    }

    return { betId, evidence: options };
}

export function parseAgentBetStatusOptions(argumentsList) {
    if (argumentsList.length !== 2) throw new Error('Uso: mycompany agent bet status ID ESTADO.');
    const [betId, status] = argumentsList;
    if (!['proposed', 'investigating', 'validated', 'discarded', 'archived'].includes(status)) {
        throw new Error('El estado no es válido; converted requiere una operación separada.');
    }

    return { betId: parseTaskId(betId), status };
}

export function parseAgentBetConversionOptions(argumentsList) {
    if (argumentsList.length !== 2) throw new Error('Uso: mycompany agent bet convert ID --type=product|service.');
    const betId = parseTaskId(argumentsList[0]);
    const match = /^--type=(product|service)$/.exec(argumentsList[1]);
    if (match === null) throw new Error('El tipo de oferta debe ser producto o servicio (--type=product|service).');

    return { betId, type: match[1] };
}

export function parseAgentStatusOptions(argumentsList) {
    if (argumentsList.length !== 2) throw new Error('Uso: mycompany agent task status ID ESTADO.');
    const [taskId, status] = argumentsList;
    if (!['open', 'in_progress', 'completed', 'blocked', 'cancelled'].includes(status)) {
        throw new Error('El estado no es válido.');
    }
    return { taskId: parseTaskId(taskId), status };
}

export function parseAgentTaskCreateOptions(argumentsList) {
    const allowedOptions = new Set(['title', 'description', 'priority', 'due-date', 'workspace-id', 'idempotency-key']);
    const values = {};
    for (const argument of argumentsList) {
        const separator = argument.indexOf('=');
        if (!argument.startsWith('--') || separator < 3) throw new Error('Usa opciones --nombre=valor para crear la tarea.');
        const name = argument.slice(2, separator);
        const value = argument.slice(separator + 1);
        if (!allowedOptions.has(name) || !value || Object.hasOwn(values, name)) {
            throw new Error('Opción desconocida, vacía o repetida para crear la tarea. Usa mycompany help.');
        }
        values[name] = value;
    }

    if (!values.title) throw new Error('Falta --title para crear la tarea.');
    const idempotencyKey = values['idempotency-key'];
    if (!idempotencyKey || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idempotencyKey)) {
        throw new Error('Falta --idempotency-key o no contiene un UUID válido.');
    }
    if (values.priority && !['low', 'normal', 'high'].includes(values.priority)) {
        throw new Error('La prioridad debe ser low, normal o high.');
    }
    if (values['due-date'] && !/^\d{4}-\d{2}-\d{2}$/.test(values['due-date'])) {
        throw new Error('La fecha debe usar el formato AAAA-MM-DD.');
    }

    const task = { title: values.title };
    if (values.description !== undefined) task.description = values.description;
    if (values.priority !== undefined) task.priority = values.priority;
    if (values['due-date'] !== undefined) task.due_date = values['due-date'];
    if (values['workspace-id'] !== undefined) task.workspace_id = parseTaskId(values['workspace-id']);
    return { idempotencyKey, task };
}

export function parseAgentAssignmentOptions(argumentsList) {
    if (argumentsList.length !== 2) throw new Error('Uso: mycompany agent task assign ID AGENT_ID|none.');
    const taskId = parseTaskId(argumentsList[0]);
    const assigneeAgentId = argumentsList[1] === 'none' ? null : parseTaskId(argumentsList[1]);
    return { taskId, assigneeAgentId };
}

export function parseAgentTaskEditOptions(argumentsList) {
    if (argumentsList.length < 2) throw new Error('Uso: mycompany agent task edit ID --campo=valor. Indica al menos un campo.');
    const taskId = parseTaskId(argumentsList[0]);
    const allowedOptions = new Set(['title', 'description', 'priority', 'due-date']);
    const changes = {};
    for (const argument of argumentsList.slice(1)) {
        const separator = argument.indexOf('=');
        if (!argument.startsWith('--') || separator < 3) throw new Error('Usa opciones --nombre=valor para editar la tarea.');
        const name = argument.slice(2, separator);
        const value = argument.slice(separator + 1);
        if (!allowedOptions.has(name) || Object.hasOwn(changes, name)) {
            throw new Error('Opción desconocida o repetida para editar la tarea.');
        }
        if (name === 'title' && value === '') throw new Error('El título no puede estar vacío.');
        if (name === 'priority' && !['low', 'normal', 'high'].includes(value)) throw new Error('Prioridad no válida. Usa low, normal o high.');
        if (name === 'due-date') {
            if (value === 'none') changes.due_date = null;
            else if (/^\d{4}-\d{2}-\d{2}$/.test(value)) changes.due_date = value;
            else throw new Error('La fecha debe ser AAAA-MM-DD o none.');
            continue;
        }
        if (name === 'description') changes.description = value === '' ? null : value;
        else changes[name] = value;
    }
    if (Object.keys(changes).length === 0) throw new Error('Indica al menos un campo de detalle para editar.');
    return { taskId, changes };
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
    stdout.write('  mycompany agent login --server=URL [--allow-insecure-localhost]\n');
    stdout.write('    Valida una credencial de agente introducida sin mostrarla y la guarda en un almacén local separado del Runner.\n');
    stdout.write('    El servidor debe usar HTTPS; HTTP solo se permite para pruebas en localhost. La carpeta de empresa actual se asocia a la identidad.\n');
    stdout.write('  mycompany agent me\n');
    stdout.write('    Consulta la identidad Agent y sus permisos vigentes desde la carpeta de empresa asociada. No ejecuta tareas.\n');
    stdout.write('  mycompany agent tasks [--after=ID]\n');
    stdout.write('    Lista tareas activas permitidas por los grants Agent actuales. No las modifica ni las ejecuta.\n');
    stdout.write('  mycompany agent bets [--after=ID]\n');
    stdout.write('    Lista apuestas de la empresa con bets.read o bets.manage. Solo muestra título y estado.\n');
    stdout.write('  mycompany agent offers [--after=ID]\n');
    stdout.write('    Lista ofertas de la empresa con offers.read o offers.manage.\n');
    stdout.write('  mycompany agent goals [--after=ID]\n');
    stdout.write('    Lista objetivos de la empresa con goals.read o goals.manage.\n');
    stdout.write('  mycompany agent goal ID\n');
    stdout.write('    Muestra la descripción y el criterio de éxito de un objetivo permitido.\n');
    stdout.write('  mycompany agent assets [--after=ID]\n');
    stdout.write('    Lista activos de la empresa con assets.read o assets.manage.\n');
    stdout.write('  mycompany agent asset ID\n');
    stdout.write('    Muestra los datos de un activo permitido.\n');
    stdout.write('  mycompany agent workspaces [--after=ID]\n');
    stdout.write('    Lista Workspaces de la empresa con workspaces.read o workspaces.manage.\n');
    stdout.write('  mycompany agent workspace ID\n');
    stdout.write('    Muestra un Workspace lógico sin exponer una ruta local.\n');
    stdout.write('  mycompany agent offer ID\n');
    stdout.write('    Muestra los detalles de una oferta permitida, incluida su apuesta de origen.\n');
    stdout.write('  mycompany agent offer status ID ESTADO\n');
    stdout.write('    Cambia el estado con offers.manage y registra al agente en el historial.\n');
    stdout.write('  mycompany artifact publish FILE --title=TEXTO [--description=TEXTO] [--source=TEXTO]\n');
    stdout.write('    Publica un archivo .md, .txt o .pdf seleccionado en la carpeta de empresa con artifacts.publish.\n');
    stdout.write('  mycompany artifact show ID\n');
    stdout.write('    Muestra los metadatos de un informe permitido con artifacts.read; no descarga su contenido.\n');
    stdout.write('  mycompany artifacts [--after=ID]\n');
    stdout.write('    Lista informes compartidos; artifacts.publish incluye lectura y artifacts.read permite consultarlos.\n');
    stdout.write('  mycompany artifact download ID --output=FILE\n');
    stdout.write('    Descarga un informe con artifacts.read a una nueva ruta dentro de la carpeta de empresa.\n');
    stdout.write('  mycompany agent bet ID\n');
    stdout.write('    Muestra hipótesis, descripción y evidencias de una apuesta permitida, como texto sin ejecutarlas.\n');
    stdout.write('  mycompany agent bet evidence ID --title=TEXTO --details=TEXTO --assessment=supports|challenges|neutral [--source-url=URL]\n');
    stdout.write('    Registra una observación en la apuesta con bets.manage y conserva el agente que la aportó. No cambia el estado de la apuesta.\n');
    stdout.write('  mycompany agent bet status ID ESTADO\n');
    stdout.write('    Cambia el estado con bets.status.manage y registra el agente en el historial. La conversión en oferta es una operación separada.\n');
    stdout.write('  mycompany agent bet convert ID --type=product|service\n');
    stdout.write('    Convierte una apuesta validada en oferta con offers.manage; conserva el agente en ambos historiales.\n');
    stdout.write('  mycompany agent task ID\n');
    stdout.write('    Consulta una tarea activa dentro del ámbito Agent y muestra descripción y detalles como texto. No interpreta instrucciones.\n');
    stdout.write('  mycompany agent task status ID ESTADO\n');
    stdout.write('    Cambia el estado con tasks.manage; MyCompanies valida grants, dependencias y registra la identidad Agent.\n');
    stdout.write('  mycompany agent task create --title=TEXTO --idempotency-key=UUID [--description=TEXTO] [--priority=low|normal|high] [--due-date=AAAA-MM-DD] [--workspace-id=ID]\n');
    stdout.write('    Crea una tarea con tasks.manage, abierta y sin asignar. Reutiliza el mismo UUID al reintentar la misma petición; el servidor aplica el scope y evita duplicados.\n');
    stdout.write('  mycompany agent task assign ID AGENT_ID|none\n');
    stdout.write('    Asigna a un agente activo con tasks.read usando tasks.assign, o deja la tarea sin asignar. MyCompanies registra el actor y valida el scope.\n');
    stdout.write('  mycompany agent task edit ID [--title=TEXTO] [--description=TEXTO|] [--priority=low|normal|high] [--due-date=AAAA-MM-DD|none]\n');
    stdout.write('    Edita solo datos descriptivos con tasks.manage y deja el historial en MyCompanies. Usa --description= vacío o --due-date=none para borrarlos.\n');
    stdout.write('  mycompany agent forget\n');
    stdout.write('    Elimina la credencial Agent local de esta carpeta. No la revoca en MyCompanies.\n');
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
