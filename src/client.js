import { realpath, readdir, stat } from 'node:fs/promises';
const API_TOKEN_PATTERN = /^[A-Za-z0-9]{80}$/;
const ENROLLMENT_CODE_PATTERN = /^[A-Za-z0-9]{64}$/;
const MAX_RESPONSE_BYTES = 1024 * 1024;

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

export class RunnerClient {
    constructor(configStore, fetchImplementation = globalThis.fetch) {
        this.configStore = configStore;
        this.fetch = fetchImplementation;
    }

    async enroll(serverUrl, code, workspacePath = process.cwd(), allowInsecureLocalhost = false) {
        const normalizedServerUrl = normalizeServerUrl(serverUrl, allowInsecureLocalhost);
        if (!ENROLLMENT_CODE_PATTERN.test(code)) {
            throw new Error('El código de alta debe contener 64 caracteres alfanuméricos.');
        }
        const resolvedWorkspacePath = await validateWorkspacePath(workspacePath);
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
            workspace_path: resolvedWorkspacePath,
            allow_insecure_localhost: allowInsecureLocalhost,
            api_token: body.api_token,
        });

        return body.runner_id;
    }

    async heartbeat(currentDirectory = process.cwd()) {
        const configuration = await this.configStore.loadForDirectory(currentDirectory);
        const serverUrl = normalizeServerUrl(configuration.server_url, configuration.allow_insecure_localhost);
        try {
            await validateWorkspacePath(configuration.workspace_path);
        } catch {
            throw new Error('La ruta local del workspace no está disponible; no se envió el heartbeat.');
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
            await validateWorkspacePath(configuration.workspace_path);
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

    async listTasks(currentDirectory = process.cwd()) {
        const configuration = await this.configStore.loadForDirectory(currentDirectory);
        const serverUrl = normalizeServerUrl(configuration.server_url, configuration.allow_insecure_localhost);
        const response = await this.getJson(`${serverUrl}/api/v1/runner/tasks`, configuration.api_token);

        if (response.status === 401) {
            throw new Error('La credencial Runner fue rechazada (HTTP 401). Comprueba si fue revocada.');
        }
        if (response.status !== 200
            || !Array.isArray(response.body.tasks)
            || response.body.tasks.length > 100
            || typeof response.body.has_more !== 'boolean'
            || response.body.tasks.some((task) => !isRunnerTask(task))) {
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

function isRunnerTask(task, includeDescription = false) {
    return task !== null
        && typeof task === 'object'
        && Number.isInteger(task.id)
        && task.id > 0
        && typeof task.title === 'string'
        && ['open', 'in_progress', 'blocked'].includes(task.status)
        && ['low', 'normal', 'high'].includes(task.priority)
        && (!includeDescription || task.description === null || typeof task.description === 'string')
        && (task.due_date === null || /^\d{4}-\d{2}-\d{2}$/.test(task.due_date))
        && task.workspace !== null
        && typeof task.workspace === 'object'
        && Number.isInteger(task.workspace.id)
        && task.workspace.id > 0
        && typeof task.workspace.name === 'string';
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

async function validateWorkspacePath(workspacePath) {
    try {
        const resolvedPath = await realpath(workspacePath);
        if (!(await stat(resolvedPath)).isDirectory()) throw new Error('Not a directory.');
        await readdir(resolvedPath);
        return resolvedPath;
    } catch {
        throw new Error('La ruta del workspace debe existir y poder leerse.');
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
