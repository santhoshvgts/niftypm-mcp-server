export interface NiftyProject {
  id: string;
  name: string;
  description?: string;
  status?: string;
  color?: string;
  created_at?: string;
  updated_at?: string;
  members?: NiftyMember[];
  portfolio?: string;
}

export interface NiftyTask {
  id: string;
  name: string;
  description?: string;
  completed?: boolean;
  due_date?: string;
  start_date?: string;
  assignees?: NiftyMember[];
  milestone_id?: string;
  task_group_id?: string;
  labels?: string[];
  story_points?: number;
  created_at?: string;
  updated_at?: string;
  status?: string;
}

export interface NiftyMilestone {
  id: string;
  name: string;
  description?: string;
  start?: string;
  end?: string;
  project_id?: string;
  completed?: boolean;
  completion?: number;
  created_at?: string;
  status?: string;
  tasks?: NiftyTask[];
}

export interface NiftyTimelog {
  id: string;
  task_id?: string;
  user?: NiftyMember;
  time?: number;
  note?: string;
  date?: string;
  created_at?: string;
}

export interface NiftyComment {
  id: string;
  body?: string;
  author?: NiftyMember;
  task_id?: string;
  created_at?: string;
  updated_at?: string;
}

export interface NiftyActivity {
  id: string;
  action?: string;
  actor?: NiftyMember;
  entity?: string;
  entity_id?: string;
  project_id?: string;
  created_at?: string;
  meta?: Record<string, unknown>;
}

export interface NiftyMember {
  id: string;
  name?: string;
  email?: string;
  avatar?: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  total?: number;
  has_more: boolean;
  next_offset?: number;
}

export interface NiftyApiError {
  message: string;
  status: number;
}
