import * as fs from 'node:fs';
import * as path from 'node:path';
import Mocha from 'mocha';

export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'tdd', color: false, timeout: 120000 });
  mocha.addFile(path.resolve(__dirname, 'smoke.test.js'));
  mocha.addFile(path.resolve(__dirname, 'e2e.test.js'));
  const log = path.join(process.env.E2E_SCRATCH ?? 'F:/TrashCache/e2e', 'last-run.log');
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(log, '');
  return new Promise((resolve, reject) => {
    mocha
      .run((failures) => (failures ? reject(new Error(`${failures} tests failed (details: ${log})`)) : resolve()))
      .on('pass', (t) => fs.appendFileSync(log, `PASS ${t.fullTitle()}\n`))
      .on('fail', (t, err) => fs.appendFileSync(log, `FAIL ${t.fullTitle()}\n${err.stack ?? err.message}\n`));
  });
}
