import { execFile } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const SCRIPT_PATH = path.join('automations', 'devto', 'devto_stats.py');
const OUTPUT_SOURCE = 'Dev.to API /api/analytics/totals';
const OUTPUT_SCOPE = 'lifetime totals';

export const DEVTO_STATS_TOTALS_CAPABILITY = Object.freeze({
    name: 'devto.stats.totals',
    version: '1.0.0',
    maxRuntimeMs: 120_000,
    maxOutputBytes: 1_048_576,
    agentTool: Object.freeze({
        permission: 'automations.execute',
        description: 'Consulta las métricas acumuladas de los artículos Dev.to configurados en esta empresa.',
        parameters: Object.freeze({ type: 'object', properties: {}, additionalProperties: false }),
        validateParameters: (parameters) => parameters !== null
            && typeof parameters === 'object'
            && !Array.isArray(parameters)
            && Object.keys(parameters).length === 0,
        summarize: (result) => {
            const totals = {};
            for (const article of result.articles) {
                for (const [name, value] of Object.entries(article.metrics)) {
                    if (name.endsWith('_average_read_time_in_seconds')) continue;
                    const total = (totals[name] ?? 0) + value;
                    if (Number.isFinite(total)) totals[name] = total;
                }
            }

            const views = totals.page_views_total;
            const readTime = totals.page_views_total_read_time_in_seconds;
            const weightedAverage = Number.isFinite(views) && views > 0 && Number.isFinite(readTime)
                ? Math.round((readTime / views) * 100) / 100
                : null;

            return {
                source: result.source,
                scope: result.scope,
                article_count: result.articles.length,
                totals,
                ...(weightedAverage === null ? {} : { calculated_weighted_average_read_time_seconds: weightedAverage }),
            };
        },
    }),
});

export async function isDevtoStatsInstalled(companyRoot) {
    return await resolveCompanyRoot(companyRoot) !== null;
}

export async function runDevtoStatsTotals({ companyRoot, timeoutMs = DEVTO_STATS_TOTALS_CAPABILITY.maxRuntimeMs, execFileImplementation = execFile } = {}) {
    if (!Number.isInteger(timeoutMs)
        || timeoutMs < 1
        || timeoutMs > DEVTO_STATS_TOTALS_CAPABILITY.maxRuntimeMs) {
        throw new Error('El límite de ejecución de la capacidad no es válido.');
    }

    const resolvedCompanyRoot = await resolveCompanyRoot(companyRoot);
    if (resolvedCompanyRoot === null) {
        throw new Error('La capacidad Dev.to no está instalada en esta carpeta de empresa.');
    }

    const output = await executeFixedScript(execFileImplementation, resolvedCompanyRoot, timeoutMs);
    if (Buffer.byteLength(output, 'utf8') > DEVTO_STATS_TOTALS_CAPABILITY.maxOutputBytes) {
        throw new Error('La respuesta de Dev.to es demasiado grande.');
    }

    let response;
    try {
        response = JSON.parse(output);
    } catch {
        throw new Error('La respuesta JSON de Dev.to no es válida.');
    }

    return validateAndFilterResponse(response);
}

async function resolveCompanyRoot(companyRoot) {
    let resolvedCompanyRoot;
    let resolvedScriptPath;

    try {
        resolvedCompanyRoot = await realpath(companyRoot);
        resolvedScriptPath = await realpath(path.join(resolvedCompanyRoot, SCRIPT_PATH));
        const scriptStats = await stat(resolvedScriptPath);
        const relativeScriptPath = path.relative(resolvedCompanyRoot, resolvedScriptPath);

        if (!scriptStats.isFile()
            || relativeScriptPath === ''
            || relativeScriptPath.startsWith(`..${path.sep}`)
            || path.isAbsolute(relativeScriptPath)) {
            return null;
        }
    } catch {
        return null;
    }

    return resolvedCompanyRoot;
}

function executeFixedScript(execFileImplementation, companyRoot, timeoutMs) {
    return new Promise((resolve, reject) => {
        const environment = {
            PATH: process.env.PATH ?? '',
            PYTHONIOENCODING: 'utf-8',
            PYTHONUNBUFFERED: '1',
            ...(typeof process.env.DEVTO_API_KEY === 'string'
                ? { DEVTO_API_KEY: process.env.DEVTO_API_KEY }
                : {}),
        };

        try {
            execFileImplementation(
                'python3',
                [SCRIPT_PATH, 'stats', 'totals'],
                {
                    cwd: companyRoot,
                    env: environment,
                    encoding: 'utf8',
                    maxBuffer: DEVTO_STATS_TOTALS_CAPABILITY.maxOutputBytes + 1,
                    shell: false,
                    timeout: timeoutMs,
                    windowsHide: true,
                },
                (error, stdout) => {
                    if (error) {
                        reject(new Error('La consulta de estadísticas Dev.to falló.'));

                        return;
                    }

                    if (typeof stdout !== 'string') {
                        reject(new Error('La respuesta JSON de Dev.to no es válida.'));

                        return;
                    }

                    resolve(stdout);
                },
            );
        } catch {
            reject(new Error('La consulta de estadísticas Dev.to falló.'));
        }
    });
}

function validateAndFilterResponse(response) {
    if (response === null
        || typeof response !== 'object'
        || Array.isArray(response)
        || response.source !== OUTPUT_SOURCE
        || response.scope !== OUTPUT_SCOPE
        || !Array.isArray(response.articles)) {
        throw new Error('La respuesta de métricas Dev.to no es válida.');
    }

    const articles = response.articles.map((article) => {
        if (article === null
            || typeof article !== 'object'
            || Array.isArray(article)
            || !Number.isSafeInteger(article.id)
            || article.id < 1
            || article.metrics === null
            || typeof article.metrics !== 'object'
            || Array.isArray(article.metrics)) {
            throw new Error('La respuesta de métricas Dev.to no es válida.');
        }

        const metrics = {};
        flattenMetrics(article.metrics, '', metrics, 0);

        return { id: article.id, metrics };
    });

    return {
        source: 'Dev.to analytics',
        scope: OUTPUT_SCOPE,
        articles,
    };
}

function flattenMetrics(value, prefix, metrics, depth) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        if (!/^[a-zA-Z][a-zA-Z0-9_]{0,79}$/.test(prefix) || Object.hasOwn(metrics, prefix)) {
            throw new Error('La respuesta de métricas Dev.to no es válida.');
        }
        metrics[prefix] = value;
        if (Object.keys(metrics).length > 100) {
            throw new Error('La respuesta de métricas Dev.to no es válida.');
        }

        return;
    }

    if (value === null || typeof value !== 'object' || Array.isArray(value) || depth >= 3) {
        throw new Error('La respuesta de métricas Dev.to no es válida.');
    }

    for (const [name, nestedValue] of Object.entries(value)) {
        if (!/^[a-zA-Z][a-zA-Z0-9_]{0,79}$/.test(name)) {
            throw new Error('La respuesta de métricas Dev.to no es válida.');
        }
        const key = prefix === '' ? name : `${prefix}_${name}`;
        flattenMetrics(nestedValue, key, metrics, depth + 1);
    }
}
