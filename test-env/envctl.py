"""Local SVN test environment: svnserve (svn://) + Apache httpd/mod_dav_svn (http://, https://).

Usage: python test-env/envctl.py <setup|start|stop|status|reset|incoming> [options]
Tested: Windows 11, Python 3.12, TortoiseSVN 1.14.2, Apache httpd 2.4.71 (Lounge VS18), mod_dav_svn 1.15.0.
Everything runs as ordinary user processes (no services, no admin, no firewall changes); data lives in ENV_ROOT.
"""
import argparse
import base64
import os
import random
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
import zipfile
from datetime import datetime
from pathlib import Path

ENV_ROOT = Path(r"F:\TrashCache\svn-test-env")
CONF_DIR = Path(__file__).resolve().parent / "conf"
REPOS, WCS, RUN, AUTH, CERTS, SEED, CFG, TOOLS = (
    ENV_ROOT / n for n in ("repos", "wc", "run", "auth", "certs", "seed-tmp", "svn-config", "tools"))
HTTPD_HOME = TOOLS / "httpd-dist" / "Apache24"
MODSVN = TOOLS / "modsvn"

SVN_BIN = Path(r"C:\Program Files\TortoiseSVN\bin")
SVN, SVNADMIN, SVNSERVE = (SVN_BIN / n for n in ("svn.exe", "svnadmin.exe", "svnserve.exe"))

HOST = "127.0.0.1"
PORTS = {"svn": 13690, "http": 18080, "https": 18443}
REPO_NAMES = ["alpha", "beta"]
PROTOS = ["svn", "http", "https"]
RW_USER, RW_PASS = "tester", "tester-pass"
RO_USER, RO_PASS = "reader", "reader-pass"

HTTPD_URL = "https://www.apachelounge.com/download/VS18/binaries/httpd-2.4.71-261112-Win64-VS18.zip"
MODSVN_URL = "https://github.com/nono303/win-svn/releases/download/1.15.0/vs18-x64-avx2.zip"

NO_WINDOW = 0x08000000 | 0x00000008 | 0x00000200  # CREATE_NO_WINDOW | DETACHED_PROCESS | NEW_PROCESS_GROUP


def say(m):
    print(f"[test-env] {m}", flush=True)


def repo_url(repo, proto):
    return {"svn": f"svn://{HOST}:{PORTS['svn']}/{repo}",
            "http": f"http://{HOST}:{PORTS['http']}/svn/{repo}",
            "https": f"https://{HOST}:{PORTS['https']}/svn/{repo}"}[proto]


def wc_path(repo, proto, n):
    return WCS / f"{repo}-{proto}" / f"wc{n}"


def svn(*args, check=True):
    cmd = [str(SVN), *map(str, args), "--non-interactive", "--no-auth-cache", "--config-dir", str(CFG),
           "--username", RW_USER, "--password", RW_PASS,
           "--trust-server-cert-failures", "unknown-ca,cn-mismatch,expired,not-yet-valid,other"]
    r = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if check and r.returncode != 0:
        raise SystemExit(f"svn {args[0]} failed ({r.returncode}): {r.stderr.strip()}")
    return r.stdout


def check_tools():
    for f in (SVN, SVNADMIN, SVNSERVE):
        if not f.exists():
            raise SystemExit(f"Missing {f}. Install TortoiseSVN with the command line client tools.")


def have_httpd():
    return (HTTPD_HOME / "bin" / "httpd.exe").exists() and (MODSVN / "mod_dav_svn.so").exists()


def port_open(port):
    try:
        with socket.create_connection((HOST, port), timeout=0.5):
            return True
    except OSError:
        return False


def wait_port(port, secs=20):
    end = time.time() + secs
    while time.time() < end:
        if port_open(port):
            return True
        time.sleep(0.25)
    return False


def pidfile(name):
    return RUN / f"{name}.pid"


def running(name):
    pf = pidfile(name)
    if not pf.exists():
        return False
    out = subprocess.run(["tasklist", "/FI", f"PID eq {pf.read_text().strip()}", "/NH"],
                         capture_output=True, text=True).stdout
    return pf.read_text().strip() in out


def stop_named(name):
    pf = pidfile(name)
    if pf.exists():
        pid = pf.read_text().strip()
        subprocess.run(["taskkill", "/PID", pid, "/T", "/F"], capture_output=True)  # /T also ends Apache children
        pf.unlink()
        say(f"stopped {name} (pid {pid})")


