import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import authRouter from './routes/auth.routes';
import clubRouter from './routes/club.routes';
import { platformDetectorMiddleware } from './middlewares/platform.middleware';

const app = express();

// 1. Headers HTTP de Segurança (CSP, HSTS, X-Frame-Options, X-Content-Type-Options)
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        objectSrc: ["'none'"],
        upgradeInsecureRequests: [],
      },
    },
  })
);

// 2. CORS restrito com suporte a Cookies HttpOnly (Web) e origens nativas (Mobile Capacitor/Expo)
app.use(
  cors({
    origin: [
      process.env.CORS_ORIGIN || 'http://localhost:3000',
      'capacitor://localhost',
      'ionic://localhost',
      'http://localhost',
    ],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Client-Platform'],
    exposedHeaders: ['X-Detected-Platform', 'X-Auth-Transport'],
  })
);

// 3. Limite de payload JSON e detecção automática de plataforma (MOBILE vs WEB)
app.use(express.json({ limit: '64kb' }));
app.use(cookieParser());
app.use(platformDetectorMiddleware);

// Endpoint de diagnóstico que retorna a detecção automática de plataforma do cliente
app.get('/api/auth/client-info', (req, res) => {
  res.json({
    endpoint: req.originalUrl,
    clientPlatform: req.clientPlatform,
  });
});

// 4. Registro de Rotas
app.use('/api/auth', authRouter);
app.use('/api/club', clubRouter);

const PORT = Number(process.env.PORT) || 4000;
app.listen(PORT, () => {
  console.log(`[Carniceiros MC API] Rodando com segurança na porta ${PORT}`);
});

export default app;
