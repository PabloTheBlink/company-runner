import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

const REPORT_PATH_PATTERN = /^reports\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:md|txt)$/i;

export const COMPANY_REPORT_PUBLISH_CAPABILITY = Object.freeze({
    name: 'company.report.publish',
    version: '1.0.0',
    maxRuntimeMs: 10_000,
    maxOutputBytes: 32_768,
});

export async function isCompanyReportPublishInstalled(companyRoot) {
    try {
        const resolvedRoot = await realpath(companyRoot);
        const reportsDirectory = path.join(resolvedRoot, 'reports');
        const directoryStats = await lstat(reportsDirectory);
        return directoryStats.isDirectory() && !directoryStats.isSymbolicLink();
    } catch {
        return false;
    }
}

export async function runCompanyReportPublish({ companyRoot, parameters } = {}) {
    if (parameters === null
        || typeof parameters !== 'object'
        || Array.isArray(parameters)
        || Object.keys(parameters).sort().join(',') !== 'path,title'
        || typeof parameters.path !== 'string'
        || !REPORT_PATH_PATTERN.test(parameters.path)
        || typeof parameters.title !== 'string'
        || parameters.title.trim() === ''
        || parameters.title.length > 160) {
        throw new Error('Los parámetros de publicación del informe no son válidos.');
    }

    const resolvedRoot = await realpath(companyRoot).catch(() => null);
    if (resolvedRoot === null) {
        throw new Error('La carpeta de empresa no está disponible.');
    }

    const reportsDirectory = path.join(resolvedRoot, 'reports');
    const reportPath = path.join(resolvedRoot, ...parameters.path.split('/'));
    let resolvedReportsDirectory;
    let resolvedReportPath;
    let reportStats;
    try {
        const directoryStats = await lstat(reportsDirectory);
        const fileStats = await lstat(reportPath);
        if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink() || fileStats.isSymbolicLink() || !fileStats.isFile()) {
            throw new Error('Ruta de informe no válida.');
        }
        resolvedReportsDirectory = await realpath(reportsDirectory);
        resolvedReportPath = await realpath(reportPath);
        reportStats = fileStats;
    } catch {
        throw new Error('El informe autorizado no está disponible.');
    }

    const relativeReportPath = path.relative(resolvedReportsDirectory, resolvedReportPath);
    if (relativeReportPath === '' || relativeReportPath.startsWith(`..${path.sep}`) || path.isAbsolute(relativeReportPath)) {
        throw new Error('La ruta del informe sale de la carpeta reports.');
    }
    if (reportStats.size < 1 || reportStats.size > COMPANY_REPORT_PUBLISH_CAPABILITY.maxOutputBytes) {
        throw new Error('El informe supera el tamaño permitido o está vacío.');
    }

    let content;
    try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(resolvedReportPath));
    } catch {
        throw new Error('El informe debe ser texto UTF-8 válido.');
    }
    if (content.includes('\0')) {
        throw new Error('El informe debe ser texto UTF-8 válido.');
    }

    return {
        title: parameters.title.trim(),
        original_filename: path.basename(parameters.path),
        content,
    };
}
