/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/
import type { IDesktopTestConfiguration, TestConfiguration } from '@vscode/test-cli';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import resolveModule from 'enhanced-resolve';
import * as fs from 'fs';
import { minimatch } from 'minimatch';
import * as path from 'path';
import * as vscode from 'vscode';
import { ConfigValue } from './configValue';
import { cliPackageName } from './constants';
import { DisposableStore } from './disposable';
import { CliPackageMissing, ConfigProcessReadError, HumanError } from './errors';

export interface IResolvedConfiguration {
  env: Record<string, string>;
  extensionTestsPath: string;
  extensionDevelopmentPath: string;
  config: TestConfiguration;
  path: string;
}

const resolver = resolveModule.ResolverFactory.createResolver({
  fileSystem: new resolveModule.CachedInputFileSystem(fs, 4000),
  conditionNames: ['node', 'require', 'module'],
});

export class ConfigurationFile implements vscode.Disposable {
  private readonly ds = new DisposableStore();
  private readonly didDeleteEmitter = this.ds.add(new vscode.EventEmitter<void>());
  private readonly didChangeEmitter = this.ds.add(new vscode.EventEmitter<void>());

  /** Cached read promise, invalided on file change. */
  private readPromise?: Promise<ConfigurationList>;

  /** Fired when the file is deleted. */
  public readonly onDidDelete = this.didDeleteEmitter.event;

  /** Fired when the file changes. */
  public readonly onDidChange = this.didChangeEmitter.event;

  constructor(
    public readonly uri: vscode.Uri,
    public readonly wf: vscode.WorkspaceFolder,
    private readonly wrapper: ConfigValue<string | undefined>,
  ) {
    const watcher = this.ds.add(vscode.workspace.createFileSystemWatcher(uri.fsPath));
    let changeDebounce: NodeJS.Timeout | undefined;
    this.ds.add(
      watcher.onDidChange(() => {
        if (changeDebounce) {
          clearTimeout(changeDebounce);
        }
        changeDebounce = setTimeout(() => {
          changeDebounce = undefined;
          this.readPromise = undefined;
          this.didChangeEmitter.fire();
        }, 300);
      }),
    );

    this.ds.add(
      watcher.onDidDelete(() => {
        this.readPromise = undefined;
        this.didDeleteEmitter.fire();
      }),
    );

    this.ds.add(
      wrapper.onDidChange(() => {
        this.readPromise = undefined;
        this.didChangeEmitter.fire();
      }),
    );
  }

  /**
   * Reads the config file from disk.
   * @throws {HumanError} if anything goes wrong
   */
  public read() {
    return (this.readPromise ??= this._read());
  }

  /**
   * Clears any cached config read.
   */
  public forget() {
    this.readPromise = undefined;
  }

  /**
   * Spawns the test CLI associated with the configuration file using the
   * given args.
   */
  public async spawnCli(args: readonly string[]) {
    const cliPath = await this.resolveCli();
    const wrapper = this.wrapper.value;
    return await new Promise<ChildProcessWithoutNullStreams>((resolve, reject) => {
      const argvN = [cliPath, '--config', this.uri.fsPath, ...args];
      let argv0 = process.execPath;
      if (wrapper) {
        argvN.unshift(process.execPath);
        argv0 = wrapper;
      }

      const p = spawn(argv0, argvN, {
        cwd: path.dirname(this.uri.fsPath),
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      });
      p.on('spawn', () => resolve(p));
      p.on('error', reject);
    });
  }

  /**
   * Spawns the test CLI associated with the configuration file using the
   * given args, and captures its output.
   */
  public async captureCliJson<T>(args: readonly string[]) {
    const p = await this.spawnCli(args);
    return await new Promise<T>((resolve, reject) => {
      const output: Buffer[] = [];
      p.stdout.on('data', (chunk) => output.push(chunk));
      p.stderr.on('data', (chunk) => output.push(chunk));
      p.on('error', reject);
      p.on('close', (code) => {
        const joined = Buffer.concat(output).toString();
        if (code !== 0) {
          return reject(new ConfigProcessReadError(joined));
        }

        try {
          resolve(JSON.parse(joined));
        } catch {
          reject(new ConfigProcessReadError(`invalid JSON: ${joined}`));
        }
      });
    });
  }

  private async _read() {
    const configs = await this.captureCliJson<IResolvedConfiguration[]>(['--list-configuration']);
    return new ConfigurationList(this.uri, configs, this.wf);
  }

  /**
   * Resolves the path to the test runner CLI, a JavaScript file.
   * @throws {HumanError} if the module isn't found
   */
  public async resolveCli(suffix?: string) {
    return new Promise<string>((resolve, reject) =>
      resolver.resolve(
        {},
        this.uri.fsPath,
        suffix ? `${cliPackageName}/${suffix}` : cliPackageName,
        {},
        (err, res) => {
          if (err) {
            reject(new CliPackageMissing(err));
          } else {
            resolve(suffix ? (res as string) : path.join(path.dirname(res as string), 'bin.mjs'));
          }
        },
      ),
    );
  }

  /** @inheritdoc */
  public dispose() {
    this.ds.dispose();
  }
}

const toForwardSlashes = (p: string) => p.replace(/\\/g, '/');

export const isDesktopConfig = (cfg: TestConfiguration): cfg is IDesktopTestConfiguration =>
  !cfg.platform || cfg.platform === 'desktop';

export class ConfigurationList {
  private readonly patterns: (
    | { glob: false; value: string }
    | { glob: true; value: string; workspaceFolderRelativeGlob: string }
  )[][];

  constructor(
    public readonly uri: vscode.Uri,
    public readonly value: IResolvedConfiguration[],
    wf: vscode.WorkspaceFolder,
  ) {
    this.patterns = value.map(({ config }) => {
      const files = typeof config.files === 'string' ? [config.files] : config.files;
      return files.map((f) => {
        if (path.isAbsolute(f)) {
          return { glob: false, value: path.normalize(f) };
        } else {
          const cfgDir = path.dirname(this.uri.fsPath);
          return {
            glob: true,
            value: toForwardSlashes(path.join(cfgDir, f)),
            workspaceFolderRelativeGlob: toForwardSlashes(
              path.join(path.relative(wf.uri.fsPath, cfgDir), f),
            ),
          };
        }
      });
    });
  }

  /**
   * Returns a rough list of glob patterns and files that are included by the
   * test configurations.
   */
  public roughIncludedFiles() {
    const patterns = new Set<string>();
    const files = new Set<string>();
    for (const patternList of this.patterns) {
      for (const p of patternList) {
        if (p.value.startsWith('!')) {
          continue;
        }

        if (p.glob) {
          patterns.add(p.workspaceFolderRelativeGlob);
        } else {
          files.add(p.value);
        }
      }
    }

    return { patterns: [...patterns], files: [...files] };
  }

  /** Gets the configs the given test file is included by, if any. */
  public includesTestFile(uri: vscode.Uri) {
    const file = toForwardSlashes(uri.fsPath);
    let indexes: number[] | undefined;

    for (const [i, patterns] of this.patterns.entries()) {
      let matched = false;
      for (let { glob, value } of patterns) {
        let negated = false;
        if (value.startsWith('!')) {
          negated = true;
          value = value.slice(1);
        }

        if (glob ? minimatch(file, value) : value === path.normalize(file)) {
          matched = !negated;
        }
      }

      if (matched) {
        indexes ??= [];
        indexes.push(i);
      }
    }

    return indexes;
  }
}
