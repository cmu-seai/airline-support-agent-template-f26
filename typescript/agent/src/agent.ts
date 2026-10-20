import { google } from "@ai-sdk/google";
import { LanguageModelV2 } from "@ai-sdk/provider";
import { generateText } from "ai";
import type {
  AssistantModelMessage,
  GenerateTextResult,
  ModelMessage,
  SystemModelMessage,
  ToolCallPart,
  ToolModelMessage,
  ToolSet,
  TypedToolCall,
  UserModelMessage,
} from "ai";
import dotenv from "dotenv";
import { RateLimiter } from "./rate_limiter.ts";
import { ToolManager } from "./tool_manager.ts";
import type { MCPServerStatus } from "./mcp_client.ts";
import { logMessageToContext } from "./logging.ts";
import { agentModel, tau2DomainDataPath } from "./config.ts";

dotenv.config();

type ModelResponse = GenerateTextResult<ToolSet, never>;

export class ToolCallingAgent {
  private readonly messages: ModelMessage[];
  readonly toolManager: ToolManager;
  private readonly maxSteps: number = 5;
  private readonly model: LanguageModelV2;

  constructor(
    toolManager: ToolManager,
    model: LanguageModelV2 = agentModel,
    maxSteps: number = 5,
  ) {
    this.toolManager = toolManager;
    this.maxSteps = maxSteps;
    this.messages = [];
    this.model = model;
    this.addToContext({ role: "system", content: this.createSystemPrompt() });
  }

  async execute(task: string): Promise<string> {
    console.log(`\n🎯 Starting new user request: ${task}\n`);
    this.addToContext({ role: "user", content: task });

    // Agent loop
    for (let step = 1; step <= this.maxSteps; step++) {
      console.log(`\n--- Step ${step} ---`);

      const response: ModelResponse = await this.reason();
      const useTools = response.toolCalls.length > 0;

      // Empty response (neither text nor tool calls): try again
      if (!response.text && !useTools) {
        continue;
      }

      if (response.text) {
        console.log(`🤖 Assistant: ${response.text}\n`);
      }

      // Add the assistant message (text and/or tool calls) as one turn.
      // We keep the messages as returned by the model, including
      // provider-specific fields (e.g., Gemini thought signatures or
      // reasoning parts) that must be sent back to the model in later calls.
      for (const message of response.response.messages) {
        this.addToContext(message);
      }

      if (useTools) {
        console.log(`🔧 Tool calls requested: ${response.toolCalls.length}`);

        // Execute tool calls and add results
        for (const toolCall of response.toolCalls) {
          const result: ToolModelMessage = await this.act(toolCall);
          this.addToContext(result);
        }
      }

      if (!useTools) {
        // Exit loop - waiting for user's next input
        return response.text;
      }
    }

    throw new Error(
      `Maximum steps (${this.maxSteps}) reached without completing the task`,
    );
  }

  private async reason(): Promise<ModelResponse> {
    const tools = this.toolManager.getTools();
    const hasTools = Object.keys(tools).length > 0;

    const response = await generateText({
      model: this.model,
      messages: this.messages,
      tools: hasTools ? tools : undefined,
      toolChoice: hasTools ? "auto" : undefined,
      maxRetries: 2,
    });

    return response;
  }

  private async act(
    toolCall: TypedToolCall<ToolSet>,
  ): Promise<ToolModelMessage> {
    console.log(
      `🔧 Executing: ${toolCall.toolName}(${JSON.stringify(toolCall.input)})`,
    );
    try {
      const result = await this.toolManager.executeTool(
        toolCall.toolName,
        toolCall.input as Record<string, unknown>,
      );

      return {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName,
            output: {
              type: "text",
              value: result,
            },
          },
        ],
      };
    } catch (error) {
      const errorMessage = error instanceof Error
        ? error.message
        : String(error);
      console.error(`   ❌ Tool execution failed: ${errorMessage}`);

      return {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName,
            output: {
              type: "text",
              value: `Error: ${errorMessage}`,
            },
          },
        ],
      };
    }
  }

  getRateLimitStatus() {
    // @ts-ignore
    return this.model.rateLimiter.getStatus();
  }

  getRateLimitConfig() {
    // @ts-ignore
    return this.model.rateLimiter.getConfig();
  }

  private addToContext(message: ModelMessage): void {
    this.messages.push(message);
    logMessageToContext(message);
  }
  disconnect() {
    this.toolManager.disconnect();
  }

  getMessages(): ModelMessage[] {
    return this.messages;
  }

  private createSystemPrompt(): string {
    // Load policy from file
    const policyFile = tau2DomainDataPath + "policy.md";
    const policy = Deno.readTextFileSync(policyFile);

    // Load system prompt template
    const template = Deno.readTextFileSync(
      new URL("./prompts/system_prompt.txt", import.meta.url),
    );

    return template.replace("$POLICY", () => policy);
  }
}
