/**
 * Linear API helpers for the assemble extension
 *
 * Provides functions to fetch tickets, comments, and post comments
 * using linear.sh CLI or direct GraphQL API calls via native fetch.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";

export interface LinearTicket {
	identifier: string;
	id: string;
	title: string;
	description: string;
	state: string;
	team: string;
	assignee: string | null;
}

export interface LinearComment {
	body: string;
	author: string;
	createdAt: string;
}

/**
 * Get the path to linear.sh script
 */
export function getLinearShPath(): string {
	const skillPath = path.join(os.homedir(), ".pi", "agent", "skills", "linear", "linear.sh");
	if (fs.existsSync(skillPath)) {
		return skillPath;
	}
	return "";
}

/**
 * Truncate text to avoid OS argv limits and Linear body limits
 */
export function truncateForLinearComment(body: string, maxChars: number = 12000): string {
	if (body.length <= maxChars) return body;
	return body.slice(0, maxChars - 100) + "\n\n... (truncated)";
}

/**
 * Get Linear API key from environment or auth.json
 */
function getApiKey(): string | null {
	// Check environment variable first
	const envKey = process.env.LINEAR_API_KEY;
	if (envKey) return envKey;

	// Check auth.json
	try {
		const authPath = path.join(os.homedir(), ".pi", "agent", "auth.json");
		if (fs.existsSync(authPath)) {
			const auth = JSON.parse(fs.readFileSync(authPath, "utf-8"));
			return auth.linear?.apiKey || auth.linearApiKey || null;
		}
	} catch {
		// Ignore errors
	}

	return null;
}

/**
 * Execute a shell command and return result.
 * Used only for running linear.sh — GraphQL calls use native fetch.
 */
async function runCommand(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	return new Promise((resolve) => {
		const proc = spawn(cmd, args, { shell: false });
		let stdout = "";
		let stderr = "";

		proc.stdout?.on("data", (data: Buffer) => { stdout += data.toString(); });
		proc.stderr?.on("data", (data: Buffer) => { stderr += data.toString(); });

		const timer = setTimeout(() => {
			proc.kill();
			resolve({ stdout, stderr: "Timeout", exitCode: 1 });
		}, 30000);

		proc.on("close", (code: number) => {
			clearTimeout(timer);
			resolve({ stdout, stderr, exitCode: code ?? 0 });
		});

		proc.on("error", (err: Error) => {
			clearTimeout(timer);
			resolve({ stdout: "", stderr: err.message, exitCode: 1 });
		});
	});
}

/**
 * Parse a ticket identifier (e.g., "K20-1049" or "k20-1049") into team key and number.
 * Team key is uppercased since Linear's API is case-sensitive.
 */
function parseIdentifier(ticketId: string): { teamKey: string; number: number } {
	const dashIndex = ticketId.lastIndexOf("-");
	if (dashIndex === -1) {
		throw new Error(`Invalid ticket identifier: ${ticketId}`);
	}
	return {
		teamKey: ticketId.slice(0, dashIndex).toUpperCase(),
		number: parseInt(ticketId.slice(dashIndex + 1), 10),
	};
}

/**
 * Make a GraphQL request to the Linear API using native fetch.
 */
async function graphqlRequest(apiKey: string, query: string, variables: Record<string, unknown>): Promise<any> {
	const response = await fetch("https://api.linear.app/graphql", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Authorization": apiKey,
		},
		body: JSON.stringify({ query, variables }),
	});

	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(`Linear API error: ${response.status} ${response.statusText}${body ? ` — ${body.slice(0, 200)}` : ""}`);
	}

	const data = await response.json();
	if (data.errors?.length) {
		throw new Error(`GraphQL error: ${data.errors[0].message}`);
	}
	return data;
}

/**
 * Fetch a Linear ticket by identifier (e.g., "ENG-123")
 */
