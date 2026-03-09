import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { apiClient } from "../api/client";
import type { PublicUser } from "../types";

interface AuthContextValue {
  user: PublicUser | null;
  loading: boolean;
  login: (input: {
    username: string;
    password: string;
    captchaToken: string;
    captcha: string;
  }) => Promise<void>;
  register: (input: {
    username: string;
    password: string;
    avatarEmoji: string;
    captchaToken: string;
    captcha: string;
  }) => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
  setUser: (user: PublicUser | null) => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshUser = useCallback(async () => {
    const me = await apiClient.getMe();
    setUser(me);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const me = await apiClient.getMe();
        if (!cancelled) {
          setUser(me);
        }
      } catch {
        try {
          const me = await apiClient.refresh();
          if (!cancelled) {
            setUser(me);
          }
        } catch {
          if (!cancelled) {
            setUser(null);
          }
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback<NonNullable<AuthContextValue["login"]>>(async (input) => {
    const me = await apiClient.login(input);
    setUser(me);
  }, []);

  const register = useCallback<NonNullable<AuthContextValue["register"]>>(async (input) => {
    const me = await apiClient.register(input);
    setUser(me);
  }, []);

  const logout = useCallback(async () => {
    await apiClient.logout();
    setUser(null);
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      loading,
      login,
      register,
      logout,
      refreshUser,
      setUser,
    }),
    [user, loading, login, register, logout, refreshUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used inside AuthProvider");
  }
  return context;
}
