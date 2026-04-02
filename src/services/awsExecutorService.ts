import {
  CloudControlClient,
  CreateResourceCommand,
  UpdateResourceCommand,
  DeleteResourceCommand,
  GetResourceRequestStatusCommand,
  OperationStatus,
} from "@aws-sdk/client-cloudcontrol";
import { CloudControlCall, AwsCredentials } from "../types";
import { createLogger } from "../utils/logging";

const log = createLogger({ component: "aws-executor" });

const POLL_INITIAL_MS  = 1_000;
const POLL_MAX_MS      = 10_000;
const POLL_TIMEOUT_MS  = 10 * 60 * 1000; // 10 minutes — some resources (EKS, RDS) take time

export interface AwsCallResult {
  call: CloudControlCall;
  success: boolean;
  identifier?: string; // primary id of the created/updated resource
  error?: string;
}

/**
 * Executes an ordered list of Cloud Control API calls produced by AwsPlannerAgent.
 *
 * Cloud Control provides a single unified CRUD surface for every AWS resource
 * type that CloudFormation supports — no per-service SDK clients needed.
 *
 * All mutating operations are async; this service polls
 * GetResourceRequestStatus until SUCCESS or FAILED.
 *
 * Calls are executed sequentially so dependencies are guaranteed to exist.
 */
export class AwsExecutorService {
  private readonly client: CloudControlClient;

  constructor(region: string, credentials?: AwsCredentials) {
    this.client = new CloudControlClient({
      region,
      ...(credentials && { credentials }),
    });
  }

  async execute(calls: CloudControlCall[]): Promise<AwsCallResult[]> {
    const results: AwsCallResult[] = [];
    for (const call of calls) {
      const result = await this.executeOne(call);
      results.push(result);
      if (!result.success) {
        log.error("Cloud Control call failed — stopping", {
          event: "cc_call_failed",
          typeName: call.typeName,
          operation: call.operation,
          error: result.error,
        });
        break;
      }
    }
    return results;
  }

  describeCallPlan(calls: CloudControlCall[]): string {
    return calls
      .map((c, i) => `${i + 1}. [${c.operation.toUpperCase()}] ${c.typeName}  — ${c.description}`)
      .join("\n");
  }

  // ── private ──────────────────────────────────────────────────────────────────

  private async executeOne(call: CloudControlCall): Promise<AwsCallResult> {
    const startedAt = Date.now();
    log.debug("Executing Cloud Control call", { typeName: call.typeName, operation: call.operation });

    try {
      let requestToken: string | undefined;

      if (call.operation === "create") {
        const res = await this.client.send(
          new CreateResourceCommand({
            TypeName: call.typeName,
            DesiredState: JSON.stringify(call.desiredState),
          }),
        );
        requestToken = res.ProgressEvent?.RequestToken;
      } else if (call.operation === "update") {
        if (!call.identifier) throw new Error("identifier required for update");
        const res = await this.client.send(
          new UpdateResourceCommand({
            TypeName: call.typeName,
            Identifier: call.identifier,
            PatchDocument: JSON.stringify(call.desiredState),
          }),
        );
        requestToken = res.ProgressEvent?.RequestToken;
      } else {
        if (!call.identifier) throw new Error("identifier required for delete");
        const res = await this.client.send(
          new DeleteResourceCommand({
            TypeName: call.typeName,
            Identifier: call.identifier,
          }),
        );
        requestToken = res.ProgressEvent?.RequestToken;
      }

      if (!requestToken) throw new Error("No RequestToken returned — cannot poll status");

      const identifier = await this.poll(requestToken);
      log.debug("Cloud Control call succeeded", {
        event: "cc_call_success",
        typeName: call.typeName,
        operation: call.operation,
        identifier,
        latencyMs: Date.now() - startedAt,
      });
      return { call, success: true, identifier };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { call, success: false, error: message };
    }
  }

  /** Poll GetResourceRequestStatus until the operation completes or times out. */
  private async poll(requestToken: string): Promise<string | undefined> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let interval = POLL_INITIAL_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, interval));
      interval = Math.min(interval * 1.5, POLL_MAX_MS);
      const { ProgressEvent: ev } = await this.client.send(
        new GetResourceRequestStatusCommand({ RequestToken: requestToken }),
      );
      if (!ev) throw new Error("Empty ProgressEvent during polling");

      if (ev.OperationStatus === OperationStatus.SUCCESS) return ev.Identifier;
      if (
        ev.OperationStatus === OperationStatus.FAILED ||
        ev.OperationStatus === OperationStatus.CANCEL_COMPLETE
      ) {
        throw new Error(ev.StatusMessage ?? `Operation ${ev.OperationStatus}`);
      }
      // IN_PROGRESS / PENDING — keep polling
    }
    throw new Error(`Timed out after ${POLL_TIMEOUT_MS / 1000}s waiting for Cloud Control operation`);
  }
}
