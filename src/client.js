import { lstat, open, realpath, readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, extname, relative, resolve, sep } from 'node:path';
import { DEVTO_STATS_TOTALS_CAPABILITY, listLocalCapabilities, runDevtoStatsTotals } from './capabilities/devto-stats-totals.js';
const API_TOKEN_PATTERN = /^[A-Za-z0-9]{80}$/;
const ENROLLMENT_CODE_PATTERN = /^[A-Za-z0-9]{64}$/;
const AGENT_TOKEN_PATTERN = /^[A-Za-z0-9]{80}$/;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
const MAX_EXECUTION_RESULT_BYTES = 65_536;
const ARTIFACT_EXTENSIONS = new Set(['.md', '.txt', '.pdf']);

export function normalizeServerUrl(serverUrl, allowInsecureLocalhost = false) {
    if (typeof serverUrl !== 'string' || serverUrl.trim() !== serverUrl || /[\r\n\0\t ]/.test(serverUrl)) {
        throw new Error('La URL del servidor no es válida.');
    }

    let parsedUrl;
    try {
        parsedUrl = new URL(serverUrl);
    } catch {
        throw new Error('La URL del servidor no es válida.');
    }
    if (!['http:', 'https:'].includes(parsedUrl.protocol)
        || parsedUrl.username !== ''
        || parsedUrl.password !== ''
        || parsedUrl.pathname !== '/'
        || parsedUrl.search !== ''
        || parsedUrl.hash !== '') {
        throw new Error('Indica la URL base del servidor, sin credenciales, ruta ni parámetros.');
    }

    if (parsedUrl.protocol === 'https:') {
        return parsedUrl.origin;
    }

    const hostname = parsedUrl.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(hostname);
    if (!allowInsecureLocalhost || !isLoopback) {
        throw new Error('Usa HTTPS. HTTP solo se permite con autorización explícita en loopback.');
    }

    return parsedUrl.origin;
}

export function formatAssignee(assignee) {
    if (assignee === undefined || assignee === null) {
        return 'sin asignar';
    }

    const kind = assignee.type === 'agent' ? 'Agente' : 'Persona';
    return `${kind}: ${String(assignee.name).replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')}`;
}

export class RunnerClient {
    constructor(configStore, fetchImplementation = globalThis.fetch, {
        listLocalCapabilitiesImplementation = listLocalCapabilities,
        runDevtoStatsTotalsImplementation = runDevtoStatsTotals,
    } = {}) {
        this.configStore = configStore;
        this.fetch = fetchImplementation;
        this.listLocalCapabilities = listLocalCapabilitiesImplementation;
        this.runDevtoStatsTotals = runDevtoStatsTotalsImplementation;
    }

    async enroll(serverUrl, code, companyRootPath = process.cwd(), allowInsecureLocalhost = false) {
        const normalizedServerUrl = normalizeServerUrl(serverUrl, allowInsecureLocalhost);
        if (!ENROLLMENT_CODE_PATTERN.test(code)) {
            throw new Error('El código de alta debe contener 64 caracteres alfanuméricos.');
        }
        const resolvedCompanyRootPath = await validateCompanyRootPath(companyRootPath);
        const { status, body } = await this.postJson(
            `${normalizedServerUrl}/api/v1/runner/enrollments/exchange`,
            { code },
        );
        if (status !== 201
            || !Number.isInteger(body.runner_id)
            || body.runner_id < 1
            || typeof body.api_token !== 'string'
            || !API_TOKEN_PATTERN.test(body.api_token)) {
            throw enrollmentError(status);
        }

        await this.configStore.saveNew({
            server_url: normalizedServerUrl,
            runner_id: body.runner_id,
            workspace_path: resolvedCompanyRootPath,
            allow_insecure_localhost: allowInsecureLocalhost,
            api_token: body.api_token,
        });

        return body.runner_id;
    }

    async heartbeat(currentDirectory = process.cwd()) {
        const configuration = await this.configStore.loadForDirectory(currentDirectory);
        const serverUrl = normalizeServerUrl(configuration.server_url, configuration.allow_insecure_localhost);
        try {
            await validateCompanyRootPath(configuration.workspace_path);
        } catch {
            throw new Error('La carpeta raíz de la empresa no está disponible; no se envió el heartbeat.');
        }

        const { status, body } = await this.postJson(
            `${serverUrl}/api/v1/runner/heartbeat`,
            {},
            configuration.api_token,
        );
        if (status === 401) {
            throw new Error('La credencial Runner fue rechazada (HTTP 401). Comprueba si fue revocada.');
        }
        if (status !== 200
            || body.runner_id !== configuration.runner_id
            || typeof body.runner_name !== 'string'
            || typeof body.company_name !== 'string'
            || body.status !== 'online'
            || typeof body.last_seen_at !== 'string'
            || !Array.isArray(body.workspaces)
            || body.workspaces.some((workspace) => workspace === null
                || typeof workspace !== 'object'
                || !Number.isInteger(workspace.id)
                || typeof workspace.name !== 'string')) {
            throw new Error('MyCompanies devolvió una respuesta de heartbeat no válida.');
        }

        return body;
    }

    async workOnce(currentDirectory = process.cwd()) {
        const configuration = await this.configStore.loadForDirectory(currentDirectory);
        const serverUrl = normalizeServerUrl(configuration.server_url, configuration.allow_insecure_localhost);
        const claim = await this.postJson(
            `${serverUrl}/api/v1/runner/workspace-checks/claim`,
            {},
            configuration.api_token,
        );

        if (claim.status === 204) {
            return null;
        }
        if (claim.status === 401) {
            throw new Error('La credencial Runner fue rechazada (HTTP 401). Comprueba si fue revocada.');
        }
        if (claim.status !== 200
            || !Number.isInteger(claim.body.id)
            || claim.body.id < 1
            || claim.body.capability !== 'workspace.check'
            || typeof claim.body.lease_token !== 'string'
            || !API_TOKEN_PATTERN.test(claim.body.lease_token)
            || claim.body.workspace === null
            || typeof claim.body.workspace !== 'object'
            || !Number.isInteger(claim.body.workspace.id)
            || typeof claim.body.workspace.name !== 'string') {
            throw new Error('MyCompanies devolvió un trabajo no válido o una capacidad no permitida.');
        }

        let workspaceAccessible = true;
        try {
            await validateCompanyRootPath(configuration.workspace_path);
        } catch {
            workspaceAccessible = false;
        }

        const result = await this.postJson(
            `${serverUrl}/api/v1/runner/workspace-checks/${claim.body.id}/result`,
            {
                lease_token: claim.body.lease_token,
                workspace_accessible: workspaceAccessible,
            },
            configuration.api_token,
        );
        if (result.status !== 200
            || result.body.status !== 'completed'
            || result.body.workspace_accessible !== workspaceAccessible) {
            throw new Error('MyCompanies no aceptó el resultado de la comprobación del workspace.');
        }

        return {
            workspace_name: claim.body.workspace.name,
            workspace_accessible: workspaceAccessible,
        };
    }

    async executeOnce(currentDirectory = process.cwd()) {
        const configuration = await this.configStore.loadForDirectory(currentDirectory);
        const serverUrl = normalizeServerUrl(configuration.server_url, configuration.allow_insecure_localhost);
        const localCapabilities = await this.listLocalCapabilities(configuration.workspace_path);
        const hasDevtoCapability = localCapabilities.some((capability) => capability.name === DEVTO_STATS_TOTALS_CAPABILITY.name
            && capability.version === DEVTO_STATS_TOTALS_CAPABILITY.version);
        if (!hasDevtoCapability) {
            throw new Error('La capacidad devto.stats.totals@1.0.0 no está instalada en esta carpeta de empresa.');
        }

        const claim = await this.postJson(
            `${serverUrl}/api/v1/runner/executions/claim`,
            { capabilities: [{ name: DEVTO_STATS_TOTALS_CAPABILITY.name, version: DEVTO_STATS_TOTALS_CAPABILITY.version }] },
            configuration.api_token,
        );
        if (claim.status === 204) return null;
        if (claim.status === 401) {
            throw new Error('La credencial Runner fue rechazada (HTTP 401). Comprueba si fue revocada.');
        }
        if (claim.status !== 200
            || !Number.isSafeInteger(claim.body.id)
            || claim.body.id < 1
            || claim.body.capability !== DEVTO_STATS_TOTALS_CAPABILITY.name
            || claim.body.capability_version !== DEVTO_STATS_TOTALS_CAPABILITY.version
            || !Array.isArray(claim.body.parameters)
            || claim.body.parameters.length !== 0
            || typeof claim.body.lease_token !== 'string'
            || !API_TOKEN_PATTERN.test(claim.body.lease_token)) {
            throw new Error('MyCompanies devolvió una autorización de ejecución no válida.');
        }

        const executionPath = `${serverUrl}/api/v1/runner/executions/${claim.body.id}`;
        const start = await this.postJson(
            `${executionPath}/start`,
            { lease_token: claim.body.lease_token },
            configuration.api_token,
        );
        const runtimeDeadline = Date.parse(start.body.runtime_deadline_at);
        if (start.status !== 200
            || start.body.status !== 'running'
            || !Number.isFinite(runtimeDeadline)
            || runtimeDeadline <= Date.now()) {
            throw new Error('La ejecución no se inició; el adaptador local no se ejecutó.');
        }

        const timeoutMs = Math.min(
            DEVTO_STATS_TOTALS_CAPABILITY.maxRuntimeMs,
            runtimeDeadline - Date.now() - 1_000,
        );
        if (timeoutMs <= 0) {
            throw new Error('El plazo de ejecución ya venció; el adaptador local no se ejecutó.');
        }

        let localResult;
        let outcome = 'succeeded';
        let resultPayload;
        try {
            localResult = await this.runDevtoStatsTotals({
                companyRoot: configuration.workspace_path,
                timeoutMs,
            });
            const successPayload = {
                lease_token: claim.body.lease_token,
                outcome: 'succeeded',
                result: localResult,
            };
            if (!isValidDevtoStatsResult(localResult)
                || Buffer.byteLength(JSON.stringify(successPayload), 'utf8') > MAX_EXECUTION_RESULT_BYTES) {
                outcome = 'failed';
                resultPayload = { failure_code: 'invalid_local_result' };
            } else {
                resultPayload = { result: localResult };
            }
        } catch {
            outcome = 'failed';
            resultPayload = { failure_code: 'capability_failed' };
        }

        const result = await this.postJson(
            `${executionPath}/result`,
            {
                lease_token: claim.body.lease_token,
                outcome,
                ...resultPayload,
            },
            configuration.api_token,
        );
        if (result.status !== 200
            || result.body.status !== outcome
            || typeof result.body.result_hash !== 'string'
            || !/^[a-f0-9]{64}$/.test(result.body.result_hash)
            || typeof result.body.replayed !== 'boolean') {
            throw new Error('MyCompanies no aceptó el resultado; el intento puede requerir revisión.');
        }

        return {
            outcome,
            article_count: outcome === 'succeeded' ? localResult.articles.length : 0,
        };
    }

    async listTasks(currentDirectory = process.cwd(), afterId = null, status = null) {
        if (afterId !== null && (!Number.isSafeInteger(afterId) || afterId < 1)) {
            throw new Error('El cursor de tareas debe ser un entero positivo.');
        }
        if (status !== null && !['open', 'in_progress', 'blocked'].includes(status)) {
            throw new Error('El estado de tareas no es válido.');
        }

        const configuration = await this.configStore.loadForDirectory(currentDirectory);
        const serverUrl = normalizeServerUrl(configuration.server_url, configuration.allow_insecure_localhost);
        const query = new URLSearchParams();
        if (afterId !== null) query.set('after_id', String(afterId));
        if (status !== null) query.set('status', status);
        const queryString = query.size === 0 ? '' : `?${query.toString()}`;
        const response = await this.getJson(`${serverUrl}/api/v1/runner/tasks${queryString}`, configuration.api_token);

        if (response.status === 401) {
            throw new Error('La credencial Runner fue rechazada (HTTP 401). Comprueba si fue revocada.');
        }
        if (response.status !== 200
            || !Array.isArray(response.body.tasks)
            || response.body.tasks.length > 100
            || typeof response.body.has_more !== 'boolean'
            || response.body.tasks.some((task) => !isRunnerTask(task))
            || (response.body.has_more
                ? !Number.isInteger(response.body.next_after)
                    || response.body.next_after < 1
                    || response.body.tasks.at(-1)?.id !== response.body.next_after
                : response.body.next_after !== null)) {
            throw new Error('MyCompanies devolvió una respuesta de tareas no válida.');
        }

        return response.body;
    }

    async getTask(taskId, currentDirectory = process.cwd()) {
        if (!Number.isSafeInteger(taskId) || taskId < 1) {
            throw new Error('El ID de tarea debe ser un entero positivo.');
        }

        const configuration = await this.configStore.loadForDirectory(currentDirectory);
        const serverUrl = normalizeServerUrl(configuration.server_url, configuration.allow_insecure_localhost);
        const response = await this.getJson(`${serverUrl}/api/v1/runner/tasks/${taskId}`, configuration.api_token);

        if (response.status === 401) {
            throw new Error('La credencial Runner fue rechazada (HTTP 401). Comprueba si fue revocada.');
        }
        if (response.status === 404) {
            throw new Error('La tarea no existe o no está disponible para este Runner.');
        }
        if (response.status !== 200 || !isRunnerTask(response.body.task, true)) {
            throw new Error('MyCompanies devolvió una respuesta de detalle no válida.');
        }

        return response.body.task;
    }

