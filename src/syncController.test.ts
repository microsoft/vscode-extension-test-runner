/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import * as sinon from 'sinon';
import { SyncController } from './syncController';

describe('SyncController', () => {
  let clock: sinon.SinonFakeTimers;
  let doSync: sinon.SinonStub;

  beforeEach(() => {
    clock = sinon.useFakeTimers();
    doSync = sinon.stub().resolves();
  });

  afterEach(() => {
    clock.restore();
  });

  it('should debounce sync calls', async () => {
    const controller = new SyncController(doSync);

    controller.scheduleSync('arg1');
    controller.scheduleSync('arg2');

    expect(doSync.called).to.be.false;

    clock.tick(500);

    expect(doSync.calledOnce).to.be.true;
    expect(doSync.calledWith('arg2')).to.be.true;
  });

  it('should wait for the current sync to finish before starting a new one', async () => {
    const controller = new SyncController(doSync);

    controller.scheduleSync('arg1');
    clock.tick(500);

    expect(doSync.calledOnce).to.be.true;

    controller.scheduleSync('arg2');
    clock.tick(500);

    expect(doSync.calledOnce).to.be.true;

    await doSync.firstCall.returnValue;

    clock.tick(500); // tick again because debounce is scheduled only after resolution

    expect(doSync.calledTwice).to.be.true;
    expect(doSync.secondCall.calledWith('arg2')).to.be.true;
  });

  it('should resolve all pending promises after sync', async () => {
    const controller = new SyncController(doSync);

    const promise1 = controller.scheduleSync('arg1');
    const promise2 = controller.scheduleSync('arg2');

    clock.tick(500);

    await Promise.all([promise1, promise2]);

    expect(doSync.calledOnce).to.be.true;
    expect(doSync.calledWith('arg2')).to.be.true;
  });

  it('should clear pending promises on dispose', () => {
    const controller = new SyncController(doSync);

    const promise1 = controller.scheduleSync('arg1');
    const promise2 = controller.scheduleSync('arg2');

    controller.dispose();

    return Promise.all([promise1, promise2]).then(() => {
      expect(doSync.called).to.be.false;
    });
  });
});
