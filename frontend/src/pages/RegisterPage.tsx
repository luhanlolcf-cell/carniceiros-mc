import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

const API_BASE_URL = import.meta.env?.VITE_API_URL || 'http://localhost:4000/api';

const PASSWORD_RULES: Array<{ key: string; label: string; test: (v: string) => boolean }> = [
  { key: 'len', label: 'Mín. 8', test: (v) => v.length >= 8 },
  { key: 'upper', label: 'Maiúscula', test: (v) => /[A-Z]/.test(v) },
  { key: 'lower', label: 'Minúscula', test: (v) => /[a-z]/.test(v) },
  { key: 'num', label: 'Número', test: (v) => /\d/.test(v) },
  { key: 'spec', label: 'Símbolo', test: (v) => /[^A-Za-z0-9]/.test(v) },
];

interface RegisterForm {
  fullName: string;
  roadName: string;
  email: string;
  phoneWhatsapp: string;
  motorcycle: string;
  referral: string;
  emergencyContactName: string;
  emergencyContactPhone: string;
  password: string;
  confirmPassword: string;
  acceptTerms: boolean;
  website: string; // honeypot anti-bot (oculto)
}

const EMPTY: RegisterForm = {
  fullName: '', roadName: '', email: '', phoneWhatsapp: '', motorcycle: '', referral: '',
  emergencyContactName: '', emergencyContactPhone: '', password: '', confirmPassword: '',
  acceptTerms: false, website: '',
};

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '0.6rem', background: '#020203', border: '1px solid #1a1b20',
  color: '#e6e6e1', borderRadius: 4, fontSize: 13,
};

/**
 * Tela pública "Solicitar Cadastro".
 * POST /api/auth/register → usuário PROSPECT com is_active = FALSE (PENDENTE até a Diretoria aprovar).
 * Todo conteúdo é renderizado via JSX (escape automático do React → sem XSS).
 */
