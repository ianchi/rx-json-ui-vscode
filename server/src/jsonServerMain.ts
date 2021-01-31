/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Copyright (c) Adrian Panella
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
    TextDocuments,
    InitializeParams,
    InitializeResult,
    NotificationType,
    RequestType,
    ServerCapabilities,
    TextDocumentSyncKind,
} from 'vscode-languageserver';
import { createConnection } from 'vscode-languageserver/node';

import {
    xhr,
    XHRResponse,
    configure as configureHttpRequests,
    getErrorStatusDescription,
} from 'request-light';
import * as fs from 'fs';
import { URI } from 'vscode-uri';
import { setTimeout, clearTimeout } from 'timers';
import { formatError, runSafeAsync } from './utils/runner';
import {
    TextDocument,
    JSONDocument,
    JSONSchema,
    getLanguageService,
    SchemaConfiguration,
    ClientCapabilities,
    SchemaRequestService,
    Diagnostic,
} from 'vscode-json-languageservice';
import { getLanguageModelCache } from './languageModelCache';
import { validateExpr, hoverData } from 'rx-json-ui-cli/languageservice';
import { resolvePath } from './utils/requests';

interface ISchemaAssociations {
    [pattern: string]: string[];
}

interface ISchemaAssociation {
    fileMatch: string[];
    uri: string;
}

namespace SchemaAssociationNotification {
    export const type: NotificationType<
        ISchemaAssociations | ISchemaAssociation[]
    > = new NotificationType('json/schemaAssociations');
}

namespace VSCodeContentRequest {
    export const type: RequestType<string, string, any> = new RequestType('vscode/content');
}

namespace SchemaContentChangeNotification {
    export const type: NotificationType<string> = new NotificationType('json/schemaContent');
}

namespace ForceValidateRequest {
    export const type: RequestType<string, Diagnostic[], any> = new RequestType('json/validate');
}

// Create a connection for the server
const connection = createConnection();

process.on('unhandledRejection', (e: any) => {
    console.error(formatError(`Unhandled exception`, e));
});
process.on('uncaughtException', (e: any) => {
    console.error(formatError(`Unhandled exception`, e));
});

console.log = connection.console.log.bind(connection.console);
console.error = connection.console.error.bind(connection.console);

const workspaceContext = {
    resolveRelativePath: (relativePath: string, resource: string) => {
        const base = resource.substr(0, resource.lastIndexOf('/') + 1);
        return resolvePath(base, relativePath);
    },
};

const fileRequestService: SchemaRequestService = (uri: string) => {
    const fsPath = URI.parse(uri).fsPath;
    return new Promise<string>((c, e) => {
        fs.readFile(fsPath, 'UTF-8', (err, result) => {
            err ? e(err.message || err.toString()) : c(result.toString());
        });
    });
};

const httpRequestService: SchemaRequestService = (uri: string) => {
    const headers = { 'Accept-Encoding': 'gzip, deflate' };
    return xhr({ url: uri, followRedirects: 5, headers }).then(
        response => {
            return response.responseText;
        },
        (error: XHRResponse) => {
            return Promise.reject(
                error.responseText || getErrorStatusDescription(error.status) || error.toString()
            );
        }
    );
};

function getSchemaRequestService(handledSchemas: string[] = ['https', 'http', 'file']) {
    const builtInHandlers: { [protocol: string]: SchemaRequestService } = {};
    for (let protocol of handledSchemas) {
        if (protocol === 'file') {
            builtInHandlers[protocol] = fileRequestService;
        } else if (protocol === 'http' || protocol === 'https') {
            builtInHandlers[protocol] = httpRequestService;
        }
    }
    return (uri: string): Thenable<string> => {
        const protocol = uri.substr(0, uri.indexOf(':'));

        const builtInHandler = builtInHandlers[protocol];
        if (builtInHandler) {
            return builtInHandler(uri);
        }
        return connection.sendRequest(VSCodeContentRequest.type, uri).then(
            responseText => {
                return responseText;
            },
            error => {
                return Promise.reject(error.message);
            }
        );
    };
}

// create the JSON language service
let languageService = getLanguageService({
    workspaceContext,
    contributions: [],
    clientCapabilities: ClientCapabilities.LATEST,
});

// Create a text document manager.
const documents = new TextDocuments(TextDocument);

// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

// After the server has started the client sends an initialize request. The server receives
// in the passed params the rootPath of the workspace plus the client capabilities.
connection.onInitialize(
    (params: InitializeParams): InitializeResult => {
        const handledProtocols = params.initializationOptions?.handledSchemaProtocols;

        languageService = getLanguageService({
            schemaRequestService: getSchemaRequestService(handledProtocols),
            workspaceContext,
            contributions: [],
            clientCapabilities: params.capabilities,
        });

        const capabilities: ServerCapabilities = {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            hoverProvider: true,
        };

        return { capabilities };
    }
);

// The settings interface describes the server relevant settings part
interface Settings {
    json: {
        schemas: JSONSchemaSettings[];
        format: { enable: boolean };
        resultLimit?: number;
    };
    http: {
        proxy: string;
        proxyStrictSSL: boolean;
    };
}

interface JSONSchemaSettings {
    fileMatch?: string[];
    url?: string;
    schema?: JSONSchema;
}

namespace LimitExceededWarnings {
    const pendingWarnings: {
        [uri: string]: { features: { [name: string]: string }; timeout?: NodeJS.Timeout };
    } = {};

    export function cancel(uri: string) {
        const warning = pendingWarnings[uri];
        if (warning && warning.timeout) {
            clearTimeout(warning.timeout);
            delete pendingWarnings[uri];
        }
    }
}

