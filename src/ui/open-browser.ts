import { spawn } from "node:child_process";

/**
 * Open a URL in the default browser. Best effort: never throws, never keeps
 * the process alive.
 */
export function openBrowser(url: string): void {
  try {
    let cmd: string;
    let args: string[];
    switch (process.platform) {
      case "darwin":
        cmd = "open";
        args = [url];
        break;
      case "win32":
        cmd = "cmd";
        args = ["/c", "start", "", url];
        break;
      default:
        cmd = "xdg-open";
        args = [url];
    }
    const child = spawn(cmd, args, { stdio: "ignore", detached: true, windowsHide: true });
    child.on("error", () => {
      /* ignore: no browser available */
    });
    child.unref();
  } catch {
    /* ignore */
  }
}
