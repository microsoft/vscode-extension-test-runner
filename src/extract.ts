/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { join } from 'path';
import { Worker } from 'worker_threads';

export interface IParsedNode {
  name: string;
  kind: NodeKind;
  startLine: number; // base 1
  startColumn: number; // base 1
  endLine?: number; // base 1
  endColumn?: number; // base 1
  directive?: 'skip' | 'only' | string;
  children: IParsedNode[];
  error?: string;
}

export interface ITestSymbols {
  suite: readonly string[];
  test: readonly string[];
  extractWith: 'evaluation' | 'syntax';
}

export const enum NodeKind {
  Suite,
  Test,
}

export interface IExtractOpts {
  file: string;
  /** Contents, if known. Otherwise read from the disk. */
  contents: string | undefined;
  skipIfShaMatches: number | undefined;
  symbols: ITestSymbols;
}

export interface IToExtractWorkerMsg extends IExtractOpts {
  req: number;
}

export interface IFromExtractWorkerMsg {
  req: number;
  hash: number;
  /** Undefined if the SHA matched */
  nodes: IParsedNode[] | undefined;
}

let worker: Worker | undefined;
let workerTimeout: NodeJS.Timeout | undefined;
let reqCounter = 0;

const WORKER_IDLE_TIME = 10_000;

export const extract = (opts: IExtractOpts) => {
  worker ??= new Worker(join(__dirname, 'extract', 'worker.js'));
  if (workerTimeout) {
    clearTimeout(workerTimeout);
  }

  workerTimeout = setTimeout(() => {
    worker?.terminate();
    worker = undefined;
  }, WORKER_IDLE_TIME);

  const reqId = reqCounter++;
  worker.postMessage({ ...opts, req: reqId } satisfies IToExtractWorkerMsg);

  return new Promise<{ nodes: IParsedNode[] | undefined; hash: number }>((resolve) => {
    const listener = (msg: IFromExtractWorkerMsg) => {
      if (msg.req === reqId) {
        worker!.removeListener('message', listener);
        resolve(msg);
      }
    };

    worker!.on('message', listener);
  });
};
