/**
 * autonomousLoop.ts — Autonomous task execution with self-evaluation loop.
 *
 * Wraps an AgentInstance in an outer loop:
 *   PLAN → EXECUTE → REVIEW → EVALUATE → (repeat if score < threshold)
 *
 * Each phase uses the agent's existing chat() method, so all tools,
 * sandbox rules, and memory are available in every phase.
 */

import type {
    AutonomousTaskConfig,
    AutonomousTaskResult,
    IterationProgress,
    ChatResult,
} from './types';
import type { AgentInstance } from './agentInstance';

// ---------------------------------------------------------------------------
// Phase prompts
// ---------------------------------------------------------------------------

function planPrompt(task: string, previousContext: string): string {
    return `You are given a task to complete autonomously. Break it into clear, numbered subtasks.
Consider what information you need, what order to work in, and what tools to use.

## Task
${task}

## Previous Attempt Context
${previousContext}

## Instructions
Output a detailed, structured plan with numbered steps. Be specific about what each step should accomplish.
If this is a refinement (previous context is provided), focus on addressing the identified improvements.`;
}

function executePrompt(task: string, plan: string): string {
    return `Execute the following plan step by step. Use tools as needed to gather information and produce output.
Report your progress and detailed output for each step.

## Original Task
${task}

## Plan to Execute
${plan}

## Instructions
- Work through each step methodically
- Use tools when they help (read_file, bash, WebSearch, WebFetch, etc.)
- Produce comprehensive, detailed output for each step
- If a step fails, note the failure and continue with remaining steps`;
}

function reviewPrompt(task: string, executeOutput: string): string {
    return `You are a harsh but fair critic. Review the work done against the original task requirements.

## Original Task
${task}

## Work Output
${executeOutput}

## Instructions
Evaluate the output critically. Identify:
1. **Strengths**: What was done well
2. **Gaps**: What is missing or incomplete
3. **Errors**: Any factual or logical errors
4. **Improvements**: Specific, actionable improvements for the next iteration

Be thorough and specific. The goal is to drive quality higher on the next iteration.`;
}

function evaluatePrompt(
    task: string,
    executeOutput: string,
    reviewOutput: string,
): string {
    return `Score the current output quality on a scale of 1-10.

## Original Task
${task}

## Work Output
${executeOutput}

## Review
${reviewOutput}

## Scoring Criteria
- 1-3: Major gaps, missing core requirements, significant errors
- 4-5: Partially complete, some important gaps or errors
- 6-7: Mostly complete, minor gaps or improvements needed
- 8-9: High quality, meets nearly all requirements
- 10: Exceptional, exceeds requirements

## Instructions
Respond ONLY with valid JSON (no markdown, no code fences):
{"score": <number 1-10>, "reasoning": "<concise explanation>", "improvements": ["<improvement 1>", "<improvement 2>"]}`;
}

// ---------------------------------------------------------------------------
// Score parser
// ---------------------------------------------------------------------------

interface EvalResult {
    score: number;
    reasoning: string;
    improvements: string[];
}

function parseEvaluation(text: string): EvalResult {
    // Try to extract JSON from the response
    const jsonMatch = text.match(/\{[\s\S]*?"score"\s*:\s*(\d+)[\s\S]*?\}/);
    if (jsonMatch) {
        try {
            const parsed = JSON.parse(jsonMatch[0]);
            return {
                score: Math.max(1, Math.min(10, Number(parsed.score) || 5)),
                reasoning: String(parsed.reasoning ?? ''),
                improvements: Array.isArray(parsed.improvements)
                    ? parsed.improvements.map(String)
                    : [],
            };
        } catch {
            // Fall through to heuristic
        }
    }

    // Heuristic: look for a number
    const numMatch = text.match(/\b([1-9]|10)\b/);
    return {
        score: numMatch ? parseInt(numMatch[1], 10) : 5,
        reasoning: text.slice(0, 200),
        improvements: [],
    };
}

// ---------------------------------------------------------------------------
// AutonomousLoop
// ---------------------------------------------------------------------------

export class AutonomousLoop {
    private _agent: AgentInstance;

    constructor(agent: AgentInstance) {
        this._agent = agent;
    }

