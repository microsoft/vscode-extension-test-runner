/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import { parseCliJsonOutput } from './configurationFile';
import { ConfigProcessReadError } from './errors';

describe('ConfigurationFile', () => {
  it('parses JSON from stdout when stderr contains a diagnostic', () => {
    const result = parseCliJsonOutput<{ config: { files: string } }[]>(
      '[{"config":{"files":"out/test/**/*.test.js"}}]',
      'warning from Electron or Crashpad',
    );

    expect(result).to.deep.equal([{ config: { files: 'out/test/**/*.test.js' } }]);
  });

  it('includes stderr diagnostics when stdout is invalid JSON', () => {
    expect(() => parseCliJsonOutput('not JSON', 'warning from Electron or Crashpad')).to.throw(
      ConfigProcessReadError,
      'invalid JSON on stdout: not JSON\nstderr:\nwarning from Electron or Crashpad',
    );
  });
});
