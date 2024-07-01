/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as vscode from 'vscode';
import { ConfigValue } from './configValue';
import { ConfigurationFile, ConfigurationList, isDesktopConfig } from './configurationFile';
import { defaultTestSymbols, showConfigErrorCommand } from './constants';
import { coverageContext } from './coverage';
import { DisposableStore, MutableDisposable } from './disposable';
import { IParsedNode, NodeKind, extract } from './extract';
import { last } from './iterable';
import { ICreateOpts, ItemType, getContainingItemsForFile, testMetadata } from './metadata';
import { TestRunner } from './runner';
import { ISourceMapMaintainer, SourceMapStore } from './source-map-store';

const diagnosticCollection = vscode.languages.createDiagnosticCollection('ext-test-duplicates');

export class Controller {
  private readonly disposable = new DisposableStore();
  public readonly configFile: ConfigurationFile;

  /**
   * Configuration list, used for moment-in-time operations. May change
   * as the file is modified.
   */
  private currentConfig?: ConfigurationList;

  /** Fired when the file associated with the controller is deleted. */
  public readonly onDidDelete: vscode.Event<void>;

  private readonly extractMode = this.disposable.add(
    new ConfigValue('extractSettings', defaultTestSymbols),
  );
  private readonly watcher = this.disposable.add(new MutableDisposable());
  private readonly didChangeEmitter = new vscode.EventEmitter<void>();
  private runProfiles = new Map<
    string,
    { run: vscode.TestRunProfile; debug: vscode.TestRunProfile; cover: vscode.TestRunProfile }
  >();

  /** Error item shown in the tree, if any. */
  private errorItem?: vscode.TestItem;

  /** Mapping of the top-level tests found in each compiled */
  private readonly testsInFiles = new Map<
    /* uri */ string,
    {
      hash: number;
      sourceMap: ISourceMapMaintainer;
      items: Map<string, vscode.TestItem>;
    }
  >();

  /** Change emitter used for testing, to pick up when the file watcher detects a chagne */
  public readonly onDidChange = this.didChangeEmitter.event;

  /** Gets run profiles the controller has registerd. */
  public get profiles() {
    return [...this.runProfiles.values()].flatMap((o) => Object.values(o));
  }

  constructor(
    public readonly ctrl: vscode.TestController,
    private readonly wf: vscode.WorkspaceFolder,
    private readonly smStore: SourceMapStore,
    configFileUri: vscode.Uri,
    private readonly runner: TestRunner,
    wrapper: ConfigValue<string | undefined>,
  ) {
    this.disposable.add(ctrl);
    this.configFile = this.disposable.add(new ConfigurationFile(configFileUri, wf, wrapper));
    this.onDidDelete = this.configFile.onDidDelete;

    const rescan = () => this.scanFiles();
    this.disposable.add(this.configFile.onDidChange(rescan));
    this.disposable.add(this.extractMode.onDidChange(rescan));
    ctrl.refreshHandler = () => {
      this.configFile.forget();
      rescan();
    };
    this.scanFiles();
  }

  public dispose() {
    this.disposable.dispose();
  }

  public async syncFile(uri: vscode.Uri, contents?: () => string) {
    this._syncFile(uri, contents?.());
  }

