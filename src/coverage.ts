/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { randomUUID } from 'crypto';
import { existsSync, promises as fs, mkdirSync } from 'fs';
import { IstanbulCoverage } from 'istanbul-to-vscode';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import * as vscode from 'vscode';
import { ConfigurationFile } from './configurationFile';

export class Coverage {
  private readonly targetDir = join(tmpdir(), `ext-coverage-${randomUUID()}`);
  public readonly args = [
    '--coverage',
    '--coverage-reporter',
    'json',
    '--coverage-output',
    this.targetDir,
  ];

  constructor(private readonly configFile: ConfigurationFile) {
    mkdirSync(this.targetDir, { recursive: true });
  }

  public async finalize(run: vscode.TestRun) {
    const coverageFile = join(this.targetDir, 'coverage-final.json');
    if (existsSync(coverageFile)) {
      try {
        const contents = JSON.parse(await fs.readFile(coverageFile, 'utf8'));
        const coverage = new IstanbulCoverage(contents);
        coverage.booleanCounts = true;
        run.coverageProvider = coverage;
      } catch (e) {
        vscode.window.showWarningMessage(`Error parsing test coverage: ${e}`);
      }
    } else {
      try {
        // if there wasn't the expected coverage file, check if that's because
        // their CLI version is too old
        const packageJsonPath = resolve(await this.configFile.resolveCli(), '../../package.json');
        const { version } = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
        if (/^0\.0\.[0-4]$/.test(version)) {
          vscode.window.showInformationMessage(
            `Your @vscode/test-cli version is ${version}. Please update to CLI version 0.0.5 or higher to enable coverage.`,
            { modal: true },
          );
        }
      } catch {
        // ignored
      }
    }

    await fs.rm(this.targetDir, { recursive: true, force: true });
  }
}
