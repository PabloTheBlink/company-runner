import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const SCRIPT_PATH = path.join('automations', 'microapps', 'inspect_telemetry.py');
const APP_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const METRIC_FIELDS = Object.freeze([
    'page_views', 'sessions', 'requests', 'javascript_errors', 'server_errors', 'resolved_errors',
]);

export const MICROAPPS_TELEMETRY_CAPABILITY = Object.freeze({
    name: 'microapps.telemetry.summary',
    version: '1.0.0',
    maxRuntimeMs: 45_000,
    maxOutputBytes: 16_384,
    agentTool: Object.freeze({
        permission: 'automations.execute',
        description: 'Consulta métricas agregadas de telemetría local o de producción de una Microapp (últimos 1–30 días).',
        parameters: Object.freeze({
            type: 'object',
            properties: {
                app: Object.freeze({ type: 'string', pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$' }),
                days: Object.freeze({ type: 'integer', minimum: 1, maximum: 30 }),
                environment: Object.freeze({ type: 'string', enum: ['local', 'production'] }),
            },
            required: Object.freeze(['app', 'days', 'environment']),
            additionalProperties: false,
        }),
        validateParameters: isValidParameters,
        summarize: (result) => ({ ...result }),
    }),
});

export async function isMicroappsTelemetryInstalled(companyRoot) {
    const resolvedCompanyRoot = await resolveCompanyRoot(companyRoot);
    if (resolvedCompanyRoot === null) {
        return false;
    }

    try {
        const helperPath = await realpath(path.join(resolvedCompanyRoot, 'automations', 'microapps', 'telemetry_summary.php'));
        const helperStats = await stat(helperPath);
        const relativeHelperPath = path.relative(resolvedCompanyRoot, helperPath);
        return helperStats.isFile() && !relativeHelperPath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeHelperPath);
    } catch {
        return false;
    }
}

export async function runMicroappsTelemetry({
    companyRoot,
    parameters,
    timeoutMs = MICROAPPS_TELEMETRY_CAPABILITY.maxRuntimeMs,
    execFileImplementation = execFile,
} = {}) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MICROAPPS_TELEMETRY_CAPABILITY.maxRuntimeMs) {
        throw new Error('El límite de ejecución de telemetría no es válido.');
    }
    if (!isValidParameters(parameters)) {
        throw new Error('Los parámetros de consulta de telemetría no son válidos.');
    }

    const resolvedCompanyRoot = await resolveCompanyRoot(companyRoot);
    if (resolvedCompanyRoot === null) {
        throw new Error('La capacidad de telemetría Microapps no está instalada en esta carpeta de empresa.');
    }

    const output = await executeFixedScript(execFileImplementation, resolvedCompanyRoot, parameters, timeoutMs);
    if (Buffer.byteLength(output, 'utf8') > MICROAPPS_TELEMETRY_CAPABILITY.maxOutputBytes) {
        throw new Error('La respuesta de telemetría es demasiado grande.');
    }

    let response;
    try {
        response = JSON.parse(output);
    } catch {
        throw new Error('La respuesta de telemetría no es válida.');
    }

    if (!isValidResult(response, parameters)) {
        throw new Error('La respuesta de telemetría no es válida.');
    }

    return response;
}

function isValidParameters(parameters) {
    return parameters !== null
        && typeof parameters === 'object'
        && !Array.isArray(parameters)
        && Object.keys(parameters).sort().join(',') === 'app,days,environment'
        && typeof parameters.app === 'string'
        && APP_PATTERN.test(parameters.app)
        && Number.isInteger(parameters.days)
        && parameters.days >= 1
        && parameters.days <= 30
        && ['local', 'production'].includes(parameters.environment);
}

function isValidResult(result, parameters) {
    return result !== null
        && typeof result === 'object'
        && !Array.isArray(result)
        && Object.keys(result).sort().join(',') === [
            'app', 'environment', 'javascript_errors', 'page_views', 'period_days', 'requests', 'resolved_errors', 'server_errors', 'sessions', 'source',
        ].sort().join(',')
        && result.source === 'Devetty app telemetry'
        && result.app === parameters.app
        && result.environment === parameters.environment
        && result.period_days === parameters.days
        && METRIC_FIELDS.every((field) => Number.isSafeInteger(result[field]) && result[field] >= 0);
}

export function isValidMicroappsTelemetryResult(result) {
    return result !== null
        && typeof result === 'object'
        && !Array.isArray(result)
        && Object.keys(result).sort().join(',') === [
            'app', 'environment', 'javascript_errors', 'page_views', 'period_days', 'requests', 'resolved_errors', 'server_errors', 'sessions', 'source',
        ].sort().join(',')
        && result.source === 'Devetty app telemetry'
        && typeof result.app === 'string'
        && APP_PATTERN.test(result.app)
        && ['local', 'production'].includes(result.environment)
        && Number.isInteger(result.period_days)
        && result.period_days >= 1
        && result.period_days <= 30
        && METRIC_FIELDS.every((field) => Number.isSafeInteger(result[field]) && result[field] >= 0);
}

async function resolveCompanyRoot(companyRoot) {
    try {
        const resolvedCompanyRoot = await realpath(companyRoot);
        const resolvedScriptPath = await realpath(path.join(resolvedCompanyRoot, SCRIPT_PATH));
        const scriptStats = await stat(resolvedScriptPath);
        const relativeScriptPath = path.relative(resolvedCompanyRoot, resolvedScriptPath);
        if (!scriptStats.isFile() || relativeScriptPath.startsWith(`..${path.sep}`) || path.isAbsolute(relativeScriptPath)) {
            return null;
        }
        return resolvedCompanyRoot;
    } catch {
        return null;
    }
}

function executeFixedScript(execFileImplementation, companyRoot, parameters, timeoutMs) {
    return new Promise((resolve, reject) => {
        try {
            execFileImplementation(
                'python3',
                [SCRIPT_PATH, '--app', parameters.app, '--days', String(parameters.days), '--environment', parameters.environment],
                {
                    cwd: companyRoot,
                    env: { PATH: process.env.PATH ?? '', PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
                    encoding: 'utf8',
                    maxBuffer: MICROAPPS_TELEMETRY_CAPABILITY.maxOutputBytes + 1,
                    shell: false,
                    timeout: timeoutMs,
                    windowsHide: true,
                },
                (error, stdout) => {
                    if (error) {
                        reject(new Error('La consulta de telemetría Microapps falló.'));
                        return;
                    }
                    if (typeof stdout !== 'string') {
                        reject(new Error('La respuesta de telemetría no es válida.'));
                        return;
                    }
                    resolve(stdout);
                },
            );
        } catch {
            reject(new Error('La consulta de telemetría Microapps falló.'));
        }
    });
}
