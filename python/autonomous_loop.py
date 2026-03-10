"""
autonomous_loop.py — Autonomous task execution with self-evaluation loop.

Wraps an AgentInstance in an outer loop:
  PLAN → EXECUTE → REVIEW → EVALUATE → (repeat if score < threshold)

Each phase uses the agent's existing chat() method, so all tools,
sandbox rules, and memory are available in every phase.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from agent_instance import AgentInstance

from agent_types import (
    AutonomousTaskConfig,
    AutonomousTaskResult,
    IterationProgress,
)

# ---------------------------------------------------------------------------
# Phase prompts
# ---------------------------------------------------------------------------


def _plan_prompt(task: str, previous_context: str) -> str:
    return f"""You are given a task to complete autonomously. Break it into clear, numbered subtasks.
Consider what information you need, what order to work in, and what tools to use.

## Task
{task}

## Previous Attempt Context
{previous_context}

## Instructions
Output a detailed, structured plan with numbered steps. Be specific about what each step should accomplish.
If this is a refinement (previous context is provided), focus on addressing the identified improvements."""


def _execute_prompt(task: str, plan: str) -> str:
    return f"""Execute the following plan step by step. Use tools as needed to gather information and produce output.
Report your progress and detailed output for each step.

## Original Task
{task}

## Plan to Execute
{plan}

## Instructions
- Work through each step methodically
- Use tools when they help (read_file, bash, WebSearch, WebFetch, etc.)
- Produce comprehensive, detailed output for each step
- If a step fails, note the failure and continue with remaining steps"""


def _review_prompt(task: str, execute_output: str) -> str:
    return f"""You are a harsh but fair critic. Review the work done against the original task requirements.

## Original Task
{task}

## Work Output
{execute_output}

## Instructions
Evaluate the output critically. Identify:
1. **Strengths**: What was done well
2. **Gaps**: What is missing or incomplete
3. **Errors**: Any factual or logical errors
4. **Improvements**: Specific, actionable improvements for the next iteration

Be thorough and specific. The goal is to drive quality higher on the next iteration."""


def _evaluate_prompt(task: str, execute_output: str, review_output: str) -> str:
    return f"""Score the current output quality on a scale of 1-10.

## Original Task
{task}

## Work Output
{execute_output}

## Review
{review_output}

## Scoring Criteria
- 1-3: Major gaps, missing core requirements, significant errors
- 4-5: Partially complete, some important gaps or errors
- 6-7: Mostly complete, minor gaps or improvements needed
- 8-9: High quality, meets nearly all requirements
- 10: Exceptional, exceeds requirements

