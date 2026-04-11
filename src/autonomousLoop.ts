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

    // #20: Try "score: N" format
    const scoreMatch = text.match(/score\s*[:\-=]\s*(\d+)/i);
    if (scoreMatch) {
        const s = parseInt(scoreMatch[1], 10);
        if (!isNaN(s)) {
            return {
                score: Math.max(1, Math.min(10, s)),
                reasoning: text.slice(0, 200),
                improvements: [],
            };
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
            // ── Phase 1: PLAN ──  (#10: phase retry on failure)
            let plan: string;
            try {
                const planResult = await this._chat(planPrompt(task, previousContext));
                fullHistory.push(...planResult.history);
                plan = planResult.reply;
            } catch (e: any) {
                try {
                    const planResult = await this._chat(planPrompt(task, previousContext));
                    fullHistory.push(...planResult.history);
                    plan = planResult.reply;
                } catch {
                    plan = `Execute the task directly: ${task}`;
                }
            }

            const planProgress: IterationProgress = { iteration, phase: 'plan', plan };
            progressHistory.push(planProgress);
            if (await this._callOnProgress(onProgress, planProgress)) { aborted = true; break; }

            // ── Phase 2: EXECUTE ──
            let output: string;
            try {
                const execResult = await this._chat(executePrompt(task, plan));
                fullHistory.push(...execResult.history);
                output = execResult.reply;
            } catch (e: any) {
                try {
                    const execResult = await this._chat(executePrompt(task, plan));
                    fullHistory.push(...execResult.history);
                    output = execResult.reply;
                } catch {
                    output = `[Execute phase failed: ${e.message ?? String(e)}]`;
                }
            }

            const execProgress: IterationProgress = { iteration, phase: 'execute', plan, output };
            progressHistory.push(execProgress);
            if (await this._callOnProgress(onProgress, execProgress)) { aborted = true; lastOutput = output; break; }

            // ── Phase 3: REVIEW ──
            let review: string;
            try {
                const reviewResult = await this._chat(reviewPrompt(task, output));
                fullHistory.push(...reviewResult.history);
                review = reviewResult.reply;
            } catch {
                review = 'Review skipped due to error.';
            }

            const reviewProgress: IterationProgress = { iteration, phase: 'review', plan, output, review };
            progressHistory.push(reviewProgress);
            if (await this._callOnProgress(onProgress, reviewProgress)) { aborted = true; lastOutput = output; break; }

            // ── Phase 4: EVALUATE ──
            let evalParsed: EvalResult;
            try {
                const evalResult = await this._chat(evaluatePrompt(task, output, review));
                fullHistory.push(...evalResult.history);
                evalParsed = parseEvaluation(evalResult.reply);
            } catch {
                evalParsed = { score: 5, reasoning: 'Evaluation failed, using default score.', improvements: [] };
            }

            const evalProgress: IterationProgress = {
                iteration, phase: 'evaluate', plan, output, review,
                evaluation: evalParsed.reasoning, qualityScore: evalParsed.score,
            };
            progressHistory.push(evalProgress);
            if (await this._callOnProgress(onProgress, evalProgress)) { aborted = true; lastOutput = output; lastScore = evalParsed.score; break; }

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
                `### Review`, review,
                `### Evaluation (score: ${evalParsed.score}/${threshold} threshold)`,
                evalParsed.reasoning,
                `### Required Improvements`,
                evalParsed.improvements.length
                    ? evalParsed.improvements.map((imp, i) => `${i + 1}. ${imp}`).join('\n')
                    : 'General quality improvement needed.',
            ].join('\n');

            // #19: trim history to prevent unbounded growth
            if (fullHistory.length > 40) {
                fullHistory.splice(0, fullHistory.length - 20);
            }
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

    /** #21: Safe onProgress wrapper — catches callback errors */
    private async _callOnProgress(
        onProgress: ((p: IterationProgress) => Promise<boolean | void> | boolean | void) | undefined,
        progress: IterationProgress,
    ): Promise<boolean> {
        if (!onProgress) return false;
        try {
            return (await onProgress(progress)) === false;
        } catch (e: any) {
            console.error('[AutonomousLoop] onProgress callback error:', e.message ?? e);
            return false;
        }
    }

    private async _chat(message: string): Promise<ChatResult> {
        return this._agent.chat(message);
    }
}
