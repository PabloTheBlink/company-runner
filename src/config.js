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
        this.agentsDirectory = path.join(path.dirname(configPath), 'agents');
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

    async saveAgent(configuration) {
        const agents = await this.readAgents();
        if (agents.some(({ configuration: existing }) => existing.agent_id === configuration.agent_id)) {
            throw new Error('Ya existe una credencial local para este agente.');
        }

        const hasExistingProfileForCompany = agents.some(({ configuration: existing }) => (
            existing.company_root_path === configuration.company_root_path
        ));
        const storedConfiguration = {
            ...configuration,
            default_for_company: configuration.default_for_company ?? !hasExistingProfileForCompany,
        };

        await this.ensurePrivateDirectory(path.dirname(this.path));
        await this.ensurePrivateDirectory(this.agentsDirectory);
        const credentialPath = this.agentPath(storedConfiguration.agent_id);
        let file;
        try {
            file = await open(credentialPath, 'wx', 0o600);
        } catch (error) {
            if (error.code === 'EEXIST') {
                throw new Error('Ya existe una credencial local para este agente.');
            }
            throw new Error('No se pudo crear el archivo privado de configuración.');
        }

        try {
            await file.writeFile(`${JSON.stringify(storedConfiguration, null, 2)}\n`, 'utf8');
            await file.sync();
        } catch {
            await file.close();
            await unlink(credentialPath).catch(() => {});
            throw new Error('No se pudo guardar la credencial privada del agente.');
        }
        await file.close();
        if (process.platform !== 'win32') await chmod(credentialPath, 0o600);
    }

    async assertAgentNotConfigured(agentId) {
        if ((await this.readAgents()).some(({ configuration }) => configuration.agent_id === agentId)) {
            throw new Error('Este agente ya tiene una credencial local configurada.');
        }
    }

    async loadAgentForDirectory(currentDirectory = process.cwd(), selectedAgentId = process.env.MYCOMPANY_AGENT_ID) {
        const { default_for_company: _defaultForCompany, ...configuration } = (
            await this.selectAgentForDirectory(currentDirectory, selectedAgentId)
        ).configuration;
        return configuration;
    }

    async forgetAgent(currentDirectory = process.cwd()) {
        const agent = await this.selectAgentForDirectory(currentDirectory);
        await unlink(agent.filePath);
    }

    async selectAgentForDirectory(currentDirectory, selectedAgentId = process.env.MYCOMPANY_AGENT_ID) {
        let resolvedDirectory;
        try {
            resolvedDirectory = await realpath(currentDirectory);
        } catch {
            throw new Error('No se puede determinar la carpeta actual.');
        }

        const matchingAgents = [];
        for (const agent of await this.readAgents()) {
            let companyRootPath;
            try {
                companyRootPath = await realpath(agent.configuration.company_root_path);
            } catch {
                continue;
            }
            if (isWithinDirectory(companyRootPath, resolvedDirectory)) {
                matchingAgents.push({ ...agent, resolvedCompanyRootPath: companyRootPath });
            }
        }

        if (matchingAgents.length === 0) {
            throw new Error('No hay un agente configurado para esta carpeta. Ejecuta agent login desde la raíz de empresa.');
        }
        matchingAgents.sort((first, second) => second.resolvedCompanyRootPath.length - first.resolvedCompanyRootPath.length);
        const mostSpecificRoot = matchingAgents[0].resolvedCompanyRootPath;
        const sameRootAgents = matchingAgents.filter((agent) => agent.resolvedCompanyRootPath === mostSpecificRoot);
        if (selectedAgentId !== undefined && selectedAgentId !== '') {
            if (!/^\d+$/.test(String(selectedAgentId)) || Number(selectedAgentId) < 1) {
                throw new Error('MYCOMPANY_AGENT_ID debe ser un ID de agente positivo.');
            }
            const selectedAgent = sameRootAgents.find((agent) => agent.configuration.agent_id === Number(selectedAgentId));
            if (!selectedAgent) {
                throw new Error('No hay un agente configurado para esta identidad en la carpeta actual.');
            }
            return selectedAgent;
        }

        if (sameRootAgents.length === 1) return sameRootAgents[0];
        const defaultAgents = sameRootAgents.filter((agent) => agent.configuration.default_for_company === true);
        if (defaultAgents.length === 1) return defaultAgents[0];
        const legacyAgents = sameRootAgents.filter((agent) => agent.configuration.default_for_company === undefined);
        if (defaultAgents.length === 0 && legacyAgents.length === 1) return legacyAgents[0];
        throw new Error('Hay varios agentes configurados para esta carpeta. Define MYCOMPANY_AGENT_ID con el ID del agente antes de continuar.');
    }

    async readAgents() {
        try {
            const directoryInfo = await lstat(this.agentsDirectory);
            if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) {
                throw new Error('La carpeta privada de credenciales Agent no es válida.');
            }
            this.assertPrivateMode(directoryInfo, 'La carpeta de credenciales Agent permite acceso a otros usuarios. Protege la carpeta con permisos 0700.');
            const agents = [];
            for (const fileName of (await readdir(this.agentsDirectory)).filter((name) => /^agent-\d+\.json$/.test(name))) {
                const filePath = path.join(this.agentsDirectory, fileName);
                await this.rejectSymlink(filePath);
                const fileInfo = await lstat(filePath);
                if (!fileInfo.isFile()) throw new Error('La configuración Agent local no es un archivo normal.');
                this.assertPrivateMode(fileInfo, 'La configuración Agent permite acceso a otros usuarios. Protege el archivo con permisos 0600.');
                let configuration;
                try {
                    configuration = JSON.parse(await readFile(filePath, 'utf8'));
                } catch {
                    throw new Error('La configuración Agent local no es válida.');
                }
                if (typeof configuration.server_url !== 'string'
                    || !Number.isInteger(configuration.agent_id)
                    || !Number.isInteger(configuration.company_id)
                    || typeof configuration.agent_name !== 'string'
                    || typeof configuration.company_name !== 'string'
                    || typeof configuration.company_root_path !== 'string'
                    || typeof configuration.allow_insecure_localhost !== 'boolean'
                    || typeof configuration.api_token !== 'string'
                    || (configuration.default_for_company !== undefined && typeof configuration.default_for_company !== 'boolean')) {
                    throw new Error('La configuración Agent local está incompleta.');
                }
                agents.push({ configuration, filePath });
            }
            return agents;
        } catch (error) {
            if (error.code === 'ENOENT') return [];
            throw error;
        }
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

    agentPath(agentId) {
        return path.join(this.agentsDirectory, `agent-${agentId}.json`);
    }
}

function isWithinDirectory(parentDirectory, candidateDirectory) {
    const relativePath = path.relative(parentDirectory, candidateDirectory);
    return relativePath === ''
        || (relativePath !== '..'
            && !relativePath.startsWith(`..${path.sep}`)
            && !path.isAbsolute(relativePath));
}
