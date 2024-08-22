/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { Disposable } from 'vscode';

const syncDebounce = 500;

/**
 * Debounces and coalesces calls to the inner 'sync' function.
 * - Individual calls get a 500ms debounce
 * - While the inner function is being called, all calls wait on that *   to finish. If there are calls to make after it finishes, those
 *   are debounced.
 *
 * Designed to avoid excessive syncs while editing files.
 */
export class SyncController<TLastCallArg> implements Disposable {
  private isRunningCall = false;
  private syncTimeout: NodeJS.Timeout | undefined;
  private pendingToResolve: { fn: () => void; arg: TLastCallArg }[] = [];

  constructor(private readonly doSync: (arg: TLastCallArg | undefined) => Promise<void>) {}

  public scheduleSync(arg: TLastCallArg): Promise<void> {
    if (!this.isRunningCall) {
      this.doDebounce();
    }

    return new Promise<void>((resolve) => {
      this.pendingToResolve.push({ fn: resolve, arg });
    });
  }

  public dispose(): void {
    this.pendingToResolve.forEach((r) => r.fn());
    this.pendingToResolve = [];

    if (this.syncTimeout) {
      clearTimeout(this.syncTimeout);
    }
  }

  private sync(): void {
    this.syncTimeout = undefined;
    this.isRunningCall = true;

    const toResolve = this.pendingToResolve;
    this.pendingToResolve = [];

    this.doSync(toResolve[toResolve.length - 1].arg).finally(() => {
      toResolve.forEach((r) => r.fn());
      this.isRunningCall = false;
      if (this.pendingToResolve.length) {
        this.doDebounce();
      }
    });
  }

  private doDebounce(): void {
    if (this.syncTimeout) {
      clearTimeout(this.syncTimeout);
    }

    this.syncTimeout = setTimeout(() => this.sync(), syncDebounce);
  }
}
