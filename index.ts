/**
 * Assemble Extension - Linear-Synced Multi-Agent Orchestration
 *
 * Implements the `/assemble <ticket-id>` command that:
 * 1. Fetches a Linear ticket and existing comments
 * 2. Posts a "started" comment to Linear
 * 3. Sends a prompt via sendUserMessage that instructs the LLM to
 *    use the subagent tool (scout→planner→worker→reviewer pipeline)
 *    with full native UI rendering
 * 4. Provides a `linear_comment` tool for the LLM to post progress updates
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
	fetchTicket,
	fetchComments,
	postComment,
	type LinearTicket,
	type LinearComment,
} from "./linear.js";

function validateTicketId(id: string): boolean {
	return /^[A-Za-z0-9]+-[0-9]+$/.test(id);
}

function buildAssemblePrompt(ticket: LinearTicket, existingComments: LinearComment[]): string {
	const commentsSection = existingComments.length > 0
		? existingComments.map(c => `**${c.author}** (${new Date(c.createdAt).toLocaleDateString()}):\n${c.body}`).join("\n\n")
		: "None";

	return `Execute this implementation workflow for Linear ticket ${ticket.identifier}: ${ticket.title}

## Ticket Context

**Identifier:** ${ticket.identifier}
**Issue ID:** ${ticket.id}
**Title:** ${ticket.title}
**Team:** ${ticket.team}
**State:** ${ticket.state}
${ticket.assignee ? `**Assignee:** ${ticket.assignee}` : ""}

### Description
${ticket.description || "(No description)"}

### Existing Comments
${commentsSection}

## Instructions

Follow this pipeline using the subagent tool. After EACH phase completes, call the \`linear_comment\` tool to post a progress update to the Linear ticket using ticket ID \`${ticket.identifier}\` and issue ID \`${ticket.id}\`.

### Phase 1: Scout and Plan (chain)

Use the subagent tool with the chain parameter:

1. "scout" agent: Find all code relevant to: ${ticket.identifier}: ${ticket.title}. ${ticket.description || ""}
2. "planner" agent: Create an implementation plan for "${ticket.identifier}: ${ticket.title}" using {previous}

Save the plan output — you'll need it for the next phases.

After the chain completes, call \`linear_comment\` with a summary of the scout findings and the plan.

### Phase 2: Implement and Review (loop)

Now run a worker→reviewer loop. Repeat up to 3 iterations:

**Iteration N:**

1. Use the "worker" agent (single mode) with this task:
   - On first iteration: pass the full plan from Phase 1 and instruct it to implement all steps
   - On subsequent iterations: pass the reviewer's feedback and instruct it to fix the identified issues

2. After each worker run, call \`linear_comment\` with a summary of what the worker implemented.

3. Use the "reviewer" agent (single mode) to review the worker's output. The reviewer task should include:
   - The original plan from Phase 1
   - The worker's output from this iteration
   - Instruction to check: are ALL plan steps fully implemented? Any bugs, missing pieces, or issues?

4. After each reviewer run, call \`linear_comment\` with the review verdict and any feedback.

5. Check the reviewer's output:
   - If the reviewer reports all steps complete with no critical issues → **stop looping, move to Phase 3**
   - If the reviewer reports incomplete steps or critical issues → **loop back to step 1** with the reviewer's feedback
   - If this is iteration 3 → **stop looping regardless**, report what remains incomplete

### Phase 3: Report

Summarise what was done:
- Which plan steps were completed
- Files changed
- Any remaining issues the reviewer flagged that were not resolved
- Total iterations used

Call \`linear_comment\` one final time with the complete summary, including status (approved/needs work), files changed, and iterations used.`;
}

export default function (pi: ExtensionAPI) {
	// Register linear_comment tool for the LLM to post progress updates
	pi.registerTool({
		name: "linear_comment",
		label: "Linear Comment",
		description: "Post a progress comment to a Linear ticket. Use this after each phase of the assemble pipeline to update the ticket with status.",
		parameters: Type.Object({
			ticketId: Type.String({ description: "Linear ticket identifier (e.g. ENG-123)" }),
			issueId: Type.String({ description: "Linear issue UUID for direct API access" }),
			body: Type.String({ description: "Markdown comment body to post" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const success = await postComment(params.ticketId, params.body, params.issueId);
			return {
				content: [{
					type: "text" as const,
					text: success
						? `Comment posted to ${params.ticketId}`
						: `Failed to post comment to ${params.ticketId}`,
				}],
				details: { success, ticketId: params.ticketId },
			};
		},
	});

	pi.registerCommand("assemble", {
		description: "Run scout→planner→worker→reviewer pipeline for a Linear ticket with native UI rendering",
		async handler(args: string, ctx) {
			const ticketId = args.trim();

			if (!ticketId) {
				ctx.ui.notify("Usage: /assemble <ticket-id> (e.g., /assemble ENG-123)", "error");
				return;
			}

			if (!validateTicketId(ticketId)) {
				ctx.ui.notify(`Invalid ticket ID: ${ticketId}. Use format like ENG-123`, "error");
				return;
			}

			await ctx.waitForIdle?.();

			// Fetch ticket
			let ticket: LinearTicket;
			try {
				ticket = await fetchTicket(ticketId);
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Failed to fetch ticket ${ticketId}: ${msg}`, "error");
				return;
			}

			// Fetch existing comments (non-fatal)
			let existingComments: LinearComment[] = [];
			try {
				existingComments = await fetchComments(ticketId);
			} catch {
				// Continue without comments
			}

			// Post "Assembly Started" comment to Linear
			await postComment(
				ticketId,
				`### 🚀 Assembly Started\n\n**Ticket:** ${ticket.identifier}: ${ticket.title}\n**Team:** ${ticket.team}\n**State:** ${ticket.state}\n${ticket.assignee ? `**Assignee:** ${ticket.assignee}\n` : ""}\n_Running scout→planner→worker→reviewer pipeline..._\n\n---\n_assembled via pi_`,
				ticket.id,
			);

			// Send the prompt — triggers a normal LLM turn with full native UI
			pi.sendUserMessage(buildAssemblePrompt(ticket, existingComments));
		},
	});
}
