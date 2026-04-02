import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  type InvokeModelCommandInput,
} from "@aws-sdk/client-bedrock-runtime";
import { createLogger } from "../utils/logging";
import { TelemetryCollector } from "./telemetryCollector";

const DEFAULT_MAX_TOKENS = 4096;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 500;
const DEFAULT_MODEL_ID = "global.anthropic.claude-sonnet-4-5-20250929-v1:0";
const FALLBACK_MODEL_ID = "mistral.mistral-large-3-675b-instruct";
const log = createLogger({ component: "bedrock" });

export interface CompleteOptions {
  maxTokens?: number;
}

export class BedrockService {
  private readonly client: BedrockRuntimeClient;
  private readonly region: string;
  private readonly modelId: string;
  private readonly canFallbackToMarketplaceFreeModel: boolean;
  private readonly telemetry?: TelemetryCollector;

  constructor(
    region: string,
    modelId = process.env.BEDROCK_MODEL_ID?.trim() || DEFAULT_MODEL_ID,
    telemetry?: TelemetryCollector,
  ) {
    this.client = new BedrockRuntimeClient({ region });
    this.region = region;
    this.modelId = modelId;
    this.telemetry = telemetry;
    this.canFallbackToMarketplaceFreeModel =
      !process.env.BEDROCK_MODEL_ID?.trim() && modelId === DEFAULT_MODEL_ID;
  }

  private buildRequestBody(modelId: string, prompt: string, maxTokens: number): string {
    if (modelId.startsWith("anthropic.") || modelId.includes(".anthropic.")) {
      return JSON.stringify({
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: maxTokens,
        temperature: 0,
        messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
      });
    }

    if (modelId.startsWith("mistral.")) {
      return JSON.stringify({
        prompt,
        max_tokens: maxTokens,
        temperature: 0,
      });
    }

    return JSON.stringify({
      inputText: prompt,
      textGenerationConfig: {
        maxTokenCount: maxTokens,
        temperature: 0,
      },
    });
  }

  private buildMessagesBody(prompt: string, maxTokens: number): string {
    return JSON.stringify({
      max_tokens: maxTokens,
      temperature: 0,
      messages: [{ role: "user", content: prompt }],
    });
  }

  private parseResponseBody(decoded: string): { text: string; inputTokens: number; outputTokens: number } {
    const parsed = JSON.parse(decoded) as Record<string, unknown>;

    // Extract token usage — present in Anthropic and OpenAI-style responses.
    const usage = parsed.usage as Record<string, number> | undefined;
    const inputTokens  = usage?.input_tokens  ?? usage?.prompt_tokens     ?? 0;
    const outputTokens = usage?.output_tokens ?? usage?.completion_tokens ?? 0;

    let text: string | undefined;

    if (Array.isArray(parsed.content)) {
      const first = parsed.content[0] as { text?: string } | undefined;
      if (first?.text) text = first.text;
    }

    if (!text && Array.isArray(parsed.outputs)) {
      const first = parsed.outputs[0] as { text?: string } | undefined;
      if (first?.text) text = first.text;
    }

    if (!text && typeof parsed.outputText === "string" && parsed.outputText.length > 0) {
      text = parsed.outputText;
    }

    if (!text && Array.isArray(parsed.choices)) {
      const first = parsed.choices[0] as
        | { text?: string; message?: { content?: string | Array<{ text?: string }> } }
        | undefined;
      if (typeof first?.text === "string" && first.text.length > 0) text = first.text;
      const messageContent = first?.message?.content;
      if (!text && typeof messageContent === "string" && messageContent.length > 0) text = messageContent;
      if (!text && Array.isArray(messageContent)) {
        const chunk = messageContent[0] as { text?: string } | undefined;
        if (chunk?.text) text = chunk.text;
      }
    }

    if (!text && Array.isArray(parsed.generations)) {
      const first = parsed.generations[0] as { text?: string } | undefined;
      if (first?.text) text = first.text;
    }

    if (!text) throw new Error(`Bedrock response had no text output. raw=${decoded.slice(0, 400)}`);
    return { text, inputTokens, outputTokens };
  }

  private isRetryable(message: string): boolean {
    return (
      message.includes("ThrottlingException") ||
      message.includes("ServiceUnavailableException") ||
      message.toLowerCase().includes("too many requests") ||
      message.includes("Rate exceeded")
    );
  }

