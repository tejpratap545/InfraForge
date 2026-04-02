import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { ClarificationQuestion, Intent } from "../types";

export async function askText(question: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    const value = await rl.question(`${question}: `);
    return value.trim();
  } finally {
    rl.close();
  }
}

async function askRequiredText(question: string): Promise<string> {
  const value = await askText(question);
  if (value.length > 0) {
    return value;
  }
  throw new Error(`Input required for: ${question}`);
}

async function askQuestionWithOptions(item: ClarificationQuestion): Promise<string> {
  const options = item.options?.filter((v) => v.trim().length > 0) ?? [];
  if (options.length === 0) {
    return askText(item.question);
  }

  console.log(`\n${item.question}`);
  options.forEach((option, index) => {
    console.log(`  ${index + 1}) ${option}`);
  });
  const otherIndex = options.length + 1;
  if (item.allowCustom) {
    console.log(`  ${otherIndex}) Other`);
  }

  const raw = await askText(
    item.allowCustom
      ? `Select an option (1-${otherIndex})`
      : `Select an option (1-${options.length})`,
  );
  const selected = Number(raw);

  if (!Number.isInteger(selected) || selected < 1) {
    throw new Error(`Invalid option selected for: ${item.question}`);
  }

  if (selected <= options.length) {
    return options[selected - 1];
  }

  if (item.allowCustom && selected === otherIndex) {
    return askRequiredText("Enter custom value");
  }

  throw new Error(`Invalid option selected for: ${item.question}`);
}

export async function collectMissingIntentFields(
  intent: Intent,
  questions: ClarificationQuestion[] = [],
): Promise<Intent> {
  const next = { ...intent };
  next.parameters = { ...(intent.parameters ?? {}) };

  for (const item of questions) {
    const answer = await askQuestionWithOptions(item);
    if (item.required && answer.length === 0) {
      throw new Error(`Input required for: ${item.question}`);
    }
    if (!answer) continue;

    switch (item.key) {
      case "region":
        next.region = answer;
        break;
      case "instanceType":
        next.instanceType = answer;
        break;
      case "clusterName":
        next.clusterName = answer;
        break;
      case "vpcCidr":
        next.vpcCidr = answer;
        break;
      case "roleName":
        next.roleName = answer;
        break;
      case "bucketName":
        next.bucketName = answer;
        break;
      default:
        next.parameters[item.key] = answer;
    }
  }

  // Fallbacks when no clarifications were generated.
  if (!next.region) {
    next.region = await askRequiredText("Enter AWS region (e.g., ap-south-1)");
  }
  if (next.resourceTypes.length === 0) {
    next.resourceTypes = ["aws_s3_bucket"];
  }

  return next;
}

export async function askForApproval(summary: string): Promise<boolean> {
  const answer = (await askText(`${summary}\nProceed? (yes/no)`)).toLowerCase();
  return answer === "yes" || answer === "y";
}
