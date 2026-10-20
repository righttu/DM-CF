// Container runtime release: the SDK's Container.stop() only signals SIGTERM
// and returns without confirming the runtime exited (observed: finished jobs
// left instances running, exhausting max_instances). destroy() releases the
// runtime; this helper resolves only after awaited destruction and confirms
// runtime.running is false. Never wipes DO storage or job data.
export interface ContainerRuntimeControl {
  readonly running: boolean;
  destroy(): Promise<void>;
}

// Stable marker for classifying release failures across RPC / Workflow steps.
export const CONTAINER_RELEASE_FAILED = "container_release_failed";

// Evidence a DO-side stopJob returns after a confirmed release. The workflow
// records this struct as the memoized step output so a bare null RPC result
// can never masquerade as a release.
export interface ContainerReleaseConfirmation {
  container_released: true;
  release_method: "destroy";
}

export async function destroyRunningContainer(
  runtime: ContainerRuntimeControl
): Promise<void> {
  // A false local `running` flag is not sufficient reason to skip requesting
  // release — the flag can lag the real runtime state, and destroy() on an
  // already-stopped runtime was verified idempotent in production.
  await runtime.destroy();
  if (runtime.running) {
    throw new Error("container_still_running_after_destroy");
  }
}