let jsonConfigurationSettings: JSONSchemaSettings[] | undefined = undefined;
let schemaAssociations: ISchemaAssociations | ISchemaAssociation[] | undefined = undefined;

// The settings have changed. Is send on server activation as well.
connection.onDidChangeConfiguration(change => {
    let settings = <Settings>change.settings;
    configureHttpRequests(
        settings.http && settings.http.proxy,
        settings.http && settings.http.proxyStrictSSL
    );

    jsonConfigurationSettings = settings.json && settings.json.schemas;
    updateConfiguration();
});

// The jsonValidation extension configuration has changed
connection.onNotification(SchemaAssociationNotification.type, associations => {
    schemaAssociations = associations;
    updateConfiguration();
});

// A schema has changed
connection.onNotification(SchemaContentChangeNotification.type, uri => {
    languageService.resetSchema(uri);
});

// Retry schema validation on all open documents
connection.onRequest(ForceValidateRequest.type, uri => {
    return new Promise<Diagnostic[]>(resolve => {
        const document = documents.get(uri);
        if (document) {
            updateConfiguration();
            validateTextDocument(document, diagnostics => {
                resolve(diagnostics);
            });
        } else {
            resolve([]);
        }
    });
});

function updateConfiguration() {
    const languageSettings = {
        validate: true,
        allowComments: true,
        schemas: new Array<SchemaConfiguration>(),
    };
    if (schemaAssociations) {
        if (Array.isArray(schemaAssociations)) {
            Array.prototype.push.apply(languageSettings.schemas, schemaAssociations);
        } else {
            for (const pattern in schemaAssociations) {
                const association = schemaAssociations[pattern];
                if (Array.isArray(association)) {
                    association.forEach(uri => {
                        languageSettings.schemas.push({ uri, fileMatch: [pattern] });
                    });
                }
            }
        }
    }
    if (jsonConfigurationSettings) {
        jsonConfigurationSettings.forEach((schema, index) => {
            let uri = schema.url;
            if (!uri && schema.schema) {
                uri = schema.schema.id || `vscode://schemas/custom/${index}`;
            }
            if (uri) {
                languageSettings.schemas.push({
                    uri,
                    fileMatch: schema.fileMatch,
                    schema: schema.schema,
                });
            }
        });
    }
    languageService.configure(languageSettings);

    // Revalidate any open text documents
    documents.all().forEach(triggerValidation);
}

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent(change => {
    LimitExceededWarnings.cancel(change.document.uri);
    triggerValidation(change.document);
});

// a document has closed: clear all diagnostics
documents.onDidClose(event => {
    LimitExceededWarnings.cancel(event.document.uri);
    cleanPendingValidation(event.document);
    connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
});

const pendingValidationRequests: { [uri: string]: NodeJS.Timer } = {};
const validationDelayMs = 500;

function cleanPendingValidation(textDocument: TextDocument): void {
    const request = pendingValidationRequests[textDocument.uri];
    if (request) {
        clearTimeout(request);
        delete pendingValidationRequests[textDocument.uri];
    }
}

function triggerValidation(textDocument: TextDocument): void {
    cleanPendingValidation(textDocument);
    pendingValidationRequests[textDocument.uri] = setTimeout(() => {
        delete pendingValidationRequests[textDocument.uri];
        validateTextDocument(textDocument);
    }, validationDelayMs);
}

function validateTextDocument(
    textDocument: TextDocument,
    callback?: (diagnostics: Diagnostic[]) => void
): void {
    const respond = (diagnostics: Diagnostic[]) => {
        connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
        if (callback) {
            callback(diagnostics);
        }
    };
    if (textDocument.getText().length === 0) {
        respond([]); // ignore empty documents
        return;
    }
    const jsonDocument = getJSONDocument(textDocument);
    const version = textDocument.version;

    validateExpr(languageService, textDocument, jsonDocument).then(
        diagnostics => {
            setTimeout(() => {
                const currDocument = documents.get(textDocument.uri);
                if (currDocument && currDocument.version === version) {
                    respond(diagnostics); // Send the computed diagnostics to VSCode.
                }
            }, 100);
        },
        error => {
            connection.console.error(
                formatError(`Error while validating ${textDocument.uri}`, error)
            );
        }
    );
}

connection.onDidChangeWatchedFiles(change => {
    // Monitored files have changed in VSCode
    let hasChanges = false;
    change.changes.forEach(c => {
        if (languageService.resetSchema(c.uri)) {
            hasChanges = true;
        }
    });
    if (hasChanges) {
        documents.all().forEach(triggerValidation);
    }
});

const jsonDocuments = getLanguageModelCache<JSONDocument>(10, 60, document =>
    languageService.parseJSONDocument(document)
);
documents.onDidClose(e => {
    jsonDocuments.onDocumentRemoved(e.document);
});
connection.onShutdown(() => {
    jsonDocuments.dispose();
});

function getJSONDocument(document: TextDocument): JSONDocument {
    return jsonDocuments.get(document);
}

connection.onHover((textDocumentPositionParams, token) => {
    return runSafeAsync(
        async () => {
            const document = documents.get(textDocumentPositionParams.textDocument.uri);
            if (document) {
                const jsonDocument = getJSONDocument(document);
                return hoverData(
                    languageService,
                    document,
                    jsonDocument,
                    textDocumentPositionParams.position
                );
            }
            return null;
        },
        null,
        `Error while computing hover for ${textDocumentPositionParams.textDocument.uri}`,
        token
    );
});

// Listen on the connection
connection.listen();
