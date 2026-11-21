// Shared wrapper: every agent runs through here so the Coordinator gets a uniform,
// honest record of what ran, how long it took, and whether it succeeded.
export async function runAgent({ name, role, dependsOn = [], optional = false }, fn) {
  const startedAt = Date.now();
  try {
    const { output, summary = '', notes = [] } = await fn();
    return {
      ok: true,
      output,
      trace: { agent: name, role, dependsOn, status: 'ok', ms: Date.now() - startedAt, summary, notes },
    };
  } catch (error) {
    return {
      ok: false,
      output: null,
      error,
      trace: {
        agent: name, role, dependsOn,
        status: optional ? 'degraded' : 'failed',
        ms: Date.now() - startedAt,
        summary: error.message,
        notes: [],
      },
    };
  }
}

export function skippedTrace(name, role, dependsOn, reason) {
  return { agent: name, role, dependsOn, status: 'skipped', ms: 0, summary: reason, notes: [] };
}