    async postJson(endpoint, payload, apiToken = '') {
        let response;
        try {
            response = await this.fetch(endpoint, {
                method: 'POST',
                headers: {
                    Accept: 'application/json',
                    'Content-Type': 'application/json',
                    ...(apiToken === '' ? {} : { Authorization: `Bearer ${apiToken}` }),
                },
                body: JSON.stringify(payload),
                redirect: 'manual',
                signal: AbortSignal.timeout(10_000),
            });
        } catch {
            throw new Error('No se pudo conectar con MyCompanies. Comprueba la URL y la red.');
        }

        if (response.status === 204) {
            return { status: response.status, body: {} };
        }
        if (response.status === 401 || response.status === 404 || response.status === 429 || response.status >= 300) {
            return { status: response.status, body: {} };
        }

        let responseText;
        try {
            responseText = await readResponseLimited(response, MAX_RESPONSE_BYTES);
        } catch {
            throw new Error('MyCompanies devolvió una respuesta demasiado grande o no válida.');
        }
        try {
            const body = JSON.parse(responseText);
            if (body === null || typeof body !== 'object' || Array.isArray(body)) {
                throw new Error('Invalid response shape.');
            }
            return { status: response.status, body };
        } catch {
            throw new Error('MyCompanies devolvió una respuesta JSON no válida.');
        }
    }

    async getJson(endpoint, apiToken) {
        let response;
        try {
            response = await this.fetch(endpoint, {
                method: 'GET',
                headers: {
                    Accept: 'application/json',
                    Authorization: `Bearer ${apiToken}`,
                },
                redirect: 'manual',
                signal: AbortSignal.timeout(10_000),
            });
        } catch {
            throw new Error('No se pudo conectar con MyCompanies. Comprueba la URL y la red.');
        }

        if (response.status === 401 || response.status === 404 || response.status === 429 || response.status >= 300) {
            return { status: response.status, body: {} };
        }

        let responseText;
        try {
            responseText = await readResponseLimited(response, MAX_RESPONSE_BYTES);
        } catch {
            throw new Error('MyCompanies devolvió una respuesta demasiado grande o no válida.');
        }
        try {
            const body = JSON.parse(responseText);
            if (body === null || typeof body !== 'object' || Array.isArray(body)) {
                throw new Error('Invalid response shape.');
            }
            return { status: response.status, body };
        } catch {
            throw new Error('MyCompanies devolvió una respuesta JSON no válida.');
        }
    }


}

export class AgentClient {
    constructor(configStore, fetchImplementation = globalThis.fetch) {
        this.configStore = configStore;
        this.fetch = fetchImplementation;
    }

    async login(serverUrl, apiToken, companyRootPath = process.cwd(), allowInsecureLocalhost = false) {
        const normalizedServerUrl = normalizeServerUrl(serverUrl, allowInsecureLocalhost);
        if (typeof apiToken !== 'string' || !AGENT_TOKEN_PATTERN.test(apiToken)) {
            throw new Error('La credencial Agent no tiene el formato esperado.');
        }
        const resolvedCompanyRootPath = await validateCompanyRootPath(companyRootPath);
        const identity = await this.requestIdentity(normalizedServerUrl, apiToken);
        await this.configStore.saveAgent({
            server_url: normalizedServerUrl,
            agent_id: identity.agent.id,
            agent_name: identity.agent.name,
            company_id: identity.company.id,
            company_name: identity.company.name,
            company_root_path: resolvedCompanyRootPath,
            allow_insecure_localhost: allowInsecureLocalhost,
            api_token: apiToken,
        });
        return identity;
    }

    async identity(currentDirectory = process.cwd()) {
        const configuration = await this.configStore.loadAgentForDirectory(currentDirectory);
        const serverUrl = normalizeServerUrl(configuration.server_url, configuration.allow_insecure_localhost);
        const identity = await this.requestIdentity(serverUrl, configuration.api_token);
        if (identity.agent.id !== configuration.agent_id || identity.company.id !== configuration.company_id) {
            throw new Error('La identidad Agent del servidor no coincide con la configuración local.');
        }
        return identity;
    }

    async forget(currentDirectory = process.cwd()) {
        await this.configStore.forgetAgent(currentDirectory);
    }

    async issueCredential(agentId, name, currentDirectory = process.cwd()) {
        if (!Number.isSafeInteger(agentId) || agentId < 1) throw new Error('El ID de agente debe ser un entero positivo.');
        if (typeof name !== 'string' || name.trim() === '' || name.length > 120) {
            throw new Error('El nombre de credencial debe tener entre 1 y 120 caracteres.');
        }
        await this.configStore.assertAgentNotConfigured(agentId);
        const parent = await this.configStore.loadAgentForDirectory(currentDirectory);
        const serverUrl = normalizeServerUrl(parent.server_url, parent.allow_insecure_localhost);
        const endpoint = `${serverUrl}/api/v1/agent/agents/${agentId}/credentials`;
        const response = await this.postJson(endpoint, { name: name.trim() }, parent.api_token);
        if (response.status === 401) throw new Error('La credencial Agent fue rechazada (HTTP 401). Comprueba si fue revocada o si el perfil está pausado.');
        if (response.status === 403) throw new Error('El agente necesita agents.credentials.manage para emitir credenciales (HTTP 403).');
        if (response.status === 404) throw new Error('El destino no es un reporte directo de esta empresa (HTTP 404).');
        if (response.status === 409) throw new Error('El agente de destino está pausado y no puede recibir credenciales (HTTP 409).');
        if (response.status === 422) throw new Error('MyCompanies rechazó el nombre de credencial (HTTP 422).');
        if (response.status === 429) throw new Error('MyCompanies limitó las solicitudes (HTTP 429). Vuelve a intentarlo más tarde.');
        const { credential_id: credentialId, api_token: apiToken, agent } = response.body;
        if (response.status !== 201
            || !Number.isSafeInteger(credentialId) || credentialId < 1
            || typeof apiToken !== 'string' || !AGENT_TOKEN_PATTERN.test(apiToken)
            || agent?.id !== agentId || typeof agent.uuid !== 'string'
            || typeof agent.name !== 'string' || !(agent.role === null || typeof agent.role === 'string') || agent.status !== 'active'
            || agent.company_id !== parent.company_id || typeof agent.company_name !== 'string') {
            throw new Error('MyCompanies devolvió una credencial de Agent no válida; no se mostró ningún secreto.');
        }

        try {
            await this.configStore.saveAgent({
                server_url: serverUrl,
                agent_id: agent.id,
                agent_name: agent.name,
                company_id: agent.company_id,
                company_name: agent.company_name,
                company_root_path: parent.company_root_path,
                allow_insecure_localhost: parent.allow_insecure_localhost,
                api_token: apiToken,
            });
        } catch {
            try {
                const rollback = await this.deleteJson(`${endpoint}/${credentialId}`, parent.api_token);
                if (rollback.status === 200 && rollback.body.revoked === true) {
                    throw new Error('No se pudo guardar la credencial en el almacén local; la credencial remota se revocó. El secreto no se mostró.');
                }
            } catch (error) {
                if (error.message.startsWith('No se pudo guardar la credencial')) throw error;
            }
            throw new Error(`MyCompanies emitió la credencial #${credentialId}, pero no pudo guardarse ni revocarse automáticamente. Revócala desde la web. El secreto no se mostró.`);
        }

        return { credential_id: credentialId, agent: { id: agent.id, name: agent.name } };
    }

    async revokeCredential(agentId, credentialId, currentDirectory = process.cwd()) {
        if (!Number.isSafeInteger(agentId) || agentId < 1 || !Number.isSafeInteger(credentialId) || credentialId < 1) {
            throw new Error('Los IDs de agente y credencial deben ser enteros positivos.');
        }
        const configuration = await this.configStore.loadAgentForDirectory(currentDirectory);
        const serverUrl = normalizeServerUrl(configuration.server_url, configuration.allow_insecure_localhost);
        const response = await this.deleteJson(
            `${serverUrl}/api/v1/agent/agents/${agentId}/credentials/${credentialId}`,
            configuration.api_token,
        );
        if (response.status === 401) throw new Error('La credencial Agent fue rechazada (HTTP 401). Comprueba si fue revocada o si el perfil está pausado.');
        if (response.status === 403) throw new Error('El agente necesita agents.credentials.manage para revocar credenciales (HTTP 403).');
        if (response.status === 404) throw new Error('La credencial no pertenece a un reporte directo o ya fue revocada (HTTP 404).');
        if (response.status === 429) throw new Error('MyCompanies limitó las solicitudes (HTTP 429). Vuelve a intentarlo más tarde.');
        if (response.status !== 200 || response.body.revoked !== true) {
            throw new Error('MyCompanies devolvió una confirmación de revocación no válida.');
        }
        return response.body;
    }

    async listCredentials(agentId, afterId = null, currentDirectory = process.cwd()) {
        if (!Number.isSafeInteger(agentId) || agentId < 1) throw new Error('El ID de agente debe ser un entero positivo.');
        if (afterId !== null && (!Number.isSafeInteger(afterId) || afterId < 1)) {
            throw new Error('El cursor de credenciales debe ser un entero positivo.');
        }
        const configuration = await this.configStore.loadAgentForDirectory(currentDirectory);
        const serverUrl = normalizeServerUrl(configuration.server_url, configuration.allow_insecure_localhost);
        const cursor = afterId === null ? '' : `?after_id=${afterId}`;
        const response = await this.getJson(
            `${serverUrl}/api/v1/agent/agents/${agentId}/credentials${cursor}`,
            configuration.api_token,
        );
        if (response.status === 401) throw new Error('La credencial Agent fue rechazada (HTTP 401). Comprueba si fue revocada o si el perfil está pausado.');
        if (response.status === 403) throw new Error('El agente necesita agents.credentials.manage para consultar credenciales (HTTP 403).');
        if (response.status === 404) throw new Error('El destino no es un reporte directo de esta empresa (HTTP 404).');
        if (response.status === 422) throw new Error('MyCompanies rechazó el cursor de credenciales (HTTP 422).');
        if (response.status === 429) throw new Error('MyCompanies limitó las solicitudes (HTTP 429). Vuelve a intentarlo más tarde.');
        const { agent, credentials, has_more: hasMore, next_after: nextAfter } = response.body;
        if (response.status !== 200
            || agent?.id !== agentId
            || typeof agent.name !== 'string'
            || !['active', 'paused'].includes(agent.status)
            || !Array.isArray(credentials)
            || credentials.length > 100
            || credentials.some((credential) => credential === null
                || typeof credential !== 'object'
                || !Number.isSafeInteger(credential.id)
                || typeof credential.name !== 'string'
                || !(credential.issued_by_type === null || typeof credential.issued_by_type === 'string')
                || !(credential.issued_by_name === null || typeof credential.issued_by_name === 'string')
                || typeof credential.created_at !== 'string'
                || !(credential.revoked_by_type === null || typeof credential.revoked_by_type === 'string')
                || !(credential.revoked_by_name === null || typeof credential.revoked_by_name === 'string')
                || !(credential.revoked_at === null || typeof credential.revoked_at === 'string')
                || Object.hasOwn(credential, 'token_hash')
                || Object.hasOwn(credential, 'api_token'))
            || typeof hasMore !== 'boolean'
            || (hasMore ? (!Number.isSafeInteger(nextAfter) || nextAfter < 1) : nextAfter !== null)) {
            throw new Error('MyCompanies devolvió un historial de credenciales no válido.');
        }
        return response.body;
    }

