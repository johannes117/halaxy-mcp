import { createInterface } from 'node:readline/promises';

export async function ask(question: string, defaultValue?: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const suffix = defaultValue ? ` [${defaultValue}]` : '';
    const answer = (await rl.question(`${question}${suffix}: `)).trim();
    return answer || defaultValue || '';
  } finally {
    rl.close();
  }
}

/** Read a line without echoing it (for the client secret). */
export function askHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stderr.write(`${question}: `);
    let value = '';
    const wasRaw = stdin.isRaw;
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const done = (err?: Error) => {
      stdin.removeListener('data', onData);
      stdin.setRawMode?.(wasRaw ?? false);
      stdin.pause();
      process.stderr.write('\n');
      if (err) reject(err);
      else resolve(value.trim());
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done();
        if (ch === '\u0003') return done(new Error('Cancelled'));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}
