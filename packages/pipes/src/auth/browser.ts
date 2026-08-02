/**
 * Best-effort browser auto-open for a login URL, on top of `sindresorhus/open`
 * (the standard cross-platform launcher: `open` on macOS, `start` on Windows,
 * `xdg-open` elsewhere) -- matches GitHub CLI's own device-flow pattern and
 * Enigma's identically-named module: always show the URL as text regardless,
 * and treat opening a real browser as a convenience that can fail (headless
 * session, no browser installed, SSH-only remote) without ever failing the
 * login itself.
 */
import open from "open";

export type BrowserOpener = (url: string) => Promise<unknown>;

/** Resolves true if a browser was launched, false if it failed -- never throws. */
export async function openInBrowser(url: string, opener: BrowserOpener = open): Promise<boolean> {
	try {
		await opener(url);
		return true;
	} catch {
		return false;
	}
}
