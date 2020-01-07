/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Copyright (c) Adrian Panella
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as fs from 'fs';
import { xhr, XHRResponse, getErrorStatusDescription } from 'request-light';

import { workspace, ExtensionContext, extensions, Uri } from 'vscode';
import {
    LanguageClient,
    LanguageClientOptions,
    RequestType,
    ServerOptions,
    TransportKind,
    NotificationType,
    DidChangeConfigurationNotification,
    ResponseError,
} from 'vscode-languageclient';

import { hash } from './utils/hash';

namespace VSCodeContentRequest {
    export const type: RequestType<string, string, any, any> = new RequestType('vscode/content');
}

namespace SchemaContentChangeNotification {
    export const type: NotificationType<string, any> = new NotificationType('json/schemaContent');
}

export interface ISchemaAssociations {
    [pattern: string]: string[];
}

namespace SchemaAssociationNotification {
    export const type: NotificationType<ISchemaAssociations, any> = new NotificationType(
        'json/schemaAssociations'
    );
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
    let clientOptions: LanguageClientOptions = {
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
    let client = new LanguageClient(
        'json',
        'rx-json-ui Language Server',
        serverOptions,
        clientOptions,
        true
    );
    client.registerProposedFeatures();

    let disposable = client.start();
    toDispose.push(disposable);
    client.onReady().then(() => {
        const schemaDocuments: { [uri: string]: boolean } = {};

        // handle content request
        client.onRequest(VSCodeContentRequest.type, (uriPath: string) => {
            let uri = Uri.parse(uriPath);
            if (uri.scheme !== 'http' && uri.scheme !== 'https') {
                return workspace.openTextDocument(uri).then(
                    doc => {
                        schemaDocuments[uri.toString()] = true;
                        return doc.getText();
                    },
                    error => {
                        return Promise.reject(error);
                    }
                );
            } else {
                const headers = { 'Accept-Encoding': 'gzip, deflate' };
                return xhr({ url: uriPath, followRedirects: 5, headers }).then(
                    response => {
                        return response.responseText;
                    },
                    (error: XHRResponse) => {
                        let extraInfo = error.responseText || error.toString();
                        if (extraInfo.length > 256) {
                            extraInfo = `${extraInfo.substr(0, 256)}...`;
                        }
                        return Promise.reject(
                            new ResponseError(
                                error.status,
                                getErrorStatusDescription(error.status) + '\n' + extraInfo
                            )
                        );
                    }
                );
            }
        });

        let handleContentChange = (uriString: string) => {
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

        client.sendNotification(SchemaAssociationNotification.type, getSchemaAssociation(context));

        extensions.onDidChange(_ => {
            client.sendNotification(
                SchemaAssociationNotification.type,
                getSchemaAssociation(context)
            );
        });
    });
}

function getSchemaAssociation(_context: ExtensionContext): ISchemaAssociations {
    let associations: ISchemaAssociations = {};
    extensions.all.forEach(extension => {
        let packageJSON = extension.packageJSON;
        if (packageJSON && packageJSON.contributes && packageJSON.contributes.jsonValidation) {
            let jsonValidation = packageJSON.contributes.jsonValidation;
            if (Array.isArray(jsonValidation)) {
                jsonValidation.forEach(jv => {
                    let { fileMatch, url } = jv;
                    if (fileMatch && url) {
                        if (url[0] === '.' && url[1] === '/') {
                            url = Uri.file(path.join(extension.extensionPath, url)).toString();
                        }
                        if (fileMatch[0] === '%') {
                            fileMatch = fileMatch.replace(/%APP_SETTINGS_HOME%/, '/User');
                            fileMatch = fileMatch.replace(/%MACHINE_SETTINGS_HOME%/, '/Machine');
                            fileMatch = fileMatch.replace(/%APP_WORKSPACES_HOME%/, '/Workspaces');
                        } else if (fileMatch.charAt(0) !== '/' && !fileMatch.match(/\w+:\/\//)) {
                            fileMatch = '/' + fileMatch;
                        }
                        let association = associations[fileMatch];
                        if (!association) {
                            association = [];
                            associations[fileMatch] = association;
                        }
                        association.push(url);
                    }
                });
            }
        }
    });
    return associations;
}

function getSettings(): Settings {
    let httpSettings = workspace.getConfiguration('http');

    let resultLimit: number =
        Math.trunc(
            Math.max(0, Number(workspace.getConfiguration().get('json.maxItemsComputed')))
        ) || 5000;

    let settings: Settings = {
        http: {
            proxy: httpSettings.get('proxy'),
            proxyStrictSSL: httpSettings.get('proxyStrictSSL'),
        },
        json: {
            schemas: [],
            resultLimit,
        },
    };
    let schemaSettingsById: { [schemaId: string]: JSONSchemaSettings } = Object.create(null);
    let collectSchemaSettings = (
        schemaSettings: JSONSchemaSettings[],
        rootPath?: string,
        fileMatchPrefix?: string
    ) => {
        for (let setting of schemaSettings) {
            let url = getSchemaId(setting, rootPath);
            if (!url) {
                continue;
            }
            let schemaSetting = schemaSettingsById[url];
            if (!schemaSetting) {
                schemaSetting = schemaSettingsById[url] = { url, fileMatch: [] };
                settings.json!.schemas!.push(schemaSetting);
            }
            let fileMatches = setting.fileMatch;
            let resultingFileMatches = schemaSetting.fileMatch!;
            if (Array.isArray(fileMatches)) {
                if (fileMatchPrefix) {
                    for (let fileMatch of fileMatches) {
                        if (fileMatch[0] === '/') {
                            resultingFileMatches.push(fileMatchPrefix + fileMatch);
                            resultingFileMatches.push(fileMatchPrefix + '/*' + fileMatch);
                        } else {
                            resultingFileMatches.push(fileMatchPrefix + '/' + fileMatch);
                            resultingFileMatches.push(fileMatchPrefix + '/*/' + fileMatch);
                        }
                    }
                } else {
                    resultingFileMatches.push(...fileMatches);
                }
            }
            if (setting.schema) {
                schemaSetting.schema = setting.schema;
            }
        }
    };

    // merge global and folder settings. Qualify all file matches with the folder path.
    let globalSettings = workspace
        .getConfiguration('json', null)
        .get<JSONSchemaSettings[]>('schemas');
    if (Array.isArray(globalSettings)) {
        collectSchemaSettings(globalSettings, workspace.rootPath);
    }
    let folders = workspace.workspaceFolders;
    if (folders) {
        for (let folder of folders) {
            let folderUri = folder.uri;

            let schemaConfigInfo = workspace
                .getConfiguration('json', folderUri)
                .inspect<JSONSchemaSettings[]>('schemas');

            let folderSchemas = schemaConfigInfo!.workspaceFolderValue;
            if (Array.isArray(folderSchemas)) {
                let folderPath = folderUri.toString();
                if (folderPath[folderPath.length - 1] === '/') {
                    folderPath = folderPath.substr(0, folderPath.length - 1);
                }
                collectSchemaSettings(folderSchemas, folderUri.fsPath, folderPath);
            }
        }
    }
    return settings;
}

function getSchemaId(schema: JSONSchemaSettings, rootPath?: string) {
    let url = schema.url;
    if (!url) {
        if (schema.schema) {
            url =
                schema.schema.id ||
                `vscode://schemas/custom/${encodeURIComponent(hash(schema.schema).toString(16))}`;
        }
    } else if (rootPath && (url[0] === '.' || url[0] === '/')) {
        url = Uri.file(path.normalize(path.join(rootPath, url))).toString();
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