def download(url, dest, referer=None):
    dest.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", **({"Referer": referer} if referer else {})})
    with urllib.request.urlopen(req) as r, open(dest, "wb") as f:
        shutil.copyfileobj(r, f)


# ---------------------------------------------------------------- setup
def cmd_setup(_):
    check_tools()
    dl = TOOLS / "dl"
    if not (HTTPD_HOME / "bin" / "httpd.exe").exists():
        z = dl / "httpd.zip"
        if not z.exists():
            say("downloading Apache httpd (Apache Lounge VS18 build; needs a recent VC++ runtime)")
            download(HTTPD_URL, z, "https://www.apachelounge.com/download/")
        zipfile.ZipFile(z).extractall(TOOLS / "httpd-dist")
    if not (MODSVN / "mod_dav_svn.so").exists():
        z = dl / "win-svn15.zip"
        if not z.exists():
            say("downloading mod_dav_svn (nono303/win-svn 1.15.0, AVX2 build; use the avx zip if the CPU lacks AVX2)")
            download(MODSVN_URL, z)
        zipfile.ZipFile(z).extractall(MODSVN)
    CERTS.mkdir(parents=True, exist_ok=True)
    if not (CERTS / "server.crt").exists():
        env = {**os.environ, "OPENSSL_CONF": str(HTTPD_HOME / "conf" / "openssl.cnf")}
        r = subprocess.run([str(HTTPD_HOME / "bin" / "openssl.exe"), "req", "-x509", "-newkey", "rsa:2048", "-nodes",
                            "-days", "3650", "-keyout", str(CERTS / "server.key"), "-out", str(CERTS / "server.crt"),
                            "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost"],
                           env=env, capture_output=True, text=True)
        if r.returncode:
            raise SystemExit("openssl failed: " + r.stderr)
    say(f"setup done; httpd available = {have_httpd()}")


# ---------------------------------------------------------------- start / stop / status
def cmd_start(args):
    check_tools()
    if not REPOS.exists():
        raise SystemExit("No repos yet. Run: python test-env/envctl.py reset")
    RUN.mkdir(parents=True, exist_ok=True)
    AUTH.mkdir(parents=True, exist_ok=True)
    (AUTH / "authz").write_text(f"[/]\n{RW_USER} = rw\n{RO_USER} = r\n")
    (AUTH / "passwd").write_text(f"[users]\n{RW_USER} = {RW_PASS}\n{RO_USER} = {RO_PASS}\n")

    if running("svnserve"):
        say("svnserve already running")
    else:
        p = subprocess.Popen([str(SVNSERVE), "-d", "--foreground", "-r", str(REPOS), "--listen-host", HOST,
                              "--listen-port", str(PORTS["svn"])], creationflags=NO_WINDOW,
                             stdout=open(RUN / "svnserve.out.log", "wb"), stderr=open(RUN / "svnserve.err.log", "wb"),
                             stdin=subprocess.DEVNULL)
        pidfile("svnserve").write_text(str(p.pid))
        if not wait_port(PORTS["svn"]):
            raise SystemExit(f"svnserve did not open port {PORTS['svn']}; see {RUN}\\svnserve.err.log")
        say(f"svnserve up: svn://{HOST}:{PORTS['svn']}/ (pid {p.pid})")

    if args.svn_only:
        return
    if not have_httpd():
        say("Apache not set up (run: envctl.py setup); http/https skipped")
        return
    if running("httpd"):
        say("httpd already running")
        return
    htpasswd = str(HTTPD_HOME / "bin" / "htpasswd.exe")
    hp = AUTH / "htpasswd"
    hp.unlink(missing_ok=True)
    subprocess.run([htpasswd, "-cbm", str(hp), RW_USER, RW_PASS], capture_output=True, check=True)
    subprocess.run([htpasswd, "-bm", str(hp), RO_USER, RO_PASS], capture_output=True, check=True)

    conf = (CONF_DIR / "httpd.conf.template").read_text()
    for k, v in {"HTTPD": HTTPD_HOME, "HTTP_PORT": PORTS["http"], "HTTPS_PORT": PORTS["https"], "RUN": RUN,
                 "MODSVN": MODSVN, "REPOS": REPOS, "AUTH": AUTH, "CERT": CERTS}.items():
        conf = conf.replace(f"@@{k}@@", str(v).replace("\\", "/"))
    conf_file = RUN / "httpd.conf"
    conf_file.write_text(conf)

    # Apache's own DLLs first; mod_dav_svn's libsvn_* and extra deps (sqlite, serf, ...) after
    env = {**os.environ, "PATH": os.pathsep.join([str(HTTPD_HOME / "bin"), str(MODSVN), str(MODSVN / "deps"),
                                                    os.environ["PATH"]])}
    err = RUN / "httpd.err.log"
    p = subprocess.Popen([str(HTTPD_HOME / "bin" / "httpd.exe"), "-f", str(conf_file)], env=env,
                         creationflags=NO_WINDOW, stdout=open(RUN / "httpd.out.log", "wb"), stderr=open(err, "wb"),
                         stdin=subprocess.DEVNULL)
    pidfile("httpd").write_text(str(p.pid))
    if not wait_port(PORTS["http"]):
        stop_named("httpd")
        raise SystemExit(f"httpd did not open port {PORTS['http']}; see {err} and {RUN}\\httpd-error.log")
    say(f"httpd up: http://{HOST}:{PORTS['http']}/svn/ and https://{HOST}:{PORTS['https']}/svn/ (pid {p.pid})")