    async publishArtifact(filePath, metadata, currentDirectory = process.cwd()) {
        if (typeof filePath !== 'string' || filePath.trim() === '') {
            throw new Error('Indica el archivo concreto que quieres publicar.');
        }
        if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)
            || typeof metadata.title !== 'string' || metadata.title.trim() === '' || metadata.title.length > 160
            || (metadata.description !== undefined && (typeof metadata.description !== 'string' || metadata.description.length > 2000))
            || (metadata.source !== undefined && (typeof metadata.source !== 'string' || metadata.source.length > 160))) {
            throw new Error('El informe requiere un título y metadatos válidos.');
        }

        const configuration = await this.configStore.loadAgentForDirectory(currentDirectory);
        const companyRootPath = await realpath(configuration.company_root_path);
        const selectedPath = resolve(currentDirectory, filePath);
        let selectedLink;
        try {
            selectedLink = await lstat(selectedPath);
        } catch {
            throw new Error('El archivo indicado no existe o no se puede leer.');
        }
        if (selectedLink.isSymbolicLink()) {
            throw new Error('No se publican enlaces simbólicos. Indica el archivo real que quieres compartir.');
        }

        let sourcePath;
        try {
            sourcePath = await realpath(selectedPath);
        } catch {
            throw new Error('El archivo indicado no existe o no se puede leer.');
        }
        if (!isPathInside(companyRootPath, sourcePath)) {
            throw new Error('Solo se pueden publicar archivos dentro de la carpeta de esta empresa.');
        }
        const sourceStats = await stat(sourcePath);
        if (!sourceStats.isFile()) {
            throw new Error('Solo se pueden publicar archivos normales, no carpetas.');
        }
        if (sourceStats.size < 1 || sourceStats.size > MAX_ARTIFACT_BYTES) {
            throw new Error('El archivo debe tener entre 1 byte y 10 MB.');
        }
        const extension = extname(sourcePath).toLowerCase();
        if (!ARTIFACT_EXTENSIONS.has(extension)) {
            throw new Error('Solo se admiten informes .md, .txt o .pdf.');
        }

        const form = new FormData();
        form.append('title', metadata.title);
        if (metadata.description !== undefined) form.append('description', metadata.description);
        if (metadata.source !== undefined) form.append('source', metadata.source);
        const mimeType = extension === '.pdf' ? 'application/pdf' : 'text/plain';
        form.append('file', new Blob([await readFile(sourcePath)], { type: mimeType }), basename(sourcePath));

        const serverUrl = normalizeServerUrl(configuration.server_url, configuration.allow_insecure_localhost);
        const response = await this.postMultipart(`${serverUrl}/api/v1/agent/artifacts`, form, configuration.api_token);
        if (response.status === 401) {
            throw new Error('La credencial Agent fue rechazada (HTTP 401). Comprueba si fue revocada o si el perfil está pausado.');
        }
        if (response.status === 403) {
            throw new Error('El agente necesita artifacts.publish para publicar informes (HTTP 403).');
        }
        if (response.status === 422) {
            throw new Error('MyCompanies rechazó el informe. Comprueba el título y que el archivo sea .md, .txt o .pdf de hasta 10 MB (HTTP 422).');
        }
        if (response.status === 429) {
            throw new Error('MyCompanies limitó las solicitudes (HTTP 429). Vuelve a intentarlo más tarde.');
        }
        if (response.status !== 201 || !isArtifactSummary(response.body.artifact)) {
            throw new Error('MyCompanies devolvió una respuesta de publicación de informe no válida.');
        }
        return response.body.artifact;
    }

    async listArtifacts(currentDirectory = process.cwd(), afterId = null) {
        if (afterId !== null && (!Number.isSafeInteger(afterId) || afterId < 1)) {
            throw new Error('El cursor de informes debe ser un entero positivo.');
        }
        const configuration = await this.configStore.loadAgentForDirectory(currentDirectory);
        const serverUrl = normalizeServerUrl(configuration.server_url, configuration.allow_insecure_localhost);
        const cursor = afterId === null ? '' : `?after_id=${afterId}`;
        const response = await this.getJson(`${serverUrl}/api/v1/agent/artifacts${cursor}`, configuration.api_token);
        if (response.status === 401) {
            throw new Error('La credencial Agent fue rechazada (HTTP 401). Comprueba si fue revocada o si el perfil está pausado.');
        }
        if (response.status === 403) {
            throw new Error('El agente necesita artifacts.read para consultar informes (HTTP 403).');
        }
        if (response.status === 429) {
            throw new Error('MyCompanies limitó las solicitudes (HTTP 429). Vuelve a intentarlo más tarde.');
        }
        if (response.status !== 200
            || !Array.isArray(response.body.artifacts)
            || response.body.artifacts.length > 100
            || response.body.artifacts.some((artifact) => !isArtifactSummary(artifact))
            || typeof response.body.has_more !== 'boolean'
            || (response.body.has_more
                ? !Number.isInteger(response.body.next_after)
                    || response.body.artifacts.at(-1)?.id !== response.body.next_after
                : response.body.next_after !== null)) {
            throw new Error('MyCompanies devolvió una lista de informes no válida.');
        }
        return response.body;
    }

    async getArtifact(artifactId, currentDirectory = process.cwd()) {
        if (!Number.isSafeInteger(artifactId) || artifactId < 1) {
            throw new Error('El ID de informe debe ser un entero positivo.');
        }
        const configuration = await this.configStore.loadAgentForDirectory(currentDirectory);
        const serverUrl = normalizeServerUrl(configuration.server_url, configuration.allow_insecure_localhost);
        const response = await this.getJson(`${serverUrl}/api/v1/agent/artifacts/${artifactId}`, configuration.api_token);
        if (response.status === 401) {
            throw new Error('La credencial Agent fue rechazada (HTTP 401). Comprueba si fue revocada o si el perfil está pausado.');
        }
        if (response.status === 403) {
            throw new Error('El agente necesita artifacts.read para consultar informes (HTTP 403).');
        }
        if (response.status === 404) {
            throw new Error('El informe no existe o no pertenece a la empresa de este agente.');
        }
        if (response.status === 429) {
            throw new Error('MyCompanies limitó las solicitudes (HTTP 429). Vuelve a intentarlo más tarde.');
        }
        if (response.status !== 200 || !isArtifactSummary(response.body.artifact)) {
            throw new Error('MyCompanies devolvió detalles de informe no válidos.');
        }

        return response.body.artifact;
    }

    async downloadArtifact(artifactId, outputPath, currentDirectory = process.cwd()) {
        if (!Number.isSafeInteger(artifactId) || artifactId < 1) {
            throw new Error('El ID de informe debe ser un entero positivo.');
        }
        if (typeof outputPath !== 'string' || outputPath.trim() === '') {
            throw new Error('Indica una ruta de salida para el informe.');
        }
        const configuration = await this.configStore.loadAgentForDirectory(currentDirectory);
        const companyRootPath = await realpath(configuration.company_root_path);
        const targetPath = resolve(currentDirectory, outputPath);
        if (!ARTIFACT_EXTENSIONS.has(extname(targetPath).toLowerCase())) {
            throw new Error('La ruta de salida debe terminar en .md, .txt o .pdf.');
        }
        const targetDirectory = await realpath(dirname(targetPath)).catch(() => null);
        if (targetDirectory === null || !isPathInside(companyRootPath, targetDirectory)) {
            throw new Error('La carpeta de salida debe existir dentro de la carpeta de esta empresa.');
        }
        try {
            await lstat(targetPath);
            throw new Error('El archivo de salida ya existe; no se sobrescribe.');
        } catch (error) {
            if (error instanceof Error && error.message.includes('no se sobrescribe')) throw error;
            if (error?.code !== 'ENOENT') throw new Error('No se pudo comprobar la ruta de salida.');
        }

        const serverUrl = normalizeServerUrl(configuration.server_url, configuration.allow_insecure_localhost);
        const response = await this.getBinary(`${serverUrl}/api/v1/agent/artifacts/${artifactId}/download`, configuration.api_token);
        if (response.status === 401) {
            throw new Error('La credencial Agent fue rechazada (HTTP 401). Comprueba si fue revocada o si el perfil está pausado.');
        }
        if (response.status === 403) {
            throw new Error('El agente necesita artifacts.read para descargar informes (HTTP 403).');
        }
        if (response.status === 404) {
            throw new Error('El informe no existe o no pertenece a la empresa de este agente.');
        }
        if (response.status === 429) {
            throw new Error('MyCompanies limitó las solicitudes (HTTP 429). Vuelve a intentarlo más tarde.');
        }
        if (response.status !== 200 || response.bytes.length === 0) {
            throw new Error('MyCompanies devolvió un archivo de informe no válido.');
        }

        const outputFile = await open(targetPath, 'wx', 0o600).catch(() => null);
        if (outputFile === null) throw new Error('No se pudo crear el archivo de salida sin sobrescribir datos.');
        try {
            await outputFile.writeFile(response.bytes);
        } finally {
            await outputFile.close();
        }

        return { outputPath: targetPath };
    }

    async listMemoryTopics(currentDirectory = process.cwd()) {
        const configuration = await this.configStore.loadAgentForDirectory(currentDirectory);
        const serverUrl = normalizeServerUrl(configuration.server_url, configuration.allow_insecure_localhost);
        const response = await this.getJson(`${serverUrl}/api/v1/agent/memory/topics`, configuration.api_token);
        if (response.status === 401) throw new Error('La credencial Agent fue rechazada (HTTP 401). Comprueba si fue revocada o si el perfil está pausado.');
        if (response.status === 403) throw new Error('El agente no tiene permisos de memoria vigentes (HTTP 403).');
        if (response.status === 429) throw new Error('MyCompanies limitó las solicitudes (HTTP 429). Vuelve a intentarlo más tarde.');
        if (response.status !== 200
            || !Array.isArray(response.body.topics)
            || response.body.topics.length > 500
            || response.body.topics.some((topic) => !isMemoryTopic(topic))) {
            throw new Error('MyCompanies devolvió un catálogo de temas de memoria no válido.');
        }
        return response.body;
    }

    async listMemory(options = {}, currentDirectory = process.cwd()) {
        if (options === null || typeof options !== 'object' || Array.isArray(options)
            || Object.keys(options).some((key) => !['topicId', 'workspaceId', 'afterId'].includes(key))) {
            throw new Error('Las opciones de memoria no son válidas.');
        }
        validateOptionalPositiveId(options.topicId, 'tema');
        validateOptionalPositiveId(options.workspaceId, 'Workspace');
        validateOptionalPositiveId(options.afterId, 'cursor de memoria');
        const configuration = await this.configStore.loadAgentForDirectory(currentDirectory);
        const serverUrl = normalizeServerUrl(configuration.server_url, configuration.allow_insecure_localhost);
        const query = new URLSearchParams();
        if (options.topicId !== undefined) query.set('topic_id', String(options.topicId));
        if (options.workspaceId !== undefined) query.set('workspace_id', String(options.workspaceId));
        if (options.afterId !== undefined) query.set('after_id', String(options.afterId));
        const queryString = query.size === 0 ? '' : `?${query.toString()}`;
        const response = await this.getJson(`${serverUrl}/api/v1/agent/memory${queryString}`, configuration.api_token);
        if (response.status === 401) throw new Error('La credencial Agent fue rechazada (HTTP 401). Comprueba si fue revocada o si el perfil está pausado.');
        if (response.status === 403) throw new Error('El agente no tiene memory.read para ese ámbito de empresa, Workspace o tema (HTTP 403).');
        if (response.status === 422) throw new Error('MyCompanies rechazó el tema, Workspace o cursor solicitado (HTTP 422).');
        if (response.status === 429) throw new Error('MyCompanies limitó las solicitudes (HTTP 429). Vuelve a intentarlo más tarde.');
        if (response.status !== 200
            || !Array.isArray(response.body.memory)
            || response.body.memory.length > 100
            || response.body.memory.some((node) => !isMemoryNode(node))
            || typeof response.body.has_more !== 'boolean'
            || (response.body.has_more
                ? !Number.isSafeInteger(response.body.next_after)
                    || response.body.memory.at(-1)?.id !== response.body.next_after
                : response.body.next_after !== null)) {
            throw new Error('MyCompanies devolvió una lista de memoria no válida.');
        }
        return response.body;
    }

    async getMemory(memoryId, currentDirectory = process.cwd()) {
        if (!Number.isSafeInteger(memoryId) || memoryId < 1) throw new Error('El ID de memoria debe ser un entero positivo.');
        const configuration = await this.configStore.loadAgentForDirectory(currentDirectory);
        const serverUrl = normalizeServerUrl(configuration.server_url, configuration.allow_insecure_localhost);
        const response = await this.getJson(`${serverUrl}/api/v1/agent/memory/${memoryId}`, configuration.api_token);
        if (response.status === 401) throw new Error('La credencial Agent fue rechazada (HTTP 401). Comprueba si fue revocada o si el perfil está pausado.');
        if (response.status === 403) throw new Error('El agente no tiene memory.read para el tema y Workspace de esta entrada (HTTP 403).');
        if (response.status === 404) throw new Error('La entrada no existe o no pertenece a esta empresa.');
        if (response.status === 429) throw new Error('MyCompanies limitó las solicitudes (HTTP 429). Vuelve a intentarlo más tarde.');
        if (response.status !== 200 || !isMemoryNode(response.body.memory)) {
            throw new Error('MyCompanies devolvió una entrada de memoria no válida.');
        }
        return response.body;
    }

    async addMemory(entry, currentDirectory = process.cwd()) {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('La entrada de memoria no es válida.');
        validateOptionalPositiveId(entry.topicId, 'tema', true);
        validateOptionalPositiveId(entry.workspaceId, 'Workspace');
        if (!['observation', 'hypothesis', 'decision', 'assertion'].includes(entry.kind)) throw new Error('El tipo de conocimiento no es válido.');
        if (typeof entry.title !== 'string' || entry.title.trim() === '' || entry.title.length > 180
            || typeof entry.content !== 'string' || entry.content.trim() === '' || entry.content.length > 20_000) {
            throw new Error('El título y el contenido son obligatorios y deben respetar sus límites de tamaño.');
        }
        const sourceType = entry.sourceType ?? 'manual';
        if (!['manual', 'url', 'artifact', 'task', 'execution', 'conversation', 'other'].includes(sourceType)) {
            throw new Error('El tipo de procedencia no es válido.');
        }
        if (entry.sourceReference !== undefined && entry.sourceReference !== null
            && (typeof entry.sourceReference !== 'string' || entry.sourceReference.length > 2048)) {
            throw new Error('La referencia de procedencia no es válida.');
        }
        if (sourceType === 'url') {
            let sourceUrl;
            try {
                sourceUrl = new URL(entry.sourceReference);
            } catch {
                throw new Error('La procedencia URL requiere una dirección HTTP o HTTPS válida.');
            }
            if (!['http:', 'https:'].includes(sourceUrl.protocol)) throw new Error('La procedencia URL requiere una dirección HTTP o HTTPS válida.');
        }

        const payload = {
            memory_topic_id: entry.topicId,
            kind: entry.kind,
            title: entry.title.trim(),
            content: entry.content,
            source_type: sourceType,
        };
        if (entry.workspaceId !== undefined) payload.workspace_id = entry.workspaceId;
        if (entry.sourceReference !== undefined && entry.sourceReference !== null) payload.source_reference = entry.sourceReference;

        const configuration = await this.configStore.loadAgentForDirectory(currentDirectory);
        const serverUrl = normalizeServerUrl(configuration.server_url, configuration.allow_insecure_localhost);
        const response = await this.postJson(`${serverUrl}/api/v1/agent/memory`, payload, configuration.api_token);
        if (response.status === 401) throw new Error('La credencial Agent fue rechazada (HTTP 401). Comprueba si fue revocada o si el perfil está pausado.');
        if (response.status === 403) throw new Error('El agente no tiene memory.write para ese ámbito de empresa, Workspace o tema (HTTP 403).');
        if (response.status === 422) throw new Error('MyCompanies rechazó la entrada. Comprueba tema, Workspace, tipo y referencia (HTTP 422).');
        if (response.status === 429) throw new Error('MyCompanies limitó las solicitudes (HTTP 429). Vuelve a intentarlo más tarde.');
        if (response.status !== 201 || !isMemoryNode(response.body.memory)) {
            throw new Error('MyCompanies devolvió una confirmación de escritura de memoria no válida.');
        }
        return response.body;
    }

    async listTasks(currentDirectory = process.cwd(), afterId = null, status = null) {
        if (afterId !== null && (!Number.isSafeInteger(afterId) || afterId < 1)) {
            throw new Error('El cursor de tareas debe ser un entero positivo.');
        }
        if (status !== null && !['open', 'in_progress', 'blocked'].includes(status)) {
            throw new Error('El estado de tareas no es válido.');
        }
        const configuration = await this.configStore.loadAgentForDirectory(currentDirectory);
        const serverUrl = normalizeServerUrl(configuration.server_url, configuration.allow_insecure_localhost);
        const query = new URLSearchParams();
        if (afterId !== null) query.set('after_id', String(afterId));
        if (status !== null) query.set('status', status);
        const queryString = query.size === 0 ? '' : `?${query.toString()}`;
        const response = await this.getJson(`${serverUrl}/api/v1/agent/tasks${queryString}`, configuration.api_token);
        if (response.status === 401) {
            throw new Error('La credencial Agent fue rechazada (HTTP 401). Comprueba si fue revocada o si el perfil está pausado.');
        }
        if (response.status === 403) {
            throw new Error('El agente no tiene un permiso de lectura de tareas para su ámbito (HTTP 403).');
        }
        if (response.status === 429) {
            throw new Error('MyCompanies limitó las solicitudes (HTTP 429). Vuelve a intentarlo más tarde.');
        }
        if (response.status !== 200
            || !Array.isArray(response.body.tasks)
            || response.body.tasks.length > 100
            || typeof response.body.has_more !== 'boolean'
            || response.body.tasks.some((task) => !isAgentTask(task))
            || (response.body.has_more
                ? !Number.isInteger(response.body.next_after)
                    || response.body.next_after < 1
                    || response.body.tasks.at(-1)?.id !== response.body.next_after
                : response.body.next_after !== null)) {
            throw new Error('MyCompanies devolvió una lista de tareas Agent no válida.');
        }
        return response.body;
    }

    async getTask(taskId, currentDirectory = process.cwd()) {
        if (!Number.isSafeInteger(taskId) || taskId < 1) {
            throw new Error('El ID de tarea debe ser un entero positivo.');
        }
        const configuration = await this.configStore.loadAgentForDirectory(currentDirectory);
        const serverUrl = normalizeServerUrl(configuration.server_url, configuration.allow_insecure_localhost);
        const response = await this.getJson(`${serverUrl}/api/v1/agent/tasks/${taskId}`, configuration.api_token);
        if (response.status === 401) {
            throw new Error('La credencial Agent fue rechazada (HTTP 401). Comprueba si fue revocada o si el perfil está pausado.');
        }
        if (response.status === 403) {
            throw new Error('El agente no tiene un permiso de lectura de tareas para su ámbito (HTTP 403).');
        }
        if (response.status === 404) {
            throw new Error('La tarea no existe o no está disponible para el ámbito de este agente.');
        }
        if (response.status === 429) {
            throw new Error('MyCompanies limitó las solicitudes (HTTP 429). Vuelve a intentarlo más tarde.');
        }
        if (response.status !== 200 || !isAgentTask(response.body.task, true)) {
            throw new Error('MyCompanies devolvió un detalle de tarea Agent no válido.');
        }
        return response.body.task;
    }

    async listOffers(currentDirectory = process.cwd(), afterId = null) {
        if (afterId !== null && (!Number.isSafeInteger(afterId) || afterId < 1)) {
            throw new Error('El cursor de ofertas debe ser un entero positivo.');
        }
        const configuration = await this.configStore.loadAgentForDirectory(currentDirectory);
        const serverUrl = normalizeServerUrl(configuration.server_url, configuration.allow_insecure_localhost);
        const cursor = afterId === null ? '' : `?after_id=${afterId}`;
        const response = await this.getJson(`${serverUrl}/api/v1/agent/offers${cursor}`, configuration.api_token);
        if (response.status === 401) {
            throw new Error('La credencial Agent fue rechazada (HTTP 401). Comprueba si fue revocada o si el perfil está pausado.');
        }
        if (response.status === 403) {
            throw new Error('El agente no tiene offers.read o offers.manage en su empresa (HTTP 403).');
        }
        if (response.status === 429) {
            throw new Error('MyCompanies limitó las solicitudes (HTTP 429). Vuelve a intentarlo más tarde.');
        }
        if (response.status !== 200
            || !Array.isArray(response.body.offers)
            || response.body.offers.length > 100
            || typeof response.body.has_more !== 'boolean'
            || response.body.offers.some((offer) => !isAgentOfferSummary(offer))
            || (response.body.has_more
                ? !Number.isInteger(response.body.next_after)
                    || response.body.next_after < 1
                    || response.body.offers.at(-1)?.id !== response.body.next_after
                : response.body.next_after !== null)) {
            throw new Error('MyCompanies devolvió una lista de ofertas Agent no válida.');
        }
        return response.body;
    }

    async listGoals(currentDirectory = process.cwd(), afterId = null) {
        if (afterId !== null && (!Number.isSafeInteger(afterId) || afterId < 1)) {
            throw new Error('El cursor de objetivos debe ser un entero positivo.');
        }
        const configuration = await this.configStore.loadAgentForDirectory(currentDirectory);
        const serverUrl = normalizeServerUrl(configuration.server_url, configuration.allow_insecure_localhost);
        const cursor = afterId === null ? '' : `?after_id=${afterId}`;
        const response = await this.getJson(`${serverUrl}/api/v1/agent/goals${cursor}`, configuration.api_token);
        if (response.status === 401) {
            throw new Error('La credencial Agent fue rechazada (HTTP 401). Comprueba si fue revocada o si el perfil está pausado.');
        }
        if (response.status === 403) {
            throw new Error('El agente no tiene goals.read o goals.manage en su empresa (HTTP 403).');
        }
        if (response.status === 429) {
            throw new Error('MyCompanies limitó las solicitudes (HTTP 429). Vuelve a intentarlo más tarde.');
        }
        if (response.status !== 200
            || !Array.isArray(response.body.goals)
            || response.body.goals.length > 100
            || typeof response.body.has_more !== 'boolean'
            || response.body.goals.some((goal) => !isAgentGoalSummary(goal))
            || (response.body.has_more
                ? !Number.isInteger(response.body.next_after)
                    || response.body.next_after < 1
                    || response.body.goals.at(-1)?.id !== response.body.next_after
                : response.body.next_after !== null)) {
            throw new Error('MyCompanies devolvió una lista de objetivos Agent no válida.');
        }
        return response.body;
    }

    async getGoal(goalId, currentDirectory = process.cwd()) {
        if (!Number.isSafeInteger(goalId) || goalId < 1) {
            throw new Error('El ID de objetivo debe ser un entero positivo.');
        }
        const configuration = await this.configStore.loadAgentForDirectory(currentDirectory);
        const serverUrl = normalizeServerUrl(configuration.server_url, configuration.allow_insecure_localhost);
        const response = await this.getJson(`${serverUrl}/api/v1/agent/goals/${goalId}`, configuration.api_token);
        if (response.status === 401) {
            throw new Error('La credencial Agent fue rechazada (HTTP 401). Comprueba si fue revocada o si el perfil está pausado.');
        }
        if (response.status === 403) {
            throw new Error('El agente no tiene goals.read o goals.manage en su empresa (HTTP 403).');
        }
        if (response.status === 404) {
            throw new Error('El objetivo no existe o no pertenece a la empresa de este agente.');
        }
        if (response.status === 429) {
            throw new Error('MyCompanies limitó las solicitudes (HTTP 429). Vuelve a intentarlo más tarde.');
        }
        if (response.status !== 200 || !isAgentGoal(response.body.goal)) {
            throw new Error('MyCompanies devolvió un detalle de objetivo Agent no válido.');
        }
        return response.body.goal;
    }

    async listAssets(currentDirectory = process.cwd(), afterId = null) {
        if (afterId !== null && (!Number.isSafeInteger(afterId) || afterId < 1)) {
            throw new Error('El cursor de activos debe ser un entero positivo.');
        }
        const configuration = await this.configStore.loadAgentForDirectory(currentDirectory);
        const serverUrl = normalizeServerUrl(configuration.server_url, configuration.allow_insecure_localhost);
        const cursor = afterId === null ? '' : `?after_id=${afterId}`;
        const response = await this.getJson(`${serverUrl}/api/v1/agent/assets${cursor}`, configuration.api_token);
        if (response.status === 401) {
            throw new Error('La credencial Agent fue rechazada (HTTP 401). Comprueba si fue revocada o si el perfil está pausado.');
        }
        if (response.status === 403) {
            throw new Error('El agente no tiene assets.read o assets.manage en su empresa (HTTP 403).');
        }
        if (response.status === 429) {
            throw new Error('MyCompanies limitó las solicitudes (HTTP 429). Vuelve a intentarlo más tarde.');
        }
        if (response.status !== 200
            || !Array.isArray(response.body.assets)
            || response.body.assets.length > 100
            || typeof response.body.has_more !== 'boolean'
            || response.body.assets.some((asset) => !isAgentAssetSummary(asset))
            || (response.body.has_more
                ? !Number.isInteger(response.body.next_after)
                    || response.body.next_after < 1
                    || response.body.assets.at(-1)?.id !== response.body.next_after
                : response.body.next_after !== null)) {
            throw new Error('MyCompanies devolvió una lista de activos Agent no válida.');
        }
        return response.body;
    }

    async getAsset(assetId, currentDirectory = process.cwd()) {
        if (!Number.isSafeInteger(assetId) || assetId < 1) {
            throw new Error('El ID de activo debe ser un entero positivo.');
        }
        const configuration = await this.configStore.loadAgentForDirectory(currentDirectory);
        const serverUrl = normalizeServerUrl(configuration.server_url, configuration.allow_insecure_localhost);
        const response = await this.getJson(`${serverUrl}/api/v1/agent/assets/${assetId}`, configuration.api_token);
        if (response.status === 401) {
            throw new Error('La credencial Agent fue rechazada (HTTP 401). Comprueba si fue revocada o si el perfil está pausado.');
        }
        if (response.status === 403) {
            throw new Error('El agente no tiene assets.read o assets.manage en su empresa (HTTP 403).');
        }
        if (response.status === 404) {
            throw new Error('El activo no existe o no pertenece a la empresa de este agente.');
        }
        if (response.status === 429) {
            throw new Error('MyCompanies limitó las solicitudes (HTTP 429). Vuelve a intentarlo más tarde.');
        }
        if (response.status !== 200 || !isAgentAsset(response.body.asset)) {
            throw new Error('MyCompanies devolvió un detalle de activo Agent no válido.');
        }
        return response.body.asset;
    }

    async listWorkspaces(currentDirectory = process.cwd(), afterId = null) {
        if (afterId !== null && (!Number.isSafeInteger(afterId) || afterId < 1)) {
            throw new Error('El cursor de Workspaces debe ser un entero positivo.');
        }
        const configuration = await this.configStore.loadAgentForDirectory(currentDirectory);
        const serverUrl = normalizeServerUrl(configuration.server_url, configuration.allow_insecure_localhost);
        const cursor = afterId === null ? '' : `?after_id=${afterId}`;
        const response = await this.getJson(`${serverUrl}/api/v1/agent/workspaces${cursor}`, configuration.api_token);
        if (response.status === 401) {
            throw new Error('La credencial Agent fue rechazada (HTTP 401). Comprueba si fue revocada o si el perfil está pausado.');
        }
        if (response.status === 403) {
            throw new Error('El agente no tiene workspaces.read o workspaces.manage en su empresa (HTTP 403).');
        }
        if (response.status === 429) {
            throw new Error('MyCompanies limitó las solicitudes (HTTP 429). Vuelve a intentarlo más tarde.');
        }
        if (response.status !== 200
            || !Array.isArray(response.body.workspaces)
            || response.body.workspaces.length > 100
            || typeof response.body.has_more !== 'boolean'
            || response.body.workspaces.some((workspace) => !isAgentWorkspaceSummary(workspace))
            || (response.body.has_more
                ? !Number.isInteger(response.body.next_after)
                    || response.body.next_after < 1
                    || response.body.workspaces.at(-1)?.id !== response.body.next_after
                : response.body.next_after !== null)) {
            throw new Error('MyCompanies devolvió una lista de Workspaces Agent no válida.');
        }
        return response.body;
    }

    async getWorkspace(workspaceId, currentDirectory = process.cwd()) {
        if (!Number.isSafeInteger(workspaceId) || workspaceId < 1) {
            throw new Error('El ID de Workspace debe ser un entero positivo.');
        }
        const configuration = await this.configStore.loadAgentForDirectory(currentDirectory);
        const serverUrl = normalizeServerUrl(configuration.server_url, configuration.allow_insecure_localhost);
        const response = await this.getJson(`${serverUrl}/api/v1/agent/workspaces/${workspaceId}`, configuration.api_token);
        if (response.status === 401) {
            throw new Error('La credencial Agent fue rechazada (HTTP 401). Comprueba si fue revocada o si el perfil está pausado.');
        }
        if (response.status === 403) {
            throw new Error('El agente no tiene workspaces.read o workspaces.manage en su empresa (HTTP 403).');
        }
        if (response.status === 404) {
            throw new Error('El Workspace no existe o no pertenece a la empresa de este agente.');
        }
        if (response.status === 429) {
            throw new Error('MyCompanies limitó las solicitudes (HTTP 429). Vuelve a intentarlo más tarde.');
        }
        if (response.status !== 200 || !isAgentWorkspace(response.body.workspace)) {
            throw new Error('MyCompanies devolvió un detalle de Workspace Agent no válido.');
        }
        return response.body.workspace;
    }

    async listAgents(currentDirectory = process.cwd(), afterId = null) {
        if (afterId !== null && (!Number.isSafeInteger(afterId) || afterId < 1)) {
            throw new Error('El cursor de agentes debe ser un entero positivo.');
        }
        const configuration = await this.configStore.loadAgentForDirectory(currentDirectory);
        const serverUrl = normalizeServerUrl(configuration.server_url, configuration.allow_insecure_localhost);
        const cursor = afterId === null ? '' : `?after_id=${afterId}`;
        const response = await this.getJson(`${serverUrl}/api/v1/agent/agents${cursor}`, configuration.api_token);
        if (response.status === 401) {
            throw new Error('La credencial Agent fue rechazada (HTTP 401). Comprueba si fue revocada o si el perfil está pausado.');
        }
        if (response.status === 403) {
            throw new Error('El agente necesita agents.permissions.manage para consultar sus reportes directos (HTTP 403).');
        }
        if (response.status === 429) {
            throw new Error('MyCompanies limitó las solicitudes (HTTP 429). Vuelve a intentarlo más tarde.');
        }
        if (response.status !== 200
            || !Array.isArray(response.body.agents)
            || response.body.agents.length > 100
            || typeof response.body.has_more !== 'boolean'
            || response.body.agents.some((agent) => !isAgentDirectReport(agent))
            || (response.body.has_more
                ? !Number.isInteger(response.body.next_after)
                    || response.body.next_after < 1
                    || response.body.agents.at(-1)?.id !== response.body.next_after
                : response.body.next_after !== null)) {
            throw new Error('MyCompanies devolvió una lista de reportes directos Agent no válida.');
        }
        return response.body;
    }

    async listAgentPermissions(currentDirectory = process.cwd()) {
        const configuration = await this.configStore.loadAgentForDirectory(currentDirectory);
        const serverUrl = normalizeServerUrl(configuration.server_url, configuration.allow_insecure_localhost);
        const response = await this.getJson(`${serverUrl}/api/v1/agent/permissions`, configuration.api_token);
        if (response.status === 401) {
            throw new Error('La credencial Agent fue rechazada (HTTP 401). Comprueba si fue revocada o si el perfil está pausado.');
        }
        if (response.status === 429) {
            throw new Error('MyCompanies limitó las solicitudes (HTTP 429). Vuelve a intentarlo más tarde.');
        }
        if (response.status !== 200
            || !Array.isArray(response.body.permissions)
            || response.body.permissions.length > 100
            || response.body.permissions.some((permission) => permission === null
                || typeof permission !== 'object'
                || typeof permission.name !== 'string'
                || !/^[a-z]+(?:\.[a-z]+)+$/.test(permission.name)
                || typeof permission.label !== 'string'
                || typeof permission.workspace_scope !== 'boolean')) {
            throw new Error('MyCompanies devolvió un catálogo de permisos Agent no válido.');
        }

        return response.body;
    }

    async updateAgentStatus(agentId, status, currentDirectory = process.cwd()) {
        if (!Number.isSafeInteger(agentId) || agentId < 1) throw new Error('El ID de agente debe ser un entero positivo.');
        if (!['active', 'paused'].includes(status)) throw new Error('El estado de agente no es válido.');
        const configuration = await this.configStore.loadAgentForDirectory(currentDirectory);
        const serverUrl = normalizeServerUrl(configuration.server_url, configuration.allow_insecure_localhost);
        const response = await this.patchJson(
            `${serverUrl}/api/v1/agent/agents/${agentId}/status`,
            { status },
            configuration.api_token,
        );
        if (response.status === 401) {
            throw new Error('La credencial Agent fue rechazada (HTTP 401). Comprueba si fue revocada o si el perfil está pausado.');
        }
        if (response.status === 403) {
            throw new Error('El agente necesita agents.manage para cambiar el estado de reportes directos (HTTP 403).');
        }
        if (response.status === 404) {
            throw new Error('El destino no es un reporte directo de esta empresa (HTTP 404).');
        }
        if (response.status === 422) {
            throw new Error('MyCompanies rechazó el estado solicitado (HTTP 422).');
        }
        if (response.status === 429) {
            throw new Error('MyCompanies limitó las solicitudes (HTTP 429). Vuelve a intentarlo más tarde.');
        }
        const agent = response.body.agent;
        if (response.status !== 200
            || !Number.isSafeInteger(agent?.id)
            || agent.id !== agentId
            || typeof agent.name !== 'string'
            || agent.status !== status
            || typeof response.body.changed !== 'boolean'
            || !Number.isSafeInteger(response.body.revoked_descendants)
            || response.body.revoked_descendants < 0) {
            throw new Error('MyCompanies devolvió una respuesta de estado de agente no válida.');
        }

        return response.body;
    }

    async updateAgentProfile(agentId, changes, currentDirectory = process.cwd()) {
        if (!Number.isSafeInteger(agentId) || agentId < 1) throw new Error('El ID de agente debe ser un entero positivo.');
        if (changes === null || typeof changes !== 'object' || Array.isArray(changes)) {
            throw new Error('Indica el rol o las instrucciones que quieres cambiar.');
        }
        const allowedFields = new Set(['role', 'instructions']);
        if (Object.keys(changes).length === 0 || Object.keys(changes).some((field) => !allowedFields.has(field))) {
            throw new Error('Solo se pueden editar role e instructions y debes indicar al menos uno.');
        }
        if (Object.hasOwn(changes, 'role') && changes.role !== null
            && (typeof changes.role !== 'string' || changes.role.trim() === '' || changes.role.length > 120)) {
            throw new Error('El rol debe ser texto no vacío de hasta 120 caracteres o null.');
        }
        if (Object.hasOwn(changes, 'instructions') && changes.instructions !== null
            && (typeof changes.instructions !== 'string' || changes.instructions.trim() === '' || changes.instructions.length > 10000)) {
            throw new Error('Las instrucciones deben ser texto no vacío de hasta 10.000 caracteres o null.');
        }

        const configuration = await this.configStore.loadAgentForDirectory(currentDirectory);
        const serverUrl = normalizeServerUrl(configuration.server_url, configuration.allow_insecure_localhost);
        const response = await this.patchJson(
            `${serverUrl}/api/v1/agent/agents/${agentId}`,
            changes,
            configuration.api_token,
        );
        if (response.status === 401) {
            throw new Error('La credencial Agent fue rechazada (HTTP 401). Comprueba si fue revocada o si el perfil está pausado.');
        }
        if (response.status === 403) {
            throw new Error('El agente necesita agents.manage para editar perfiles de reportes directos (HTTP 403).');
        }
        if (response.status === 404) {
            throw new Error('El destino no es un reporte directo de esta empresa (HTTP 404).');
        }
        if (response.status === 422) {
            throw new Error('MyCompanies rechazó la edición del perfil (HTTP 422).');
        }
        if (response.status === 429) {
            throw new Error('MyCompanies limitó las solicitudes (HTTP 429). Vuelve a intentarlo más tarde.');
        }
        const agent = response.body.agent;
        if (response.status !== 200
            || !Number.isSafeInteger(agent?.id)
            || agent.id !== agentId
            || typeof agent.name !== 'string'
            || !(agent.role === null || typeof agent.role === 'string')
            || Object.hasOwn(agent, 'instructions')
            || !Array.isArray(response.body.changed_fields)
            || response.body.changed_fields.some((field) => !['role', 'instructions'].includes(field))
            || typeof response.body.changed !== 'boolean'
            || response.body.changed !== (response.body.changed_fields.length > 0)) {
            throw new Error('MyCompanies devolvió una respuesta de edición de perfil no válida.');
        }

        return response.body;
    }

    async createAgent(agentData, currentDirectory = process.cwd()) {
        if (agentData === null || typeof agentData !== 'object' || Array.isArray(agentData)) {
            throw new Error('Indica un nombre para el nuevo agente.');
        }
        const allowedFields = new Set(['name', 'role', 'instructions']);
        if (Object.keys(agentData).some((field) => !allowedFields.has(field))) {
            throw new Error('La creación solo permite nombre, rol e instrucciones.');
        }
        if (typeof agentData.name !== 'string' || agentData.name.trim() === '' || agentData.name.length > 120
            || (agentData.role !== undefined && agentData.role !== null && (typeof agentData.role !== 'string' || agentData.role.length > 120))
            || (agentData.instructions !== undefined && agentData.instructions !== null
                && (typeof agentData.instructions !== 'string' || agentData.instructions.length > 10000))) {
            throw new Error('Los datos del perfil de agente no son válidos.');
        }
        const payload = {
            name: agentData.name,
            role: agentData.role ?? null,
            instructions: agentData.instructions ?? null,
        };
        const configuration = await this.configStore.loadAgentForDirectory(currentDirectory);
        const serverUrl = normalizeServerUrl(configuration.server_url, configuration.allow_insecure_localhost);
        const response = await this.postJson(`${serverUrl}/api/v1/agent/agents`, payload, configuration.api_token);
        if (response.status === 401) {
            throw new Error('La credencial Agent fue rechazada (HTTP 401). Comprueba si fue revocada o si el perfil está pausado.');
        }
        if (response.status === 403) {
            throw new Error('El agente necesita agents.manage para crear perfiles directos (HTTP 403).');
        }
        if (response.status === 422) {
            throw new Error('MyCompanies rechazó el perfil. Revisa el nombre y confirma que no exista otro igual en la empresa (HTTP 422).');
        }
        if (response.status === 429) {
            throw new Error('MyCompanies limitó las solicitudes (HTTP 429). Vuelve a intentarlo más tarde.');
        }
        const agent = response.body.agent;
        if (response.status !== 201
            || !Number.isSafeInteger(agent?.id)
            || agent.id < 1
            || typeof agent.uuid !== 'string'
            || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(agent.uuid)
            || agent.name !== payload.name
            || agent.role !== payload.role
            || agent.status !== 'active'
            || agent.reports_to_agent_id !== configuration.agent_id
            || !Array.isArray(agent.permissions)
            || agent.permissions.length !== 0) {
            throw new Error('MyCompanies devolvió una respuesta de creación de perfil Agent no válida.');
        }
        return agent;
    }

    async grantAgentPermission(agentId, permission, workspaceId = null, currentDirectory = process.cwd()) {
        if (!Number.isSafeInteger(agentId) || agentId < 1) throw new Error('El ID de agente debe ser un entero positivo.');
        if (typeof permission !== 'string' || !/^[a-z]+(?:\.[a-z]+)+$/.test(permission)) {
            throw new Error('El permiso solicitado no es válido.');
        }
        if (workspaceId !== null && (!Number.isSafeInteger(workspaceId) || workspaceId < 1)) {
            throw new Error('El ID de Workspace debe ser un entero positivo.');
        }
        const configuration = await this.configStore.loadAgentForDirectory(currentDirectory);
        const serverUrl = normalizeServerUrl(configuration.server_url, configuration.allow_insecure_localhost);
        const response = await this.postJson(
            `${serverUrl}/api/v1/agent/agents/${agentId}/permissions`,
            { permission, workspace_id: workspaceId },
            configuration.api_token,
        );
        if (response.status === 401) {
            throw new Error('La credencial Agent fue rechazada (HTTP 401). Comprueba si fue revocada o si el perfil está pausado.');
        }
        if (response.status === 403) {
            throw new Error('El agente no puede delegar este permiso o no lo posee para el alcance solicitado (HTTP 403).');
        }
        if (response.status === 404) {
            throw new Error('El destino no es un reporte directo activo o el Workspace no existe en esta empresa (HTTP 404).');
        }
        if (response.status === 422) {
            throw new Error('MyCompanies rechazó la concesión. Comprueba el permiso, el Workspace y si ya está concedido (HTTP 422).');
        }
        if (response.status === 429) {
            throw new Error('MyCompanies limitó las solicitudes (HTTP 429). Vuelve a intentarlo más tarde.');
        }
        const grant = response.body.grant;
        if (response.status !== 201
            || !Number.isSafeInteger(grant?.id)
            || grant.id < 1
            || grant.permission !== permission
            || typeof grant.scope !== 'string'
            || typeof grant.granted_by !== 'string') {
            throw new Error('MyCompanies devolvió una respuesta de concesión Agent no válida.');
        }
        return grant;
    }

    async revokeAgentPermission(agentId, grantId, currentDirectory = process.cwd()) {
        if (!Number.isSafeInteger(agentId) || agentId < 1) throw new Error('El ID de agente debe ser un entero positivo.');
        if (!Number.isSafeInteger(grantId) || grantId < 1) throw new Error('El ID de permiso debe ser un entero positivo.');
        const configuration = await this.configStore.loadAgentForDirectory(currentDirectory);
        const serverUrl = normalizeServerUrl(configuration.server_url, configuration.allow_insecure_localhost);
        const response = await this.deleteJson(
            `${serverUrl}/api/v1/agent/agents/${agentId}/permissions/${grantId}`,
            configuration.api_token,
        );
        if (response.status === 401) {
            throw new Error('La credencial Agent fue rechazada (HTTP 401). Comprueba si fue revocada o si el perfil está pausado.');
        }
        if (response.status === 403) {
            throw new Error('El agente no puede revocar este permiso o no posee el permiso de origen (HTTP 403).');
        }
        if (response.status === 404) {
            throw new Error('El permiso no existe o no pertenece a un reporte directo de esta empresa (HTTP 404).');
        }
        if (response.status === 409) {
            throw new Error('MyCompanies no reconoce el permiso que se intenta revocar (HTTP 409).');
        }
        if (response.status === 429) {
            throw new Error('MyCompanies limitó las solicitudes (HTTP 429). Vuelve a intentarlo más tarde.');
        }
        if (response.status !== 200 || !Number.isSafeInteger(response.body.revoked_count) || response.body.revoked_count < 1) {
            throw new Error('MyCompanies devolvió una respuesta de revocación Agent no válida.');
        }
        return response.body;
    }

    async getOffer(offerId, currentDirectory = process.cwd()) {
        if (!Number.isSafeInteger(offerId) || offerId < 1) {
            throw new Error('El ID de oferta debe ser un entero positivo.');
        }
        const configuration = await this.configStore.loadAgentForDirectory(currentDirectory);
        const serverUrl = normalizeServerUrl(configuration.server_url, configuration.allow_insecure_localhost);
        const response = await this.getJson(`${serverUrl}/api/v1/agent/offers/${offerId}`, configuration.api_token);
        if (response.status === 401) {
            throw new Error('La credencial Agent fue rechazada (HTTP 401). Comprueba si fue revocada o si el perfil está pausado.');
        }
        if (response.status === 403) {
            throw new Error('El agente no tiene offers.read o offers.manage en su empresa (HTTP 403).');
        }
        if (response.status === 404) {
            throw new Error('La oferta no existe o no pertenece a la empresa de este agente.');
        }
        if (response.status === 429) {
            throw new Error('MyCompanies limitó las solicitudes (HTTP 429). Vuelve a intentarlo más tarde.');
        }
        if (response.status !== 200 || !isAgentOffer(response.body.offer)) {
            throw new Error('MyCompanies devolvió un detalle de oferta Agent no válido.');
        }
        return response.body.offer;
    }

    async updateOfferStatus(offerId, status, currentDirectory = process.cwd()) {
        if (!Number.isSafeInteger(offerId) || offerId < 1) {
            throw new Error('El ID de oferta debe ser un entero positivo.');
        }
        if (!['preparing', 'available', 'withdrawn'].includes(status)) {
            throw new Error('El estado de oferta no es válido.');
        }
        const configuration = await this.configStore.loadAgentForDirectory(currentDirectory);
        const serverUrl = normalizeServerUrl(configuration.server_url, configuration.allow_insecure_localhost);
        const response = await this.patchJson(
            `${serverUrl}/api/v1/agent/offers/${offerId}/status`,
            { status },
            configuration.api_token,
        );
        if (response.status === 401) {
            throw new Error('La credencial Agent fue rechazada (HTTP 401). Comprueba si fue revocada o si el perfil está pausado.');
        }
        if (response.status === 403) {
            throw new Error('El agente necesita offers.manage para cambiar el estado (HTTP 403).');
        }
        if (response.status === 404) {
            throw new Error('La oferta no existe o no pertenece a la empresa de este agente.');
        }
        if (response.status === 422) {
            throw new Error('MyCompanies rechazó el estado solicitado (HTTP 422).');
        }
        if (response.status === 429) {
            throw new Error('MyCompanies limitó las solicitudes (HTTP 429). Vuelve a intentarlo más tarde.');
        }
        const offer = response.body.offer;
        if (response.status !== 200
            || offer?.id !== offerId
            || offer.status !== status
            || typeof offer.changed !== 'boolean'
            || (offer.changed
                ? offer.changed_by?.type !== 'agent'
                    || !Number.isInteger(offer.changed_by.id)
                    || typeof offer.changed_by.name !== 'string'
                : offer.changed_by !== null)) {
            throw new Error('MyCompanies devolvió una respuesta de cambio de estado de oferta no válida.');
        }
        return offer;
    }

    async listBets(currentDirectory = process.cwd(), afterId = null) {
        if (afterId !== null && (!Number.isSafeInteger(afterId) || afterId < 1)) {
            throw new Error('El cursor de apuestas debe ser un entero positivo.');
        }
        const configuration = await this.configStore.loadAgentForDirectory(currentDirectory);
        const serverUrl = normalizeServerUrl(configuration.server_url, configuration.allow_insecure_localhost);
        const cursor = afterId === null ? '' : `?after_id=${afterId}`;
        const response = await this.getJson(`${serverUrl}/api/v1/agent/bets${cursor}`, configuration.api_token);
        if (response.status === 401) {
            throw new Error('La credencial Agent fue rechazada (HTTP 401). Comprueba si fue revocada o si el perfil está pausado.');
        }
        if (response.status === 403) {
            throw new Error('El agente no tiene bets.read o bets.manage en su empresa (HTTP 403).');
        }
        if (response.status === 429) {
            throw new Error('MyCompanies limitó las solicitudes (HTTP 429). Vuelve a intentarlo más tarde.');
        }
        if (response.status !== 200
            || !Array.isArray(response.body.bets)
            || response.body.bets.length > 100
            || typeof response.body.has_more !== 'boolean'
            || response.body.bets.some((bet) => !isAgentBetSummary(bet))
            || (response.body.has_more
                ? !Number.isInteger(response.body.next_after)
                    || response.body.next_after < 1
                    || response.body.bets.at(-1)?.id !== response.body.next_after
                : response.body.next_after !== null)) {
            throw new Error('MyCompanies devolvió una lista de apuestas Agent no válida.');
        }
        return response.body;
    }

    async getBet(betId, currentDirectory = process.cwd()) {
        if (!Number.isSafeInteger(betId) || betId < 1) {
            throw new Error('El ID de apuesta debe ser un entero positivo.');
        }
        const configuration = await this.configStore.loadAgentForDirectory(currentDirectory);
        const serverUrl = normalizeServerUrl(configuration.server_url, configuration.allow_insecure_localhost);
        const response = await this.getJson(`${serverUrl}/api/v1/agent/bets/${betId}`, configuration.api_token);
        if (response.status === 401) {
            throw new Error('La credencial Agent fue rechazada (HTTP 401). Comprueba si fue revocada o si el perfil está pausado.');
        }
        if (response.status === 403) {
            throw new Error('El agente no tiene bets.read o bets.manage en su empresa (HTTP 403).');
        }
        if (response.status === 404) {
            throw new Error('La apuesta no existe o no está disponible para la empresa de este agente.');
        }
        if (response.status === 429) {
            throw new Error('MyCompanies limitó las solicitudes (HTTP 429). Vuelve a intentarlo más tarde.');
        }
        if (response.status !== 200 || !isAgentBet(response.body.bet)) {
            throw new Error('MyCompanies devolvió un detalle de apuesta Agent no válido.');
        }
        return response.body.bet;
    }

    async addBetEvidence(betId, evidenceData, currentDirectory = process.cwd()) {
        if (!Number.isSafeInteger(betId) || betId < 1) {
            throw new Error('El ID de apuesta debe ser un entero positivo.');
        }
        if (!isBetEvidenceInput(evidenceData)) {
            throw new Error('La evidencia requiere título, detalles y una valoración válida; la fuente debe usar HTTP o HTTPS.');
        }
        const configuration = await this.configStore.loadAgentForDirectory(currentDirectory);
        const serverUrl = normalizeServerUrl(configuration.server_url, configuration.allow_insecure_localhost);
        const response = await this.postJson(`${serverUrl}/api/v1/agent/bets/${betId}/evidences`, evidenceData, configuration.api_token);
        if (response.status === 401) {
            throw new Error('La credencial Agent fue rechazada (HTTP 401). Comprueba si fue revocada o si el perfil está pausado.');
        }
        if (response.status === 403) {
            throw new Error('El agente necesita bets.manage en su empresa para registrar evidencias (HTTP 403).');
        }
        if (response.status === 404) {
            throw new Error('La apuesta no existe o no pertenece a la empresa de este agente.');
        }
        if (response.status === 409) {
            throw new Error('La apuesta ya está convertida y no puede volver a cambiar de estado.');
        }
        if (response.status === 422) {
            throw new Error('MyCompanies rechazó la evidencia. Revisa el título, los detalles, la valoración y la fuente (HTTP 422).');
        }
        if (response.status === 429) {
            throw new Error('MyCompanies limitó las solicitudes (HTTP 429). Vuelve a intentarlo más tarde.');
        }
        if (response.status !== 201 || !isRecordedAgentEvidence(response.body.evidence)) {
            throw new Error('MyCompanies devolvió una respuesta de evidencia Agent no válida.');
        }
        return response.body.evidence;
    }

    async updateBetStatus(betId, status, currentDirectory = process.cwd()) {
        if (!Number.isSafeInteger(betId) || betId < 1) {
            throw new Error('El ID de apuesta debe ser un entero positivo.');
        }
        if (!['proposed', 'investigating', 'validated', 'discarded', 'archived'].includes(status)) {
            throw new Error('El estado de apuesta no es válido. La conversión se realiza con una operación separada.');
        }
        const configuration = await this.configStore.loadAgentForDirectory(currentDirectory);
        const serverUrl = normalizeServerUrl(configuration.server_url, configuration.allow_insecure_localhost);
        const response = await this.patchJson(
            `${serverUrl}/api/v1/agent/bets/${betId}/status`,
            { status },
            configuration.api_token,
        );
        if (response.status === 401) {
            throw new Error('La credencial Agent fue rechazada (HTTP 401). Comprueba si fue revocada o si el perfil está pausado.');
        }
        if (response.status === 403) {
            throw new Error('El agente necesita bets.status.manage para cambiar el estado (HTTP 403).');
        }
        if (response.status === 404) {
            throw new Error('La apuesta no existe o no pertenece a la empresa de este agente.');
        }
        if (response.status === 409) {
            throw new Error('La apuesta ya está convertida y no puede volver a cambiar de estado.');
        }
        if (response.status === 422) {
            throw new Error('MyCompanies rechazó el estado solicitado (HTTP 422).');
        }
        if (response.status === 429) {
            throw new Error('MyCompanies limitó las solicitudes (HTTP 429). Vuelve a intentarlo más tarde.');
        }
        const bet = response.body.bet;
        if (response.status !== 200
            || bet?.id !== betId
            || bet.status !== status
            || typeof bet.changed !== 'boolean'
            || (bet.changed
                ? bet.changed_by?.type !== 'agent'
                    || !Number.isInteger(bet.changed_by.id)
                    || typeof bet.changed_by.name !== 'string'
                : bet.changed_by !== null)) {
            throw new Error('MyCompanies devolvió una respuesta de cambio de estado de apuesta no válida.');
        }
        return bet;
    }

    async convertBet(betId, type, currentDirectory = process.cwd()) {
        if (!Number.isSafeInteger(betId) || betId < 1) {
            throw new Error('El ID de apuesta debe ser un entero positivo.');
        }
        if (!['product', 'service'].includes(type)) {
            throw new Error('El tipo de oferta debe ser producto o servicio.');
        }
        const configuration = await this.configStore.loadAgentForDirectory(currentDirectory);
        const serverUrl = normalizeServerUrl(configuration.server_url, configuration.allow_insecure_localhost);
        const response = await this.postJson(
            `${serverUrl}/api/v1/agent/bets/${betId}/conversion`,
            { type },
            configuration.api_token,
        );
        if (response.status === 401) {
            throw new Error('La credencial Agent fue rechazada (HTTP 401). Comprueba si fue revocada o si el perfil está pausado.');
        }
        if (response.status === 403) {
            throw new Error('El agente necesita offers.manage para convertir una apuesta (HTTP 403).');
        }
        if (response.status === 404) {
            throw new Error('La apuesta no existe o no pertenece a la empresa de este agente.');
        }
        if (response.status === 409) {
            throw new Error('La apuesta debe estar validada antes de convertirse en oferta (HTTP 409).');
        }
        if (response.status === 422) {
            throw new Error('MyCompanies rechazó el tipo de oferta solicitado (HTTP 422).');
        }
        if (response.status === 429) {
            throw new Error('MyCompanies limitó las solicitudes (HTTP 429). Vuelve a intentarlo más tarde.');
        }
        const offer = response.body.offer;
        if (![200, 201].includes(response.status)
            || !Number.isSafeInteger(offer?.id)
            || offer.bet_id !== betId
            || typeof offer.name !== 'string'
            || !['product', 'service'].includes(offer.type)
            || !['preparing', 'available', 'withdrawn'].includes(offer.status)
            || (offer.created_by !== null
                && (offer.created_by?.type !== 'agent' && offer.created_by?.type !== 'user'
                    || !Number.isSafeInteger(offer.created_by.id)
                    || typeof offer.created_by.name !== 'string'))
            || response.body.bet?.id !== betId
            || response.body.bet.status !== 'converted'
            || typeof response.body.bet.changed !== 'boolean') {
            throw new Error('MyCompanies devolvió una respuesta de conversión de apuesta no válida.');
        }
        return response.body;
    }

    async editTask(taskId, changes, currentDirectory = process.cwd()) {
        if (!Number.isSafeInteger(taskId) || taskId < 1) {
            throw new Error('El ID de tarea debe ser un entero positivo.');
        }
        if (changes === null || typeof changes !== 'object' || Array.isArray(changes)) {
            throw new Error('La edición solo permite campos de detalle.');
        }
        const allowedFields = new Set(['title', 'description', 'priority', 'due_date']);
        const fields = Object.keys(changes);
        if (fields.length === 0 || fields.some((field) => !allowedFields.has(field))) {
            throw new Error('La edición solo permite título, descripción, prioridad y fecha objetivo.');
        }
        if (('title' in changes && (typeof changes.title !== 'string' || changes.title.trim() === '' || changes.title.length > 160))
            || ('description' in changes && changes.description !== null && (typeof changes.description !== 'string' || changes.description.length > 2000))
            || ('priority' in changes && !['low', 'normal', 'high'].includes(changes.priority))
            || ('due_date' in changes && changes.due_date !== null && (typeof changes.due_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(changes.due_date)))) {
            throw new Error('Los campos de detalle de la tarea no son válidos.');
        }
        const configuration = await this.configStore.loadAgentForDirectory(currentDirectory);
        const serverUrl = normalizeServerUrl(configuration.server_url, configuration.allow_insecure_localhost);
        const response = await this.patchJson(`${serverUrl}/api/v1/agent/tasks/${taskId}`, changes, configuration.api_token);
        if (response.status === 401) {
            throw new Error('La credencial Agent fue rechazada (HTTP 401). Comprueba si fue revocada o si el perfil está pausado.');
        }
        if (response.status === 403) {
            throw new Error('El agente no tiene el permiso tasks.manage para este ámbito (HTTP 403).');
        }
        if (response.status === 404) {
            throw new Error('La tarea no existe o no está disponible para el ámbito de este agente.');
        }
        if (response.status === 422) {
            throw new Error('MyCompanies rechazó la edición. Revisa los campos de detalle (HTTP 422).');
        }
        if (response.status === 429) {
            throw new Error('MyCompanies limitó las solicitudes (HTTP 429). Vuelve a intentarlo más tarde.');
        }
        if (response.status !== 200 || response.body.task?.id !== taskId || !isAgentTask(response.body.task, true)) {
            throw new Error('MyCompanies devolvió una respuesta de edición Agent no válida.');
        }
        return response.body.task;
    }

    async assignTask(taskId, assigneeAgentId, currentDirectory = process.cwd()) {
        if (!Number.isSafeInteger(taskId) || taskId < 1) {
            throw new Error('El ID de tarea debe ser un entero positivo.');
        }
        if (assigneeAgentId !== null && (!Number.isSafeInteger(assigneeAgentId) || assigneeAgentId < 1)) {
            throw new Error('El ID del agente responsable debe ser un entero positivo o null.');
        }
        const configuration = await this.configStore.loadAgentForDirectory(currentDirectory);
        const serverUrl = normalizeServerUrl(configuration.server_url, configuration.allow_insecure_localhost);
        const response = await this.patchJson(`${serverUrl}/api/v1/agent/tasks/${taskId}/assignee`, { assignee_agent_id: assigneeAgentId }, configuration.api_token);
        if (response.status === 401) {
            throw new Error('La credencial Agent fue rechazada (HTTP 401). Comprueba si fue revocada o si el perfil está pausado.');
        }
        if (response.status === 403) {
            throw new Error('El agente no tiene el permiso tasks.assign para este ámbito (HTTP 403).');
        }
        if (response.status === 404) {
            throw new Error('La tarea o el agente responsable no existen o están fuera del ámbito disponible.');
        }
        if (response.status === 422) {
            throw new Error('MyCompanies rechazó la asignación. El agente responsable debe tener tasks.read para este ámbito (HTTP 422).');
        }
        if (response.status === 429) {
            throw new Error('MyCompanies limitó las solicitudes (HTTP 429). Vuelve a intentarlo más tarde.');
        }
        const assignee = response.body.task?.assignee;
        if (response.status !== 200
            || response.body.task?.id !== taskId
            || (assignee !== null
                && (assignee?.type !== 'agent' || typeof assignee.name !== 'string'))) {
            throw new Error('MyCompanies devolvió una respuesta de asignación Agent no válida.');
        }
        return response.body.task;
    }

    async updateTaskStatus(taskId, status, currentDirectory = process.cwd()) {
        if (!Number.isSafeInteger(taskId) || taskId < 1) {
            throw new Error('El ID de tarea debe ser un entero positivo.');
        }
        if (!['open', 'in_progress', 'completed', 'blocked', 'cancelled'].includes(status)) {
            throw new Error('El estado no es válido.');
        }
        const configuration = await this.configStore.loadAgentForDirectory(currentDirectory);
        const serverUrl = normalizeServerUrl(configuration.server_url, configuration.allow_insecure_localhost);
        const response = await this.patchJson(`${serverUrl}/api/v1/agent/tasks/${taskId}/status`, { status }, configuration.api_token);
        if (response.status === 401) {
            throw new Error('La credencial Agent fue rechazada (HTTP 401). Comprueba si fue revocada o si el perfil está pausado.');
        }
        if (response.status === 403) {
            throw new Error('El agente no tiene el permiso tasks.manage para cambiar estados (HTTP 403).');
        }
        if (response.status === 404) {
            throw new Error('La tarea no existe o no está disponible para el ámbito de este agente.');
        }
        if (response.status === 429) {
            throw new Error('MyCompanies limitó las solicitudes (HTTP 429). Vuelve a intentarlo más tarde.');
        }
        if (response.status === 422) {
            throw new Error('MyCompanies rechazó el cambio. Revisa dependencias y estado actual de la tarea (HTTP 422).');
        }
        if (response.status !== 200
            || response.body.task?.id !== taskId
            || response.body.task?.status !== status) {
            throw new Error('MyCompanies devolvió una respuesta de cambio de estado Agent no válida.');
        }
        return response.body.task;
    }

    async createTask(taskData, idempotencyKey, currentDirectory = process.cwd()) {
        if (typeof idempotencyKey !== 'string'
            || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(idempotencyKey)) {
            throw new Error('La clave de idempotencia debe ser un UUID válido.');
        }
        if (taskData === null || typeof taskData !== 'object' || typeof taskData.title !== 'string' || taskData.title.trim() === '') {
            throw new Error('El título de la tarea es obligatorio.');
        }
        const payload = {
            title: taskData.title,
            description: taskData.description ?? null,
            priority: taskData.priority ?? 'normal',
            due_date: taskData.due_date ?? null,
            workspace_id: taskData.workspace_id ?? null,
        };
        const configuration = await this.configStore.loadAgentForDirectory(currentDirectory);
        const serverUrl = normalizeServerUrl(configuration.server_url, configuration.allow_insecure_localhost);
        const response = await this.postJson(`${serverUrl}/api/v1/agent/tasks`, payload, configuration.api_token, idempotencyKey);
        if (response.status === 401) {
            throw new Error('La credencial Agent fue rechazada (HTTP 401). Comprueba si fue revocada o si el perfil está pausado.');
        }
        if (response.status === 403) {
            throw new Error('El agente no tiene el permiso tasks.manage para este ámbito (HTTP 403).');
        }
        if (response.status === 404) {
            throw new Error('El workspace no existe o no está disponible para este agente.');
        }
        if (response.status === 409) {
            throw new Error('La clave UUID ya se usó con datos distintos. Usa otra clave para crear una tarea nueva.');
        }
        if (response.status === 422) {
            throw new Error('MyCompanies rechazó la tarea. Revisa los campos y el ámbito del workspace (HTTP 422).');
        }
        if (response.status === 429) {
            throw new Error('MyCompanies limitó las solicitudes (HTTP 429). Vuelve a intentarlo más tarde.');
        }
        if (![200, 201].includes(response.status)
            || !isCreatedAgentTask(response.body.task)
            || typeof response.body.replayed !== 'boolean') {
            throw new Error('MyCompanies devolvió una respuesta de creación Agent no válida.');
        }
        return response.body;
    }

    async postJson(endpoint, payload, apiToken, idempotencyKey = null) {
        let response;
        try {
            response = await this.fetch(endpoint, {
                method: 'POST',
                headers: {
                    Accept: 'application/json',
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${apiToken}`,
                    ...(idempotencyKey === null ? {} : { 'Idempotency-Key': idempotencyKey }),
                },
                body: JSON.stringify(payload),
                redirect: 'manual',
                signal: AbortSignal.timeout(10_000),
            });
        } catch {
            throw new Error('No se pudo conectar con MyCompanies. Comprueba la URL y la red.');
        }
        if (![200, 201, 401, 403, 404, 409, 422, 429].includes(response.status)) {
            throw new Error(`MyCompanies devolvió un error HTTP ${response.status}.`);
        }
        if (![200, 201].includes(response.status)) return { status: response.status, body: {} };
        let responseText;
        try {
            responseText = await readResponseLimited(response, MAX_RESPONSE_BYTES);
        } catch {
            throw new Error('MyCompanies devolvió una respuesta demasiado grande o no válida.');
        }
        try {
            const body = JSON.parse(responseText);
            if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid response shape.');
            return { status: response.status, body };
        } catch {
            throw new Error('MyCompanies devolvió una respuesta JSON no válida.');
        }
    }

    async postMultipart(endpoint, form, apiToken) {
        let response;
        try {
            response = await this.fetch(endpoint, {
                method: 'POST',
                headers: { Accept: 'application/json', Authorization: `Bearer ${apiToken}` },
                body: form,
                redirect: 'manual',
                signal: AbortSignal.timeout(30_000),
            });
        } catch {
            throw new Error('No se pudo conectar con MyCompanies. Comprueba la URL y la red.');
        }
        if (![201, 401, 403, 422, 429].includes(response.status)) {
            throw new Error(`MyCompanies devolvió un error HTTP ${response.status}.`);
        }
        if (response.status !== 201) return { status: response.status, body: {} };
        let responseText;
        try {
            responseText = await readResponseLimited(response, MAX_RESPONSE_BYTES);
        } catch {
            throw new Error('MyCompanies devolvió una respuesta demasiado grande o no válida.');
        }
        try {
            const body = JSON.parse(responseText);
            if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid response shape.');
            return { status: response.status, body };
        } catch {
            throw new Error('MyCompanies devolvió una respuesta JSON no válida.');
        }
    }

    async patchJson(endpoint, payload, apiToken) {
        let response;
        try {
            response = await this.fetch(endpoint, {
                method: 'PATCH',
                headers: {
                    Accept: 'application/json',
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${apiToken}`,
                },
                body: JSON.stringify(payload),
                redirect: 'manual',
                signal: AbortSignal.timeout(10_000),
            });
        } catch {
            throw new Error('No se pudo conectar con MyCompanies. Comprueba la URL y la red.');
        }
        if (![200, 401, 403, 404, 409, 422, 429].includes(response.status)) {
            throw new Error(`MyCompanies devolvió un error HTTP ${response.status}.`);
        }
        if (response.status !== 200) return { status: response.status, body: {} };
        let responseText;
        try {
            responseText = await readResponseLimited(response, MAX_RESPONSE_BYTES);
        } catch {
            throw new Error('MyCompanies devolvió una respuesta demasiado grande o no válida.');
        }
        try {
            const body = JSON.parse(responseText);
            if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid response shape.');
            return { status: response.status, body };
        } catch {
            throw new Error('MyCompanies devolvió una respuesta JSON no válida.');
        }
    }
    async deleteJson(endpoint, apiToken) {
        let response;
        try {
            response = await this.fetch(endpoint, {
                method: 'DELETE',
                headers: { Accept: 'application/json', Authorization: `Bearer ${apiToken}` },
                redirect: 'manual',
                signal: AbortSignal.timeout(10_000),
            });
        } catch {
            throw new Error('No se pudo conectar con MyCompanies. Comprueba la URL y la red.');
        }
        if (![200, 401, 403, 404, 409, 429].includes(response.status)) {
            throw new Error(`MyCompanies devolvió un error HTTP ${response.status}.`);
        }
        if (response.status !== 200) return { status: response.status, body: {} };
        let responseText;
        try {
            responseText = await readResponseLimited(response, MAX_RESPONSE_BYTES);
        } catch {
            throw new Error('MyCompanies devolvió una respuesta demasiado grande o no válida.');
        }
        try {
            const body = JSON.parse(responseText);
            if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid response shape.');
            return { status: response.status, body };
        } catch {
            throw new Error('MyCompanies devolvió una respuesta JSON no válida.');
        }
    }

    async requestIdentity(serverUrl, apiToken) {
        const response = await this.getJson(`${serverUrl}/api/v1/agent/me`, apiToken);
        if (response.status === 401) {
            throw new Error('La credencial Agent fue rechazada (HTTP 401). Comprueba si fue revocada o si el perfil está pausado.');
        }
        const { agent, company, permissions } = response.body;
        if (response.status !== 200
            || agent === null || typeof agent !== 'object'
            || !Number.isInteger(agent.id) || agent.id < 1
            || typeof agent.uuid !== 'string'
            || typeof agent.name !== 'string'
            || !(agent.role === null || typeof agent.role === 'string')
            || company === null || typeof company !== 'object'
            || !Number.isInteger(company.id) || company.id < 1
            || typeof company.name !== 'string'
            || !Array.isArray(permissions)
            || permissions.some((permission) => permission === null
                || typeof permission !== 'object'
                || typeof permission.name !== 'string'
                || !['company', 'workspace'].includes(permission.scope)
                || (permission.workspace_id !== null && !Number.isInteger(permission.workspace_id))
                || (permission.workspace_name !== null && typeof permission.workspace_name !== 'string'))) {
            throw new Error('MyCompanies devolvió una identidad Agent no válida.');
        }
        return response.body;
    }

    async getJson(endpoint, apiToken) {
        let response;
        try {
            response = await this.fetch(endpoint, {
                method: 'GET',
                headers: { Accept: 'application/json', Authorization: `Bearer ${apiToken}` },
                redirect: 'manual',
                signal: AbortSignal.timeout(10_000),
            });
        } catch {
            throw new Error('No se pudo conectar con MyCompanies. Comprueba la URL y la red.');
        }
        if (response.status !== 200) {
            if ([401, 403, 404, 422, 429].includes(response.status)) return { status: response.status, body: {} };
            throw new Error(`MyCompanies devolvió un error HTTP ${response.status}.`);
        }
        let responseText;
        try {
            responseText = await readResponseLimited(response, MAX_RESPONSE_BYTES);
        } catch {
            throw new Error('MyCompanies devolvió una respuesta demasiado grande o no válida.');
        }
        try {
            const body = JSON.parse(responseText);
            if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid response shape.');
            return { status: response.status, body };
        } catch {
            throw new Error('MyCompanies devolvió una respuesta JSON no válida.');
        }
    }

    async getBinary(endpoint, apiToken) {
        let response;
        try {
            response = await this.fetch(endpoint, {
                method: 'GET',
                headers: { Accept: 'application/octet-stream', Authorization: `Bearer ${apiToken}` },
                redirect: 'manual',
                signal: AbortSignal.timeout(30_000),
            });
        } catch {
            throw new Error('No se pudo conectar con MyCompanies. Comprueba la URL y la red.');
        }
        if (response.status !== 200) {
            if ([401, 403, 404, 429].includes(response.status)) return { status: response.status, bytes: Buffer.alloc(0) };
            throw new Error(`MyCompanies devolvió un error HTTP ${response.status}.`);
        }
        try {
            return { status: response.status, bytes: await readResponseBytesLimited(response, MAX_ARTIFACT_BYTES) };
        } catch {
            throw new Error('MyCompanies devolvió un informe demasiado grande o no válido.');
        }
    }
}

