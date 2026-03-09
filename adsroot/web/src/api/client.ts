import type { AdItem, HomeData, PublicUser, UserConfigData, UserRole } from "../types";

interface ApiResponse<T> {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

let refreshInFlight: Promise<boolean> | null = null;

function parseErrorMessage<T>(response: Response, payload: ApiResponse<T>): string {
  return String(payload.error ?? `请求失败: HTTP ${response.status}`);
}

function shouldRetryWithRefresh<T>(path: string, response: Response, payload: ApiResponse<T>): boolean {
  const unauthorized = response.status === 401 || String(payload.error ?? "") === "unauthorized";
  if (!unauthorized) {
    return false;
  }
  return (
    path === "/api/auth/me"
    || path.startsWith("/api/user/")
    || path.startsWith("/api/admin/")
  );
}

async function refreshSessionOnce(): Promise<boolean> {
  if (refreshInFlight) {
    return refreshInFlight;
  }
  refreshInFlight = (async () => {
    try {
      const response = await fetch("/api/auth/refresh", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });
      const payload = (await response.json().catch(() => ({}))) as ApiResponse<unknown>;
      return response.ok && payload.ok !== false;
    } catch {
      return false;
    }
  })();
  const result = await refreshInFlight;
  refreshInFlight = null;
  return result;
}

async function request<T>(
  path: string,
  init?: RequestInit,
  options?: { skipRefreshRetry?: boolean },
): Promise<T> {
  const response = await fetch(path, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    ...init,
  });
  const payload = (await response.json().catch(() => ({}))) as ApiResponse<T> & T;
  if (!response.ok || payload.ok === false) {
    if (!options?.skipRefreshRetry && shouldRetryWithRefresh(path, response, payload)) {
      const refreshed = await refreshSessionOnce();
      if (refreshed) {
        return request<T>(path, init, { skipRefreshRetry: true });
      }
    }
    throw new Error(parseErrorMessage(response, payload));
  }
  return payload;
}

export const apiClient = {
  async fetchHomeData(): Promise<HomeData> {
    const payload = await request<{ hero: HomeData["hero"]; ads: AdItem[] }>("/api/public/home");
    return {
      hero: payload.hero,
      ads: payload.ads,
    };
  },
  async fetchPublicAds(): Promise<AdItem[]> {
    const payload = await request<{ items: AdItem[] }>("/api/ads");
    return payload.items;
  },
  async getMe(): Promise<PublicUser> {
    const payload = await request<{ user: PublicUser }>("/api/auth/me");
    return payload.user;
  },
  async register(input: {
    username: string;
    password: string;
    avatarEmoji: string;
    captchaToken: string;
    captcha: string;
  }): Promise<PublicUser> {
    const payload = await request<{ user: PublicUser }>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return payload.user;
  },
  async getCaptcha(): Promise<{ captchaToken: string; captchaSvgDataUrl: string }> {
    const payload = await request<{ captchaToken: string; captchaSvgDataUrl: string }>(
      "/api/auth/captcha",
    );
    return {
      captchaToken: payload.captchaToken,
      captchaSvgDataUrl: payload.captchaSvgDataUrl,
    };
  },
  async login(input: {
    username: string;
    password: string;
    captchaToken: string;
    captcha: string;
  }): Promise<PublicUser> {
    const payload = await request<{ user: PublicUser }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return payload.user;
  },
  async refresh(): Promise<PublicUser> {
    const payload = await request<{ user: PublicUser }>("/api/auth/refresh", {
      method: "POST",
      body: JSON.stringify({}),
    });
    return payload.user;
  },
  async logout(): Promise<void> {
    await request("/api/auth/logout", {
      method: "POST",
      body: JSON.stringify({}),
    });
  },
  async updateProfile(input: { avatarEmoji: string }): Promise<PublicUser> {
    const payload = await request<{ user: PublicUser }>("/api/user/profile", {
      method: "PATCH",
      body: JSON.stringify(input),
    });
    return payload.user;
  },
  async changePassword(input: { oldPassword: string; newPassword: string }): Promise<void> {
    await request("/api/user/password", {
      method: "POST",
      body: JSON.stringify(input),
    });
  },
  async getUserConfig(): Promise<UserConfigData | null> {
    const payload = await request<{ config: UserConfigData | null }>("/api/user/config");
    return payload.config;
  },
  async uploadUserConfig(content: string): Promise<{ version: number; updatedAt: string }> {
    const payload = await request<{ config: { version: number; updatedAt: string } }>("/api/user/config", {
      method: "PUT",
      body: JSON.stringify({ content }),
    });
    return payload.config;
  },
  async listUsers(): Promise<Array<PublicUser & { isDisabled: boolean }>> {
    const payload = await request<{ users: Array<PublicUser & { isDisabled: boolean }> }>("/api/admin/users");
    return payload.users;
  },
  async createUser(input: {
    username: string;
    password: string;
    role: UserRole;
    avatarEmoji: string;
  }): Promise<PublicUser & { isDisabled: boolean }> {
    const payload = await request<{ user: PublicUser & { isDisabled: boolean } }>("/api/admin/users", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return payload.user;
  },
  async updateUser(
    id: number,
    input: { role?: UserRole; avatarEmoji?: string; isDisabled?: boolean },
  ): Promise<PublicUser & { isDisabled: boolean }> {
    const payload = await request<{ user: PublicUser & { isDisabled: boolean } }>(`/api/admin/users/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
    return payload.user;
  },
  async deleteUser(id: number): Promise<void> {
    await request(`/api/admin/users/${id}`, {
      method: "DELETE",
    });
  },
  async listAdsForAdmin(): Promise<AdItem[]> {
    const payload = await request<{ items: AdItem[] }>("/api/admin/ads");
    return payload.items;
  },
  async createAd(input: Omit<AdItem, "id">): Promise<AdItem> {
    const payload = await request<{ item: AdItem }>("/api/admin/ads", {
      method: "POST",
      body: JSON.stringify(input),
    });
    return payload.item;
  },
  async updateAd(id: number, input: Omit<AdItem, "id">): Promise<AdItem> {
    const payload = await request<{ item: AdItem }>(`/api/admin/ads/${id}`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
    return payload.item;
  },
  async toggleAd(id: number): Promise<AdItem> {
    const payload = await request<{ item: AdItem }>(`/api/admin/ads/${id}/toggle`, {
      method: "PATCH",
      body: JSON.stringify({}),
    });
    return payload.item;
  },
  async deleteAd(id: number): Promise<void> {
    await request(`/api/admin/ads/${id}`, {
      method: "DELETE",
    });
  },
};