  private async _syncFile(uri: vscode.Uri, contents?: string) {
    if (!this.currentConfig) {
      await this.readConfig();
    }

    const includeViaConfigs = this.currentConfig?.includesTestFile(uri);
    if (!includeViaConfigs) {
      return;
    }

    contents ??= await fs.readFile(uri.fsPath, 'utf8');

    // avoid re-parsing if the contents are the same (e.g. if a file is edited
    // and then saved.)
    const previous = this.testsInFiles.get(uri.toString());
    const hash = createHash('sha256').update(contents).digest().readInt32BE(0);
    if (hash === previous?.hash) {
      return;
    }

    let tree: IParsedNode[];
    try {
      tree = extract(contents, this.extractMode.value);
    } catch (e) {
      this.deleteFileTests(uri.toString());
      return;
    }

    if (!tree.length) {
      this.deleteFileTests(uri.toString());
      return;
    }

    const smMaintainer = previous?.sourceMap ?? this.smStore.maintain(uri);
    const sourceMap = await smMaintainer.refresh(contents);
    const tags = includeViaConfigs.map((c) => new vscode.TestTag(`${c}`));
    const add = (
      parent: vscode.TestItem,
      node: IParsedNode,
      start: vscode.Location,
      end: vscode.Location,
    ): vscode.TestItem => {
      let item = parent.children.get(node.name);
      if (!item) {
        item = this.ctrl.createTestItem(node.name, node.name, start.uri);
        item.tags = tags;
        testMetadata.set(item, {
          type: node.kind === NodeKind.Suite ? ItemType.Suite : ItemType.Test,
        });
        parent.children.add(item);
      }
      item.range = new vscode.Range(start.range.start, end.range.end);
      item.error = node.error;

      const seen = new Map<string, vscode.TestItem>();
      for (const child of node.children) {
        const existing = seen.get(child.name);
        const start = sourceMap.originalPositionFor(child.startLine, child.startColumn - 1);
        const end =
          child.endLine !== undefined && child.endColumn !== undefined
            ? sourceMap.originalPositionFor(child.endLine, child.endColumn - 1)
            : start;
        if (existing) {
          addDuplicateDiagnostic(start, existing);
          continue;
        }

        seen.set(child.name, add(item, child, start, end));
      }

      for (const [id] of item.children) {
        if (!seen.has(id)) {
          item.children.delete(id);
        }
      }

      return item;
    };

    // We assume that all tests inside a top-level describe/test are from the same
    // source file. This is probably a good assumption. Likewise we assume that a single
    // a single describe/test is not split between different files.
    const newTestsInFile = new Map<string, vscode.TestItem>();
    for (const node of tree) {
      const start = sourceMap.originalPositionFor(node.startLine, node.startColumn - 1);
      const end =
        node.endLine !== undefined && node.endColumn !== undefined
          ? sourceMap.originalPositionFor(node.endLine, node.endColumn - 1)
          : start;
      const file = last(this.getContainingItemsForFile(start.uri, { compiledFile: uri, tags }))!
        .item!;
      diagnosticCollection.delete(start.uri);
      newTestsInFile.set(node.name, add(file, node, start, end));
    }

    if (previous) {
      for (const [id, test] of previous.items) {
        if (!newTestsInFile.has(id)) {
          (test.parent?.children ?? this.ctrl.items).delete(id);
        }
      }
    }

    this.testsInFiles.set(uri.toString(), { items: newTestsInFile, hash, sourceMap: smMaintainer });
    this.didChangeEmitter.fire();
  }

  private deleteFileTests(uriStr: string) {
    const previous = this.testsInFiles.get(uriStr);
    if (!previous) {
      return;
    }

    this.testsInFiles.delete(uriStr);
    for (const [id, item] of previous.items) {
      diagnosticCollection.delete(item.uri!);
      const itemsIt = this.getContainingItemsForFile(item.uri!);

      // keep 'deleteFrom' as the node to remove if there are no nested children
      let deleteFrom: { items: vscode.TestItemCollection; id: string } | undefined;
      let last: vscode.TestItemCollection | undefined;
      for (const { children, item } of itemsIt) {
        if (item && children.size === 1) {
          deleteFrom ??= { items: last || this.ctrl.items, id: item.id };
        } else {
          deleteFrom = undefined;
        }

        last = children;
      }

      if (!last!.get(id)) {
        break;
      }

      if (deleteFrom) {
        deleteFrom.items.delete(deleteFrom.id);
      } else {
        last!.delete(id);
      }
    }

    this.didChangeEmitter.fire();
  }

