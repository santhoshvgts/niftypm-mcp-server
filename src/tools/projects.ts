import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AxiosInstance } from "axios";
import { z } from "zod";
import { DEFAULT_LIMIT, MAX_LIMIT, CHARACTER_LIMIT } from "../constants.js";
import { formatApiError, truncateIfNeeded } from "../services/niftyClient.js";
import { NiftyProject } from "../types.js";

export function registerProjectTools(server: McpServer, getClient: () => AxiosInstance): void {

  server.registerTool(
    "nifty_list_projects",
    {
      title: "List Nifty Projects",
      description: `Fetch all projects in your Nifty workspace.

Returns a list of projects with their IDs, names, status, color, and member info.
Use project IDs from this list as input for other tools (tasks, milestones, etc.).

Args:
  - limit (number): Max results per page, 1-100 (default: 25)
  - offset (number): Pagination offset (default: 0)

Returns:
  JSON array of projects with: id, name, description, status, color, created_at, members

Examples:
  - "Show me all my projects" -> call with default params
  - "List projects, page 2" -> call with offset=25`,
      inputSchema: z.object({
        limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT).describe("Max results per page"),
        offset: z.number().int().min(0).default(0).describe("Pagination offset"),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ limit, offset }) => {
      try {
        const client = getClient();
        const { data } = await client.get("/projects", { params: { limit, offset } });
        const projects: NiftyProject[] = data?.data || data || [];
        const total = data?.total || projects.length;

        const output = {
          total,
          count: projects.length,
          offset,
          has_more: total > offset + projects.length,
          projects: projects.map((p) => ({
            id: p.id,
            name: p.name,
            description: p.description,
            status: p.status,
            color: p.color,
            created_at: p.created_at,
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
    "nifty_get_project",
    {
      title: "Get Nifty Project",
      description: `Get detailed information about a specific Nifty project by ID.

Returns full project details including members, settings, and metadata.

Args:
  - project_id (string): The Nifty project ID (get from nifty_list_projects)

Returns:
  JSON with full project details: id, name, description, status, members, color, created_at

Examples:
  - "Show details for project XYZ" -> call with project_id="XYZ"`,
      inputSchema: z.object({
        project_id: z.string().min(1).describe("Nifty project ID"),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ project_id }) => {
      try {
        const client = getClient();
        const { data } = await client.get(`/projects/${project_id}`);
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
    "nifty_list_members",
    {
      title: "List Nifty Members",
      description: `List all members in your Nifty workspace, or members of a specific project.

Returns member IDs, names, and emails. Use member IDs when filtering tasks by assignee.

Args:
  - project_id (string, optional): Filter members by project ID
  - limit (number): Max results (default: 25)
  - offset (number): Pagination offset (default: 0)

Returns:
  JSON array with: id, name, email, avatar`,
      inputSchema: z.object({
        project_id: z.string().optional().describe("Optional project ID to filter members"),
        limit: z.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT).describe("Max results"),
        offset: z.number().int().min(0).default(0).describe("Pagination offset"),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ project_id, limit, offset }) => {
      try {
        const client = getClient();
        const params: Record<string, unknown> = { limit, offset };
        if (project_id) params.project_id = project_id;
        const { data } = await client.get("/members", { params });
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
