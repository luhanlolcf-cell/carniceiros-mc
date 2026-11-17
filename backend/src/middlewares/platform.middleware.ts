import { Request, Response, NextFunction } from 'express';

export type PlatformType = 'MOBILE' | 'WEB';
export type PlatformOS = 'ANDROID' | 'IOS' | 'DESKTOP';
export type AuthTransport = 'BEARER_SECURE_STORE' | 'HTTPONLY_COOKIE';

export interface ClientPlatformInfo {
  type: PlatformType;
  os: PlatformOS;
  authTransport: AuthTransport;
  isNativeApp: boolean;
  detectedBy: 'HEADER_EXPLICIT' | 'ORIGIN_SCHEME' | 'CLIENT_HINTS' | 'USER_AGENT';
}

declare global {
  namespace Express {
    interface Request {
      clientPlatform?: ClientPlatformInfo;
    }
  }
}

/**
 * Identifica automaticamente se a requisição ao endpoint vem de um cliente
 * MOBILE (Android / iOS — App nativo Capacitor/Expo ou navegador mobile) ou WEB (Desktop).
 *
 * Ordem de precedência:
 * 1. Header explícito `X-Client-Platform` enviado pelo app/cliente
 * 2. Esquema do header `Origin` (`capacitor://`, `ionic://`, `exp://`)
 * 3. Client Hints HTTP (`Sec-CH-UA-Mobile`, `Sec-CH-UA-Platform`)
 * 4. Assinatura do `User-Agent` (`Android`, `iPhone`, `iPad`, `okhttp`, `CFNetwork`, `Dalvik`)
 */
export function detectClientPlatform(req: Request): ClientPlatformInfo {
  const explicitHeader = (req.headers['x-client-platform'] as string | undefined)?.toLowerCase().trim();
  const origin = (req.headers.origin || '').toLowerCase();
  const chMobile = req.headers['sec-ch-ua-mobile'] as string | undefined;
  const chPlatform = (req.headers['sec-ch-ua-platform'] as string | undefined)?.toLowerCase() || '';
  const ua = req.headers['user-agent'] || '';

  const detectOS = (source: string): PlatformOS => {
    if (/android|okhttp|dalvik/i.test(source)) return 'ANDROID';
    if (/iphone|ipad|ipod|ios|cfnetwork|darwin/i.test(source)) return 'IOS';
    return 'DESKTOP';
  };

  // 1. Header explícito X-Client-Platform
  if (explicitHeader) {
    if (explicitHeader === 'mobile' || explicitHeader === 'android' || explicitHeader === 'ios') {
      const os = explicitHeader === 'android' ? 'ANDROID' : explicitHeader === 'ios' ? 'IOS' : detectOS(ua);
      return {
        type: 'MOBILE',
        os: os === 'DESKTOP' ? 'ANDROID' : os,
        authTransport: 'BEARER_SECURE_STORE',
        isNativeApp: true,
        detectedBy: 'HEADER_EXPLICIT',
      };
    }
    if (explicitHeader === 'web') {
      return {
        type: 'WEB',
        os: 'DESKTOP',
        authTransport: 'HTTPONLY_COOKIE',
        isNativeApp: false,
        detectedBy: 'HEADER_EXPLICIT',
      };
    }
  }

  // 2. Origin de WebView Nativo (Capacitor / Ionic / Expo)
  if (origin.startsWith('capacitor://') || origin.startsWith('ionic://') || origin.startsWith('exp://')) {
    const os = detectOS(ua);
    return {
      type: 'MOBILE',
      os: os === 'DESKTOP' ? 'ANDROID' : os,
      authTransport: 'BEARER_SECURE_STORE',
      isNativeApp: true,
      detectedBy: 'ORIGIN_SCHEME',
    };
  }

  // 3. HTTP Client Hints (Sec-CH-UA-Mobile / Sec-CH-UA-Platform)
  if (chMobile === '?1' || chPlatform.includes('android') || chPlatform.includes('ios')) {
    const os = chPlatform.includes('ios') ? 'IOS' : chPlatform.includes('android') ? 'ANDROID' : detectOS(ua);
    return {
      type: 'MOBILE',
      os: os === 'DESKTOP' ? 'ANDROID' : os,
      authTransport: 'BEARER_SECURE_STORE',
      isNativeApp: false,
      detectedBy: 'CLIENT_HINTS',
    };
  }

  // 4. Fallback por User-Agent (Android, iOS, clientes HTTP nativos mobile)
  if (/Android|iPhone|iPad|iPod|Mobile|Capacitor|Expo|okhttp|Dalvik|CFNetwork/i.test(ua)) {
    const os = detectOS(ua);
    return {
      type: 'MOBILE',
      os: os === 'DESKTOP' ? 'ANDROID' : os,
      authTransport: 'BEARER_SECURE_STORE',
      isNativeApp: /Capacitor|Expo|okhttp|Dalvik|CFNetwork/i.test(ua),
      detectedBy: 'USER_AGENT',
    };
  }

  // Padrão: Navegador Web Desktop
  return {
    type: 'WEB',
    os: 'DESKTOP',
    authTransport: 'HTTPONLY_COOKIE',
    isNativeApp: false,
    detectedBy: 'USER_AGENT',
  };
}

/**
 * Middleware Express que anexa `req.clientPlatform` em todas as rotas
 * e expõe os headers `X-Detected-Platform` e `X-Auth-Transport` na resposta.
 */
export function platformDetectorMiddleware(req: Request, res: Response, next: NextFunction): void {
  const info = detectClientPlatform(req);
  req.clientPlatform = info;

  res.setHeader('X-Detected-Platform', `${info.type} (${info.os})`);
  res.setHeader('X-Auth-Transport', info.authTransport);
  res.setHeader('Accept-CH', 'Sec-CH-UA-Mobile, Sec-CH-UA-Platform');

  next();
}
