import { CloudWatchService } from "../services/cloudWatchService";
import { IDebugProvider } from "./IDebugProvider";
import { DebugSignal, DebugOptions } from "../types";

const cw = new CloudWatchService();

export class CloudWatchLogsProvider implements IDebugProvider {
  readonly name = "CloudWatch Logs";

  async isAvailable(options: DebugOptions): Promise<boolean> {
    return cw.pingLogs(options.awsRegion ?? "us-east-1");
  }

  async fetchSignals(serviceName: string, options: DebugOptions): Promise<DebugSignal[]> {
    const region = options.awsRegion ?? "us-east-1";
    const groups = options.logGroups?.length
      ? options.logGroups
      : await cw.discoverLogGroups(serviceName, region);
    return cw.queryLogs(groups, region, { since: options.since, tailLines: options.tailLines });
  }
}
