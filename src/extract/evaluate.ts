import * as errorParser from 'error-stack-parser';
import { dirname } from 'path';
import * as vm from 'vm';
import { IParsedNode, ITestSymbols, NodeKind } from '../extract';

// node modules that we allow to be required. There are probably more we can
// add as needed with greater or lesser confidence regarding side-effects.
const allowedNodeModules = [
  'buffer',
  'constants',
  'crypto',
  'events',
  'os',
  'path',
  'stream',
  'string_decoder',
  'timers',
  'util',
  'zlib',
].flatMap((m) => [m, `node:${m}`]);

/**
 * Honestly kind of amazed this works. We can use a Proxy as our globalThis
 * in a VM context, and mock *every* global. We use this to return arbitrary
 * objects and track ones that are Mocha's globals.
 *
 * This is a nice, flexible alternative to the other alternatives: AST
 * transversal (which can miss test-table style tests, for example) or
 * require/import mocks (which don't guarentee a side-effect-free execution.)
 *
 * Since extension host tests are always common.js (at least for now) this
 * is also effective in stubbing require() so we know code is nicely isolated.
 */
export const extractWithEvaluation = (file: string, code: string, symbols: ITestSymbols) => {
  /**
   * Note: the goal is not to sandbox test code (workspace trust is required
   * for this extension) but rather to avoid side-effects from evaluation which
   * are much more likely when other code is required.
   */
  const replacedGlobals = new Map<string, () => unknown>([
    // avoid side-effects:
    [
      'require',
      () => (mod: string) =>
        allowedNodeModules.some((m) => m === mod || mod.startsWith(m + '/'))
          ? wrapImportedModule(require(mod))
          : placeholder(),
    ],
    ['process', placeholder],
    // avoid printing to the console from tests:
    ['console', placeholder],
    // avoid messing with TS es module interop loader:
    ['__importStar', () => undefined],
    ['__setModuleDefault', () => undefined],
    ['__createBinding', () => undefined],
    // general constants:
    ['__dirname', () => dirname(file)],
    ['__filename', () => file],
  ]);

  const stack: IParsedNode[] = [{ children: [] } as Partial<IParsedNode> as IParsedNode];
  const placeholders = new WeakSet<object>();

  // A placeholder object that returns itself for all functions calls and method accesses.
  // It must be a function definition, not an arrow function, to allow it to be 'constructed'
  // and captured the `construct` trap.
  function placeholder(): unknown {
    const ph = new Proxy(placeholder, {
      get: (obj, target) => {
        const desc = Object.getOwnPropertyDescriptor(obj, target);
        if (desc && !desc.writable && !desc.configurable) {
          return desc.value; // avoid invariant volation https://stackoverflow.com/q/75148897
        }
        return placeholder();
      },
      construct() {
        return placeholder() as object;
      },
      set: () => true,
    });
    placeholders.add(ph);
    return ph;
  }

  // Wraps an imported module to avoid placeholders getting passed as arguments,
  // which can cause mysterious and disturbing things to happen (#42)
  function wrapImportedModule(obj: any): unknown {
    return new Proxy(obj, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value === 'function') {
          return function (...args: any[]) {
            return value.apply(
              target,
              args.map((arg) => (placeholders.has(arg) ? undefined : arg)),
            );
          };
        }
        if (value && typeof value === 'object') {
          return wrapImportedModule(value);
        }

        return value;
      },
    });
  }

  function makeTesterFunction(kind: NodeKind, directive?: string) {
    const fn = (name: string, callback: () => void) => {
      if (typeof name !== 'string' || typeof callback !== 'function') {
        return placeholder();
      }

      const frame = errorParser.parse(new Error())[1];
      if (!frame || !frame.lineNumber) {
        return placeholder();
      }

      const startLine = frame.lineNumber;
      const startColumn = frame.columnNumber || 1;

      // approximate the length of the test case:
      const functionLines = String(callback).split('\n');
      const endLine = frame.lineNumber + functionLines.length - 1;
      let endColumn = functionLines[functionLines.length - 1].length;
      if (endLine === startLine) {
        endColumn = Number.MAX_SAFE_INTEGER; // assume it takes the entire line of a single-line test case
      }

      const node: IParsedNode = {
        name,
        kind,
        startLine,
        startColumn,
        endLine,
        endColumn,
        children: [],
      };
      if (directive) {
        node.directive = directive;
      }
      stack[stack.length - 1].children.push(node);
      if (kind === NodeKind.Suite) {
        stack.push(node);
        try {
          callback.call(placeholder());
        } catch (e) {
          node.error = e instanceof Error ? e.message : String(e);
        } finally {
          stack.pop();
        }
      }
    };
    if (!directive) {
      fn.skip = makeTesterFunction(kind, 'skip');
      fn.only = makeTesterFunction(kind, 'only');
    }

    return fn;
  }

  // currently these are the same, but they might be different in the future?
  const suiteFunction = makeTesterFunction(NodeKind.Suite);
  const testFunction = makeTesterFunction(NodeKind.Test);

  const contextObj = new Proxy({} as any, {
    get(target, prop, _receiver) {
      if (symbols.suite.includes(prop as string)) {
        return suiteFunction;
      } else if (symbols.test.includes(prop as string)) {
        return testFunction;
      } else if (prop in target) {
        return target[prop]; // top-level `var` defined get set on the contextObj
      } else if (prop in globalThis || replacedGlobals.has(prop as string)) {
        return replacedGlobals.get(prop as string)?.() ?? (globalThis as any)[prop];
      } else {
        return placeholder();
      }
    },
  });

  vm.runInNewContext(code, contextObj, {
    timeout: 1000,
  });

  return stack[0].children;
};
