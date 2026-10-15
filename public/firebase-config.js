// Cole aqui a configuração do app Web do seu projeto:
// Console do Firebase → ⚙️ Configurações do projeto → Seus apps → Web → "firebaseConfig"
export const firebaseConfig = {
  apiKey: 'AIzaSyCt0pEXtDiDHVKv6fDV2aBe2UJn7hR8w6M',
  authDomain: 'gastos-pessoais-8b555.firebaseapp.com',
  projectId: 'gastos-pessoais-8b555',
  storageBucket: 'gastos-pessoais-8b555.firebasestorage.app',
  messagingSenderId: '965322399313',
  appId: '1:965322399313:web:6b1c6e53e278c72423a270',
};

// Só estas contas Google conseguem entrar (mantenha igual à lista em firestore.rules).
// Para liberar outra pessoa, descomente/adicione o e-mail aqui e lá.
export const EMAILS_PERMITIDOS = [
  'fernandomendoncacintra@gmail.com',
  'gabrielagomesfran@gmail.com',
];