function isRunnerTask(task, includeDescription = false) {
    return task !== null
        && typeof task === 'object'
        && Number.isInteger(task.id)
        && task.id > 0
        && typeof task.title === 'string'
        && ['open', 'in_progress', 'blocked'].includes(task.status)
        && ['low', 'normal', 'high'].includes(task.priority)
        && (task.assignee === undefined || task.assignee === null || isRunnerAssignee(task.assignee))
        && (!includeDescription || task.description === null || typeof task.description === 'string')
        && (task.due_date === null || /^\d{4}-\d{2}-\d{2}$/.test(task.due_date))
        && task.workspace !== null
        && typeof task.workspace === 'object'
        && Number.isInteger(task.workspace.id)
        && task.workspace.id > 0
        && typeof task.workspace.name === 'string';
}

function isRunnerAssignee(assignee) {
    return assignee !== null
        && typeof assignee === 'object'
        && ['user', 'agent'].includes(assignee.type)
        && typeof assignee.name === 'string';
}

function isAgentTask(task, includeDescription = false) {
    return task !== null
        && typeof task === 'object'
        && Number.isInteger(task.id)
        && task.id > 0
        && typeof task.title === 'string'
        && ['open', 'in_progress', 'blocked'].includes(task.status)
        && ['low', 'normal', 'high'].includes(task.priority)
        && (!includeDescription || task.description === null || typeof task.description === 'string')
        && (task.assignee === null || isRunnerAssignee(task.assignee))
        && (task.due_date === null || /^\d{4}-\d{2}-\d{2}$/.test(task.due_date))
        && (task.workspace === null
            || (typeof task.workspace === 'object'
                && Number.isInteger(task.workspace.id)
                && task.workspace.id > 0
                && typeof task.workspace.name === 'string'));
}

