import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { loginUser, registerUser } from '../controllers/auth.controller';

const authRouter = Router();

/**
 * Rate Limiter estrito para a rota /api/auth/login:
 * Máximo de 5 requisições a cada 15 minutos por IP para mitigar ataques de força bruta e credential stuffing.
 */
const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: {
    error: 'TOO_MANY_LOGIN_ATTEMPTS',
    message: 'Muitas tentativas de login detectadas deste endereço IP. Aguarde 15 minutos antes de tentar novamente.',
  },
});

/**
 * Rate Limiter para o auto-cadastro público (/api/auth/register):
 * máximo de 5 solicitações por hora por IP (anti-spam / criação em massa).
 */
const registerRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: 'TOO_MANY_REGISTRATIONS',
    message: 'Muitas solicitações de cadastro deste endereço IP. Tente novamente em 1 hora.',
  },
});

authRouter.post('/register', registerRateLimiter, registerUser);
authRouter.post('/login', loginRateLimiter, loginUser);

export default authRouter;
