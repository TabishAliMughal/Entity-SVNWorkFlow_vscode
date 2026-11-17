/**
 * Live tests for the security review fixes against the local servers: password via stdin (svn://, http://, https://),
 * the svn:externals guard, certificate pinning, "@" in working copy paths, URLs with spaces and non-ASCII, and the
 * patch-shelf binary protection. Scratch checkouts under F:\TrashCache\svn-security-vitest.
 */
import { X509Certificate } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { rmTree, runDir } from './scratch';
import { createRef, listDirs, urlExists } from '../../src/branch/ops';
import { detectLayout, refUrl } from '../../src/branch/model';
import { ExternalsGuard, type ExternalsChoice, type ExternalsPrompt } from '../../src/externals/guard';
import { CertGuard } from '../../src/repos/certGuard';
import { checkServerUrl, type RepoEntry } from '../../src/repos/model';
import { RepoCredentialProvider, PasswordStore } from '../../src/repos/credentials';
import { RepoStore } from '../../src/repos/store';
import { ServerStore } from '../../src/repos/servers';
import { shelve, unshelve, type ShelfCtx } from '../../src/shelve/ops';
import { ShelfStore } from '../../src/shelve/store';
import { probeCertificate } from '../../src/svn/certificate';
import { Credentials, SvnClient } from '../../src/svn/client';
import { findSvnExe } from '../../src/svn/discovery';
import { SvnLocator } from '../../src/svn/locator';
import { joinSvnUrl } from '../../src/util/svnUrl';
import * as wcops from '../../src/wc/ops';

const BASE = runDir('svn-security-vitest');
const TESTER = { username: 'tester', password: 'tester-pass' };
const CERT = 'F:\\TrashCache\\svn-test-env\\certs\\server.crt';

const SVN = { proto: 'svn', repo: 'alpha', root: 'svn://127.0.0.1:13690/alpha', trust: false } as const;
const HTTP = { proto: 'http', repo: 'beta', root: 'http://127.0.0.1:18080/svn/beta', trust: false } as const;
const HTTPS = { proto: 'https', repo: 'beta', root: 'https://127.0.0.1:18443/svn/beta', trust: true } as const;

const exe = findSvnExe().path;
const ports = [13690, 18080, 18443];
const up =
  spawnSync(process.execPath, ['-e', `const n=require('net');let ok=0;for(const p of ${JSON.stringify(ports)}){const s=n.connect({host:'127.0.0.1',port:p,timeout:1500});s.on('connect',()=>{s.destroy();if(++ok===${ports.length})process.exit(0)});s.on('timeout',()=>process.exit(1));s.on('error',()=>process.exit(1));}`], { timeout: 10_000 }).status === 0;
const enabled = !!exe && up;
if (!enabled) console.warn('[test:svn] security tests SKIPPED: servers or svn.exe unavailable');

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const stamp = `sec-${Date.now()}`;
/** beta is reachable over http and https, so each protocol gets its own project folder. */
const P = { svn: stamp, http: `${stamp}-http`, https: `${stamp}-https` } as const;

