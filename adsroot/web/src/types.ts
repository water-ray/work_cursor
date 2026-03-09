export type UserRole = "user" | "admin";

export interface PublicUser {
  id: number;
  username: string;
  role: UserRole;
  avatarEmoji: string;
  createdAt: string;
  updatedAt: string;
}

export interface AdItem {
  id: number;
  title: string;
  imageUrl: string;
  targetUrl: string;
  summary: string;
  sortOrder: number;
  isActive?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface HomeHero {
  title: string;
  slogan: string;
  description: string;
  techStacks: string[];
}

export interface HomeData {
  hero: HomeHero;
  ads: AdItem[];
}

export interface UserConfigData {
  version: number;
  updatedAt: string;
  content: string;
}
