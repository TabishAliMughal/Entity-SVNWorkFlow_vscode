import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

const pkgPath = path.resolve(__dirname, '../../../../package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { publisher: string; name: string; contributes: { commands: { command: string }[] } };

suite('smoke', () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension(`${pkg.publisher}.${pkg.name}`);
    assert.ok(ext, 'extension is installed in the test host');
    await ext.activate();
  });

  test('the extension activates', () => {
    assert.strictEqual(vscode.extensions.getExtension(`${pkg.publisher}.${pkg.name}`)?.isActive, true);
  });

  test('every contributed command is registered', async () => {
    const registered = new Set(await vscode.commands.getCommands(true));
    const missing = pkg.contributes.commands.map((c) => c.command).filter((c) => !registered.has(c));
    assert.deepStrictEqual(missing, []);
  });
});
