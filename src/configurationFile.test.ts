/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import { parseCliJsonOutput } from './configurationFile';

describe('ConfigurationFile', () => {
  it('parses JSON from stdout when stderr contains a diagnostic', () => {
    const result = parseCliJsonOutput<{ config: { files: string } }[]>(
      '[{"config":{"files":"out/test/**/*.test.js"}}]',
      'warning from Electron or Crashpad',
    );

    expect(result).to.deep.equal([{ config: { files: 'out/test/**/*.test.js' } }]);
  });
});
