/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

/** Ported from js-debug https://github.com/microsoft/vscode-js-debug/blob/7c3f88043e84f50ee184e2ae2001c57b68f2919d/src/common/stackTraceParser.ts */

// Either match lines like
// "    at fulfilled (/Users/roblou/code/testapp-node2/out/app.js:5:58)"
// or
// "    at /Users/roblou/code/testapp-node2/out/app.js:60:23"
// and replace the path in them
const re1 = /^(\W*at .*\()(.*):(\d+):(\d+)(\))$/;
const re2 = /^(\W*at )(.*):(\d+):(\d+)$/;

/**
 * Parses a textual stack trace.
 */
export class StackTraceParser {
  /** Gets whether the stacktrace has any locations in it. */
  public static isStackLike(str: string) {
    return re1.test(str) || re2.test(str);
  }
  constructor(private readonly stack: string) {}

  /** Iterates over segments of text and locations in the stack. */
  *[Symbol.iterator]() {
    for (const line of this.stack.split('\n')) {
      const match = re1.exec(line) || re2.exec(line);
      if (!match) {
        yield line + '\n';
        continue;
      }

      const [, prefix, url, lineNo, columnNo, suffix] = match;
      if (prefix) {
        yield prefix;
      }

      yield new StackTraceLocation(url, Number(lineNo), Number(columnNo));

      if (suffix) {
        yield suffix;
      }

      yield '\n';
    }
  }
}

export class StackTraceLocation {
  constructor(public readonly path: string, public readonly lineBase1: number, public readonly columnBase1: number) {}

  public toString() {
    return `${this.path}:${this.lineBase1}:${this.columnBase1}`;
  }
}
