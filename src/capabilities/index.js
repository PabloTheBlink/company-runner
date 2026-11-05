import { DEVTO_STATS_TOTALS_CAPABILITY, isDevtoStatsInstalled, runDevtoStatsTotals } from './devto-stats-totals.js';
import { COMPANY_REPORT_PUBLISH_CAPABILITY, isCompanyReportPublishInstalled, runCompanyReportPublish } from './company-report-publish.js';
import { createCapabilityRegistry } from './registry.js';
import {
    isMicroappsTelemetryInstalled,
    isValidMicroappsTelemetryResult,
    MICROAPPS_TELEMETRY_CAPABILITY,
    runMicroappsTelemetry,
} from './microapps-telemetry.js';

export const localCapabilityRegistry = createCapabilityRegistry([{
    ...DEVTO_STATS_TOTALS_CAPABILITY,
    access: 'solo lectura',
    requirement: 'Python 3',
    isInstalled: isDevtoStatsInstalled,
    run: runDevtoStatsTotals,
    maxRuntimeMs: DEVTO_STATS_TOTALS_CAPABILITY.maxRuntimeMs,
    validateParameters: (parameters) => Array.isArray(parameters) && parameters.length === 0,
    validateResult: isValidDevtoResult,
    summarize: (result) => ({ outcome: 'succeeded', article_count: result.articles.length }),
}, {
    ...MICROAPPS_TELEMETRY_CAPABILITY,
    access: 'solo lectura',
    requirement: 'Python 3 y proyecto Microapps configurado en la carpeta de empresa',
    isInstalled: isMicroappsTelemetryInstalled,
    run: runMicroappsTelemetry,
    validateParameters: MICROAPPS_TELEMETRY_CAPABILITY.agentTool.validateParameters,
    validateResult: isValidMicroappsTelemetryResult,
    summarize: MICROAPPS_TELEMETRY_CAPABILITY.agentTool.summarize,
}, {
    ...COMPANY_REPORT_PUBLISH_CAPABILITY,
    access: 'publicar informe',
    requirement: 'archivo UTF-8 .md o .txt bajo reports/',
    isInstalled: isCompanyReportPublishInstalled,
    run: runCompanyReportPublish,
    validateParameters: (parameters) => parameters !== null
        && typeof parameters === 'object'
        && !Array.isArray(parameters)
        && Object.keys(parameters).sort().join(',') === 'path,title'
        && typeof parameters.path === 'string'
        && /^reports\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:md|txt)$/i.test(parameters.path)
        && typeof parameters.title === 'string'
        && parameters.title.trim() !== ''
        && parameters.title.length <= 160,
    validateResult: isValidCompanyReportResult,
    summarize: (result) => ({ outcome: 'succeeded', title: result.title, filename: result.original_filename }),
}]);

export function listLocalCapabilities(companyRoot) {
    return localCapabilityRegistry.listInstalled(companyRoot);
}

export async function listAgentCapabilities(companyRoot, identity, task) {
    const installed = await localCapabilityRegistry.listInstalled(companyRoot);

    return installed
        .filter((capability) => capability.agent_tool !== undefined
            && capability.access === 'solo lectura'
            && identity.permissions.some((permission) => permission?.name === capability.agent_tool.permission
                && (permission.scope === 'company'
                    || (task.workspace_id !== null && task.workspace_id !== undefined
                        && permission.workspace_id === task.workspace_id))))
        .map((capability) => {
            const adapter = localCapabilityRegistry.get(capability.name, capability.version);

            return {
                ...capability,
                permission: capability.agent_tool.permission,
                validateParameters: adapter.agentTool.validateParameters,
                validateResult: adapter.validateResult,
                summarize: adapter.agentTool.summarize ?? adapter.summarize,
                run: ({ companyRoot: selectedCompanyRoot, parameters }) => adapter.run({ companyRoot: selectedCompanyRoot, parameters }),
            };
        });
}

function isValidDevtoResult(result) {
    return result !== null
        && typeof result === 'object'
        && !Array.isArray(result)
        && Object.keys(result).sort().join(',') === 'articles,scope,source'
        && result.source === 'Dev.to analytics'
        && result.scope === 'lifetime totals'
        && Array.isArray(result.articles)
        && result.articles.length <= 500
        && result.articles.every((article) => article !== null
            && Number.isSafeInteger(article.id)
            && article.id > 0
            && article.metrics !== null
            && typeof article.metrics === 'object'
            && !Array.isArray(article.metrics)
            && Object.entries(article.metrics).length <= 50
            && Object.entries(article.metrics).every(([name, value]) => /^[a-zA-Z][a-zA-Z0-9_]{0,79}$/.test(name)
                && typeof value === 'number'
                && Number.isFinite(value)
                && value >= 0));
}

function isValidCompanyReportResult(result) {
    return result !== null
        && typeof result === 'object'
        && !Array.isArray(result)
        && Object.keys(result).sort().join(',') === 'content,original_filename,title'
        && typeof result.title === 'string'
        && typeof result.original_filename === 'string'
        && /^[A-Za-z0-9_-]+\.(?:md|txt)$/i.test(result.original_filename)
        && typeof result.content === 'string'
        && result.content.length > 0
        && Buffer.byteLength(result.content, 'utf8') <= COMPANY_REPORT_PUBLISH_CAPABILITY.maxOutputBytes
        && !result.content.includes('\0');
}