function isAgentOfferSummary(offer) {
    return offer !== null
        && typeof offer === 'object'
        && Number.isInteger(offer.id)
        && offer.id > 0
        && typeof offer.name === 'string'
        && ['product', 'service'].includes(offer.type)
        && ['preparing', 'available', 'withdrawn'].includes(offer.status)
        && (offer.bet_id === null || Number.isInteger(offer.bet_id));
}

function isAgentGoalSummary(goal) {
    return goal !== null
        && typeof goal === 'object'
        && Number.isSafeInteger(goal.id)
        && goal.id > 0
        && typeof goal.title === 'string'
        && ['planned', 'active', 'completed', 'cancelled'].includes(goal.status)
        && (goal.target_date === null || /^\d{4}-\d{2}-\d{2}$/.test(goal.target_date));
}

function isAgentAssetSummary(asset) {
    return asset !== null
        && typeof asset === 'object'
        && Number.isSafeInteger(asset.id)
        && asset.id > 0
        && typeof asset.name === 'string'
        && typeof asset.type === 'string'
        && (asset.url === null || typeof asset.url === 'string');
}

function isAgentWorkspaceSummary(workspace) {
    return workspace !== null
        && typeof workspace === 'object'
        && Number.isSafeInteger(workspace.id)
        && workspace.id > 0
        && typeof workspace.uuid === 'string'
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(workspace.uuid)
        && typeof workspace.name === 'string'
        && typeof workspace.status === 'string';
}

