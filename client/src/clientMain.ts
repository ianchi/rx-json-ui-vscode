/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Copyright (c) Adrian Panella
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as fs from 'fs';

import { workspace, ExtensionContext, extensions, Uri } from 'vscode';
import {
    LanguageClientOptions,
    RequestType,
    NotificationType,
    DidChangeConfigurationNotification,
    ResponseError,
} from 'vscode-languageclient';
import { LanguageClient, ServerOptions, TransportKind } from 'vscode-languageclient/node';

import { hash } from './utils/hash';

namespace VSCodeContentRequest {
    export const type: RequestType<string, string, any> = new RequestType('vscode/content');
}

namespace SchemaContentChangeNotification {
    export const type: NotificationType<string> = new NotificationType('json/schemaContent');
}

export interface ISchemaAssociations {
    [pattern: string]: string[];
}

export interface ISchemaAssociation {
    fileMatch: string[];
    uri: string;
}

namespace SchemaAssociationNotification {
    export const type: NotificationType<
        ISchemaAssociations | ISchemaAssociation[]
    > = new NotificationType('json/schemaAssociations');
}

interface Settings {
    json?: {
        schemas?: JSONSchemaSettings[];
        format?: { enable: boolean };
        resultLimit?: number;
    };
    http?: {
        proxy?: string;
        proxyStrictSSL?: boolean;
    };
}

interface JSONSchemaSettings {
    fileMatch?: string[];
    url?: string;
    schema?: any;
}

export function activate(context: ExtensionContext) {
    let toDispose = context.subscriptions;

    let serverMain = readJSONFile(context.asAbsolutePath('./server/package.json')).main;
    let serverModule = context.asAbsolutePath(path.join('server', serverMain));

    // The debug options for the server
    let debugOptions = {
        execArgv: ['--nolazy', '--inspect=6009'],
    };
    // If the extension is launch in debug mode the debug server options are use
    // Otherwise the run options are used
    let serverOptions: ServerOptions = {
        run: { module: serverModule, transport: TransportKind.ipc },
        debug: {
            module: serverModule,
            transport: TransportKind.ipc,
            options: debugOptions,
        },
    };

    // Options to control the language client
    const clientOptions: LanguageClientOptions = {
        // Register the server for json documents
        documentSelector: ['json', 'jsonc'],
        initializationOptions: {
            handledSchemaProtocols: ['file'], // language server only loads file-URI. Fetching schemas with other protocols ('http'...) are made on the client.
            provideFormatter: false, // tell the server to not provide formatting capability and ignore the `json.format.enable` setting.
        },
        synchronize: {
            // Synchronize the setting section 'json' to the server
            configurationSection: ['json', 'http'],
            fileEvents: workspace.createFileSystemWatcher('**/*.json'),
        },
        middleware: {
            workspace: {
                didChangeConfiguration: () =>
                    client.sendNotification(DidChangeConfigurationNotification.type, {
                        settings: getSettings(),
                    }),
            },
        },
    };

    // Create the language client and start the client.
    const client = new LanguageClient(
        'json',
        'rx-json-ui Language Server',
        serverOptions,
        clientOptions
    );
    client.registerProposedFeatures();

    const disposable = client.start();
    toDispose.push(disposable);
    client.onReady().then(() => {
        const schemaDocuments: { [uri: string]: boolean } = {};

        // handle content request
        client.onRequest(VSCodeContentRequest.type, (uriPath: string) => {
            const uri = Uri.parse(uriPath);
            if (uri.scheme === 'untitled') {
                return Promise.reject(new ResponseError(3, `Unable to load ${uri.toString()}`));
            }
            if (uri.scheme !== 'http' && uri.scheme !== 'https') {
                return workspace.openTextDocument(uri).then(
                    doc => {
                        schemaDocuments[uri.toString()] = true;
                        return doc.getText();
                    },
                    error => {
                        return Promise.reject(new ResponseError(2, error.toString()));
                    }
                );
            } else {
                return Promise.reject(new ResponseError(1, 'Downloading schemas is not supported'));
            }
        });

        const handleContentChange = (uriString: string) => {
            if (schemaDocuments[uriString]) {
                client.sendNotification(SchemaContentChangeNotification.type, uriString);
                return true;
            }
            return false;
        };

        toDispose.push(
            workspace.onDidChangeTextDocument(e => handleContentChange(e.document.uri.toString()))
        );
        toDispose.push(
            workspace.onDidCloseTextDocument(d => {
                const uriString = d.uri.toString();
                if (handleContentChange(uriString)) {
                    delete schemaDocuments[uriString];
                }
            })
        );

        client.sendNotification(SchemaAssociationNotification.type, getSchemaAssociations(context));

        extensions.onDidChange(_ => {
            client.sendNotification(
                SchemaAssociationNotification.type,
                getSchemaAssociations(context)
            );
        });
    });
}

export function joinPath(uri: Uri, ...paths: string[]): Uri {
    const parts = uri.path.split('/');
    for (let path of paths) {
        parts.push(...path.split('/'));
    }
    return uri.with({ path: normalizePath(parts) });
}

export function normalizePath(parts: string[]): string {
    const Dot = '.'.charCodeAt(0);
    const newParts: string[] = [];
    for (const part of parts) {
        if (part.length === 0 || (part.length === 1 && part.charCodeAt(0) === Dot)) {
            // ignore
        } else if (part.length === 2 && part.charCodeAt(0) === Dot && part.charCodeAt(1) === Dot) {
            newParts.pop();
        } else {
            newParts.push(part);
        }
    }
    if (parts.length > 1 && parts[parts.length - 1].length === 0) {
        newParts.push('');
    }
    let res = newParts.join('/');
    if (parts[0].length === 0) {
        res = '/' + res;
    }
    return res;
}

