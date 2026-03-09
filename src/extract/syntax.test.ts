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

  it('handles inconsistent indentation without misplacing nodes', () => {
    // acorn-loose uses indentation heuristics that can misplace block
    // boundaries when a line has extra indentation followed by a dedent.
    // With the acorn-strict-first approach, well-formed JS is parsed
    // correctly regardless of indentation.
    const src = extractWithAst(
      [
        "suite('Root', function () {",
        "    suite('A', function () {",
        "        test('A1', function () {",
        '            if (true) {',
        '                    x();', // ← extra indent (20 spaces)
        '                y();', // ← normal indent (16 spaces)
        '            }',
        '        });',
        "        test('A2', function () {});",
        '    });',
        "    suite('B', function () {",
        "        test('B1', function () {});",
        '    });',
        '});',
      ].join('\n'),
      defaultTestSymbols,
    );

    // Should produce a single root suite with two child suites
    expect(src).to.have.length(1);
    expect(src[0].name).to.equal('Root');
    expect(src[0].children).to.have.length(2);
    expect(src[0].children[0].name).to.equal('A');
    expect(src[0].children[0].children).to.have.length(2);
    expect(src[0].children[0].children[0].name).to.equal('A1');
    expect(src[0].children[0].children[1].name).to.equal('A2');
    expect(src[0].children[1].name).to.equal('B');
    expect(src[0].children[1].children).to.have.length(1);
    expect(src[0].children[1].children[0].name).to.equal('B1');
  });
});