function isAgentDirectReport(agent) {
    return agent !== null
        && typeof agent === 'object'
        && Number.isSafeInteger(agent.id)
        && agent.id > 0
        && typeof agent.uuid === 'string'
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(agent.uuid)
        && typeof agent.name === 'string'
        && (agent.role === null || typeof agent.role === 'string')
        && ['active', 'paused'].includes(agent.status)
        && Array.isArray(agent.permissions)
        && agent.permissions.every((permission) => permission !== null
            && typeof permission === 'object'
            && typeof permission.name === 'string'
            && typeof permission.scope === 'string');
}

function isArtifactSummary(artifact) {
    return artifact !== null
        && typeof artifact === 'object'
        && Number.isSafeInteger(artifact.id)
        && artifact.id > 0
        && typeof artifact.title === 'string'
        && (artifact.description === null || typeof artifact.description === 'string')
        && (artifact.source === null || typeof artifact.source === 'string')
        && typeof artifact.original_filename === 'string'
        && ['text/plain', 'text/markdown', 'application/pdf'].includes(artifact.mime_type)
        && Number.isSafeInteger(artifact.size_bytes)
        && artifact.size_bytes > 0
        && /^[a-f0-9]{64}$/.test(artifact.sha256)
        && typeof artifact.created_at === 'string'
        && (artifact.uploaded_by === null
            || (typeof artifact.uploaded_by === 'object'
                && artifact.uploaded_by.type === 'agent'
                && Number.isSafeInteger(artifact.uploaded_by.id)
                && typeof artifact.uploaded_by.name === 'string'));
}