    /**
     * Run the autonomous task loop.
     *
     * The loop iterates through PLAN → EXECUTE → REVIEW → EVALUATE phases.
     * It exits when:
     *   - Quality score ≥ qualityThreshold
     *   - maxIterations is reached
     *   - onProgress callback returns false (abort)
     */
    async run(config: AutonomousTaskConfig): Promise<AutonomousTaskResult> {
        const task = config.task;
        const threshold = config.qualityThreshold ?? 7;
        const maxIter = config.maxIterations ?? 10;
        const onProgress = config.onProgress;

        const progressHistory: IterationProgress[] = [];
        const fullHistory: Record<string, any>[] = [];
        let lastOutput = '';
        let lastScore = 0;
        let previousContext = 'This is the first attempt. No previous context.';
        let aborted = false;

        for (let iteration = 1; iteration <= maxIter; iteration++) {
            // ── Phase 1: PLAN ──
            const planResult = await this._chat(planPrompt(task, previousContext));
            fullHistory.push(...planResult.history);
            const plan = planResult.reply;

            const planProgress: IterationProgress = {
                iteration,
                phase: 'plan',
                plan,
            };
            progressHistory.push(planProgress);
            if (onProgress && (await onProgress(planProgress)) === false) {
                aborted = true;
                break;
            }

            // ── Phase 2: EXECUTE ──
            const execResult = await this._chat(executePrompt(task, plan));
            fullHistory.push(...execResult.history);
            const output = execResult.reply;

            const execProgress: IterationProgress = {
                iteration,
                phase: 'execute',
                plan,
                output,
            };
            progressHistory.push(execProgress);
            if (onProgress && (await onProgress(execProgress)) === false) {
                aborted = true;
                lastOutput = output;
                break;
            }

            // ── Phase 3: REVIEW ──
            const reviewResult = await this._chat(reviewPrompt(task, output));
            fullHistory.push(...reviewResult.history);
            const review = reviewResult.reply;

            const reviewProgress: IterationProgress = {
                iteration,
                phase: 'review',
                plan,
                output,
                review,
            };
            progressHistory.push(reviewProgress);
            if (onProgress && (await onProgress(reviewProgress)) === false) {
                aborted = true;
                lastOutput = output;
                break;
            }

            // ── Phase 4: EVALUATE ──
            const evalResult = await this._chat(
                evaluatePrompt(task, output, review),
            );
            fullHistory.push(...evalResult.history);
            const evalParsed = parseEvaluation(evalResult.reply);

            const evalProgress: IterationProgress = {
                iteration,
                phase: 'evaluate',
                plan,
                output,
                review,
                evaluation: evalResult.reply,
                qualityScore: evalParsed.score,
            };
            progressHistory.push(evalProgress);
            if (onProgress && (await onProgress(evalProgress)) === false) {
                aborted = true;
                lastOutput = output;
                lastScore = evalParsed.score;
                break;
            }

            lastOutput = output;
            lastScore = evalParsed.score;

            // Check threshold
            if (evalParsed.score >= threshold) {
                return {
                    result: output,
                    iterations: iteration,
                    qualityScore: evalParsed.score,
                    thresholdMet: true,
                    progressHistory,
                    history: fullHistory,
                };
            }

            // Build context for next iteration
            previousContext = [
                `## Previous Iteration ${iteration}`,
                `### Review`,
                review,
                `### Evaluation (score: ${evalParsed.score}/${threshold} threshold)`,
                evalParsed.reasoning,
                `### Required Improvements`,
                evalParsed.improvements.length
                    ? evalParsed.improvements.map((imp, i) => `${i + 1}. ${imp}`).join('\n')
                    : 'General quality improvement needed.',
            ].join('\n');
        }

        // Max iterations or abort — return best result
        return {
            result: lastOutput,
            iterations: progressHistory.filter((p) => p.phase === 'evaluate').length,
            qualityScore: lastScore,
            thresholdMet: false,
            progressHistory,
            history: fullHistory,
        };
    }

    // --- Internal ---

    private async _chat(message: string): Promise<ChatResult> {
        return this._agent.chat(message);
    }
}