function getSchemaAssociations(_context: ExtensionContext): ISchemaAssociation[] {
    const associations: ISchemaAssociation[] = [];
    extensions.all.forEach(extension => {
        const packageJSON = extension.packageJSON;
        if (packageJSON && packageJSON.contributes && packageJSON.contributes.jsonValidation) {
            const jsonValidation = packageJSON.contributes.jsonValidation;
            if (Array.isArray(jsonValidation)) {
                jsonValidation.forEach(jv => {
                    let { fileMatch, url } = jv;
                    if (typeof fileMatch === 'string') {
                        fileMatch = [fileMatch];
                    }
                    if (Array.isArray(fileMatch) && typeof url === 'string') {
                        let uri: string = url;
                        if (uri[0] === '.' && uri[1] === '/') {
                            uri = joinPath(extension.extensionUri, uri).toString();
                        }
                        fileMatch = fileMatch.map(fm => {
                            if (fm[0] === '%') {
                                fm = fm.replace(/%APP_SETTINGS_HOME%/, '/User');
                                fm = fm.replace(/%MACHINE_SETTINGS_HOME%/, '/Machine');
                                fm = fm.replace(/%APP_WORKSPACES_HOME%/, '/Workspaces');
                            } else if (!fm.match(/^(\w+:\/\/|\/|!)/)) {
                                fm = '/' + fm;
                            }
                            return fm;
                        });
                        associations.push({ fileMatch, uri });
                    }
                });
            }
        }
    });
    return associations;
}

function getSettings(): Settings {
    const httpSettings = workspace.getConfiguration('http');

    const resultLimit: number =
        Math.trunc(
            Math.max(0, Number(workspace.getConfiguration().get('json.maxItemsComputed')))
        ) || 5000;

    const settings: Settings = {
        http: {
            proxy: httpSettings.get('proxy'),
            proxyStrictSSL: httpSettings.get('proxyStrictSSL'),
        },
        json: {
            schemas: [],
            resultLimit,
        },
    };
    const schemaSettingsById: { [schemaId: string]: JSONSchemaSettings } = Object.create(null);
    const collectSchemaSettings = (
        schemaSettings: JSONSchemaSettings[],
        folderUri?: Uri,
        isMultiRoot?: boolean
    ) => {
        let fileMatchPrefix: string | undefined = undefined;
        if (folderUri && isMultiRoot) {
            fileMatchPrefix = folderUri.toString();
            if (fileMatchPrefix[fileMatchPrefix.length - 1] === '/') {
                fileMatchPrefix = fileMatchPrefix.substr(0, fileMatchPrefix.length - 1);
            }
        }
        for (const setting of schemaSettings) {
            const url = getSchemaId(setting, folderUri);
            if (!url) {
                continue;
            }
            let schemaSetting = schemaSettingsById[url];
            if (!schemaSetting) {
                schemaSetting = schemaSettingsById[url] = { url, fileMatch: [] };
                settings.json!.schemas!.push(schemaSetting);
            }
            const fileMatches = setting.fileMatch;
            if (Array.isArray(fileMatches)) {
                const resultingFileMatches = schemaSetting.fileMatch || [];
                schemaSetting.fileMatch = resultingFileMatches;
                const addMatch = (pattern: string) => {
                    //  filter duplicates
                    if (resultingFileMatches.indexOf(pattern) === -1) {
                        resultingFileMatches.push(pattern);
                    }
                };
                for (const fileMatch of fileMatches) {
                    if (fileMatchPrefix) {
                        if (fileMatch[0] === '/') {
                            addMatch(fileMatchPrefix + fileMatch);
                            addMatch(fileMatchPrefix + '/*' + fileMatch);
                        } else {
                            addMatch(fileMatchPrefix + '/' + fileMatch);
                            addMatch(fileMatchPrefix + '/*/' + fileMatch);
                        }
                    } else {
                        addMatch(fileMatch);
                    }
                }
            }
            if (setting.schema && !schemaSetting.schema) {
                schemaSetting.schema = setting.schema;
            }
        }
    };

    const folders = workspace.workspaceFolders;

    // merge global and folder settings. Qualify all file matches with the folder path.
    const globalSettings = workspace
        .getConfiguration('json', null)
        .get<JSONSchemaSettings[]>('schemas');
    if (Array.isArray(globalSettings)) {
        if (!folders) {
            collectSchemaSettings(globalSettings);
        }
    }
    if (folders) {
        const isMultiRoot = folders.length > 1;
        for (const folder of folders) {
            const folderUri = folder.uri;

            const schemaConfigInfo = workspace
                .getConfiguration('json', folderUri)
                .inspect<JSONSchemaSettings[]>('schemas');

            const folderSchemas = schemaConfigInfo!.workspaceFolderValue;
            if (Array.isArray(folderSchemas)) {
                collectSchemaSettings(folderSchemas, folderUri, isMultiRoot);
            }
            if (Array.isArray(globalSettings)) {
                collectSchemaSettings(globalSettings, folderUri, isMultiRoot);
            }
        }
    }
    return settings;
}

function getSchemaId(schema: JSONSchemaSettings, folderUri?: Uri): string | undefined {
    let url = schema.url;
    if (!url) {
        if (schema.schema) {
            url =
                schema.schema.id ||
                `vscode://schemas/custom/${encodeURIComponent(hash(schema.schema).toString(16))}`;
        }
    } else if (folderUri && (url[0] === '.' || url[0] === '/')) {
        url = joinPath(folderUri, url).toString();
    }
    return url;
}

function readJSONFile(location: string) {
    try {
        return JSON.parse(fs.readFileSync(location).toString());
    } catch (e) {
        console.log(`Problems reading ${location}: ${e}`);
        return {};
    }
}
