import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'br.com.carniceirosmc.app',
  appName: 'Carniceiros MC',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    iosScheme: 'https',
    allowNavigation: ['api.carniceirosmc.com.br'],
  },
  plugins: {
    CapacitorCookies: {
      enabled: true,
    },
    SplashScreen: {
      launchShowDuration: 2000,
      backgroundColor: '#09090B',
      showSpinner: false,
    },
  },
};

export default config;