function validateOptionalPositiveId(value, label, required = false) {
    if ((required && !Number.isSafeInteger(value))
        || (value !== undefined && value !== null && (!Number.isSafeInteger(value) || value < 1))) {
        throw new Error(`El ID de ${label} debe ser un entero positivo${required ? '' : ' si se indica'}.`);
    }
}

function isMemoryTopic(topic) {
    return topic !== null
        && typeof topic === 'object'
        && Number.isSafeInteger(topic.id)
        && topic.id > 0
        && typeof topic.name === 'string'
        && typeof topic.can_read === 'boolean'
        && typeof topic.can_write === 'boolean'
        && typeof topic.company_read === 'boolean'
        && typeof topic.company_write === 'boolean'
        && Array.isArray(topic.workspace_read_ids)
        && topic.workspace_read_ids.every((id) => Number.isSafeInteger(id) && id > 0)
        && Array.isArray(topic.workspace_write_ids)
        && topic.workspace_write_ids.every((id) => Number.isSafeInteger(id) && id > 0);
}

function isMemoryNode(node) {
    return node !== null
        && typeof node === 'object'
        && Number.isSafeInteger(node.id)
        && node.id > 0
        && node.topic !== null
        && typeof node.topic === 'object'
        && Number.isSafeInteger(node.topic.id)
        && typeof node.topic.name === 'string'
        && (node.workspace === null || (typeof node.workspace === 'object'
            && Number.isSafeInteger(node.workspace.id)
            && typeof node.workspace.name === 'string'))
        && ['observation', 'hypothesis', 'decision', 'assertion', 'synthesis'].includes(node.kind)
        && typeof node.title === 'string'
        && typeof node.content === 'string'
        && typeof node.source_type === 'string'
        && (node.source_reference === null || typeof node.source_reference === 'string')
        && node.created_by !== null
        && typeof node.created_by === 'object'
        && ['user', 'agent'].includes(node.created_by.type)
        && (node.created_by.id === null || Number.isSafeInteger(node.created_by.id))
        && typeof node.created_by.name === 'string'
        && typeof node.created_at === 'string';
}