def cmd_stop(_=None):
    for n in ("httpd", "svnserve"):
        stop_named(n)
    say("stopped")


def cmd_status(_):
    say(f"svn.exe: {SVN} (exists: {SVN.exists()})")
    for p in PROTOS:
        say(f"{p:<6} port {PORTS[p]}: {'LISTENING' if port_open(PORTS[p]) else 'down'}")
    for r in REPO_NAMES:
        for p in PROTOS:
            say(f"{r:<6} {repo_url(r, p)}  wc1={wc_path(r, p, 1)}  wc2={wc_path(r, p, 2)}")


# ---------------------------------------------------------------- reset
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")


def w(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(text.encode("utf-8"))


def wb(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(bytes(data))


def seed_alpha(t):
    w(t / "README.txt", "Alpha project\nLine 2 of the readme\nLine 3 of the readme\n")
    w(t / "src/main.py", "def main():\n    print('hello from alpha')\n\n\nif __name__ == '__main__':\n    main()\n")
    w(t / "src/util/helpers.py", "def add(a, b):\n    return a + b\n\n" + "".join(f"# filler line {i}\n" for i in range(1, 31)))
    w(t / "src/util/deep/er/still/leaf.txt", "deeply nested leaf\n")
    w(t / "docs/guide.md", "# Guide\n\nSome documentation.\n\n## Section\n\nMore text.\n")
    w(t / "data/sample.csv", "id,name,value\n1,one,10\n2,two,20\n3,three,30\n")
    wb(t / "assets/logo.png", PNG)
    wb(t / "assets/blob.bin", [(i * 7 + 3) % 256 for i in range(4096)])


def seed_beta(t):
    w(t / "README.md", "# Beta service\n\nSecond repo that simulates another server.\n")
    w(t / "app/server.js", "const http = require('http');\nhttp.createServer((q, r) => r.end('beta')).listen(3000);\n")
    w(t / "app/config.json", '{\n  "name": "beta",\n  "debug": false\n}\n')
    w(t / "app/lib/strings.txt", "alpha\nbeta\ngamma\ndelta\n")
    w(t / "notes/file with spaces.txt", "name has spaces\n")
    w(t / "notes/unicode-caf\u00e9.txt", "unicode filename and content: caf\u00e9\n")
    w(t / "scripts/run.bat", "@echo off\r\necho beta\r\n")
    wb(t / "assets/logo.png", PNG)
    wb(t / "assets/data.bin", [(i * 13 + 5) % 256 for i in range(8192)])


def rmtree(d):
    def force(fn, path, _exc):  # svn repos and .svn dirs contain read-only files
        os.chmod(path, 0o700)
        fn(path)
    if d.exists():
        shutil.rmtree(d, onerror=force)


def cmd_reset(args):
    check_tools()
    cmd_stop()
    time.sleep(0.5)
    for d in (REPOS, WCS, RUN, AUTH, SEED, CFG):
        rmtree(d)
    for d in (REPOS, WCS, RUN, AUTH, CFG):
        d.mkdir(parents=True)
    for r in REPO_NAMES:
        repo = REPOS / r
        subprocess.run([str(SVNADMIN), "create", str(repo)], check=True)
        (repo / "conf" / "svnserve.conf").write_text(
            f"[general]\nanon-access = none\nauth-access = write\npassword-db = {AUTH}\\passwd\n"
            f"authz-db = {AUTH}\\authz\nrealm = svn-test-env {r}\n")
        seed = SEED / r
        for d in ("branches", "tags"):
            (seed / d).mkdir(parents=True)
        (seed_alpha if r == "alpha" else seed_beta)(seed / "trunk")
        svn("import", seed, "file:///" + str(repo).replace("\\", "/"), "-m",
            f"Initial import of {r} (trunk/branches/tags layout)")
        say(f"created and seeded repo {r}")
    rmtree(SEED)

    cmd_start(args)

    for r in REPO_NAMES:
        for p in PROTOS:
            if p != "svn" and (args.svn_only or not port_open(PORTS[p])):
                continue
            for n in (1, 2):
                wc = wc_path(r, p, n)
                wc.parent.mkdir(parents=True, exist_ok=True)
                svn("checkout", repo_url(r, p) + "/trunk", wc)
            say(f"checked out {r} via {p} (wc1, wc2)")
    say("reset complete. Run: python test-env/envctl.py status")


# ---------------------------------------------------------------- incoming
def cmd_incoming(args):
    wc = wc_path(args.repo, args.proto, 2)
    if not wc.exists():
        raise SystemExit(f"No working copy at {wc}. Run reset first (and make sure the {args.proto} server is up).")
    stamp = datetime.now().strftime("%H%M%S")
    alpha = args.repo == "alpha"
    text = "src/main.py" if alpha else "app/server.js"
    readme = "README.txt" if alpha else "README.md"
    binf = "assets/blob.bin" if alpha else "assets/data.bin"
    dele = "data/sample.csv" if alpha else "app/lib/strings.txt"
    svn("update", wc)

    def modify():
        with open(wc / text, "a", newline="\n", encoding="utf-8") as f:
            f.write(f"// incoming change {stamp}\n")

    def add():
        p = wc / f"incoming-{stamp}.txt"
        p.write_text(f"new file from wc2 at {stamp}\n")
        svn("add", p)

    def binary():
        (wc / binf).write_bytes(random.Random(int(stamp)).randbytes(4096))

    a = args.action
    if a == "Modify":
        modify()
    elif a == "Add":
        add()
    elif a == "Delete":
        svn("delete", wc / dele)
    elif a == "Binary":
        binary()
    elif a == "Folder":
        d = wc / f"incoming-dir-{stamp}"
        (d / "sub").mkdir(parents=True)
        (d / "sub" / "a.txt").write_text("a\n")
        (d / "sub" / "b.txt").write_text("b\n")
        svn("add", d)
    elif a == "Rename":
        src = wc / text
        svn("move", src, src.with_name(f"{src.stem}-renamed-{stamp}{src.suffix}"))
    elif a == "Conflict":
        p = wc / readme
        lines = p.read_text().split("\n")
        lines[0] += f" [changed on server {stamp}]"
        p.write_bytes("\n".join(lines).encode())
    elif a == "Mixed":
        modify(); add(); binary()
    out = svn("commit", wc, "-m", f"incoming: {a} from wc2 at {stamp}")
    for line in out.strip().splitlines():
        say(line)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("setup", help="download portable Apache + mod_dav_svn, create self-signed cert").set_defaults(fn=cmd_setup)
    for n, fn, h in (("start", cmd_start, "start servers"), ("reset", cmd_reset, "wipe and recreate everything")):
        s = sub.add_parser(n, help=h)
        s.add_argument("--svn-only", action="store_true", help="only svnserve / svn:// working copies")
        s.set_defaults(fn=fn)
    sub.add_parser("stop", help="stop servers").set_defaults(fn=cmd_stop)
    sub.add_parser("status", help="show ports, URLs, paths").set_defaults(fn=cmd_status)
    i = sub.add_parser("incoming", help="commit from wc2 to create incoming changes for wc1")
    i.add_argument("--repo", choices=REPO_NAMES, default="alpha")
    i.add_argument("--proto", choices=PROTOS, default="svn")
    i.add_argument("--action", default="Modify",
                   choices=["Modify", "Add", "Delete", "Binary", "Folder", "Rename", "Conflict", "Mixed"])
    i.set_defaults(fn=cmd_incoming)
    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
