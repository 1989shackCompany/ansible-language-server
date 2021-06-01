import IntervalTree from '@flatten-js/interval-tree';
import * as child_process from 'child_process';
import { promises as fs } from 'fs';
import { ExecException } from 'child_process';
import { URL } from 'url';
import * as path from 'path';
import { promisify } from 'util';
import {
  Connection,
  Diagnostic,
  DiagnosticSeverity,
  DidChangeWatchedFilesParams,
  Position,
  Range,
  TextDocumentContentChangeEvent,
} from 'vscode-languageserver';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { parseAllDocuments } from 'yaml';
import { IAnsibleLintConfig } from '../interfaces/ansibleLintConfig';
import { fileExists, hasOwnProperty } from '../utils/misc';
import { WorkspaceFolderContext } from './workspaceManager';
const exec = promisify(child_process.exec);

/**
 * Acts as and interface to ansible-lint and a cache of its output.
 *
 * ansible-lint may provide diagnostics for more than just the file for which
 * linting was triggered, and this is reflected in the implementation.
 */
export class AnsibleLint {
  private connection: Connection;
  private context: WorkspaceFolderContext;
  private validationCache: Map<string, IntervalTree<Diagnostic>> = new Map();
  private useProgressTracker = false;
  private configCache: Map<string, IAnsibleLintConfig> = new Map();

  constructor(connection: Connection, context: WorkspaceFolderContext) {
    this.connection = connection;
    this.context = context;
    this.useProgressTracker =
      !!context.clientCapabilities.window?.workDoneProgress;
  }

  /**
   * Perform linting for the given document.
   *
   * In case no errors are found for the current document, then only the cache
   * is cleared, and not the diagnostics on the client side. That way old
   * diagnostics will persist until the file is changed. This allows inspecting
   * more complex errors reported in other files.
   */
  public async doValidate(
    textDocument: TextDocument
  ): Promise<Map<string, Diagnostic[]>> {
    const docPath = new URL(textDocument.uri).pathname;
    let diagnostics: Map<string, Diagnostic[]> = new Map();
    let progressTracker;
    if (this.useProgressTracker) {
      progressTracker = await this.connection.window.createWorkDoneProgress();
    }

    const ansibleLintConfigPromise = this.getAnsibleLintConfig(
      textDocument.uri
    );

    const workingDirectory = path.dirname(new URL(textDocument.uri).pathname);

    try {
      const settings = await this.context.documentSettings.get(
        textDocument.uri
      );

      if (settings.ansibleLint.enabled) {
        if (progressTracker) {
          progressTracker.begin(
            'ansible-lint',
            undefined,
            'Processing files...'
          );
        }
        const result = await exec(
          `${settings.ansibleLint.path} --offline --nocolor -f codeclimate ${docPath}`,
          {
            encoding: 'utf-8',
            cwd: workingDirectory,
          }
        );
        diagnostics = this.processReport(
          result.stdout,
          await ansibleLintConfigPromise,
          workingDirectory
        );

        if (result.stderr) {
          this.connection.console.info(`[ansible-lint] ${result.stderr}`);
        }
      }
    } catch (error) {
      if (error instanceof Error) {
        const execError = error as ExecException & {
          // according to the docs, these are always available
          stdout: string;
          stderr: string;
        };
        if (execError.code === 2) {
          diagnostics = this.processReport(
            execError.stdout,
            await ansibleLintConfigPromise,
            workingDirectory
          );
        } else {
          this.connection.window.showErrorMessage(execError.message);
        }

        if (execError.stderr) {
          this.connection.console.info(`[ansible-lint] ${execError.stderr}`);
        }
      } else {
        this.connection.console.error(
          `Exception in AnsibleLint service: ${JSON.stringify(error)}`
        );
      }
    }

    // (re-)set validation cache for file that triggered validation
    this.validationCache.set(textDocument.uri, new IntervalTree<Diagnostic>());

    for (const [fileUri, fileDiagnostics] of diagnostics) {
      // (re-)set validation cache for each impacted file
      const diagnosticTree = new IntervalTree<Diagnostic>();
      this.validationCache.set(fileUri, diagnosticTree);

      for (const diagnostic of fileDiagnostics) {
        diagnosticTree.insert(
          [diagnostic.range.start.line, diagnostic.range.end.line],
          diagnostic
        );
      }
    }
    if (progressTracker) {
      progressTracker.done();
    }
    return diagnostics;
  }