  private isInvalidModelIdentifier(message: string): boolean {
    const normalized = message.toLowerCase();
    return (
      normalized.includes("model identifier is invalid") ||
      normalized.includes("provided model identifier is invalid") ||
      normalized.includes("could not resolve the foundation model from the provided model identifier")
    );
  }

  private isMarketplacePaymentIssue(message: string): boolean {
    const normalized = message.toLowerCase();
    return (
      normalized.includes("invalid_payment_instrument") ||
      normalized.includes("valid payment instrument") ||
      normalized.includes("marketplace subscription for this model cannot be completed")
    );
  }

  private isAnthropicFirstTimeUseIssue(message: string): boolean {
    const normalized = message.toLowerCase();
    return (
      normalized.includes("putusecaseformodelaccess") ||
      normalized.includes("first time use") ||
      normalized.includes("use case details") ||
      normalized.includes("submit use case details")
    );
  }

  async complete(prompt: string, options: CompleteOptions = {}): Promise<string> {
    const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
    const modelIds = [this.modelId];
    if (this.canFallbackToMarketplaceFreeModel && this.modelId !== FALLBACK_MODEL_ID) {
      modelIds.push(FALLBACK_MODEL_ID);
    }

    let lastError: unknown;

    for (const modelId of modelIds) {
      const startedAt = Date.now();

      log.debug("Starting Bedrock model invocation", {
        event: "invoke_start",
        modelId,
        maxTokens,
        promptPreview: prompt.slice(0, 300),
      });

      const makeInput = (body: string): InvokeModelCommandInput => ({
        modelId,
        contentType: "application/json",
        accept: "application/json",
        body,
      });

      const run = async (body: string): Promise<{ text: string; inputTokens: number; outputTokens: number }> => {
        const response = await this.client.send(new InvokeModelCommand(makeInput(body)));
        const decoded = Buffer.from(response.body as Uint8Array).toString("utf-8");
        return this.parseResponseBody(decoded);
      };

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        let requestBody = this.buildRequestBody(modelId, prompt, maxTokens);
        try {
          let result: { text: string; inputTokens: number; outputTokens: number };
          try {
            result = await run(requestBody);
          } catch (firstError: unknown) {
            const firstMessage = firstError instanceof Error ? firstError.message : String(firstError);
            if (firstMessage.includes("missing field `messages`")) {
              requestBody = this.buildMessagesBody(prompt, maxTokens);
              result = await run(requestBody);
            } else {
              throw firstError;
            }
          }

          const latencyMs = Date.now() - startedAt;
          log.debug("Bedrock model invocation succeeded", {
            event: "invoke_success",
            modelId,
            attempt,
            latencyMs,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            responsePreview: result.text.slice(0, 300),
          });

          this.telemetry?.record({
            modelId,
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            latencyMs,
            startedAt,
          });

          return result.text;
        } catch (error: unknown) {
          lastError = error;
          const message = error instanceof Error ? error.message : String(error);

          if (message.toLowerCase().includes("end of its life")) {
            throw new Error(
              `Configured model '${modelId}' is EOL. Set BEDROCK_MODEL_ID to an active Claude Sonnet model in your AWS account.`,
            );
          }

          if (this.isInvalidModelIdentifier(message)) {
            throw new Error(
              `Configured model '${modelId}' is invalid or unavailable for region '${this.region}'. Set BEDROCK_MODEL_ID to a valid Bedrock model ID in your AWS account. Default: '${DEFAULT_MODEL_ID}'.`,
            );
          }

          if (
            modelId === DEFAULT_MODEL_ID &&
            this.canFallbackToMarketplaceFreeModel &&
            (this.isMarketplacePaymentIssue(message) || this.isAnthropicFirstTimeUseIssue(message))
          ) {
            log.warn("Falling back to alternate Bedrock model", {
              event: "invoke_fallback",
              fromModelId: DEFAULT_MODEL_ID,
              toModelId: FALLBACK_MODEL_ID,
              reason: message,
            });
            break;
          }

          if (attempt < MAX_RETRIES && this.isRetryable(message)) {
            const backoffMs = RETRY_BASE_MS * Math.pow(2, attempt - 1);
            log.warn("Retrying Bedrock model invocation", {
              event: "invoke_retry",
              modelId,
              attempt,
              backoffMs,
              error: message,
            });
            await new Promise((resolve) => setTimeout(resolve, backoffMs));
            continue;
          }

          log.error("Bedrock model invocation failed", {
            event: "invoke_failure",
            modelId,
            attempt,
            latencyMs: Date.now() - startedAt,
            error: message,
          });
          throw error;
        }
      }
    }

    throw lastError;
  }
}