  private async startWatchingWorkspace() {
    // we need to watch for *every* change due to https://github.com/microsoft/vscode/issues/60813
    const watcher = (this.watcher.value = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.wf, `**/*`),
    ));

    watcher.onDidCreate((uri) => this._syncFile(uri));
    watcher.onDidChange((uri) => this._syncFile(uri));
    watcher.onDidDelete((uri) => {
      const prefix = uri.toString();
      for (const key of this.testsInFiles.keys()) {
        if (key === prefix || (key[prefix.length] === '/' && key.startsWith(prefix))) {
          this.deleteFileTests(key);
        }
      }
    });

    await this.scanFiles();
  }

  private handleScanError() {
    this.watcher.clear();
    for (const key of this.testsInFiles.keys()) {
      this.deleteFileTests(key);
    }
    const item = (this.errorItem = this.ctrl.createTestItem('error', 'Extension Test Error'));
    item.error = new vscode.MarkdownString(
      `[View details](command:${showConfigErrorCommand}?${encodeURIComponent(
        JSON.stringify([this.configFile.uri.toString()]),
      )})`,
    );
    item.error.isTrusted = true;
    this.ctrl.items.add(item);
  }

  /** Creates run profiles for each configuration in the extension tests */
  private applyRunHandlers(configs: ConfigurationList) {
    const oldRunHandlers = this.runProfiles;
    this.runProfiles = new Map();
    for (const [index, { config }] of configs.value.entries()) {
      if (!isDesktopConfig(config)) {
        continue; // web runs currently not supported by the CLI
      }

      const originalName = config.label || `Config #${index + 1}`;
      let name = originalName;
      for (let i = 2; this.runProfiles.has(name); i++) {
        name = `${originalName} #${i}`;
      }

      const userDataDir = this.tryGetUserDataDir(config.launchArgs || []);

      const doRun = this.runner.makeHandler(
        this.ctrl,
        this.configFile,
        index,
        false,
        name,
        userDataDir,
      );
      const doDebug = this.runner.makeHandler(
        this.ctrl,
        this.configFile,
        index,
        true,
        name,
        userDataDir,
      );
      const doCoverage = this.runner.makeHandler(
        this.ctrl,
        this.configFile,
        index,
        false,
        name,
        userDataDir,
        true,
      );

      const prev = oldRunHandlers.get(name);
      if (prev) {
        prev.run.runHandler = doRun;
        prev.debug.runHandler = doDebug;
        prev.cover.runHandler = doCoverage;

        this.runProfiles.set(name, prev);
        oldRunHandlers.delete(name);
        continue;
      }

      const profiles = {
        run: this.ctrl.createRunProfile(name, vscode.TestRunProfileKind.Run, doRun, true),
        debug: this.ctrl.createRunProfile(name, vscode.TestRunProfileKind.Debug, doDebug, true),
        cover: this.ctrl.createRunProfile(
          name,
          vscode.TestRunProfileKind.Coverage,
          doCoverage,
          true,
        ),
      };

      // coverage profile:
      profiles.cover.loadDetailedCoverage = coverageContext.loadDetailedCoverage;

      for (const profile of Object.values(profiles)) {
        profile.tag = new vscode.TestTag(`${index}`);
      }

      this.runProfiles.set(name, profiles);
    }

    for (const profiles of oldRunHandlers.values()) {
      for (const profile of Object.values(profiles)) {
        profile.dispose();
      }
    }
  }

  private tryGetUserDataDir(args: string[]): string | undefined {
    const uddArg = '--user-data-dir';

    const idx = args.indexOf(uddArg);
    if (idx !== -1) {
      return args[idx + 1];
    }

    const prefix = `${uddArg}=`;
    const prefixed = args.find((a) => a.startsWith(prefix));
    return prefixed ? prefixed.slice(prefix.length) : undefined;
  }

  private async readConfig() {
    let configs: ConfigurationList;
    try {
      configs = await this.configFile.read();
    } catch {
      this.handleScanError();
      return;
    }

    if (configs !== this.currentConfig) {
      this.applyRunHandlers(configs);
      this.currentConfig = configs;
    }

    return configs;
  }

  public async scanFiles() {
    if (this.errorItem) {
      this.ctrl.items.delete(this.errorItem.id);
      this.errorItem = undefined;
    }

    if (!this.watcher.value) {
      // starting the watcher will call this again
      return this.startWatchingWorkspace();
    }

    const configs = await this.readConfig();
    if (!configs) {
      return;
    }

    const toRemove = new Set(this.testsInFiles.keys());
    const rough = configs.roughIncludedFiles();
    const seen = new Set<string>();
    const todo2: Promise<void>[] = [];

    const processFile = (file: vscode.Uri) => {
      if (!seen.has(file.toString())) {
        todo2.push(this._syncFile(file));
        toRemove.delete(file.toString());
        seen.add(file.toString());
      }
    };

    rough.files.forEach((f) => processFile(vscode.Uri.file(f)));
    const todo = rough.patterns.map(async (pattern) => {
      const relativePattern = new vscode.RelativePattern(this.wf, pattern);
      for (const file of await vscode.workspace.findFiles(relativePattern)) {
        processFile(file);
      }
    });

    // find all patterns:
    await Promise.all(todo);
    // process all files:
    await Promise.all(todo2);

    for (const uriStr of toRemove) {
      this.deleteFileTests(uriStr);
    }

    if (this.testsInFiles.size === 0) {
      this.watcher.clear(); // stop watching if there are no tests discovered
    }
  }

  /** Gets the test collection for a file of the given URI, descending from the root. */
  private getContainingItemsForFile(uri: vscode.Uri, createOpts?: ICreateOpts) {
    return getContainingItemsForFile(this.configFile.uri, this.ctrl, uri, createOpts);
  }
}

const addDuplicateDiagnostic = (location: vscode.Location, existing: vscode.TestItem) => {
  const diagnostic = new vscode.Diagnostic(
    location.range,
    'Duplicate tests cannot be run individually and will not be reported correctly by the test framework. Please rename them.',
    vscode.DiagnosticSeverity.Warning,
  );

  diagnostic.relatedInformation = [
    new vscode.DiagnosticRelatedInformation(
      new vscode.Location(existing.uri!, existing.range!),
      'First declared here',
    ),
  ];

  diagnosticCollection.set(
    location.uri,
    diagnosticCollection.get(location.uri)?.concat([diagnostic]) || [diagnostic],
  );
};