export const RegisterPage: React.FC = () => {
  const [form, setForm] = useState<RegisterForm>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  const rules = useMemo(() => PASSWORD_RULES.map((r) => ({ ...r, ok: r.test(form.password) })), [form.password]);
  const passwordsMatch = form.password.length > 0 && form.password === form.confirmPassword;

  const set = (field: keyof RegisterForm) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [field]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  const validate = (): string | null => {
    if (form.fullName.trim().split(/\s+/).length < 2) return 'Informe nome e sobrenome.';
    if (!/^[\p{L}\s'-]{2,30}$/u.test(form.roadName.trim())) return 'A alcunha deve ter de 2 a 30 letras.';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(form.email.trim())) return 'E-mail inválido.';
    const digits = form.phoneWhatsapp.replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 13) return 'WhatsApp inválido (DDD + número).';
    if (!form.emergencyContactName.trim() || form.emergencyContactPhone.replace(/\D/g, '').length < 10)
      return 'Contato de emergência obrigatório (nome + telefone).';
    if (!rules.every((r) => r.ok)) return 'Senha fora da política de segurança.';
    if (!passwordsMatch) return 'As senhas não conferem.';
    if (!form.acceptTerms) return 'É necessário aceitar o estatuto e o termo LGPD.';
    return null;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const v = validate();
    if (v) return setError(v);
    setError(null);
    setSubmitting(true);
    try {
      const { confirmPassword: _ignored, ...payload } = form;
      const res = await fetch(`${API_BASE_URL}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ ...payload, email: payload.email.trim().toLowerCase() }),
      });
      if (res.status === 202) {
        setForm(EMPTY);
        setDone(true);
      } else if (res.status === 429) {
        setError('Muitas solicitações deste endereço. Tente novamente em 1 hora.');
      } else {
        const body = await res.json().catch(() => ({}));
        const first = body?.details ? Object.values(body.details).flat()[0] : null;
        setError((first as string) || 'Não foi possível enviar a solicitação.');
      }
    } catch {
      setError('Falha de conexão com o servidor.');
    } finally {
      setSubmitting(false);
    }
  };

  if (done) {
    return (
      <main className="cmc-page">
        <section className="cmc-shield-card" style={{ maxWidth: 480, margin: '2rem auto', padding: '2rem', textAlign: 'center' }}>
          <div style={{ fontSize: 36 }}>⏳</div>
          <h1 style={{ fontSize: '1.1rem' }}>Solicitação enviada!</h1>
          <p style={{ color: '#8a8c94', fontSize: 13 }}>
            Sua ficha está <strong style={{ color: '#f59e0b' }}>AGUARDANDO APROVAÇÃO</strong> da Diretoria.
            Você será avisado pelo WhatsApp/e-mail. Até lá o login permanece bloqueado.
          </p>
          <Link to="/login" className="cmc-btn-primary" style={{ display: 'inline-block', marginTop: 12 }}>Ir para o Login</Link>
        </section>
      </main>
    );
  }

  const Field = (id: keyof RegisterForm, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <div>
      <label htmlFor={`reg-${id}`} style={{ display: 'block', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', color: '#8a8c94', marginBottom: 4 }}>{label}</label>
      <input id={`reg-${id}`} value={form[id] as string} onChange={set(id)} style={inputStyle} {...props} />
    </div>
  );

  return (
    <main className="cmc-page">
      <section className="cmc-shield-card" aria-labelledby="register-title" style={{ maxWidth: 620, margin: '2rem auto', padding: '2rem' }}>
        <header style={{ display: 'flex', gap: 12, alignItems: 'center', borderBottom: '1px solid #1a1b20', paddingBottom: 16, marginBottom: 16 }}>
          <img src="/assets/escudo-pr.jpg" alt="Escudo Carniceiros MC" width={56} height={56} style={{ objectFit: 'contain', border: '2px solid #6b0f1a', borderRadius: 4 }} />
          <div>
            <h1 id="register-title" style={{ margin: 0, fontSize: '1.1rem', letterSpacing: '0.1em' }}>SOLICITAR CADASTRO</h1>
            <p style={{ margin: 0, color: '#8a8c94', fontSize: 12 }}>Carniceiros MC • Curitiba • PR — entra como PENDENTE até a Diretoria aprovar</p>
          </div>
        </header>

        {error && (
          <div role="alert" style={{ border: '1px solid #6b0f1a', background: '#170306', padding: 10, borderRadius: 4, fontSize: 12, marginBottom: 12 }}>
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} noValidate autoComplete="off" style={{ display: 'grid', gap: 12 }}>
          <div aria-hidden="true" style={{ position: 'absolute', left: '-10000px' }}>
            <input tabIndex={-1} value={form.website} onChange={set('website')} autoComplete="off" />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
            {Field('fullName', 'Nome completo *', { maxLength: 80 })}
            {Field('roadName', 'Alcunha / Apelido *', { maxLength: 30 })}
            {Field('email', 'E-mail (login) *', { type: 'email', maxLength: 120 })}
            {Field('phoneWhatsapp', 'WhatsApp *', { type: 'tel', maxLength: 20 })}
            {Field('motorcycle', 'Moto (marca / modelo)', { maxLength: 50 })}
            {Field('referral', 'Indicação / Padrinho', { maxLength: 40 })}
            {Field('emergencyContactName', 'Emergência — nome *', { maxLength: 60 })}
            {Field('emergencyContactPhone', 'Emergência — telefone *', { type: 'tel', maxLength: 20 })}
            {Field('password', 'Senha *', { type: 'password', maxLength: 128 })}
            {Field('confirmPassword', 'Confirmar senha *', { type: 'password', maxLength: 128 })}
          </div>

          <ul style={{ display: 'flex', flexWrap: 'wrap', gap: 10, listStyle: 'none', padding: 8, margin: 0, background: '#020203', border: '1px solid #15161b', borderRadius: 4, fontSize: 12, fontFamily: 'monospace' }}>
            {rules.map((r) => (
              <li key={r.key} style={{ color: r.ok ? '#10b981' : '#8a8c94' }}>{r.ok ? '✓' : '○'} {r.label}</li>
            ))}
            <li style={{ color: passwordsMatch ? '#10b981' : '#8a8c94' }}>{passwordsMatch ? '✓' : '○'} Confere</li>
          </ul>

          <label style={{ display: 'flex', gap: 8, fontSize: 12, color: '#8a8c94' }}>
            <input type="checkbox" checked={form.acceptTerms} onChange={set('acceptTerms')} />
            Li o estatuto do Carniceiros MC e autorizo o uso dos meus dados apenas para gestão interna do clube (LGPD).
          </label>

          <div style={{ display: 'flex', gap: 8 }}>
            <Link to="/login" style={{ padding: '0.6rem 1rem', border: '1px solid #1a1b20', borderRadius: 4, color: '#8a8c94', fontSize: 12 }}>‹ Voltar</Link>
            <button type="submit" disabled={submitting} className="cmc-btn-primary" style={{ flex: 1 }}>
              {submitting ? 'Enviando...' : 'Enviar Solicitação à Diretoria'}
            </button>
          </div>
        </form>
      </section>
    </main>
  );
};
