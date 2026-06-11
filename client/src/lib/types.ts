export interface TemplateBox {
  role: string;
  x_pct: number;
  y_pct: number;
  w_pct: number;
  h_pct: number;
}

export type RatingStatus =
  | "pending" | "funny" | "meh" | "bad_context" | "bad_structure" | "bad_format";

/** funny/meh judge the caption; the two flags revise the template analysis. */
export type Rating = "funny" | "meh" | "bad_context" | "bad_structure";

export interface Candidate {
  id: string;
  top: string;
  bottom: string;
  status: RatingStatus;
  reason?: string;
  elo?: number;
  duels?: number;
}

export interface Template {
  slug: string;
  name: string;
  blank_url: string;
  box_count: number;
  examples: number;
  min_examples: number;
  analyzed: boolean;
  revision: number;
  box_layout: TemplateBox[] | null;
  funny: number;
  meh: number;
  bad_context: number;
  bad_structure: number;
  pending: Candidate[];
  learnings: { funny: number; meh: number } | null;
}

export interface AppState {
  busy: string | null;
  harvested: number;
  templates: Template[];
}

/** One pending candidate flattened with its template context, ready to render. */
export interface QueueItem {
  slug: string;
  name: string;
  blank_url: string;
  box_layout: TemplateBox[] | null;
  candidate: Candidate;
}

export interface Fighter {
  slug: string;
  template: string;
  id: string;
  top: string;
  bottom: string;
  elo: number;
  duels: number;
  image: string;
}

export interface ImgflipItem {
  name: string;
  url: string;
  box_count: number;
}

export type View = "library" | "rate" | "duel" | "board";
