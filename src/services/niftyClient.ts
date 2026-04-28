import axios, { AxiosInstance, AxiosError } from "axios";
import { NIFTY_API_BASE } from "../constants";
import { NiftyApiError } from "../types";

export function createNiftyClient(token: string): AxiosInstance {
  return axios.create({
    baseURL: NIFTY_API_BASE,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    timeout: 15000,
  });
}

export function formatApiError(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const axiosError = error as AxiosError<NiftyApiError>;
    const status = axiosError.response?.status;
    const message = axiosError.response?.data?.message || axiosError.message;

    if (status === 401) return "Error: Invalid or expired Nifty API token. Please check your NIFTY_API_TOKEN environment variable.";
    if (status === 403) return "Error: Access denied. Your API token does not have permission to access this resource.";
    if (status === 404) return `Error: Resource not found. The specified ID may be incorrect. Details: ${message}`;
    if (status === 429) return "Error: Rate limit exceeded (200 GET/min, 50 POST/min). Please wait before retrying.";
    if (status === 422) return `Error: Invalid parameters. Details: ${message}`;
    return `Error: Nifty API error (${status}): ${message}`;
  }
  if (error instanceof Error) return `Error: ${error.message}`;
  return "Error: Unknown error occurred";
}

export function truncateIfNeeded(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return text.slice(0, limit) + `\n\n[Response truncated at ${limit} characters. Use filters or pagination to narrow results.]`;
}
