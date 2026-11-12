// Inicializa o Firebase uma única vez para compartilhar autenticação e Firestore entre módulos.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// Mantém a configuração existente do projeto para preservar as contas e os dados atuais.
const firebaseConfig = {
  apiKey: "AIzaSyAzN3XQazXsW5xCQR4SBRuE1KMdN9mI6kY",
  authDomain: "kanban-7994e.firebaseapp.com",
  projectId: "kanban-7994e",
  storageBucket: "kanban-7994e.firebasestorage.app",
  messagingSenderId: "851123843265",
  appId: "1:851123843265:web:50f7ce5bf4cae665876440"
};

// Exporta os serviços compartilhados para autenticação e quadros.
const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