function isPathInside(directoryPath, targetPath) {
    const relativePath = relative(directoryPath, targetPath);
    return relativePath === '' || (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !relativePath.startsWith(sep));
}

function isAgentOffer(offer) {
    return isAgentOfferSummary(offer)
        && (offer.description === null || typeof offer.description === 'string');
}

function isAgentGoal(goal) {
    return isAgentGoalSummary(goal)
        && (goal.description === null || typeof goal.description === 'string')
        && typeof goal.success_criteria === 'string';
}

function isAgentAsset(asset) {
    return isAgentAssetSummary(asset)
        && (asset.description === null || typeof asset.description === 'string');
}

function isAgentWorkspace(workspace) {
    return isAgentWorkspaceSummary(workspace)
        && (workspace.description === null || typeof workspace.description === 'string');
}

function isAgentBetSummary(bet) {
    return bet !== null
        && typeof bet === 'object'
        && Number.isInteger(bet.id)
        && bet.id > 0
        && typeof bet.title === 'string'
        && ['proposed', 'investigating', 'validated', 'discarded', 'converted', 'archived'].includes(bet.status);
}

function isAgentBet(bet) {
    return isAgentBetSummary(bet)
        && typeof bet.hypothesis === 'string'
        && (bet.description === null || typeof bet.description === 'string')
        && Array.isArray(bet.evidences)
        && bet.evidences.every((evidence) => evidence !== null
            && typeof evidence === 'object'
            && Number.isInteger(evidence.id)
            && evidence.id > 0
            && typeof evidence.title === 'string'
            && typeof evidence.details === 'string'
            && ['supports', 'challenges', 'neutral'].includes(evidence.assessment)
            && (evidence.source_url === null || typeof evidence.source_url === 'string')
            && (evidence.recorded_by === null
                || (typeof evidence.recorded_by === 'object'
                    && evidence.recorded_by.type === 'agent'
                    && Number.isInteger(evidence.recorded_by.id)
                    && typeof evidence.recorded_by.name === 'string')));
}

function isBetEvidenceInput(evidence) {
    if (evidence === null || typeof evidence !== 'object' || Array.isArray(evidence)) return false;
    const { title, details, assessment, source_url: sourceUrl } = evidence;
    if (typeof title !== 'string' || title.trim() === '' || title.length > 160
        || typeof details !== 'string' || details.trim() === '' || details.length > 2000
        || !['supports', 'challenges', 'neutral'].includes(assessment)
        || (sourceUrl !== undefined && sourceUrl !== null && typeof sourceUrl !== 'string')) {
        return false;
    }
    if (sourceUrl === undefined || sourceUrl === null) return true;
    try {
        return ['http:', 'https:'].includes(new URL(sourceUrl).protocol) && sourceUrl.length <= 2048;
    } catch {
        return false;
    }
}

function isRecordedAgentEvidence(evidence) {
    return evidence !== null
        && typeof evidence === 'object'
        && Number.isInteger(evidence.id)
        && evidence.id > 0
        && typeof evidence.title === 'string'
        && typeof evidence.details === 'string'
        && ['supports', 'challenges', 'neutral'].includes(evidence.assessment)
        && (evidence.source_url === null || typeof evidence.source_url === 'string')
        && evidence.recorded_by !== null
        && typeof evidence.recorded_by === 'object'
        && evidence.recorded_by.type === 'agent'
        && Number.isInteger(evidence.recorded_by.id)
        && typeof evidence.recorded_by.name === 'string';
}

function isCreatedAgentTask(task) {
    return task !== null
        && typeof task === 'object'
        && Number.isInteger(task.id)
        && task.id > 0
        && typeof task.title === 'string'
        && task.status === 'open'
        && ['low', 'normal', 'high'].includes(task.priority)
        && (task.description === null || typeof task.description === 'string')
        && (task.due_date === null || /^\d{4}-\d{2}-\d{2}$/.test(task.due_date))
        && (task.workspace === null
            || (typeof task.workspace === 'object'
                && Number.isInteger(task.workspace.id)
                && task.workspace.id > 0
                && typeof task.workspace.name === 'string'));
}

function isValidDevtoStatsResult(result) {
    return result !== null
        && typeof result === 'object'
        && !Array.isArray(result)
        && Object.keys(result).sort().join(',') === 'articles,scope,source'
        && result.source === 'Dev.to analytics'
        && result.scope === 'lifetime totals'
        && Array.isArray(result.articles)
        && result.articles.length <= 500
        && result.articles.every((article) => article !== null
            && typeof article === 'object'
            && !Array.isArray(article)
            && Object.keys(article).sort().join(',') === 'id,metrics'
            && Number.isSafeInteger(article.id)
            && article.id > 0
            && article.metrics !== null
            && typeof article.metrics === 'object'
            && !Array.isArray(article.metrics)
            && Object.keys(article.metrics).length <= 50
            && Object.entries(article.metrics).every(([name, value]) => /^[a-zA-Z][a-zA-Z0-9_]{0,79}$/.test(name)
                && typeof value === 'number'
                && Number.isFinite(value)
                && value >= 0));
}

async function readResponseLimited(response, maximumBytes) {
    const reader = response.body?.getReader();
    if (!reader) return '';

    const chunks = [];
    let totalBytes = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > maximumBytes) {
            await reader.cancel();
            throw new Error('Response exceeded size limit.');
        }
        chunks.push(value);
    }

    const combined = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
        combined.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return new TextDecoder().decode(combined);
}

async function readResponseBytesLimited(response, maximumBytes) {
    if (response.body === null) throw new Error('Missing response body.');
    const reader = response.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > maximumBytes) throw new Error('Response exceeded size limit.');
        chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, totalBytes);
}

async function validateCompanyRootPath(companyRootPath) {
    try {
        const resolvedPath = await realpath(companyRootPath);
        if (!(await stat(resolvedPath)).isDirectory()) throw new Error('Not a directory.');
        await readdir(resolvedPath);
        return resolvedPath;
    } catch {
        throw new Error('La carpeta raíz de la empresa debe existir y poder leerse.');
    }
}

function enrollmentError(status) {
    if (status === 404) {
        return new Error('El código de alta no existe, caducó o ya se utilizó (HTTP 404).');
    }
    if (status === 429) {
        return new Error('MyCompanies limitó las solicitudes (HTTP 429). Vuelve a intentarlo más tarde.');
    }
    return new Error('No se pudo completar el alta en MyCompanies.');
}
