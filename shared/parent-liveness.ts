// shared/parent-liveness.ts
// Detect MCP server processes that outlived their parent Claude/Codex session.

export interface ParentLivenessProbe {
  lost: boolean;
  ppidChanged: boolean;
}

export type SignalProbe = (pid: number) => boolean;

export function canSignalPid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as { code?: string } | null)?.code;
    // EPERM still proves the process exists; ESRCH means it does not.
    if (code === "EPERM") return true;
    if (code === "ESRCH") return false;
    return false;
  }
}

export function checkInitialParentLiveness(
  initialParentPid: number,
  currentParentPid: number,
  canSignal: SignalProbe = canSignalPid,
): ParentLivenessProbe {
  if (!Number.isInteger(initialParentPid) || initialParentPid <= 1) {
    return { lost: false, ppidChanged: false };
  }

  const ppidChanged = currentParentPid !== initialParentPid;
  const parentExists = canSignal(initialParentPid);

  return {
    lost: !parentExists || (ppidChanged && currentParentPid === 1),
    ppidChanged,
  };
}
