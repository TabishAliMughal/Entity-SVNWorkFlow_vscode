import * as fs from 'node:fs';
import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

/** Everything the host writes lives under F:\TrashCache\e2e; the real %APPDATA%\Subversion and VS Code profile are never touched. */
const SCRATCH = 'F:/TrashCache/e2e';

async function main(): Promise<void> {
  const root = path.resolve(__dirname, '../../..');
  const profile = path.join(SCRATCH, `host-${process.pid}`);
  const appdata = path.join(profile, 'appdata');
  fs.mkdirSync(appdata, { recursive: true });
  await runTests({
    extensionDevelopmentPath: root,
    extensionTestsPath: path.resolve(__dirname, 'suite/index'),
    launchArgs: ['--user-data-dir', path.join(profile, 'user-data'), '--extensions-dir', path.join(profile, 'extensions'), '--disable-workspace-trust', '--disable-extensions'],
    extensionTestsEnv: { SVN_WORKFLOW_E2E: '1', APPDATA: appdata, E2E_SCRATCH: SCRATCH, SVN_WORKFLOW_E2E_CONFIG_DIR: path.join(profile, 'svn-config') },
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
