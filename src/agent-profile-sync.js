import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_INSTRUCTIONS_BYTES = 10_000;

export async function syncAgentProfileInstructions(companyRootPath, profile) {
    validateProfile(profile);
    const companyRoot = await inspectDirectory(companyRootPath, 'La carpeta de empresa');
    const targetDirectory = await ensureSafeDirectory(companyRoot, path.join('agents', profile.uuid));
    const manifestDirectory = await ensureSafeDirectory(companyRoot, path.join('.mycompanies', 'agent-profiles'));
    const targetPath = path.join(targetDirectory, 'instructions.md');
    const manifestPath = path.join(manifestDirectory, `${profile.uuid}.json`);
    const remoteContent = profile.instructions ?? '';
    const remoteHash = hashContent(remoteContent);
    const targetInfo = await inspectFile(targetPath);
    const manifestInfo = await inspectFile(manifestPath);
    const manifest = manifestInfo.exists ? await readManifest(manifestPath, profile.uuid) : null;

    if (!targetInfo.exists) {
        await createFile(targetPath, remoteContent);
        await writeManifest(manifestPath, profile.uuid, remoteHash);
        return { status: 'created', path: path.relative(companyRoot, targetPath).split(path.sep).join('/') };
    }

    const localContent = await readFile(targetPath, 'utf8');
    const localHash = hashContent(localContent);
    if (localHash === remoteHash) {
        await writeManifest(manifestPath, profile.uuid, remoteHash);
        return { status: manifest === null ? 'adopted' : 'unchanged', path: path.relative(companyRoot, targetPath).split(path.sep).join('/') };
    }

    if (manifest === null || localHash !== manifest.instructions_hash) {
        return { status: 'conflict', path: path.relative(companyRoot, targetPath).split(path.sep).join('/') };
    }

    await writeAtomically(targetPath, remoteContent, manifest.instructions_hash);
    await writeManifest(manifestPath, profile.uuid, remoteHash);
    return { status: 'updated', path: path.relative(companyRoot, targetPath).split(path.sep).join('/') };
}

function validateProfile(profile) {
    if (profile === null || typeof profile !== 'object'
        || !Number.isSafeInteger(profile.id) || profile.id < 1
        || typeof profile.uuid !== 'string' || !UUID_PATTERN.test(profile.uuid)
        || typeof profile.name !== 'string'
        || !(profile.role === null || typeof profile.role === 'string')
        || !(profile.instructions === null || typeof profile.instructions === 'string')
        || Buffer.byteLength(profile.instructions ?? '', 'utf8') > MAX_INSTRUCTIONS_BYTES) {
        throw new Error('MyCompanies devolvió un perfil Agent no válido.');
    }
}

async function inspectDirectory(directoryPath, label) {
    const info = await lstat(directoryPath);
    if (!info.isDirectory() || info.isSymbolicLink()) {
        throw new Error(`${label} debe ser una carpeta real, no un enlace simbólico.`);
    }
    return realpath(directoryPath);
}

async function ensureSafeDirectory(companyRoot, relativePath) {
    let currentPath = companyRoot;
    for (const segment of relativePath.split(path.sep)) {
        currentPath = path.join(currentPath, segment);
        try {
            await mkdir(currentPath, { mode: 0o700 });
        } catch (error) {
            if (error.code !== 'EEXIST') throw error;
        }
        const info = await lstat(currentPath);
        if (!info.isDirectory() || info.isSymbolicLink()) {
            throw new Error('La ruta local del perfil Agent contiene un enlace simbólico o no es una carpeta.');
        }
    }
    return currentPath;
}

async function inspectFile(filePath) {
    try {
        const info = await lstat(filePath);
        if (!info.isFile() || info.isSymbolicLink()) {
            throw new Error('La ruta del perfil Agent ya existe y no es un archivo regular.');
        }
        return { exists: true };
    } catch (error) {
        if (error.code === 'ENOENT') return { exists: false };
        throw error;
    }
}

async function readManifest(manifestPath, agentUuid) {
    let manifest;
    try {
        manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    } catch {
        throw new Error('El manifiesto local del perfil Agent no es válido; no se modificó el archivo.');
    }
    if (manifest.agent_uuid !== agentUuid || !/^[a-f0-9]{64}$/.test(manifest.instructions_hash)) {
        throw new Error('El manifiesto local del perfil Agent no coincide con la identidad actual.');
    }
    return manifest;
}


async function createFile(filePath, content) {
    try {
        await writeFile(filePath, content, { flag: 'wx', mode: 0o600 });
        await chmod(filePath, 0o600);
    } catch (error) {
        throw new Error('No se pudo crear el archivo local del perfil Agent; no se sobrescribió ningún archivo.', { cause: error });
    }
}

async function writeManifest(manifestPath, agentUuid, instructionsHash) {
    await writeAtomically(manifestPath, `${JSON.stringify({ agent_uuid: agentUuid, instructions_hash: instructionsHash }, null, 2)}\n`);
}

async function writeAtomically(filePath, content, expectedCurrentHash = null) {
    const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
    try {
        await writeFile(temporaryPath, content, { flag: 'wx', mode: 0o600 });
        await chmod(temporaryPath, 0o600);
        if (expectedCurrentHash !== null) {
            const currentInfo = await inspectFile(filePath);
            if (!currentInfo.exists || hashContent(await readFile(filePath, 'utf8')) !== expectedCurrentHash) {
                throw new Error('El archivo local cambió durante la sincronización; no se aplicaron cambios.');
            }
        }
        await rename(temporaryPath, filePath);
    } catch (error) {
        await rm(temporaryPath, { force: true });
        throw new Error('No se pudo sincronizar el archivo local del perfil Agent.', { cause: error });
    }
}

function hashContent(content) {
    return createHash('sha256').update(content, 'utf8').digest('hex');
}
