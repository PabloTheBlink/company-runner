import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isLocalFileOperationAllowed, normalizeLocalAgentPath } from './runtime.js';

export async function stageLocalAgentFiles({ agentId, grants, companyRoot, stagingRoot }) {
    const roots = await validateRoots(companyRoot, stagingRoot);
    const fileGrants = collectAgentFileGrants(agentId, grants);
    const stagedEntries = [];

    if ((await readdir(roots.stagingRoot)).length > 0) {
        throw new Error('La carpeta temporal debe estar vacía antes de preparar el entorno Agent.');
    }

    for (const [relativePath, operations] of fileGrants) {
        const targetPath = await inspectCompanyTarget(roots.companyRoot, relativePath, operations.includes('write'));
        if (targetPath === null) {
            throw new Error(`No existe el archivo autorizado para lectura: ${relativePath}.`);
        }

        const existed = targetPath.exists;
        const originalContent = existed ? await readFile(targetPath.absolutePath) : Buffer.alloc(0);
        const stagedContent = operations.includes('read') ? originalContent : Buffer.alloc(0);
        const stagedPath = path.join(roots.stagingRoot, ...relativePath.split('/'));
        await mkdir(path.dirname(stagedPath), { recursive: true, mode: 0o700 });
        if (existed) {
            await writeFile(stagedPath, stagedContent, { flag: 'wx', mode: 0o600 });
        }

        stagedEntries.push({
            path: relativePath,
            existed,
            originalHash: existed ? hashContent(originalContent) : null,
            originalMode: existed ? targetPath.mode : 0o600,
        });
    }

    return {
        agentId,
        companyRoot: roots.companyRoot,
        stagingRoot: roots.stagingRoot,
        entries: stagedEntries,
    };
}

export async function applyLocalAgentFileWrites({ agentId, grants, companyRoot, stagingRoot, workspace }) {
    const roots = await validateRoots(companyRoot, stagingRoot);
    if (workspace?.agentId !== agentId
        || workspace.companyRoot !== roots.companyRoot
        || workspace.stagingRoot !== roots.stagingRoot
        || !Array.isArray(workspace.entries)) {
        throw new Error('El entorno temporal no corresponde a este Agent o empresa.');
    }

    const pendingWrites = [];
    const seenPaths = new Set();

    for (const entry of workspace.entries) {
        const relativePath = normalizeLocalAgentPath(entry?.path);
        if (relativePath === null || seenPaths.has(relativePath)) {
            throw new Error('El manifiesto del entorno temporal contiene rutas no válidas.');
        }
        seenPaths.add(relativePath);

        if (!isLocalFileOperationAllowed(agentId, grants, 'write', relativePath)) continue;

        const stagedPath = path.join(roots.stagingRoot, ...relativePath.split('/'));
        const stagedFile = await inspectRegularFile(stagedPath);
        if (!stagedFile.exists) {
            if (!entry.existed) continue;
            throw new Error(`Falta el archivo temporal autorizado para escritura: ${relativePath}.`);
        }
        const outputContent = await readFile(stagedPath);
        const target = await inspectCompanyTarget(roots.companyRoot, relativePath, true);
        const currentHash = target.exists ? hashContent(await readFile(target.absolutePath)) : null;
        const expectedHash = entry.existed ? entry.originalHash : null;

        if (currentHash !== expectedHash) {
            throw new Error(`El archivo ${relativePath} cambió después de preparar el entorno Agent; no se aplicaron cambios.`);
        }

        pendingWrites.push({
            relativePath,
            targetPath: target.absolutePath,
            content: outputContent,
            mode: entry.existed ? entry.originalMode : 0o600,
        });
    }

    for (const pendingWrite of pendingWrites) {
        const currentTarget = await inspectCompanyTarget(roots.companyRoot, pendingWrite.relativePath, true);
        const currentHash = currentTarget.exists ? hashContent(await readFile(currentTarget.absolutePath)) : null;
        const entry = workspace.entries.find((candidate) => candidate.path === pendingWrite.relativePath);
        const expectedHash = entry.existed ? entry.originalHash : null;
        if (currentHash !== expectedHash) {
            throw new Error(`El archivo ${pendingWrite.relativePath} cambió durante la aplicación; se detuvo la escritura.`);
        }

        const temporaryPath = path.join(
            path.dirname(pendingWrite.targetPath),
            `.${path.basename(pendingWrite.targetPath)}.mycompany-${randomUUID()}.tmp`,
        );

        try {
            await writeFile(temporaryPath, pendingWrite.content, { flag: 'wx', mode: pendingWrite.mode });
            await chmod(temporaryPath, pendingWrite.mode);
            await rename(temporaryPath, pendingWrite.targetPath);
        } catch (error) {
            await rm(temporaryPath, { force: true });
            throw new Error(`No se pudo aplicar el archivo autorizado ${pendingWrite.relativePath}.`, { cause: error });
        }
    }

    return pendingWrites.map(({ relativePath }) => relativePath);
}