  private processReport(
    result: string,
    ansibleLintConfig: IAnsibleLintConfig | undefined,
    workingDirectory: string
  ): Map<string, Diagnostic[]> {
    const diagnostics: Map<string, Diagnostic[]> = new Map();
    const report = JSON.parse(result);
    if (report instanceof Array) {
      for (const item of report) {
        if (
          typeof item.check_name === 'string' &&
          item.location &&
          typeof item.location.path === 'string' &&
          item.location.lines &&
          (item.location.lines.begin ||
            typeof item.location.lines.begin === 'number')
        ) {
          const begin_line =
            item.location.lines.begin.line || item.location.lines.begin || 1;
          const begin_column = item.location.lines.begin.column || 1;
          const start: Position = {
            line: begin_line - 1,
            character: begin_column - 1,
          };
          const end: Position = {
            line: begin_line - 1,
            character: Number.MAX_SAFE_INTEGER,
          };
          const range: Range = {
            start: start,
            end: end,
          };

          let severity: DiagnosticSeverity = DiagnosticSeverity.Error;
          if (ansibleLintConfig) {
            const lintRuleName = (item.check_name as string).match(
              /\[(?<name>[a-z\-]+)\].*/
            )?.groups?.name;

            if (lintRuleName && ansibleLintConfig.warnList.has(lintRuleName)) {
              severity = DiagnosticSeverity.Warning;
            }

            const categories = item.categories;
            if (categories instanceof Array) {
              if (categories.some((c) => ansibleLintConfig.warnList.has(c))) {
                severity = DiagnosticSeverity.Warning;
              }
            }
          }

          const locationUri = `file://${workingDirectory}/${item.location.path}`;

          let fileDiagnostics = diagnostics.get(locationUri);
          if (!fileDiagnostics) {
            fileDiagnostics = [];
            diagnostics.set(locationUri, fileDiagnostics);
          }
          fileDiagnostics.push({
            message: item.check_name,
            range: range || Range.create(0, 0, 0, 0),
            severity: severity,
            source: 'Ansible',
          });
        }
      }
    }
    return diagnostics;
  }

  public invalidateCacheItems(
    fileUri: string,
    changes: TextDocumentContentChangeEvent[]
  ): void {
    const diagnosticTree = this.validationCache.get(fileUri);
    if (diagnosticTree) {
      for (const change of changes) {
        if ('range' in change) {
          const influencedDiagnostics = diagnosticTree.search([
            change.range.start.line,
            change.range.end.line,
          ]);
          if (influencedDiagnostics) {
            for (const diagnostic of influencedDiagnostics as Array<Diagnostic>) {
              diagnosticTree.remove(
                [diagnostic.range.start.line, diagnostic.range.end.line],
                diagnostic
              );
            }
          }
        }
      }
    }
  }

  public getValidationFromCache(fileUri: string): Diagnostic[] | undefined {
    return this.validationCache.get(fileUri)?.values;
  }

  public handleWatchedDocumentChange(
    params: DidChangeWatchedFilesParams
  ): void {
    for (const fileEvent of params.changes) {
      // remove from cache on any change
      this.configCache.delete(fileEvent.uri);
    }
  }

  private async getAnsibleLintConfig(
    uri: string
  ): Promise<IAnsibleLintConfig | undefined> {
    const configPath = await this.getAnsibleLintConfigPath(uri);
    if (configPath) {
      let config = this.configCache.get(configPath);
      if (!config) {
        config = await this.readAnsibleLintConfig(configPath);
        this.configCache.set(configPath, config);
      }
      return config;
    }
  }

  private async readAnsibleLintConfig(
    configPath: string
  ): Promise<IAnsibleLintConfig> {
    const config = {
      warnList: new Set<string>(),
    };
    try {
      const configContents = await fs.readFile(new URL(configPath), {
        encoding: 'utf8',
      });
      parseAllDocuments(configContents).forEach((configDoc) => {
        const configObject: unknown = configDoc.toJSON();
        if (
          hasOwnProperty(configObject, 'warn_list') &&
          configObject.warn_list instanceof Array
        ) {
          for (const warn_item of configObject.warn_list) {
            if (typeof warn_item === 'string') {
              config.warnList.add(warn_item);
            }
          }
        }
      });
    } catch (error) {
      this.connection.window.showErrorMessage(error);
    }
    return config;
  }

  private async getAnsibleLintConfigPath(
    uri: string
  ): Promise<string | undefined> {
    // find configuration path
    let configPath;
    const pathArray = uri.split('/');

    // Find first configuration file going up until workspace root
    for (let index = pathArray.length - 1; index >= 0; index--) {
      const candidatePath = pathArray
        .slice(0, index)
        .concat('.ansible-lint')
        .join('/');
      if (!candidatePath.startsWith(this.context.workspaceFolder.uri)) {
        // we've gone out of the workspace folder
        break;
      }
      if (await fileExists(candidatePath)) {
        configPath = candidatePath;
        break;
      }
    }
    return configPath;
  }
}