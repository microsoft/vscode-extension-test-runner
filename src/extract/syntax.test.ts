/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { expect } from 'chai';
import { defaultTestSymbols } from '../constants';
import { NodeKind } from '../extract';
import { extractWithAst } from './syntax';

describe('syntax', () => {
  it('extracts basic suite', () => {
    const src = extractWithAst(
      `suite('hello', () => {
      it('works', () => {});
    })`,
      defaultTestSymbols,
    );
    expect(src).to.deep.equal([
      {
        name: 'hello',
        startLine: 1,
        kind: NodeKind.Suite,
        startColumn: 1,
        endColumn: 7,
        endLine: 3,
        children: [
          {
            name: 'works',
            kind: NodeKind.Test,
            startLine: 2,
            startColumn: 7,
            endColumn: 28,
            endLine: 2,
            children: [],
          },
        ],
      },
    ]);
  });

  it('works with skip/only', () => {
    const src = extractWithAst(
      `suite('hello', () => {
        it.only('a', ()=>{});
        it.skip('a', ()=>{});
    })`,
      defaultTestSymbols,
    );
    expect(src).to.deep.equal([
      {
        name: 'hello',
        kind: NodeKind.Suite,
        startLine: 1,
        startColumn: 1,
        endColumn: 7,
        endLine: 4,
        children: [
          {
            name: 'a',
            kind: NodeKind.Test,
            startLine: 2,
            startColumn: 9,
            endColumn: 29,
            endLine: 2,
            children: [],
            directive: 'only',
          },
          {
            name: 'a',
            kind: NodeKind.Test,
            startLine: 3,
            startColumn: 9,
            endColumn: 29,
            endLine: 3,
            children: [],
            directive: 'skip',
          },
        ],
      },
    ]);
  });

  it('stubs out requires and placeholds correctly', () => {
    const src = extractWithAst(
      `require("some invalid module").doing().other.things()`,
      defaultTestSymbols,
    );
    expect(src).to.deep.equal([]);
  });
});
