// Controla autenticação, perfil do usuário e navegação entre as telas principais do Trilha.
import { auth, db } from "./firebase.js";
import {
  onAuthStateChanged,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  updateProfile
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { doc, getDoc, setDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { initBoardUi, startBoardSession, stopBoardSession } from "./board.js";

// Centraliza acesso aos elementos para manter os manipuladores concisos.
const $ = id => document.getElementById(id);

// Preserva o toast acessível e substitui seu temporizador quando uma mensagem nova chega.
let toastTimer;
function notify(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2800);
}

// Traduz erros do Firebase para mensagens úteis sem ocultar falhas de permissão.
function authMessage(error) {
  const messages = {
    "auth/invalid-credential": "E-mail ou senha incorretos.",
    "auth/wrong-password": "E-mail ou senha incorretos.",
    "auth/user-not-found": "E-mail ou senha incorretos.",
    "auth/invalid-email": "Digite um e-mail válido.",
    "auth/email-already-in-use": "Já existe uma conta com este e-mail. Use Entrar.",
    "auth/weak-password": "A senha precisa ter pelo menos 6 caracteres.",
    "auth/network-request-failed": "Sem conexão. Verifique sua internet e tente de novo.",
    "auth/too-many-requests": "Muitas tentativas. Aguarde um pouco e tente de novo.",
    "permission-denied": "Você não tem permissão para fazer isso."
  };
  return messages[error.code] || "Não foi possível concluir. Tente novamente.";
}

// Mantém os dados pesquisáveis do usuário sincronizados sem guardar credenciais no Firestore.
async function saveUserProfile(user, preferredName) {
  const email = (user.email || "").toLowerCase();
  const name = preferredName || user.displayName || email.split("@")[0];
  await setDoc(doc(db, "users", user.uid), { name, email, uid: user.uid }, { merge: true });
  return name;
}

// Controla a navegação de autenticação sem recriar formulários ou perder acessibilidade.
const views = {
  home: $("viewHome"),
  login: $("viewLogin"),
  signup: $("viewSignup"),
  app: $("viewApp")
};
function show(viewName) {
  document.body.classList.toggle("in-app", viewName === "app");
  Object.entries(views).forEach(([name, element]) => {
    element.hidden = name !== viewName;
  });
  $("loginError").textContent = "";
  $("signupError").textContent = "";
  document.querySelectorAll("[data-toggle]").forEach(button => {
    $(button.dataset.toggle).type = "password";
    button.textContent = "Mostrar";
  });
}

// Liga os controles existentes às telas de entrada e cadastro.
document.querySelectorAll("[data-go]").forEach(button => {
  button.addEventListener("click", () => show(button.dataset.go));
});

// Permite revelar a senha apenas na tela, mantendo o Firebase como único responsável pela credencial.
document.querySelectorAll("[data-toggle]").forEach(button => {
  button.addEventListener("click", () => {
    const input = $(button.dataset.toggle);
    const visible = input.type === "password";
    input.type = visible ? "text" : "password";
    button.textContent = visible ? "Ocultar" : "Mostrar";
    button.setAttribute("aria-label", visible ? "Ocultar senha" : "Mostrar senha");
  });
});

// Cria a conta, mantém login por nome de usuário e grava o perfil público no documento users.
$("signupForm").addEventListener("submit", async event => {
  event.preventDefault();
  const errorElement = $("signupError");
  errorElement.textContent = "";
  const name = $("signName").value.trim();
  const email = $("signEmail").value.trim().toLowerCase();
  const password = $("signPass").value;
  if (!name || !email || !$("signEmail").checkValidity()) {
    errorElement.textContent = "Preencha nome e um e-mail válido.";
    return;
  }
  if (password.length < 6) {
    errorElement.textContent = "A senha precisa ter pelo menos 6 caracteres.";
    return;
  }

  const button = event.submitter;
  if (button) button.disabled = true;
  try {
    const usernameId = encodeURIComponent(name.toLowerCase());
    const usernameRef = doc(db, "usernames", usernameId);
    if ((await getDoc(usernameRef)).exists()) {
      errorElement.textContent = "Este nome de usuário já está em uso. Escolha outro.";
      return;
    }
    const credential = await createUserWithEmailAndPassword(auth, email, password);
    await updateProfile(credential.user, { displayName: name });
    await setDoc(usernameRef, { email, uid: credential.user.uid });
    await saveUserProfile(credential.user, name);
    $("userName").textContent = `Olá, ${name}`;
    $("kanbanUserName").textContent = `Olá, ${name}`;
    $("signupForm").reset();
    notify("Conta criada com sucesso!");
  } catch (error) {
    errorElement.textContent = authMessage(error);
  } finally {
    if (button) button.disabled = false;
  }
});

// Aceita e-mail ou nome de usuário e mescla o perfil para contas existentes sem documento users.
$("loginForm").addEventListener("submit", async event => {
  event.preventDefault();
  const errorElement = $("loginError");
  errorElement.textContent = "";
  const identifier = $("loginEmail").value.trim().toLowerCase();
  const password = $("loginPass").value;
  if (!identifier || !password) {
    errorElement.textContent = "Preencha o e-mail ou nome de usuário e a senha.";
    return;
  }

  const button = event.submitter;
  if (button) button.disabled = true;
  try {
    let email = identifier;
    if (!identifier.includes("@")) {
      const usernameId = encodeURIComponent(identifier);
      const usernameSnapshot = await getDoc(doc(db, "usernames", usernameId));
      if (!usernameSnapshot.exists()) {
        errorElement.textContent = "E-mail ou senha incorretos.";
        return;
      }
      email = usernameSnapshot.data().email;
    }
    const credential = await signInWithEmailAndPassword(auth, email, password);
    await saveUserProfile(credential.user);
    $("loginForm").reset();
    notify("Login realizado com sucesso.");
  } catch (error) {
    errorElement.textContent = authMessage(error);
  } finally {
    if (button) button.disabled = false;
  }
});

// Encerra a sessão e deixa o observador limpar listeners e estados dos quadros.
async function logout() {
  try {
    await signOut(auth);
    notify("Você saiu da conta.");
  } catch (error) {
    notify(authMessage(error));
  }
}
$("logout").addEventListener("click", logout);
$("logoutBoard").addEventListener("click", logout);

// Mantém a aplicação sincronizada com a autenticação inclusive após atualização ou link direto.
let firstAuthCheck = true;
onAuthStateChanged(auth, async user => {
  if (user) {
    try {
      const name = await saveUserProfile(user);
      const sessionUser = { uid: user.uid, email: user.email || "", displayName: name };
      $("userName").textContent = `Olá, ${name}`;
      $("kanbanUserName").textContent = `Olá, ${name}`;
      show("app");
      initBoardUi({ db, user: sessionUser, notify });
      startBoardSession({ db, user: sessionUser, notify });
    } catch (error) {
      notify(authMessage(error));
      show("login");
    }
  } else {
    stopBoardSession();
    if (firstAuthCheck) show("home");
    else show("login");
  }
  firstAuthCheck = false;
});
