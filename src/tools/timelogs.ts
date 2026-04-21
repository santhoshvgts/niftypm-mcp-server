import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AxiosInstance } from "axios";
import { z } from "zod";
import { DEFAULT_LIMIT, MAX_LIMIT, CHARACTER_LIMIT } from "../constants.js";
import { formatApiError, truncateIfNeeded } from "../services/niftyClient.js";

export function registerTimelogTools(server: McpServer, getClient: () => AxiosInstance): void {

  server.registerTool(
    "nifty_list_timelogs",
    {
      title: "List Nifty Timelogs",
      description: `Fetch time tracking entries for tasks in a Nifty project.

Returns time logs with duration, notes, user, and date. Useful for billing, reporting,
and understanding how time was spent across tasks.

Args:
  - project_id (string, optional): Filter timelogs by project ID
  - task_id (string, optional): Filter timelogs by specific task ID
  - member_id (string, optional): Filter timelogs by team member ID
  - from_date (string, optional): Start date filter in YYYY-MM-DD format
  - to_date (string, optional): End date filter in YYYY-MM-DD format
  - limit (number): Max results per page (default: 25)
  - offset (number): Pagination offset (default: 0)

Returns:
  JSON array of timelogs with: id, task_id, user (id, name), time (seconds),
  note, date, created_at

Examples:
  - "Show time logged on project P1 this week" -> project_id="P1", from_date="2025-04-14"
  - "How much time did John log?" -> member_id="john_id"
  - "Time entries for task T5" -> task_id="T5"`,
      inputSchema: z.object({
        project_id: z.string().optional().describe("Filter by project ID"),
        task_id: z.string().optional().describe("Filter by task ID"),
        member_id: z.string().optional().describe("Filter by member ID"),
        from_date: z.string().optional().describe("Start date filter (YYYY-MM-DD)"),
        to_date: z.string().optional().describe("End date filter (YYYY-MM-DD)"),
        limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT).describe("Max results per page"),
        offset: z.number().int().min(0).default(0).describe("Pagination offset"),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ project_id, task_id, member_id, from_date, to_date, limit, offset }) => {
      try {
        const client = getClient();
        const params: Record<string, unknown> = { limit, offset };
        if (project_id) params.project_id = project_id;
        if (task_id) params.task_id = task_id;
        if (member_id) params.member_id = member_id;
        if (from_date) params.from_date = from_date;
        if (to_date) params.to_date = to_date;

        const { data } = await client.get("/timelogs", { params });
        const logs = data?.data || data || [];
        const total = data?.total || logs.length;

        // Calculate total time in hours for convenience
        const totalSeconds = logs.reduce((sum: number, log: Record<string, unknown>) => sum + (Number(log.time) || 0), 0);

        const output = {
          total,
          count: logs.length,
          offset,
          has_more: total > offset + logs.length,
          total_time_hours: Math.round((totalSeconds / 3600) * 100) / 100,
          timelogs: logs.map((l: Record<string, unknown>) => ({
            id: l.id,
            task_id: l.task_id,
            user: l.user,
            time_seconds: l.time,
            time_hours: Math.round((Number(l.time) / 3600) * 100) / 100,
            note: l.note,
            date: l.date,
            created_at: l.created_at,
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
    "nifty_list_activity",
    {
      title: "List Nifty Activity",
      description: `Fetch recent activity/audit log for a Nifty project.

Returns a chronological feed of actions taken in the project: task updates, comments,
status changes, milestone updates, member actions, etc.

Args:
  - project_id (string): The Nifty project ID (required)
  - limit (number): Max results per page (default: 25)
  - offset (number): Pagination offset (default: 0)

Returns:
  JSON array of activity entries with: id, action, actor (who did it),
  entity (what was affected), entity_id, project_id, created_at, meta (details)

Examples:
  - "What happened in project P1 recently?" -> project_id="P1"
  - "Show recent activity" -> project_id="P1", limit=10`,
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
        const { data } = await client.get("/activity", { params: { project_id, limit, offset } });
        return {
          content: [{ type: "text", text: truncateIfNeeded(JSON.stringify(data, null, 2), CHARACTER_LIMIT) }],
          structuredContent: data,
        };
      } catch (err) {
        return { content: [{ type: "text", text: formatApiError(err) }] };
      }
    }
  );

  server.registerTool(
    "nifty_list_messages",
    {
      title: "List Nifty Messages",
      description: `Fetch messages from a Nifty project's discussion/chat.

Returns project-level messages (not task comments) with author and content.

Args:
  - project_id (string): The Nifty project ID (required)
  - limit (number): Max results per page (default: 25)
  - offset (number): Pagination offset (default: 0)

Returns:
  JSON array of messages with: id, body, author (id, name), created_at, updated_at

Examples:
  - "Show project discussions" -> project_id="P1"
  - "What messages were sent in project P1?" -> project_id="P1"`,
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
        const { data } = await client.get("/messages", { params: { project_id, limit, offset } });
        return {
          content: [{ type: "text", text: truncateIfNeeded(JSON.stringify(data, null, 2), CHARACTER_LIMIT) }],
          structuredContent: data,
        };
      } catch (err) {
        return { content: [{ type: "text", text: formatApiError(err) }] };
      }
    }
  );
}
