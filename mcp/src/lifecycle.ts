/**
 * Keep MCP processes from outliving their host (Cursor / Claude Code).
 *
 * Orphaned sudocode-mcp instances accumulate across sessions and look like
 * memory/CPU bloat in Activity Monitor even when each process is idle.
 */

const PARENT_CHECK_MS = 5_000;

export function installHostLifecycleGuards(label = "sudocode-mcp"): void {
  const initialParent = process.ppid;

  const shutdown = (reason: string) => {
    console.error(`[${label}] exiting: ${reason}`);
    // Use exit code 0 so hosts don't treat a clean disconnect as a crash.
    process.exit(0);
  };

  const onSignal = (signal: NodeJS.Signals) => {
    shutdown(`received ${signal}`);
  };

  process.once("SIGTERM", () => onSignal("SIGTERM"));
  process.once("SIGINT", () => onSignal("SIGINT"));
  process.once("SIGHUP", () => onSignal("SIGHUP"));

  // Stdio MCP: when the host closes the pipe, we must die.
  // NB: do NOT resume() stdin here. This runs before StdioServerTransport
  // connects, and resuming puts stdin in flowing mode with no reader — Node
  // then reads and discards the client's `initialize` message, so the handshake
  // never gets a reply and the host times out. The transport resumes stdin
  // itself on connect, which is what delivers the EOF these listeners need.
  if (process.stdin) {
    process.stdin.on("end", () => shutdown("stdin end"));
    process.stdin.on("close", () => shutdown("stdin close"));
  }

  const timer = setInterval(() => {
    try {
      // Throws if parent no longer exists.
      process.kill(initialParent, 0);
    } catch {
      shutdown(`parent pid ${initialParent} is gone`);
      return;
    }

    // Reparented to launchd/init after host crash.
    if (process.ppid === 1) {
      shutdown(`reparented to init (was ${initialParent})`);
    }
  }, PARENT_CHECK_MS);

  // Don't keep the event loop alive solely for the watchdog.
  timer.unref();
}