export async function fetchTicket(ticketId: string): Promise<LinearTicket> {
	const linearSh = getLinearShPath();
	const apiKey = getApiKey();

	// Try linear.sh first
	if (linearSh && apiKey) {
		const result = await runCommand("bash", [linearSh, "get", ticketId]);
		if (result.exitCode === 0 && result.stdout) {
			try {
				const data = JSON.parse(result.stdout);
				if (data) {
					return {
						identifier: data.identifier || ticketId,
						id: data.id || "",
						title: data.title || "",
						description: data.description || "",
						state: data.state?.name || data.state || "unknown",
						team: data.team?.name || data.team || "unknown",
						assignee: data.assignee?.name || data.assignee || null,
					};
				}
			} catch {
				// Fall through to GraphQL
			}
		}
	}

	// Fallback to GraphQL via native fetch
	if (!apiKey) {
		throw new Error("Linear API key not found. Set LINEAR_API_KEY in environment or auth.json");
	}

	const { teamKey, number } = parseIdentifier(ticketId);

	const query = `query($teamKey: String!, $number: Float!) {
		issues(filter: { team: { key: { eq: $teamKey } }, number: { eq: $number } }) {
			nodes {
				id
				identifier
				title
				description
				state { name }
				team { name }
				assignee { name }
			}
		}
	}`;

	const data = await graphqlRequest(apiKey, query, { teamKey, number });
	const issue = data?.data?.issues?.nodes?.[0];

	if (!issue) {
		throw new Error(`Ticket ${ticketId} not found in Linear`);
	}

	return {
		identifier: issue.identifier,
		id: issue.id,
		title: issue.title,
		description: issue.description || "",
		state: issue.state?.name || "unknown",
		team: issue.team?.name || "unknown",
		assignee: issue.assignee?.name || null,
	};
}

/**
 * Fetch comments for a Linear ticket
 */
export async function fetchComments(ticketId: string): Promise<LinearComment[]> {
	const apiKey = getApiKey();
	if (!apiKey) {
		return [];
	}

	try {
		const { teamKey, number } = parseIdentifier(ticketId);

		const query = `query($teamKey: String!, $number: Float!) {
			issues(filter: { team: { key: { eq: $teamKey } }, number: { eq: $number } }) {
				nodes {
					comments(first: 50) {
						nodes {
							body
							user { name }
							createdAt
						}
					}
				}
			}
		}`;

		const data = await graphqlRequest(apiKey, query, { teamKey, number });
		const comments = data?.data?.issues?.nodes?.[0]?.comments?.nodes || [];

		return comments.map((c: any) => ({
			body: c.body || "",
			author: c.user?.name || "unknown",
			createdAt: c.createdAt || "",
		}));
	} catch {
		return [];
	}
}

/**
 * Post a comment to a Linear ticket.
 * Accepts an optional issueId (UUID) to skip the extra lookup query.
 * Returns true on success, false on failure (non-fatal).
 */
export async function postComment(ticketId: string, body: string, issueId?: string): Promise<boolean> {
	const apiKey = getApiKey();
	if (!apiKey) {
		console.warn(`[assemble] Cannot post comment to ${ticketId}: no API key`);
		return false;
	}

	const truncatedBody = truncateForLinearComment(body);

	try {
		// Resolve issue UUID if not provided
		let resolvedId = issueId;
		if (!resolvedId) {
			const { teamKey, number } = parseIdentifier(ticketId);
			const issueQuery = `query($teamKey: String!, $number: Float!) {
				issues(filter: { team: { key: { eq: $teamKey } }, number: { eq: $number } }) {
					nodes { id }
				}
			}`;
			const issueData = await graphqlRequest(apiKey, issueQuery, { teamKey, number });
			resolvedId = issueData?.data?.issues?.nodes?.[0]?.id;
		}

		if (!resolvedId) {
			console.warn(`[assemble] Cannot post comment: issue ${ticketId} not found`);
			return false;
		}

		const mutation = `mutation($issueId: String!, $body: String!) {
			commentCreate(input: { issueId: $issueId, body: $body }) {
				success
			}
		}`;

		const result = await graphqlRequest(apiKey, mutation, { issueId: resolvedId, body: truncatedBody });
		const success = result?.data?.commentCreate?.success;
		if (!success) {
			console.warn(`[assemble] Comment posted but success=false for ${ticketId}`);
		}
		return true;
	} catch (err) {
		console.warn(`[assemble] Failed to post comment to ${ticketId}:`, err instanceof Error ? err.message : err);
		return false;
	}
}
