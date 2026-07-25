import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState
} from "react";
import type { User } from "@damo/contracts";
import { api, tokenStore } from "./api";

interface LoginResult {
  user: User;
  accessToken: string;
  refreshToken: string;
}

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  login: (loginId: string, password: string) => Promise<void>;
  signup: (input: {
    loginId: string;
    nickname: string;
    password: string;
    email?: string;
  }) => Promise<void>;
  acceptOAuthToken: (accessToken: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: PropsWithChildren) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const loadMe = useCallback(async () => {
    if (!tokenStore.get()) {
      setUser(null);
      setLoading(false);
      return;
    }
    try {
      setUser(await api<User>("/me"));
    } catch {
      tokenStore.clear();
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadMe();
  }, [loadMe]);

  const login = useCallback(async (loginId: string, password: string) => {
    const result = await api<LoginResult>(
      "/auth/test/login",
      { method: "POST", body: JSON.stringify({ loginId, password }) },
      false
    );
    tokenStore.set(result.accessToken);
    localStorage.setItem("damo.refreshToken", result.refreshToken);
    setUser(result.user);
  }, []);

  const signup = useCallback(
    async (input: {
      loginId: string;
      nickname: string;
      password: string;
      email?: string;
    }) => {
      const result = await api<LoginResult>(
        "/auth/test/signup",
        {
          method: "POST",
          body: JSON.stringify({ ...input, email: input.email || null })
        },
        false
      );
      tokenStore.set(result.accessToken);
      localStorage.setItem("damo.refreshToken", result.refreshToken);
      setUser(result.user);
    },
    []
  );

  const acceptOAuthToken = useCallback(async (accessToken: string) => {
    tokenStore.set(accessToken);
    setUser(await api<User>("/me"));
  }, []);

  const logout = useCallback(async () => {
    try {
      if (tokenStore.get()) await api("/auth/logout", { method: "POST" });
    } finally {
      tokenStore.clear();
      setUser(null);
    }
  }, []);

  const value = useMemo(
    () => ({ user, loading, login, signup, acceptOAuthToken, logout }),
    [acceptOAuthToken, loading, login, logout, signup, user]
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const value = useContext(AuthContext);
  if (!value) throw new Error("AuthProvider가 필요합니다.");
  return value;
}
