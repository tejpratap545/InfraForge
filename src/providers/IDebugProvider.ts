import { DebugSignal, DebugOptions } from "../types";

export interface IDebugProvider {
  /** Human-readable name shown in status output. */
  readonly name: string;
  /**
   * Returns true if the provider is reachable / configured for the given
   * options. Must not throw — return false on any error.
   */
  isAvailable(options: DebugOptions): Promise<boolean>;
  /**
   * Collect signals for the given service name. Must not throw — return an
   * empty array if the query fails, so other providers still contribute.
   */
  fetchSignals(serviceName: string, options: DebugOptions): Promise<DebugSignal[]>;
}
