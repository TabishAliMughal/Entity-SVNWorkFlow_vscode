import { SvnError } from './errors';
import { DiscoveryResult, findSvnExe, notFoundMessage } from './discovery';

/** Caches the discovered svn.exe; call invalidate() when the svnPath setting changes. */
export class SvnLocator {
  private cached?: DiscoveryResult;

  constructor(
    private readonly getCustomPath: () => string,
    private readonly finder: typeof findSvnExe = findSvnExe,
  ) {}

  invalidate(): void {
    this.cached = undefined;
  }

  discover(): DiscoveryResult {
    if (!this.cached?.path) {
      this.cached = this.finder({ customPath: this.getCustomPath() });
    }
    return this.cached;
  }

  /** Path to svn.exe, or throws SvnError('svnNotFound') with setup guidance. */
  getExe(): string {
    const res = this.discover();
    if (!res.path) {
      this.cached = undefined;
      throw new SvnError('svnNotFound', notFoundMessage(res, this.getCustomPath()));
    }
    return res.path;
  }
}
