import React from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { ClubRole, useAuth } from '../context/AuthContext';

interface ProtectedRouteProps {
  allowedRoles: ClubRole[];
}

/**
 * Guardião de Rotas no Front-end (RBAC):
 * 1. Exibe estado de carregamento enquanto valida a sessão via Cookie HttpOnly.
 * 2. Redireciona para /login caso não esteja autenticado, preservando a rota de origem.
 * 3. Bloqueia e redireciona para /acesso-restrito caso a role do membro não esteja em `allowedRoles`.
 */
export const ProtectedRoute: React.FC<ProtectedRouteProps> = ({ allowedRoles }) => {
  const { user, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return (
      <div className="cmc-loading-screen" role="status" aria-live="polite">
        <span>Verificando credenciais do Carniceiros MC...</span>
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  if (!allowedRoles.includes(user.role)) {
    // Prospect tentando acessar Reuniões/Atas ou Membro tentando acessar Painel da Diretoria
    return <Navigate to="/acesso-restrito" replace />;
  }

  return <Outlet />;
};
