import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AxiosInstance } from "axios";
import { z } from "zod";
import { DEFAULT_LIMIT, MAX_LIMIT, CHARACTER_LIMIT } from "../constants.js";
import { formatApiError, truncateIfNeeded } from "../services/niftyClient.js";

export function registerMilestoneTools(server: McpServer, getClient: () => AxiosInstance): void {

  server.registerTool(
    "nifty_list_milestones",
    {
      title: "List Nifty Milestones",
      description: `Fetch milestones (phases/sprints/roadmap items) for a Nifty project.

Milestones represent project phases, sprints, or deliverables on the Nifty roadmap.
They group tasks and show completion percentage based on task status.

Args:
  - project_id (string): The Nifty project ID (required)
  - limit (number): Max results per page, 1-100 (default: 25)
  - offset (number): Pagination offset (default: 0)

Returns:
  JSON array of milestones with: id, name, description, start, end, completed,
  completion (percentage), status, project_id, created_at

Examples:
  - "Show milestones for project P1" -> project_id="P1"
  - "What sprints are in this project?" -> project_id="P1"`,
      inputSchema: z.object({
        project_id: z.string().min(1).describe("Nifty project ID (required)"),
        limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT).describe("Max results per page"),
        offset: z.number().int().min(0).default(0).describe("Pagination offset"),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ project_id, limit, offset }) => {
      try {
        const client = getClient();
        const { data } = await client.get("/milestones", { params: { project_id, limit, offset } });
        const milestones = data?.data || data || [];
        const total = data?.total || milestones.length;

        const output = {
          total,
          count: milestones.length,
          offset,
          has_more: total > offset + milestones.length,
          milestones: milestones.map((m: Record<string, unknown>) => ({
            id: m.id,
            name: m.name,
            description: m.description,
            start: m.start,
            end: m.end,
            completed: m.completed,
            completion: m.completion,
            status: m.status,
            project_id: m.project_id,
            created_at: m.created_at,
          })),
        };

        return {
          content: [{ type: "text", text: truncateIfNeeded(JSON.stringify(output, null, 2), CHARACTER_LIMIT) }],
          structuredContent: output,
        };
      } catch (err) {
        return { content: [{ type: "text", text: formatApiError(err) }] };
      }
    }
  );

  server.registerTool(
    "nifty_get_milestone",
    {
      title: "Get Nifty Milestone",
      description: `Get full details of a specific Nifty milestone including its tasks.

Returns complete milestone info with dates, completion status, and associated tasks.

Args:
  - milestone_id (string): The Nifty milestone ID

Returns:
  JSON with: id, name, description, start, end, completed, completion percentage,
  status, tasks list

Examples:
  - "Show milestone M1 details and its tasks" -> milestone_id="M1"`,
      inputSchema: z.object({
        milestone_id: z.string().min(1).describe("Nifty milestone ID"),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ milestone_id }) => {
      try {
        const client = getClient();
        const { data } = await client.get(`/milestones/${milestone_id}`);
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
          structuredContent: data,
        };
      } catch (err) {
        return { content: [{ type: "text", text: formatApiError(err) }] };
      }
    }
  );
}
