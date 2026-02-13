/**
 * Assemble Extension - Linear-Synced Multi-Agent Orchestration
 *
 * Implements the `/assemble <ticket-id>` command that:
 * 1. Fetches a Linear ticket
 * 2. Runs scout → planner → worker→reviewer pipeline
 * 3. Posts progress comments to the Linear ticket
 * 4. Shows phase completion in conversation messages
 * 5. Supports up to 3 worker/reviewer iterations
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { discoverAgents } from "../subagent/agents.js";
import { runSingleAgent, getFinalOutput, type SingleResult } from "../subagent/runner.js";
import {
	fetchTicket,
	fetchComments,
	postComment,
	type LinearTicket,
	type LinearComment,
} from "./linear.js";

const REQUIRED_AGENTS = ["scout", "planner", "worker", "reviewer"];
const MAX_ITERATIONS = 3;
interface PhaseResult {
	agent: string;
	output: string;
	exitCode: number;
	durationMs: number;
	cost: number;
}

interface AssembleDetails {
	ticketId: string;
	phases: PhaseResult[];
	status: "running" | "complete" | "failed";
	verdict?: "approved" | "needs_work";
	iterations: number;
}

function validateTicketId(id: string): boolean {
	return /^[A-Za-z0-9]+-[0-9]+$/.test(id);
}

function formatDuration(ms: number): string {
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	return `${minutes}m ${remainingSeconds}s`;
}

function formatCost(cost: number): string {
	return `$${cost.toFixed(2)}`;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	return `${Math.round(count / 1000)}k`;
}

function parseVerdict(output: string): "approved" | "needs_work" | null {
	const match = output.match(/\bVERDICT\s*:\s*(APPROVED|NEEDS_WORK)\b/i);
	if (!match) return null;
	return match[1].toUpperCase() === "APPROVED" ? "approved" : "needs_work";
}

function truncateOutput(output: string, maxChars: number = 2000): string {
	if (output.length <= maxChars) return output;
	return output.slice(0, maxChars - 100) + "\n\n... (truncated)";
}

// Prompt builders
function buildScoutPrompt(ticket: LinearTicket, existingComments: LinearComment[]): string {
	const commentsSection = existingComments.length > 0
		? existingComments.map(c => `**${c.author}** (${new Date(c.createdAt).toLocaleDateString()}):\n${c.body}`).join("\n\n")
		: "None";

	return `Investigate the codebase for Linear ticket ${ticket.identifier}: ${ticket.title}

## Ticket Description
${ticket.description || "(No description)"}

## Existing Comments
${commentsSection}

Find all code relevant to this ticket. Return structured findings about:
- Files that may need modification
- Related modules or components
- Any existing patterns to follow`;
}

function buildPlannerPrompt(ticket: LinearTicket, scoutOutput: string): string {
	return `Create an implementation plan for Linear ticket ${ticket.identifier}: ${ticket.title}

## Ticket Description
${ticket.description || "(No description)"}

## Scout Findings
${scoutOutput}

Create a concrete, step-by-step plan. The worker will execute it verbatim.
Return a numbered list of steps with specific file paths and changes needed.`;
}

function buildWorkerPrompt(ticket: LinearTicket, plan: string, iteration: number, feedback?: string): string {
	if (iteration === 1) {
		return `Implement Linear ticket ${ticket.identifier}: ${ticket.title}

## Plan
${plan}

Execute all steps. Report files changed and the specific changes made.`;
	}

	return `Fix issues for Linear ticket ${ticket.identifier}: ${ticket.title}

## Original Plan
${plan}

## Reviewer Feedback
${feedback}

Address all critical and warning items from the reviewer.
Report what you fixed and any new files created.`;
}

function buildReviewerPrompt(ticket: LinearTicket, plan: string, workerOutput: string, iteration: number): string {
	return `Review implementation for Linear ticket ${ticket.identifier}: ${ticket.title} (iteration ${iteration}/${MAX_ITERATIONS})

## Plan
${plan}

## Worker Output
${workerOutput}

Check the following:
- All plan steps fully implemented?
- Any bugs or issues?
- Security concerns?
- Code quality issues?

End your response with exactly ONE of:
**VERDICT: APPROVED** - if all steps are complete and no critical issues
**VERDICT: NEEDS_WORK** - if there are incomplete steps or critical issues

Provide specific feedback on what needs to be fixed if NEEDS_WORK.`;
}

// Comment formatters
function formatScoutComment(result: SingleResult, durationMs: number): string {
	return `### 🔍 Scout Report

${truncateOutput(result.messages.length > 0 ? getFinalOutput(result.messages) : result.stderr || "(no output)")}

---
_scout | ${formatDuration(durationMs)} | ${formatCost(result.usage.cost)}_`;
}

function formatPlanComment(result: SingleResult, durationMs: number): string {
	return `### 📋 Planner Report

${truncateOutput(result.messages.length > 0 ? getFinalOutput(result.messages) : result.stderr || "(no output)")}

---
_planner | ${formatDuration(durationMs)} | ${formatCost(result.usage.cost)}_`;
}

function formatWorkerComment(result: SingleResult, iteration: number, durationMs: number): string {
	return `### ⚡ Worker Implementation (iteration ${iteration})

${truncateOutput(result.messages.length > 0 ? getFinalOutput(result.messages) : result.stderr || "(no output)")}

---
_worker | ${formatDuration(durationMs)} | ${formatCost(result.usage.cost)}_`;
}

function formatReviewComment(result: SingleResult, iteration: number, durationMs: number): string {
	const output = result.messages.length > 0 ? getFinalOutput(result.messages) : result.stderr || "(no output)";
	const verdict = parseVerdict(output);
	const verdictEmoji = verdict === "approved" ? "✅" : "⚠️";

	return `### 👀 Review (iteration ${iteration}) ${verdictEmoji}

${truncateOutput(output)}

---
_reviewer | ${formatDuration(durationMs)} | ${formatCost(result.usage.cost)}_`;
}

function formatSummary(ticket: LinearTicket, phases: PhaseResult[], verdict: "approved" | "needs_work" | null, iterations: number): string {
	const totalDuration = phases.reduce((sum, p) => sum + p.durationMs, 0);
	const totalCost = phases.reduce((sum, p) => sum + p.cost, 0);
	const statusEmoji = verdict === "approved" ? "✅" : verdict === "needs_work" ? "⚠️" : "❌";
	const statusText = verdict === "approved"
		? `Approved (${iterations} iteration${iterations > 1 ? "s" : ""})`
		: verdict === "needs_work"
			? `Needs Work (${iterations} iteration${iterations > 1 ? "s" : ""})`
			: "Failed";

	const rows = phases.map(p => {
		const phaseName = p.agent.startsWith("worker") ? `Worker ${p.agent.split("-")[1] || ""}`.trim() :
			p.agent.startsWith("reviewer") ? `Review ${p.agent.split("-")[1] || ""}`.trim() :
			p.agent.charAt(0).toUpperCase() + p.agent.slice(1);
		return `| ${phaseName} | ${p.agent} | ${formatDuration(p.durationMs)} | ${formatCost(p.cost)} |`;
	}).join("\n");

	return `### 📊 Assembly Complete for ${ticket.identifier}

**Status:** ${statusEmoji} ${statusText} | **Duration:** ${formatDuration(totalDuration)} | **Cost:** ${formatCost(totalCost)}

| Phase | Agent | Time | Cost |
|-------|-------|------|------|
${rows}

---
_Assembled via pi /assemble_`;
}

function formatErrorComment(phase: string, error: string): string {
	return `### ❌ ${phase} Failed

**Error:** ${error}

---
_assembly aborted_`;
}

function formatPartialSummary(ticket: LinearTicket, phases: PhaseResult[], lastError: string): string {
	const totalDuration = phases.reduce((sum, p) => sum + p.durationMs, 0);
	const totalCost = phases.reduce((sum, p) => sum + p.cost, 0);

	return `### ⚠️ Assembly Partial for ${ticket.identifier}

**Stopped:** ${lastError}
**Completed Phases:** ${phases.length}
**Duration:** ${formatDuration(totalDuration)}
**Cost:** ${formatCost(totalCost)}

---
_assembly incomplete_`;
}

/** Format a phase completion message for the conversation */
function formatPhaseMessage(phaseName: string, agentName: string, result: SingleResult, durationMs: number): string {
	const icon = result.exitCode === 0 ? "✓" : "✗";
	const output = getFinalOutput(result.messages);
	const usage = result.usage;
	const stats = `${usage.turns} turns · ${formatTokens(usage.input + usage.output)} tokens · ${formatCost(usage.cost)} · ${formatDuration(durationMs)}`;

	const preview = output
		? truncateOutput(output, 500)
		: result.stderr || "(no output)";

	return `${icon} **${phaseName}** (${agentName}) — ${stats}\n\n${preview}`;
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("assemble", {
		description: "Run scout→planner→worker→reviewer pipeline for a Linear ticket, posting progress comments",
		async handler(args: string, ctx) {
			const ticketId = args.trim();

			// Validate ticket ID is provided
			if (!ticketId) {
				ctx.ui.notify("Usage: /assemble <ticket-id> (e.g., /assemble ENG-123)", "error");
				return;
			}

			// Validate ticket ID format
			if (!validateTicketId(ticketId)) {
				ctx.ui.notify(`Invalid ticket ID: ${ticketId}. Use format like ENG-123`, "error");
				return;
			}

			// Wait for idle
			await ctx.waitForIdle?.();

			// Notify start
			ctx.ui.notify(`Starting assembly for ${ticketId}...`, "info");

			// Fetch ticket (fatal on failure)
			let ticket: LinearTicket;
			try {
				ticket = await fetchTicket(ticketId);
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Failed to fetch ticket ${ticketId}: ${msg}`, "error");
				return;
			}

			// Show ticket info
			pi.sendMessage({
				customType: "assemble-ticket",
				content: `**${ticket.identifier}:** ${ticket.title}\n_${ticket.team} · ${ticket.state}${ticket.assignee ? ` · ${ticket.assignee}` : ""}_\n\nStarting scout→planner→worker→reviewer pipeline...`,
				display: true,
			});

			// Fetch existing comments (non-fatal)
			let existingComments: LinearComment[] = [];
			try {
				existingComments = await fetchComments(ticketId);
			} catch {
				// Continue without comments
			}

			// Post "Assembly Started" comment (non-fatal)
			const startComment = `### 🚀 Assembly Started

**Ticket:** ${ticket.identifier}: ${ticket.title}
**Team:** ${ticket.team}
**State:** ${ticket.state}
${ticket.assignee ? `**Assignee:** ${ticket.assignee}` : ""}

_Running scout→planner→worker→reviewer pipeline..._

---
_assembled via pi_`;

			await postComment(ticketId, startComment, ticket.id);

			// Discover agents
			const discovery = discoverAgents(ctx.cwd, "both");
			const agents = discovery.agents;

			// Validate required agents exist
			const missingAgents = REQUIRED_AGENTS.filter(name => !agents.find(a => a.name === name));
			if (missingAgents.length > 0) {
				const available = agents.map(a => a.name).join(", ") || "none";
				ctx.ui.notify(`Missing agents: ${missingAgents.join(", ")}. Available: ${available}`, "error");
				return;
			}

			const phases: PhaseResult[] = [];
			let finalVerdict: "approved" | "needs_work" | null = null;
			let lastWorkerOutput = "";
			let lastReviewerFeedback = "";
			let fatalError: string | null = null;
			let partialSummaryPosted = false;

			const noopDetails = () => ({} as any);

			try {
				// Phase 1: Scout
				ctx.ui.setStatus("assemble", "Running scout...");
				const scoutStart = Date.now();
				const scoutResult = await runSingleAgent(
					ctx.cwd,
					agents,
					"scout",
					buildScoutPrompt(ticket, existingComments),
					undefined,
					1,
					undefined,
					undefined,
					noopDetails,
				);

				const scoutDuration = Date.now() - scoutStart;
				phases.push({
					agent: "scout",
					output: getFinalOutput(scoutResult.messages),
					exitCode: scoutResult.exitCode,
					durationMs: scoutDuration,
					cost: scoutResult.usage.cost,
				});

				if (scoutResult.exitCode !== 0) {
					const errorMsg = scoutResult.errorMessage || scoutResult.stderr || "Scout failed";
					await postComment(ticketId, formatErrorComment("Scout", errorMsg), ticket.id);
					throw new Error(`Scout failed: ${errorMsg}`);
				}

				pi.sendMessage({
					customType: "assemble-phase",
					content: formatPhaseMessage("Scout", "scout", scoutResult, scoutDuration),
					display: true,
				});
				await postComment(ticketId, formatScoutComment(scoutResult, scoutDuration), ticket.id);

				// Phase 2: Planner
				ctx.ui.setStatus("assemble", "Running planner...");
				const plannerStart = Date.now();
				const plannerResult = await runSingleAgent(
					ctx.cwd,
					agents,
					"planner",
					buildPlannerPrompt(ticket, getFinalOutput(scoutResult.messages)),
					undefined,
					2,
					undefined,
					undefined,
					noopDetails,
				);

				const plannerDuration = Date.now() - plannerStart;
				const planOutput = getFinalOutput(plannerResult.messages);
				phases.push({
					agent: "planner",
					output: planOutput,
					exitCode: plannerResult.exitCode,
					durationMs: plannerDuration,
					cost: plannerResult.usage.cost,
				});

				if (plannerResult.exitCode !== 0) {
					const errorMsg = plannerResult.errorMessage || plannerResult.stderr || "Planner failed";
					await postComment(ticketId, formatErrorComment("Planner", errorMsg), ticket.id);
					throw new Error(`Planner failed: ${errorMsg}`);
				}

				pi.sendMessage({
					customType: "assemble-phase",
					content: formatPhaseMessage("Planner", "planner", plannerResult, plannerDuration),
					display: true,
				});
				await postComment(ticketId, formatPlanComment(plannerResult, plannerDuration), ticket.id);

				// Worker/Reviewer Loop (max 3 iterations)
				for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
					// Worker phase
					ctx.ui.setStatus("assemble", `Running worker (iteration ${iteration}/${MAX_ITERATIONS})...`);
					const workerStart = Date.now();
					const workerResult = await runSingleAgent(
						ctx.cwd,
						agents,
						"worker",
						buildWorkerPrompt(ticket, planOutput, iteration, iteration > 1 ? lastReviewerFeedback : undefined),
						undefined,
						iteration,
						undefined,
						undefined,
						noopDetails,
					);

					const workerDuration = Date.now() - workerStart;
					lastWorkerOutput = getFinalOutput(workerResult.messages);
					phases.push({
						agent: `worker-${iteration}`,
						output: lastWorkerOutput,
						exitCode: workerResult.exitCode,
						durationMs: workerDuration,
						cost: workerResult.usage.cost,
					});

					if (workerResult.exitCode !== 0) {
						const errorMsg = workerResult.errorMessage || workerResult.stderr || "Worker failed";
						await postComment(ticketId, formatErrorComment(`Worker (iteration ${iteration})`, errorMsg), ticket.id);
						await postComment(ticketId, formatPartialSummary(ticket, phases, errorMsg), ticket.id);
						partialSummaryPosted = true;
						pi.sendMessage({
							customType: "assemble-error",
							content: `✗ **Worker** failed at iteration ${iteration}: ${errorMsg}`,
							display: true,
						});
						break;
					}

					pi.sendMessage({
						customType: "assemble-phase",
						content: formatPhaseMessage(`Worker (iter ${iteration})`, "worker", workerResult, workerDuration),
						display: true,
					});
					await postComment(ticketId, formatWorkerComment(workerResult, iteration, workerDuration), ticket.id);

					// Reviewer phase
					ctx.ui.setStatus("assemble", `Running reviewer (iteration ${iteration}/${MAX_ITERATIONS})...`);
					const reviewerStart = Date.now();
					const reviewerResult = await runSingleAgent(
						ctx.cwd,
						agents,
						"reviewer",
						buildReviewerPrompt(ticket, planOutput, lastWorkerOutput, iteration),
						undefined,
						iteration,
						undefined,
						undefined,
						noopDetails,
					);

					const reviewerDuration = Date.now() - reviewerStart;
					const reviewerOutput = getFinalOutput(reviewerResult.messages);
					phases.push({
						agent: `reviewer-${iteration}`,
						output: reviewerOutput,
						exitCode: reviewerResult.exitCode,
						durationMs: reviewerDuration,
						cost: reviewerResult.usage.cost,
					});

					if (reviewerResult.exitCode !== 0) {
						const errorMsg = reviewerResult.errorMessage || reviewerResult.stderr || "Reviewer failed";
						await postComment(ticketId, formatErrorComment(`Reviewer (iteration ${iteration})`, errorMsg), ticket.id);
						await postComment(ticketId, formatPartialSummary(ticket, phases, errorMsg), ticket.id);
						partialSummaryPosted = true;
						pi.sendMessage({
							customType: "assemble-error",
							content: `✗ **Reviewer** failed at iteration ${iteration}: ${errorMsg}`,
							display: true,
						});
						break;
					}

					pi.sendMessage({
						customType: "assemble-phase",
						content: formatPhaseMessage(`Review (iter ${iteration})`, "reviewer", reviewerResult, reviewerDuration),
						display: true,
					});
					await postComment(ticketId, formatReviewComment(reviewerResult, iteration, reviewerDuration), ticket.id);

					// Parse verdict
					finalVerdict = parseVerdict(reviewerOutput);
					lastReviewerFeedback = reviewerOutput;

					if (finalVerdict === "approved") break;
					if (iteration >= MAX_ITERATIONS) break;
				}
			} catch (error) {
				fatalError = error instanceof Error ? error.message : String(error);
				console.error("Assembly error:", fatalError);
			}

			ctx.ui.setStatus("assemble", undefined);

			// Post final summary (skip if a partial summary was already posted for a failed phase)
			const summary = formatSummary(ticket, phases, finalVerdict, phases.filter(p => p.agent.startsWith("worker")).length);
			if (!partialSummaryPosted) {
				await postComment(ticketId, summary, ticket.id);
			}

			// Send final message to conversation
			const failed = fatalError || partialSummaryPosted;
			const statusText = failed
				? `❌ Assembly failed${fatalError ? `: ${fatalError}` : ""}`
				: finalVerdict === "approved"
					? "✅ Assembly complete - Approved"
					: finalVerdict === "needs_work"
						? "⚠️ Assembly complete - Needs work"
						: "❌ Assembly failed";

			const details: AssembleDetails = {
				ticketId,
				phases,
				status: failed ? "failed" : finalVerdict ? "complete" : "failed",
				verdict: finalVerdict || undefined,
				iterations: phases.filter(p => p.agent.startsWith("worker")).length,
			};

			pi.sendMessage({
				customType: "assemble-complete",
				content: `${statusText} for ${ticketId}: ${ticket.title}`,
				display: true,
				details,
			});

			ctx.ui.notify(
				`Assembly ${finalVerdict === "approved" ? "approved" : finalVerdict === "needs_work" ? "completed with feedback" : "finished"}`,
				finalVerdict === "approved" ? "info" : "warning",
			);
		},
	});
}
