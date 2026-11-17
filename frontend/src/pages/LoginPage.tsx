import React, { useState, FormEvent } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import '../styles/carniceiros-mc.css';

export const LoginPage: React.FC = () => {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const fromPath = (location.state as any)?.from?.pathname || '/eventos';

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setErrorMessage(null);
    setIsSubmitting(true);

    try {
      await login(email.trim(), password);
      navigate(fromPath, { replace: true });
    } catch (err: any) {
      setErrorMessage(err.message || 'Credenciais inválidas ou acesso bloqueado pelo Sargento de Armas.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <main className="cmc-auth-container">
      <section className="cmc-shield-card" aria-labelledby="login-title" style={{ maxWidth: 440, margin: '2rem auto', padding: '2rem' }}>
        <header style={{ textAlign: 'center', marginBottom: '1.5rem' }}>
          {/* Brasão Oficial Carniceiros MC - Curitiba PR */}
          <div style={{ display: 'flex', justifyContent: 'center', gap: '1rem', marginBottom: '1rem' }}>
            <img
              src="/assets/brasao-rocker.png"
              alt="Brasão 3 Peças Carniceiros MC Curitiba"
              style={{ width: 110, height: 110, objectFit: 'contain', borderRadius: 8, border: '2px solid #6b0f1a', background: '#030304' }}
            />
            <img
              src="/assets/escudo-pr.jpg"
              alt="Escudo Rebitado Carniceiros MC PR BR"
              style={{ width: 110, height: 110, objectFit: 'contain', borderRadius: 8, border: '2px solid #1f2026', background: '#030304' }}
            />
          </div>

          <div className="cmc-rocker-banner" style={{ padding: '0.45rem 1rem', borderRadius: 4, display: 'inline-block' }}>
            <h1 id="login-title" style={{ margin: 0, fontSize: '1.25rem' }}>
              CARNICEIROS <span className="cmc-mc-cube">MC</span>
            </h1>
          </div>
          <p style={{ marginTop: '0.5rem', fontSize: '0.78rem', color: '#8e9099', letterSpacing: '0.16em', textTransform: 'uppercase' }}>
            Curitiba • PR • Brasil — Comando &amp; Irmandade
          </p>
        </header>

        {errorMessage && (
          <div role="alert" style={{ background: '#1c0408', border: '1px solid #6b0f1a', color: '#e6e6e1', padding: '0.75rem', borderRadius: 4, marginBottom: '1rem', fontSize: '0.8rem' }}>
            {errorMessage}
          </div>
        )}

        <form onSubmit={handleSubmit} noValidate style={{ display: 'grid', gap: '1rem' }}>
          <div>
            <label htmlFor="cmc-email" style={{ display: 'block', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4, color: '#8e9099' }}>
              E-mail do Integrante / Alcunha
            </label>
            <input
              id="cmc-email"
              type="email"
              autoComplete="username"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="corvo@carniceirosmc.com.br"
              style={{ width: '100%', padding: '0.6rem', background: '#020203', border: '1px solid #1f2026', color: '#e6e6e1', borderRadius: 4 }}
            />
          </div>

          <div>
            <label htmlFor="cmc-password" style={{ display: 'block', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4, color: '#8e9099' }}>
              Senha Forte do Colete
            </label>
            <input
              id="cmc-password"
              type="password"
              autoComplete="current-password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••••••"
              style={{ width: '100%', padding: '0.6rem', background: '#020203', border: '1px solid #1f2026', color: '#e6e6e1', borderRadius: 4 }}
            />
          </div>

          <button
            id="cmc-login-submit"
            type="submit"
            disabled={isSubmitting}
            className="cmc-btn-primary"
          >
            {isSubmitting ? 'Validando Patch...' : 'Entrar na Sede Digital'}
          </button>
        </form>

        <p style={{ marginTop: 16, fontSize: 12, color: '#8a8c94', textAlign: 'center' }}>
          Ainda não tem acesso? <Link to="/cadastro" style={{ color: '#9e2232', fontWeight: 700 }}>Solicitar Cadastro</Link>
        </p>
      </section>
    </main>
  );
};
