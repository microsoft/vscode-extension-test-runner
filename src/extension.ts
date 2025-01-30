import * as path from 'path';
import * as timers from 'timers/promises';
import * as vscode from 'vscode';
import { ConfigValue } from './configValue';
import {
  configFilePattern,
  getControllersForTestCommand,
  showConfigErrorCommand,
} from './constants';
import { Controller } from './controller';
import { TestRunner } from './runner';
import { SourceMapStore } from './source-map-store';

const enum FolderSyncState {
  Idle,
  Syncing,
  ReSyncNeeded,
}

export function activate(context: vscode.ExtensionContext) {
  const smStore = new SourceMapStore();
  const wrapperCfg = new ConfigValue<string | string[] | undefined>('wrapper', undefined);
  const runner = new TestRunner(smStore, new ConfigValue('debugOptions', {}), wrapperCfg);

  let ctrls: Controller[] = [];
  let resyncState: FolderSyncState = FolderSyncState.Idle;

  const syncWorkspaceFolders = async () => {
    if (resyncState === FolderSyncState.Syncing) {
      resyncState = FolderSyncState.ReSyncNeeded;
    }
    if (resyncState !== FolderSyncState.Idle) {
      return;
    }

    resyncState = FolderSyncState.Syncing;
    ctrls.forEach((c) => c.dispose());
    ctrls = [];

    const folders = vscode.workspace.workspaceFolders ?? [];
    await Promise.all(
      folders.map(async (folder) => {
        const files = await vscode.workspace.findFiles(
          new vscode.RelativePattern(folder, configFilePattern),
        );
        for (const file of files) {
          const rel = path.relative(folder.uri.fsPath, path.dirname(file.fsPath));
          const ctrl = vscode.tests.createTestController(
            file.toString(),
            rel
              ? folders.length > 1
                ? `Extension (${folder.name}: ${rel})`
                : `Extension (${rel})`
              : folders.length > 1 
                ? `VS Code Extension (${folder.name})`
                : 'VS Code Extension',
          );

          ctrls.push(new Controller(ctrl, folder, smStore, file, runner, wrapperCfg));
        }
      }),
    );

    // cast is needed since TS incorrectly keeps resyncState narrowed to Syncing
    const prevState = resyncState as FolderSyncState;
    resyncState = FolderSyncState.Idle;
    if (prevState === FolderSyncState.ReSyncNeeded) {
      syncWorkspaceFolders();
    }
  };

  const openUntitledEditor = async (contents: string) => {
    const untitledDoc = await vscode.workspace.openTextDocument({ content: contents });
    await vscode.window.showTextDocument(untitledDoc);
  };

  const showConfigError = async (configUriStr: string) => {
    const configUri = vscode.Uri.parse(configUriStr);
    const ctrl = ctrls.find((c) => c.configFile.uri.toString() === configUri.toString());
    try {
      await ctrl?.configFile.read();
    } catch (e) {
      await openUntitledEditor(String(e));
      return;
    }

    vscode.window.showInformationMessage('No configuration error detected');
  };

  const initialSync = (async () => {
    // Workaround for vscode#179203 where findFiles doesn't work on startup.
    // This extension is only activated on workspaceContains, so we have pretty
    // high confidence that we should find something.
    for (let retries = 0; retries < 10; retries++) {
      await syncWorkspaceFolders();
      if (ctrls.length > 0) {
        break;
      }

      await timers.setTimeout(1000);
    }
  })();

  context.subscriptions.push(
    wrapperCfg,
    vscode.workspace.onDidChangeWorkspaceFolders(syncWorkspaceFolders),
    vscode.commands.registerCommand(showConfigErrorCommand, showConfigError),
    vscode.commands.registerCommand(getControllersForTestCommand, () =>
      initialSync.then(() => ctrls),
    ),
    new vscode.Disposable(() => ctrls.forEach((c) => c.dispose())),
  );
}

export function deactivate() {}
