import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AxiosInstance } from "axios";
import { z } from "zod";
import { DEFAULT_LIMIT, MAX_LIMIT, CHARACTER_LIMIT } from "../constants.js";
import { formatApiError, truncateIfNeeded } from "../services/niftyClient.js";

export function registerTaskTools(server: McpServer, getClient: () => AxiosInstance): void {

  server.registerTool(
    "nifty_list_tasks",
    {
      title: "List Nifty Tasks",
      description: `Fetch tasks from a Nifty project, milestone, or task group.

At least one of project_id or milestone_id is required.

Args:
  - project_id (string, optional): Filter tasks by project ID
  - milestone_id (string, optional): Filter tasks by milestone/list ID
  - task_group_id (string, optional): Filter tasks by task group ID
  - completed (boolean, optional): Filter by completion status (true=done, false=open)
  - assignee_id (string, optional): Filter by assignee member ID
  - limit (number): Max results per page, 1-100 (default: 25)
  - offset (number): Pagination offset (default: 0)

Returns:
  JSON array of tasks with: id, name, description, completed, due_date, start_date,
  assignees, milestone_id, labels, story_points, status, created_at

Examples:
  - "Show open tasks in project ABC" -> project_id="ABC", completed=false
  - "Show John's tasks" -> assignee_id="john_id"
  - "Show tasks in milestone XYZ" -> milestone_id="XYZ"`,
      inputSchema: z.object({
        project_id: z.string().optional().describe("Project ID to filter tasks"),
        milestone_id: z.string().optional().describe("Milestone/List ID to filter tasks"),
        task_group_id: z.string().optional().describe("Task group ID to filter tasks"),
        completed: z.boolean().optional().describe("Filter by completion: true=done, false=open"),
        assignee_id: z.string().optional().describe("Filter by assignee member ID"),
        limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT).describe("Max results per page"),
        offset: z.number().int().min(0).default(0).describe("Pagination offset"),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ project_id, milestone_id, task_group_id, completed, assignee_id, limit, offset }) => {
      try {
        const client = getClient();
        const params: Record<string, unknown> = { limit, offset };
        if (project_id) params.project_id = project_id;
        if (milestone_id) params.milestone_id = milestone_id;
        if (task_group_id) params.task_group_id = task_group_id;
        if (completed !== undefined) params.completed = completed;
        if (assignee_id) params.assignee_id = assignee_id;

        const { data } = await client.get("/tasks", { params });
        const tasks = data?.data || data || [];
        const total = data?.total || tasks.length;

        const output = {
          total,
          count: tasks.length,
          offset,
          has_more: total > offset + tasks.length,
          tasks: tasks.map((t: Record<string, unknown>) => ({
            id: t.id,
            name: t.name,
            description: t.description,
            completed: t.completed,
            status: t.status,
            due_date: t.due_date,
            start_date: t.start_date,
            assignees: t.assignees,
            milestone_id: t.milestone_id,
            labels: t.labels,
            story_points: t.story_points,
            created_at: t.created_at,
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
    "nifty_get_task",
    {
      title: "Get Nifty Task",
      description: `Get full details of a specific Nifty task by ID.

Returns complete task information including description, assignees, dates, labels, custom fields, and subtask info.

Args:
  - task_id (string): The Nifty task ID

Returns:
  JSON with full task details: id, name, description, completed, due_date, start_date,
  assignees, milestone_id, labels, story_points, custom fields, status

Examples:
  - "Show me task T123 details" -> task_id="T123"`,
      inputSchema: z.object({
        task_id: z.string().min(1).describe("Nifty task ID"),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ task_id }) => {
      try {
        const client = getClient();
        const { data } = await client.get(`/tasks/${task_id}`);
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
          structuredContent: data,
        };
      } catch (err) {
        return { content: [{ type: "text", text: formatApiError(err) }] };
      }
    }
  );

  server.registerTool(
    "nifty_get_task_comments",
    {
      title: "Get Nifty Task Comments",
      description: `Fetch all comments on a specific Nifty task.

Returns comments with author info, body text, and timestamps.

Args:
  - task_id (string): The Nifty task ID
  - limit (number): Max comments to return (default: 25)
  - offset (number): Pagination offset (default: 0)

Returns:
  JSON array of comments with: id, body, author (id, name, email), created_at, updated_at

Examples:
  - "Show comments on task T123" -> task_id="T123"`,
      inputSchema: z.object({
        task_id: z.string().min(1).describe("Nifty task ID"),
        limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT).describe("Max comments to return"),
        offset: z.number().int().min(0).default(0).describe("Pagination offset"),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ task_id, limit, offset }) => {
      try {
        const client = getClient();
        const { data } = await client.get(`/tasks/${task_id}/comments`, { params: { limit, offset } });
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
