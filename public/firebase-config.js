// Cole aqui a configuração do app Web do seu projeto:
// Console do Firebase → ⚙️ Configurações do projeto → Seus apps → Web → "firebaseConfig"
export const firebaseConfig = {
  apiKey: 'COLE_AQUI',
  authDomain: '',
  projectId: '',
  storageBucket: '',
  messagingSenderId: '',
  appId: '',
};

// Só estas contas Google conseguem entrar (mantenha igual à lista em firestore.rules).
export const EMAILS_PERMITIDOS = [
  'fernandomendoncacintra@gmail.com',
  'EMAIL_DA_ESPOSA@gmail.com',
];
