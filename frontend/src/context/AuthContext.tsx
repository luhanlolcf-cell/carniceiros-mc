import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';

export type ClubRole = 'DIRETORIA' | 'MEMBRO' | 'PROSPECT';
export type EndpointPlatformType = 'MOBILE' | 'WEB';
export type EndpointOS = 'ANDROID' | 'IOS' | 'DESKTOP';

export interface EndpointPlatformInfo {
  type: EndpointPlatformType;
  os: EndpointOS;
  authTransport: 'BEARER_SECURE_STORE' | 'HTTPONLY_COOKIE';
  detectedBy: string;
}

export interface ClubUser {
  id: string;
  fullName: string;
  roadName: string;
  email: string;
  role: ClubRole;
  clubRank: string;
}

interface AuthContextValue {
  user: ClubUser | null;
  platform: EndpointPlatformInfo;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

const API_BASE_URL = import.meta.env?.VITE_API_URL || 'http://localhost:4000/api';

/**
 * Identifica automaticamente no cliente se a aplicação está rodando em
 * ambiente MOBILE (Android / iOS — App Nativo Capacitor/Expo ou navegador mobile) ou WEB (Desktop).
 */
export function detectClientEndpointPlatform(): EndpointPlatformInfo {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return { type: 'WEB', os: 'DESKTOP', authTransport: 'HTTPONLY_COOKIE', detectedBy: 'SSR_DEFAULT' };
  }

  const ua = navigator.userAgent || '';
  const chMobile = (navigator as any).userAgentData?.mobile === true;
  const isCapacitorOrExpo =
    Boolean((window as any).Capacitor?.isNativePlatform?.()) ||
    window.location.protocol === 'capacitor:' ||
    window.location.protocol === 'ionic:';
  const isMobileViewport = window.matchMedia?.('(max-width: 768px) and (pointer: coarse)')?.matches;

  const isAndroid = /android/i.test(ua);
  const isIOS = /iphone|ipad|ipod/i.test(ua);

  if (isCapacitorOrExpo || chMobile || isAndroid || isIOS || isMobileViewport) {
    const os: EndpointOS = isIOS ? 'IOS' : isAndroid ? 'ANDROID' : 'ANDROID';
    return {
      type: 'MOBILE',
      os,
      authTransport: 'BEARER_SECURE_STORE',
      detectedBy: isCapacitorOrExpo
        ? 'NATIVE_BRIDGE'
        : chMobile
        ? 'CLIENT_HINTS'
        : isAndroid || isIOS
        ? 'USER_AGENT'
        : 'VIEWPORT_TOUCH',
    };
  }

  return {
    type: 'WEB',
    os: 'DESKTOP',
    authTransport: 'HTTPONLY_COOKIE',
    detectedBy: 'USER_AGENT_DESKTOP',
  };
}

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<ClubUser | null>(null);
  const [platform, setPlatform] = useState<EndpointPlatformInfo>(() => detectClientEndpointPlatform());
  const [isLoading, setIsLoading] = useState<boolean>(true);

  useEffect(() => {
    const handleResize = () => setPlatform(detectClientEndpointPlatform());
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    async function verifySession() {
      const currentPlatform = detectClientEndpointPlatform();
      try {
        const response = await fetch(`${API_BASE_URL}/auth/me`, {
          method: 'GET',
          credentials: 'include',
          headers: {
            Accept: 'application/json',
            'X-Client-Platform': currentPlatform.type.toLowerCase(),
          },
        });
        if (response.ok) {
          const data = await response.json();
          setUser(data.user);
        } else {
          setUser(null);
        }
      } catch {
        setUser(null);
      } finally {
        setIsLoading(false);
      }
    }
    verifySession();
  }, []);

  const login = async (email: string, password: string): Promise<void> => {
    const currentPlatform = detectClientEndpointPlatform();
    const response = await fetch(`${API_BASE_URL}/auth/login`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'X-Client-Platform': currentPlatform.type.toLowerCase(),
      },
      body: JSON.stringify({ email, password }),
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.message || 'Falha ao autenticar no sistema.');
    }

    if (data.clientPlatform) {
      setPlatform(data.clientPlatform);
    }
    setUser(data.user);
  };

  const logout = async (): Promise<void> => {
    await fetch(`${API_BASE_URL}/auth/logout`, {
      method: 'POST',
      credentials: 'include',
    });
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, platform, isLoading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
};

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth deve ser utilizado dentro de um AuthProvider');
  }
  return ctx;
}
