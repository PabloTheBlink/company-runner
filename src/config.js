import { chmod, lstat, mkdir, open, readFile, unlink } from 'node:fs/promises';
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
    }

    async saveNew(configuration) {
        const directory = path.dirname(this.path);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await this.rejectSymlink(directory);
        if (process.platform !== 'win32') {
            await chmod(directory, 0o700);
        }

        let file;
        try {
            file = await open(this.path, 'wx', 0o600);
        } catch (error) {
            if (error.code === 'EEXIST') {
                throw new Error('Ya existe una configuración Runner. Revoca el Runner y elimina su configuración antes de darlo de alta de nuevo.');
            }
            throw new Error('No se pudo crear el archivo privado de configuración.');
        }

        try {
            await file.writeFile(`${JSON.stringify(configuration, null, 2)}\n`, 'utf8');
            await file.sync();
        } catch {
            await file.close();
            await unlink(this.path).catch(() => {});
            throw new Error('No se pudo guardar la configuración privada del Runner.');
        }
        await file.close();
        if (process.platform !== 'win32') {
            await chmod(this.path, 0o600);
        }
    }

    async load() {
        await this.rejectSymlink(this.path);

        let fileInfo;
        try {
            fileInfo = await lstat(this.path);
        } catch {
            throw new Error('No hay una configuración Runner local. Ejecuta primero enroll.');
        }
        if (!fileInfo.isFile()) {
            throw new Error('La configuración Runner local no es un archivo normal.');
        }
        if (process.platform !== 'win32' && (fileInfo.mode & 0o077) !== 0) {
            throw new Error('La configuración Runner permite acceso a otros usuarios. Protege el archivo con permisos 0600.');
        }

        let configuration;
        try {
            configuration = JSON.parse(await readFile(this.path, 'utf8'));
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

    async forget() {
        await this.rejectSymlink(this.path);
        try {
            await unlink(this.path);
        } catch (error) {
            if (error.code !== 'ENOENT') {
                throw new Error('No se pudo eliminar la configuración Runner local.');
            }
        }
    }

    async assertAvailable() {
        await this.rejectSymlink(this.path);
        try {
            await lstat(this.path);
            throw new Error('Ya existe una configuración Runner. Revoca el Runner y elimina su configuración antes de darlo de alta de nuevo.');
        } catch (error) {
            if (error.code !== 'ENOENT') {
                throw error;
            }
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
}
