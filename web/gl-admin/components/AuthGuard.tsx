import { useEffect, useState } from "react";
import { authManager, type AuthState } from "@gl-admin/lib/auth";

interface AuthGuardProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
  redirectTo?: string;
}

export default function AuthGuard({
  children,
  fallback = <div>Please log in to access this content.</div>,
  redirectTo = "/login",
}: AuthGuardProps) {
  const [authState, setAuthState] = useState<AuthState>({
    isAuthenticated: false,
    user: null,
    accessToken: null,
    refreshToken: null,
  });
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const checkAuth = async () => {
      const state = authManager.getState();

      if (state.isAuthenticated && state.refreshToken) {
        const refreshed = await authManager.refreshAccessToken();
        if (!refreshed) {
          const currentPath = window.location.pathname;
          window.location.href = `${redirectTo}?redirect=${encodeURIComponent(
            currentPath
          )}`;
          return;
        }
      }

      setAuthState(authManager.getState());
      setIsLoading(false);

      if (!state.isAuthenticated) {
        const currentPath = window.location.pathname;
        window.location.href = `${redirectTo}?redirect=${encodeURIComponent(
          currentPath
        )}`;
      }
    };

    checkAuth();
  }, [redirectTo]);

  if (isLoading) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "2rem",
        }}>
        <div>Loading...</div>
      </div>
    );
  }

  if (!authState.isAuthenticated) {
    return <>{fallback}</>;
  }

  return <>{children}</>;
}
