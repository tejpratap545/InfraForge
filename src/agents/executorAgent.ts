import { ApplyResult, InfraPlan } from "../types";
import { TerraformMcpService } from "../services/terraformMcpService";

export class ExecutorAgent {
  constructor(private readonly terraformMcp: TerraformMcpService) {}

  async execute(tenantId: string, plan: InfraPlan): Promise<ApplyResult> {
    const dir = await this.terraformMcp.materializePlan(tenantId, plan);
    const planOutput = await this.terraformMcp.runPlan(dir);
    const applyOutput = await this.terraformMcp.runApply(dir);
    return { planOutput, applyOutput };
  }

  async dryRun(tenantId: string, plan: InfraPlan): Promise<{ planOutput: string; dir: string }> {
    const dir = await this.terraformMcp.materializePlan(tenantId, plan);
    const planOutput = await this.terraformMcp.runPlan(dir);
    return { planOutput, dir };
  }
}
