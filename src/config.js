import { chmod, lstat, mkdir, open, readFile, readdir, realpath, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export function defaultConfigPath(env = process.env) {
    let configHome;

    if (process.platform === 'win32') {
        configHome = env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    } else if (process.platform === 'darwin') {
        configHome = env.XDG_CONFIG_HOME || path.join(os.homedir(), 'Library', 'Application Support');
    } else {
        configHome = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    }

    if (!path.isAbsolute(configHome)) {
        throw new Error('La carpeta de configuración debe ser una ruta absoluta.');
    }

    return path.join(configHome, 'mycompanies', 'runner.json');
}

export class ConfigStore {
    constructor(configPath = defaultConfigPath()) {
        if (!path.isAbsolute(configPath)) {
            throw new Error('La ruta de configuración debe ser absoluta.');
        }

        this.path = configPath;
        this.registrationsDirectory = path.join(path.dirname(configPath), 'runners');
    }

    async saveNew(configuration) {
        const existingRegistrations = await this.readRegistrations();
        const duplicateRegistration = existingRegistrations.some(({ configuration: existing }) => (
            existing.runner_id === configuration.runner_id
            || existing.workspace_path === configuration.workspace_path
        ));
        if (duplicateRegistration) {
            throw new Error('Ya existe una configuración Runner para esta identidad o carpeta. Revoca el registro anterior antes de enrolarlo de nuevo.');
        }

        await this.ensurePrivateDirectory(path.dirname(this.path));
        await this.ensurePrivateDirectory(this.registrationsDirectory);

        const registrationPath = this.registrationPath(configuration.runner_id);
        let file;
        try {
            file = await open(registrationPath, 'wx', 0o600);
        } catch (error) {
            if (error.code === 'EEXIST') {
                throw new Error('Ya existe una configuración para este Runner. Revócalo antes de enrolarlo de nuevo.');
            }
            throw new Error('No se pudo crear el archivo privado de configuración.');
        }

        try {
            await file.writeFile(`${JSON.stringify(configuration, null, 2)}\n`, 'utf8');
            await file.sync();
        } catch {
            await file.close();
            await unlink(registrationPath).catch(() => {});
            throw new Error('No se pudo guardar la configuración privada del Runner.');
        }
        await file.close();
        if (process.platform !== 'win32') {
            await chmod(registrationPath, 0o600);
        }
    }

    async load() {
        const registrations = await this.readRegistrations();
        if (registrations.length === 0) {
            throw new Error('No hay una configuración Runner local. Ejecuta primero enroll.');
        }
        if (registrations.length > 1) {
            throw new Error('Hay varios Runners configurados. Ejecuta mycompany desde la carpeta raíz de la empresa correspondiente.');
        }

        return registrations[0].configuration;
    }

    async loadForDirectory(currentDirectory = process.cwd()) {
        return (await this.selectForDirectory(currentDirectory)).configuration;
    }

    async forget(currentDirectory = process.cwd()) {
        const registration = await this.selectForDirectory(currentDirectory);
        await unlink(registration.filePath);
    }

    async selectForDirectory(currentDirectory) {
        let resolvedDirectory;
        try {
            resolvedDirectory = await realpath(currentDirectory);
        } catch {
            throw new Error('No se puede determinar la carpeta actual.');
        }

        const registrations = await this.readRegistrations();
        const matchingRegistrations = [];

        for (const registration of registrations) {
            let companyRootPath;
            try {
                companyRootPath = await realpath(registration.configuration.workspace_path);
            } catch {
                continue;
            }
            if (isWithinDirectory(companyRootPath, resolvedDirectory)) {
                matchingRegistrations.push({
                    ...registration,
                    resolvedCompanyRootPath: companyRootPath,
                });
            }
        }

        if (matchingRegistrations.length === 0) {
            throw new Error('No hay un Runner configurado para esta carpeta. Ejecuta enroll desde la carpeta raíz de la empresa.');
        }

        matchingRegistrations.sort((first, second) => second.resolvedCompanyRootPath.length - first.resolvedCompanyRootPath.length);
        if (matchingRegistrations.length > 1
            && matchingRegistrations[0].resolvedCompanyRootPath === matchingRegistrations[1].resolvedCompanyRootPath) {
            throw new Error('Hay varios Runners configurados para esta carpeta. Revísalos antes de continuar.');
        }

        return matchingRegistrations[0];
    }

    async readRegistrations() {
        const registrations = [];
        const legacyConfiguration = await this.readOptionalConfiguration(this.path);
        if (legacyConfiguration !== null) {
            registrations.push({ configuration: legacyConfiguration, filePath: this.path });
        }

        try {
            const directoryInfo = await lstat(this.registrationsDirectory);
            if (directoryInfo.isSymbolicLink()) {
                throw new Error('La carpeta de configuración no puede ser un enlace simbólico.');
            }
            if (!directoryInfo.isDirectory()) {
                throw new Error('La carpeta privada de configuraciones Runner no es válida.');
            }
            this.assertPrivateMode(directoryInfo, 'La carpeta de configuración permite acceso a otros usuarios. Protege la carpeta con permisos 0700.');

            const fileNames = await readdir(this.registrationsDirectory);
            for (const fileName of fileNames.filter((name) => /^runner-\d+\.json$/.test(name))) {
                const filePath = path.join(this.registrationsDirectory, fileName);
                const configuration = await this.readConfiguration(filePath);
                registrations.push({ configuration, filePath });
            }
        } catch (error) {
            if (error.code !== 'ENOENT') {
                throw error;
            }
        }

        return registrations;
    }

    async readOptionalConfiguration(configurationPath) {
        try {
            return await this.readConfiguration(configurationPath);
        } catch (error) {
            if (error.code === 'ENOENT') {
                return null;
            }
            throw error;
        }
    }

    async readConfiguration(configurationPath) {
        await this.rejectSymlink(configurationPath);

        let fileInfo;
        try {
            fileInfo = await lstat(configurationPath);
        } catch (error) {
            throw error;
        }
        if (!fileInfo.isFile()) {
            throw new Error('La configuración Runner local no es un archivo normal.');
        }
        this.assertPrivateMode(fileInfo, 'La configuración Runner permite acceso a otros usuarios. Protege el archivo con permisos 0600.');

        let configuration;
        try {
            configuration = JSON.parse(await readFile(configurationPath, 'utf8'));
        } catch {
            throw new Error('La configuración Runner local no es válida.');
        }
        if (typeof configuration.server_url !== 'string'
            || !Number.isInteger(configuration.runner_id)
            || typeof configuration.workspace_path !== 'string'
            || typeof configuration.allow_insecure_localhost !== 'boolean'
            || typeof configuration.api_token !== 'string') {
            throw new Error('La configuración Runner local está incompleta.');
        }

        return configuration;
    }

    async ensurePrivateDirectory(directoryPath) {
        await mkdir(directoryPath, { recursive: true, mode: 0o700 });
        await this.rejectSymlink(directoryPath);
        if (process.platform !== 'win32') {
            await chmod(directoryPath, 0o700);
        }
    }

    assertPrivateMode(fileInfo, message) {
        if (process.platform !== 'win32' && (fileInfo.mode & 0o077) !== 0) {
            throw new Error(message);
        }
    }

    async rejectSymlink(targetPath) {
        try {
            const fileInfo = await lstat(targetPath);
            if (fileInfo.isSymbolicLink()) {
                throw new Error('La ruta de configuración no puede ser un enlace simbólico.');
            }
        } catch (error) {
            if (error.code !== 'ENOENT') {
                throw error;
            }
        }
    }

    registrationPath(runnerId) {
        return path.join(this.registrationsDirectory, `runner-${runnerId}.json`);
    }
}

function isWithinDirectory(parentDirectory, candidateDirectory) {
    const relativePath = path.relative(parentDirectory, candidateDirectory);
    return relativePath === ''
        || (relativePath !== '..'
            && !relativePath.startsWith(`..${path.sep}`)
            && !path.isAbsolute(relativePath));
}
