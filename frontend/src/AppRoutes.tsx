import React from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { ProtectedRoute } from './components/ProtectedRoute';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';

// Módulos unificados do Carniceiros MC
const MembersListPage = () => <div>Lista Unificada de Integrantes (Diretoria, Full Patch e Prospects)</div>;
const EventsPage = () => <div>Agenda Carniceiros — Calendário Oficial (Reuniões Fixas Toda 2ª Terça-feira do Mês)</div>;
const SuggestionsPage = () => <div>Canal de Sugestões, Observações e Anexos</div>;
const ProfilePage = () => <div>Minha Conta: dados pessoais, moto, emergência, troca de senha e sessões</div>;
const MeetingsPage = () => <div>Assembleias: Pautas, Atas Oficiais e Check-in de Presença</div>;
const TasksPage = () => <div>Gestão de Tarefas e Missões do Moto Clube</div>;
const ForbiddenPage = () => <div>Acesso Restrito: Seu colete atual não possui permissão para este módulo.</div>;

export const AppRoutes: React.FC = () => {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Routes>
          {/* Rotas públicas */}
          <Route path="/login" element={<LoginPage />} />
          <Route path="/cadastro" element={<RegisterPage />} />
          <Route path="/acesso-restrito" element={<ForbiddenPage />} />

          {/* Rotas acessíveis por TODOS os integrantes na lista unificada */}
          <Route element={<ProtectedRoute allowedRoles={['DIRETORIA', 'MEMBRO', 'PROSPECT']} />}>
            <Route path="/integrantes" element={<MembersListPage />} />
            <Route path="/eventos" element={<EventsPage />} />
            <Route path="/sugestoes" element={<SuggestionsPage />} />
            <Route path="/perfil" element={<ProfilePage />} />
          </Route>

          {/* Rotas exclusivas de Integrantes Full Patch e Diretoria (Prospects bloqueados) */}
          <Route element={<ProtectedRoute allowedRoles={['DIRETORIA', 'MEMBRO']} />}>
            <Route path="/reunioes" element={<MeetingsPage />} />
            <Route path="/tarefas" element={<TasksPage />} />
          </Route>

          <Route path="*" element={<Navigate to="/integrantes" replace />} />
        </Routes>
      </BrowserRouter>
    </AuthProvider>
  );
};