describe.skipIf(!enabled)('security fixes against local servers', () => {
  const client = new SvnClient(new SvnLocator(() => '', () => ({ path: exe, tried: [] })), undefined, silent, () => 60_000);
  const records: Array<{ args: string[]; repoName?: string }> = [];
  client.setCommandObserver((r) => records.push({ args: r.args, repoName: r.repoName }));

  beforeAll(() => {
    const appdata = path.join(BASE, 'appdata');
    fs.mkdirSync(appdata, { recursive: true });
    process.env.APPDATA = appdata;
    fs.mkdirSync(BASE, { recursive: true });
  });
  afterAll(async () => {
    for (const c of [SVN, HTTP, HTTPS]) await client.run(['delete', '-m', 'cleanup security test', '--', `${c.root}/${P[c.proto]}`], { credentials: { ...TESTER, trustServerCert: c.trust } }).catch(() => undefined);
    rmTree(BASE);
  });

  describe.each([SVN, HTTP, HTTPS])('password over stdin: $proto', ({ root, trust, proto }) => {
    const creds: Credentials = { ...TESTER, trustServerCert: trust };

    it('authenticates without --password on the command line', async () => {
      const before = records.length;
      const info = await client.info(`${root}/trunk`, { credentials: creds });
      expect(info.url).toContain('/trunk');
      const rec = records.slice(before).find((r) => r.args[0] === 'info');
      expect(rec?.args).toContain('--password-from-stdin');
      expect(rec?.args).not.toContain('--password');
      expect(JSON.stringify(rec?.args)).not.toContain(TESTER.password);
    });

    it('a wrong password is still an auth error', async () => {
      await expect(client.info(`${root}/trunk`, { credentials: { ...creds, password: 'wrong-pass' } })).rejects.toMatchObject({ kind: 'auth' });
    });

    it('a commit with credentials from stdin works (write access)', async () => {
      const r = await client.run(['mkdir', '--parents', '-m', 'security layout', '--', `${root}/${P[proto]}/trunk`, `${root}/${P[proto]}/branches`], { credentials: creds });
      expect(r.text).toMatch(/Committed revision \d+/);
    });
  });

  describe('certificate pinning (https)', () => {
    const fp = new X509Certificate(fs.readFileSync(CERT)).fingerprint.toUpperCase();
    const url = `${HTTPS.root}/trunk`;

    it('probes the fingerprint svn would show', async () => {
      const info = await probeCertificate(url);
      expect(info.fingerprint).toBe(fp);
      expect(info.port).toBe(18443);
      expect(info.subject).toContain('127.0.0.1');
    });

    function guarded(pinned: string | undefined, confirm: boolean) {
      const mem = new Map<string, unknown>();
      const servers = new ServerStore({ get: <T,>(k: string, d: T) => (mem.has(k) ? (mem.get(k) as T) : d), update: async (k, v) => void mem.set(k, v) });
      const store = new RepoStore(servers);
      store.setCurrent({ name: 'beta', serverUrl: `${HTTPS.root}/${P.https}/trunk`, localFolder: path.join(BASE, 'cert-wc') });
      void servers.set(`${HTTPS.root}/${P.https}/trunk`, { username: TESTER.username, trustServerCert: true, trustedCertFingerprint: pinned });
      const entry = (): RepoEntry => store.list()[0];
      const passwords = new PasswordStore({ get: async () => TESTER.password, store: async () => {}, delete: async () => {} });
      const c = new SvnClient(new SvnLocator(() => '', () => ({ path: exe, tried: [] })), new RepoCredentialProvider(store, passwords), silent, () => 60_000);
      const confirmChanged = vi.fn(async () => confirm);
      const g = new CertGuard({ findRepo: () => entry(), repin: async (_n, f) => void (await store.update('beta', { ...entry(), trustedCertFingerprint: f })), confirmChanged, logger: silent });
      c.setCertificatePolicy(g.policy);
      return { c, confirmChanged, get entry() { return entry(); } };
    }
    const withUser = (c: SvnClient, repoName: string) => c.info(`${HTTPS.root}/${P.https}/trunk`, { repoName, credentials: undefined });

    it('trusts the self-signed certificate while the pinned fingerprint matches', async () => {
      const t = guarded(fp, false);
      const info = await withUser(t.c, 'beta');
      expect(info.url).toContain(P.https);
      expect(t.confirmChanged).not.toHaveBeenCalled();
    });

    it('refuses a different pinned fingerprint unless re-confirmed (certificate error without trust)', async () => {
      const t = guarded('00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33', false);
      await expect(withUser(t.c, 'beta')).rejects.toMatchObject({ kind: 'certificate' });
      expect(t.confirmChanged).toHaveBeenCalledTimes(1);
      expect(t.entry.trustedCertFingerprint).toMatch(/^00:11/);
    });

    it('re-confirming pins the new fingerprint and the command succeeds', async () => {
      const t = guarded('00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33', true);
      await withUser(t.c, 'beta');
      expect(t.entry.trustedCertFingerprint).toBe(fp);
    });
  });

  describe('svn:externals guard', () => {
    const wc = path.join(BASE, 'ext', 'alpha');
    const trunk = `${SVN.root}/${P.svn}/trunk`;
    const foreignUrl = `${HTTP.root}/${P.http}/trunk`;
    const creds: Credentials = { ...TESTER };
    let entry: RepoEntry = { name: 'alpha', serverUrl: trunk, localFolder: wc };
    const prompts: ExternalsPrompt[] = [];
    let choice: ExternalsChoice = 'cancel';
    const c = new SvnClient(new SvnLocator(() => '', () => ({ path: exe, tried: [] })), undefined, silent, () => 60_000);
    const seen: string[][] = [];
    c.setCommandObserver((r) => seen.push(r.args));
    const guard = new ExternalsGuard({
      client: c,
      findRepo: () => entry,
      prompt: async (p) => {
        prompts.push(p);
        return choice;
      },
      trust: async (_n, origins) => void (entry = { ...entry, trustedExternalHosts: [...(entry.trustedExternalHosts ?? []), ...origins] }),
      logger: silent,
      ttlMs: 0,
    });
    c.setExternalsPolicy(guard);
    const setExternals = async (value: string): Promise<void> => {
      const f = path.join(BASE, 'ext', 'value.txt');
      fs.writeFileSync(f, value, 'utf8');
      await c.run(['propset', 'svn:externals', '-F', f, '--', '.'], { cwd: wc });
    };
    const guardedUpdate = (): Promise<{ text: string }> =>
      // repoName routes the policy; credentials come from the explicit option
      c.run(['update', '--', wc], { repoName: 'alpha', credentials: creds, cwd: wc });

    beforeAll(async () => {
      // the mapping repoName -> credentials is explicit above, so the guard needs the findRepo entry only
      fs.mkdirSync(path.dirname(wc), { recursive: true });
      await c.run(['mkdir', '-m', 'ext layout', '--', `${trunk}/lib`], { credentials: creds });
      await c.run(['mkdir', '-m', 'foreign data', '--', `${foreignUrl}/other`], { credentials: creds });
      await c.run(['checkout', '-q', '--', trunk, wc], { credentials: creds });
      entry = { ...entry, localFolder: wc };
    });

    it('same-origin and relative externals are silent and fetched', async () => {
      await setExternals(`^/${P.svn}/trunk/lib same-dir\n`);
      const res = await guardedUpdate();
      expect(prompts).toHaveLength(0);
      expect(fs.existsSync(path.join(wc, 'same-dir'))).toBe(true);
      expect(res.text).toMatch(/revision/i);
    });

    it('an external on another server prompts; "Update without externals" skips every external', async () => {
      await c.run(['propdel', 'svn:externals', '--', '.'], { cwd: wc });
      fs.rmSync(path.join(wc, 'same-dir'), { recursive: true, force: true });
      await setExternals(`${foreignUrl}/other foreign-dir\n^/${P.svn}/trunk/lib same-dir\n`);
      choice = 'ignore';
      await guardedUpdate();
      expect(prompts).toHaveLength(1);
      expect(prompts[0].origins).toEqual(['http://127.0.0.1:18080']);
      expect(prompts[0].lines.join('\n')).toContain(foreignUrl);
      expect(fs.existsSync(path.join(wc, 'foreign-dir'))).toBe(false);
      expect(seen.filter((a) => a[0] === 'update').at(-1)).toContain('--ignore-externals');
    });

    it('"Continue (trusted)" fetches the foreign external too', async () => {
      choice = 'continue';
      await guardedUpdate();
      expect(prompts).toHaveLength(2);
      expect(fs.existsSync(path.join(wc, 'foreign-dir', '.svn'))).toBe(true);
    });

    it('"Update externals without credentials" gives the foreign server none and keeps them for the repo', async () => {
      choice = 'separate';
      seen.length = 0;
      const res = await guardedUpdate();
      const upd = seen.filter((a) => a[0] === 'update');
      expect(upd[0]).toContain('--ignore-externals');
      const foreign = upd.find((a) => a.some((x) => x.endsWith('foreign-dir')));
      expect(foreign).toBeDefined();
      expect(foreign).not.toContain('--username');
      expect(foreign).not.toContain('--password-from-stdin');
      const local = upd.find((a) => a.some((x) => x.endsWith('same-dir')));
      expect(local).toContain('--password-from-stdin');
      // beta does not allow anonymous access, so the credential-less update of the foreign dir fails and is reported
      expect(res.text).toMatch(/foreign-dir was not updated \(no credentials offered\)/);
    });

    it('"Always trust for this repo" is remembered, so the next update is silent', async () => {
      choice = 'trust';
      const n = prompts.length;
      await guardedUpdate();
      expect(entry.trustedExternalHosts).toEqual(['http://127.0.0.1:18080']);
      await guardedUpdate();
      expect(prompts).toHaveLength(n + 1);
    });

    it('a cancelled prompt aborts before svn runs', async () => {
      entry = { ...entry, trustedExternalHosts: undefined };
      choice = 'cancel';
      seen.length = 0;
      await expect(guardedUpdate()).rejects.toMatchObject({ kind: 'cancelled' });
      expect(seen.filter((a) => a[0] === 'update')).toHaveLength(0);
    });

    it('the background incoming check (status -u) skips foreign externals without prompting or credentials for them', async () => {
      const n = prompts.length;
      seen.length = 0;
      const st = await c.status(wc, { showUpdates: true, repoName: 'alpha', credentials: creds, cwd: wc });
      expect(st.entries.length).toBeGreaterThanOrEqual(0);
      expect(prompts).toHaveLength(n);
      expect(seen.find((a) => a[0] === 'status')).toContain('--ignore-externals');
    });

    it('checkout of a URL whose tree has a foreign external asks first and honours "without externals"', async () => {
      await c.run(['commit', '-m', 'externals', '--', wc], { credentials: creds, cwd: wc }).catch(() => undefined);
      choice = 'ignore';
      const dest = path.join(BASE, 'ext', 'co');
      const n = prompts.length;
      const co = new SvnClient(new SvnLocator(() => '', () => ({ path: exe, tried: [] })), undefined, silent, () => 60_000);
      const g2 = new ExternalsGuard({ client: co, findRepo: () => undefined, prompt: async (p) => (prompts.push(p), choice), trust: async () => {}, logger: silent });
      co.setExternalsPolicy(g2);
      await co.run(['checkout', '--', trunk, dest], { credentials: creds });
      expect(prompts).toHaveLength(n + 1);
      expect(fs.existsSync(path.join(dest, 'foreign-dir'))).toBe(false);
      expect(fs.existsSync(path.join(dest, '.svn'))).toBe(true);
    });
  });

  describe('"@" in working copy paths and URLs with spaces (testing findings 3 and 7)', () => {
    const base = path.join(BASE, 'at');
    const wc = path.join(base, 'wc@home');
    const trunk = `${SVN.root}/${P.svn}/trunk`;
    const creds: Credentials = { ...TESTER };
    const entry: RepoEntry = { name: 'alpha', serverUrl: trunk, localFolder: wc, ...TESTER };
    const withCreds = new Proxy(client, {
      get(t, k) {
        if (k === 'run') return (a: string[], o = {}) => t.run(a, { ...o, credentials: creds, repoName: undefined });
        if (k === 'info') return (p: string, o = {}) => t.info(p, { ...o, credentials: creds, repoName: undefined });
        if (k === 'status') return (p: string, o = {}) => t.status(p, { ...o, credentials: creds, repoName: undefined });
        return Reflect.get(t, k) as unknown;
      },
    }) as SvnClient;
    const c = { client: withCreds, repo: entry };
    const sh = async (args: string[]): Promise<string> => (await withCreds.run(args, { cwd: wc })).text;

    it('checks out into a folder named with "@" and the ops that take WC paths work there', async () => {
      fs.mkdirSync(base, { recursive: true });
      await wcops.checkout({ client: withCreds, url: trunk, target: wc, depth: 'immediates', credentials: creds });
      expect(fs.existsSync(path.join(wc, '.svn'))).toBe(true);
      // seed a sub folder with a file (committed through the working copy)
      fs.mkdirSync(path.join(wc, 'sub@dir'), { recursive: true });
      fs.writeFileSync(path.join(wc, 'sub@dir', 'f@1.txt'), 'x\n');
      await sh(['add', '--force', '--parents', '--', 'sub@dir@']);
      await sh(['commit', '-m', 'at test', '--', 'sub@dir@']);
      await withCreds.run(['update', '--set-depth', 'empty', '--', path.join(wc, 'sub@dir') + '@'], {});
    });

    it('setDepth, updateToRevision, includeChildren and switchTo accept the "@" paths', async () => {
      const d = await wcops.setDepth(c, path.join(wc, 'sub@dir'), 'files');
      expect(d.revision).toBeGreaterThan(0);
      expect(fs.existsSync(path.join(wc, 'sub@dir', 'f@1.txt'))).toBe(true);
      const u = await wcops.updateToRevision(c, [wc], 'HEAD');
      expect(u.revision).toBeGreaterThan(0);
      await sh(['update', '--set-depth', 'empty', '--', path.join(wc, 'sub@dir', 'f@1.txt') + '@']);
      await wcops.includeChildren(c, path.join(wc, 'sub@dir'), ['f@1.txt']);
      expect(fs.existsSync(path.join(wc, 'sub@dir', 'f@1.txt'))).toBe(true);
      // switch the whole working copy (path contains "@") to a branch and back
      const lay = detectLayout(SVN.root, trunk);
      await createRef({ client: withCreds, repo: entry, tmpDir: path.join(BASE, 'tmp') }, { kind: 'url', url: trunk, rev: 'HEAD' }, refUrl(lay, 'branch', 'at-branch'), 'at branch');
      const s = await wcops.switchTo(c, wc, refUrl(lay, 'branch', 'at-branch'));
      expect(s.revision).toBeGreaterThan(0);
      expect((await withCreds.info(wc)).url).toContain('/branches/at-branch');
      await wcops.switchTo(c, wc, trunk);
      expect((await withCreds.info(wc)).url.endsWith('/trunk')).toBe(true);
    });

    it('relocate works for a working copy whose folder contains "@"', async () => {
      const other = trunk.replace('127.0.0.1', 'localhost');
      const r = await wcops.relocate(c, other);
      expect(r.oldUrl).toBe(trunk);
      expect((await withCreds.info(wc)).url).toBe(other);
      await wcops.relocate(c, trunk);
      expect((await withCreds.info(wc)).url).toBe(trunk);
    });

    it('branch names with spaces and non-ASCII characters: create, list, switch, info', async () => {
      const lay = detectLayout(SVN.root, trunk);
      const name = 'my branch ü 1';
      const url = refUrl(lay, 'branch', name);
      expect(url).toBe(`${SVN.root}/${P.svn}/branches/my%20branch%20%C3%BC%201`);
      expect(await urlExists({ client: withCreds, repo: entry }, url)).toBe(false);
      await createRef({ client: withCreds, repo: entry, tmpDir: path.join(BASE, 'tmp') }, { kind: 'url', url: trunk, rev: 'HEAD' }, url, 'branch with a space');
      expect(await urlExists({ client: withCreds, repo: entry }, url)).toBe(true);
      const listed = await listDirs({ client: withCreds, repo: entry }, lay.branches);
      expect(listed).toContain(name);
      // the picker builds the URL from the decoded name returned by svn list
      const picked = joinSvnUrl(lay.branches, name);
      expect(picked).toBe(url);
      await wcops.switchTo(c, wc, picked);
      const info = await withCreds.info(wc);
      expect(decodeURIComponent(info.url)).toContain('/branches/my branch ü 1');
      // and a URL typed by the user with the raw characters is accepted and encoded
      const typed = checkServerUrl(`${SVN.root}/${P.svn}/branches/my branch ü 1`);
      expect(typed.url).toBe(url);
      await wcops.switchTo(c, wc, trunk);
    });

    it('a layout of the repository itself (spaces in the project folder) is usable end to end', async () => {
      const dirUrl = joinSvnUrl(`${SVN.root}/${P.svn}`, 'folder with space', 'trunk');
      await withCreds.run(['mkdir', '--parents', '-m', 'space layout', '--', dirUrl], {});
      const co = path.join(base, 'spaced wc');
      await withCreds.run(['checkout', '-q', '--', dirUrl, co], {});
      expect((await withCreds.info(co)).url).toBe(dirUrl);
      expect(await urlExists({ client: withCreds, repo: entry }, dirUrl)).toBe(true);
    });
  });

  describe('patch shelf never silently overwrites a locally modified binary (testing finding 4)', () => {
    const wc = path.join(BASE, 'shelf', 'wc');
    const trunk = `${SVN.root}/${P.svn}/trunk`;
    const creds: Credentials = { ...TESTER };
    const entry: RepoEntry = { name: 'alpha', serverUrl: trunk, localFolder: wc, ...TESTER };
    const store = new ShelfStore(path.join(BASE, 'shelf', 'store'));
    const sc = new Proxy(client, {
      get(t, k) {
        if (k === 'run') return (a: string[], o = {}) => t.run(a, { ...o, credentials: creds, repoName: undefined });
        if (k === 'status') return (p: string, o = {}) => t.status(p, { ...o, credentials: creds, repoName: undefined });
        if (k === 'info') return (p: string, o = {}) => t.info(p, { ...o, credentials: creds, repoName: undefined });
        return Reflect.get(t, k) as unknown;
      },
    }) as SvnClient;
    const mk = (confirm?: (rels: string[]) => Promise<boolean>): ShelfCtx => ({ client: sc, repo: entry, store, tmpDir: path.join(BASE, 'tmp'), mode: 'patch', context: 3, confirmOverwrite: confirm });
    const BIN = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 0, 255]);
    const bin = path.join(wc, 'img.bin');

    beforeAll(async () => {
      await sc.run(['checkout', '-q', '--', trunk, wc], {});
      fs.writeFileSync(bin, BIN);
      await sc.run(['add', '--', 'img.bin'], { cwd: wc });
      await sc.run(['propset', 'svn:mime-type', 'application/octet-stream', '--', 'img.bin'], { cwd: wc });
      await sc.run(['commit', '-m', 'bin', '--', 'img.bin'], { cwd: wc });
    });

    async function shelveChange(name: string): Promise<void> {
      fs.writeFileSync(bin, Buffer.concat([BIN, Buffer.from([1, 1])]));
      await shelve(mk(), { name, message: '', paths: [bin] });
      expect(fs.readFileSync(bin).equals(BIN)).toBe(true);
    }
    const info = (name: string) => ({ name, backend: 'patch' as const, message: '', fileCount: 1 });

    it('keeps the local version and the shelf when the user does not confirm; a copy is saved', async () => {
      await shelveChange('keepme');
      const mine = Buffer.concat([BIN, Buffer.from([9, 9, 9])]);
      fs.writeFileSync(bin, mine);
      const asked = vi.fn(async () => false);
      const res = await unshelve(mk(asked), info('keepme'), { drop: true });
      expect(asked).toHaveBeenCalledWith(['img.bin']);
      expect(fs.readFileSync(bin).equals(mine)).toBe(true);
      expect(res.dropped).toBe(false);
      expect(res.conflicts).toContain('img.bin');
      const saved = path.join(store.dir('alpha', 'keepme'), 'overwritten');
      expect(fs.readdirSync(saved).length).toBe(1);
      await sc.run(['revert', '--', 'img.bin'], { cwd: wc });
    });

    it('without a confirm callback nothing is overwritten', async () => {
      await sc.run(['revert', '--', 'img.bin'], { cwd: wc });
      fs.writeFileSync(bin, Buffer.concat([BIN, Buffer.from([4])]));
      const res = await unshelve(mk(), info('keepme'), { drop: false });
      expect(fs.readFileSync(bin).equals(Buffer.concat([BIN, Buffer.from([4])]))).toBe(true);
      expect(res.conflicts).toContain('img.bin');
      await sc.run(['revert', '--', 'img.bin'], { cwd: wc });
    });

    it('replaces the file after confirmation and keeps a backup copy', async () => {
      fs.writeFileSync(bin, Buffer.concat([BIN, Buffer.from([5, 5])]));
      const res = await unshelve(mk(async () => true), info('keepme'), { drop: true });
      expect(fs.readFileSync(bin).equals(Buffer.concat([BIN, Buffer.from([1, 1])]))).toBe(true);
      expect(res.dropped).toBe(true);
    });

    it('an unmodified local file is replaced without asking', async () => {
      await sc.run(['revert', '--', 'img.bin'], { cwd: wc });
      await shelveChange('plain');
      const asked = vi.fn(async () => false);
      const res = await unshelve(mk(asked), info('plain'), { drop: true });
      expect(asked).not.toHaveBeenCalled();
      expect(res.dropped).toBe(true);
      expect(fs.readFileSync(bin).equals(Buffer.concat([BIN, Buffer.from([1, 1])]))).toBe(true);
    });
  });
});