async function validateRoots(companyRoot, stagingRoot) {
    const company = await inspectDirectory(companyRoot, 'La carpeta de empresa');
    const staging = await inspectDirectory(stagingRoot, 'La carpeta temporal');
    if (process.platform !== 'win32' && (staging.mode & 0o077) !== 0) {
        throw new Error('La carpeta temporal debe ser privada para el usuario actual.');
    }
    const stagingRelativeToCompany = path.relative(company.realPath, staging.realPath);

    if (stagingRelativeToCompany === ''
        || (!stagingRelativeToCompany.startsWith(`..${path.sep}`)
            && stagingRelativeToCompany !== '..'
            && !path.isAbsolute(stagingRelativeToCompany))) {
        throw new Error('La carpeta temporal debe estar fuera de la carpeta de empresa.');
    }

    return { companyRoot: company.realPath, stagingRoot: staging.realPath };
}

async function inspectDirectory(directoryPath, label) {
    let details;
    try {
        details = await lstat(directoryPath);
    } catch (error) {
        throw new Error(`${label} no existe o no puede leerse.`, { cause: error });
    }

    if (!details.isDirectory() || details.isSymbolicLink()) {
        throw new Error(`${label} debe ser un directorio real, no un enlace simbólico.`);
    }

    return { realPath: await realpath(directoryPath), mode: details.mode };
}

function collectAgentFileGrants(agentId, grants) {
    if (!Number.isSafeInteger(agentId) || agentId < 1 || !Array.isArray(grants)) {
        throw new Error('La política local de archivos no es válida.');
    }

    const fileGrants = new Map();
    for (const grant of grants) {
        if (grant?.agentId !== agentId || !Array.isArray(grant.operations)) continue;
        const relativePath = normalizeLocalAgentPath(grant.path);
        if (relativePath === null) throw new Error('La política local contiene una ruta no válida.');

        const operations = new Set(fileGrants.get(relativePath) ?? []);
        for (const operation of ['read', 'write']) {
            if (grant.operations.includes(operation)) operations.add(operation);
        }
        if (operations.size > 0) fileGrants.set(relativePath, [...operations]);
    }

    return fileGrants;
}

async function inspectCompanyTarget(companyRoot, relativePath, allowMissing) {
    const pathSegments = relativePath.split('/');
    let currentPath = companyRoot;

    for (const [index, segment] of pathSegments.entries()) {
        currentPath = path.join(currentPath, segment);
        const isTarget = index === pathSegments.length - 1;
        let details;
        try {
            details = await lstat(currentPath);
        } catch (error) {
            if (error.code !== 'ENOENT') throw new Error(`No se puede comprobar la ruta autorizada ${relativePath}.`, { cause: error });
            if (!isTarget || !allowMissing) return null;
            return { absolutePath: currentPath, exists: false, mode: 0o600 };
        }

        if (details.isSymbolicLink()) {
            throw new Error(`La ruta autorizada contiene un enlace simbólico: ${relativePath}.`);
        }
        if (isTarget) {
            if (!details.isFile()) throw new Error(`La ruta autorizada no es un archivo: ${relativePath}.`);
            return { absolutePath: currentPath, exists: true, mode: details.mode & 0o777 };
        }
        if (!details.isDirectory()) throw new Error(`La ruta autorizada contiene un directorio no válido: ${relativePath}.`);
    }

    throw new Error(`La ruta autorizada no es válida: ${relativePath}.`);
}

async function inspectRegularFile(filePath) {
    try {
        const details = await lstat(filePath);
        if (details.isSymbolicLink() || !details.isFile()) {
            throw new Error('El archivo temporal debe ser un archivo normal y no un enlace simbólico.');
        }
        return { exists: true };
    } catch (error) {
        if (error.code === 'ENOENT') return { exists: false };
        throw error;
    }
}

function hashContent(content) {
    return createHash('sha256').update(content).digest('hex');
}
