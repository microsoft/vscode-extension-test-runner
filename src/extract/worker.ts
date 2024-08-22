import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { parentPort } from 'worker_threads';
import { IFromExtractWorkerMsg, IParsedNode, IToExtractWorkerMsg } from '../extract';
import { extractWithEvaluation } from './evaluate';
import { extractWithAst } from './syntax';

const respond = (msg: IFromExtractWorkerMsg) => parentPort!.postMessage(msg);

parentPort!.on(
  'message',
  async ({ req, file, contents, skipIfShaMatches, symbols }: IToExtractWorkerMsg) => {
    try {
      contents ??= await fs.readFile(file, 'utf8');
    } catch {
      return respond({ req, hash: 0, nodes: undefined });
    }

    const hash = createHash('sha256').update(contents).digest().readInt32BE(0);
    if (hash === skipIfShaMatches) {
      return respond({ req, hash, nodes: undefined });
    }

    let nodes: IParsedNode[] | undefined;
    if (symbols.extractWith === 'evaluation') {
      try {
        nodes = extractWithEvaluation(file, contents, symbols);
      } catch (e) {
        console.warn('error evaluating, will fallback', e);
        // fall through
      }
    }

    nodes ??= extractWithAst(contents, symbols);
    respond({ req, hash, nodes });
  },
);
