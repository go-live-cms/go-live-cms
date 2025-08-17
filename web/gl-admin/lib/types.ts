export interface User {
  id: number;
  username: string;
  full_name: string;
  email: string;
  role: string;
  created_at: string;
  password_changed_at?: string;
}

export interface Post {
  id: number;
  title: string;
  description: string;
  content: string;
  user_id: number;
  username: string;
  url: string;
  created_at: string;
  changed_at: string;
}

export interface Taxonomy {
  id: number;
  name: string;
  description: string;
}

export interface Media {
  id: number;
  name: string;
  description: string;
  alt: string;
  media_path: string;
  user_id: number;
  created_at: string;
  changed_at: string;
  post_count?: number;
  file_size: number;
  mime_type: string;
  width?: number;
  height?: number;
  duration?: number;
  original_filename: string;
}