## Instructions
Respond ONLY with valid JSON (no markdown, no code fences):
{{"score": <number 1-10>, "reasoning": "<concise explanation>", "improvements": ["<improvement 1>", "<improvement 2>"]}}"""


# ---------------------------------------------------------------------------
# Score parser
# ---------------------------------------------------------------------------

@dataclass
class _EvalResult:
    score: int = 5
    reasoning: str = ''
    improvements: List[str] = field(default_factory=list)


def _parse_evaluation(text: str) -> _EvalResult:
    """Parse structured evaluation JSON from LLM output."""
    match = re.search(r'\{[\s\S]*?"score"\s*:\s*(\d+)[\s\S]*?\}', text)
    if match:
        try:
            parsed = json.loads(match.group(0))
            return _EvalResult(
                score=max(1, min(10, int(parsed.get('score', 5)))),
                reasoning=str(parsed.get('reasoning', '')),
                improvements=[str(i) for i in parsed.get('improvements', [])]
                if isinstance(parsed.get('improvements'), list) else [],
            )
        except (json.JSONDecodeError, ValueError):
            pass

    # #20: Try "score: N" format
    score_match = re.search(r'score\s*[:\-=]\s*(\d+)', text, re.IGNORECASE)
    if score_match:
        s = int(score_match.group(1))
        if 1 <= s <= 10:
            return _EvalResult(score=s, reasoning=text[:200])

    # Heuristic fallback: find a standalone number 1–10
    num_match = re.search(r'\b([1-9]|10)\b', text)
    return _EvalResult(
        score=int(num_match.group(1)) if num_match else 5,
        reasoning=text[:200],
    )


# ---------------------------------------------------------------------------
# AutonomousLoop
# ---------------------------------------------------------------------------

class AutonomousLoop:
    """Autonomous task execution with self-evaluating iteration loop."""

    def __init__(self, agent: 'AgentInstance') -> None:
        self._agent = agent

    def run(self, config: AutonomousTaskConfig) -> AutonomousTaskResult:
        """
        Run the autonomous task loop.

        Iterates PLAN → EXECUTE → REVIEW → EVALUATE until:
        - Quality score ≥ quality_threshold
        - max_iterations is reached
        - on_progress callback returns False (abort)
        """
        task = config.task
        threshold = config.quality_threshold
        max_iter = config.max_iterations
        on_progress = config.on_progress

        progress_history: List[IterationProgress] = []
        full_history: List[Dict[str, Any]] = []
        last_output = ''
        last_score = 0
        previous_context = 'This is the first attempt. No previous context.'

        for iteration in range(1, max_iter + 1):
            # ── Phase 1: PLAN ── (#10: phase retry on failure)
            try:
                plan_result = self._agent.chat(_plan_prompt(task, previous_context))
                full_history.extend(plan_result.history)
                plan = plan_result.reply
            except Exception as e:
                try:
                    plan_result = self._agent.chat(_plan_prompt(task, previous_context))
                    full_history.extend(plan_result.history)
                    plan = plan_result.reply
                except Exception:
                    plan = f"Execute the task directly: {task}"

            plan_progress = IterationProgress(
                iteration=iteration, phase='plan', plan=plan,
            )
            progress_history.append(plan_progress)
            if self._call_on_progress(on_progress, plan_progress):
                break

            # ── Phase 2: EXECUTE ──
            try:
                exec_result = self._agent.chat(_execute_prompt(task, plan))
                full_history.extend(exec_result.history)
                output = exec_result.reply
            except Exception as e:
                try:
                    exec_result = self._agent.chat(_execute_prompt(task, plan))
                    full_history.extend(exec_result.history)
                    output = exec_result.reply
                except Exception:
                    output = f"[Execute phase failed: {e}]"

            exec_progress = IterationProgress(
                iteration=iteration, phase='execute', plan=plan, output=output,
            )
            progress_history.append(exec_progress)
            if self._call_on_progress(on_progress, exec_progress):
                last_output = output
                break

            # ── Phase 3: REVIEW ──
            try:
                review_result = self._agent.chat(_review_prompt(task, output))
                full_history.extend(review_result.history)
                review = review_result.reply
            except Exception:
                review = "Review skipped due to error."

            review_progress = IterationProgress(
                iteration=iteration, phase='review',
                plan=plan, output=output, review=review,
            )
            progress_history.append(review_progress)
            if self._call_on_progress(on_progress, review_progress):
                last_output = output
                break

            # ── Phase 4: EVALUATE ──
            try:
                eval_result = self._agent.chat(
                    _evaluate_prompt(task, output, review),
                )
                full_history.extend(eval_result.history)
                eval_parsed = _parse_evaluation(eval_result.reply)
            except Exception:
                eval_parsed = _EvalResult(score=5, reasoning='Evaluation failed, using default score.', improvements=[])

            eval_progress = IterationProgress(
                iteration=iteration, phase='evaluate',
                plan=plan, output=output, review=review,
                evaluation=eval_parsed.reasoning,
                quality_score=eval_parsed.score,
            )
            progress_history.append(eval_progress)
            if self._call_on_progress(on_progress, eval_progress):
                last_output = output
                last_score = eval_parsed.score
                break

            last_output = output
            last_score = eval_parsed.score

            # Check threshold
            if eval_parsed.score >= threshold:
                return AutonomousTaskResult(
                    result=output,
                    iterations=iteration,
                    quality_score=eval_parsed.score,
                    threshold_met=True,
                    progress_history=progress_history,
                    history=full_history,
                )

            # Build context for next iteration
            improvements = (
                '\n'.join(f'{i + 1}. {imp}' for i, imp in enumerate(eval_parsed.improvements))
                if eval_parsed.improvements
                else 'General quality improvement needed.'
            )
            previous_context = '\n'.join([
                f'## Previous Iteration {iteration}',
                '### Review',
                review,
                f'### Evaluation (score: {eval_parsed.score}/{threshold} threshold)',
                eval_parsed.reasoning,
                '### Required Improvements',
                improvements,
            ])

            # #19: trim history to prevent unbounded growth
            if len(full_history) > 40:
                full_history = full_history[-20:]

        # Max iterations or abort
        return AutonomousTaskResult(
            result=last_output,
            iterations=sum(1 for p in progress_history if p.phase == 'evaluate'),
            quality_score=last_score,
            threshold_met=False,
            progress_history=progress_history,
            history=full_history,
        )

    @staticmethod
    def _call_on_progress(on_progress, progress: IterationProgress) -> bool:
        """#21: Safe onProgress wrapper — catches callback errors. Returns True if aborted."""
        if not on_progress:
            return False
        try:
            return on_progress(progress) is False
        except Exception as e:
            import logging
            logging.getLogger("agent").error("[AutonomousLoop] on_progress callback error: %s", e)
            return False
