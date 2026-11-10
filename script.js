// =====================================================================
//  KANBAN com Firebase (contas e tarefas sincronizadas entre dispositivos)
// =====================================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, updateProfile }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore, collection, doc, getDoc, setDoc, addDoc, updateDoc, deleteDoc, onSnapshot }
  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ---------------------------------------------------------------------
// 1) COLE AQUI a configuração do seu projeto Firebase
//    (Console do Firebase > Configurações do projeto > Seus apps > Web)
// ---------------------------------------------------------------------
const firebaseConfig = {
  apiKey: "AIzaSyAzN3XQazXsW5xCQR4SBRuE1KMdN9mI6kY",
  authDomain: "kanban-7994e.firebaseapp.com",
  projectId: "kanban-7994e",
  storageBucket: "kanban-7994e.firebasestorage.app",
  messagingSenderId: "851123843265",
  appId: "1:851123843265:web:50f7ce5bf4cae665876440"
};
const configured = !Object.values(firebaseConfig).some(v => v.startsWith("COLE_AQUI"));
const CONFIG_MSG = "Firebase não configurado. Cole sua configuração no início do arquivo script.js.";
let auth, db;
if (configured) { const app = initializeApp(firebaseConfig); auth = getAuth(app); db = getFirestore(app); }

// ================= UTILIDADES =================
const $ = id => document.getElementById(id);
const nameKey = n => encodeURIComponent(n.trim().toLowerCase()); // id do documento do nome de usuário

let toastTimer;
function notify(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2800);
}

function authMessage(e) {
  const m = {
    'auth/invalid-credential': 'E-mail ou senha incorretos.',
    'auth/wrong-password': 'E-mail ou senha incorretos.',
    'auth/user-not-found': 'E-mail ou senha incorretos.',
    'auth/invalid-email': 'Digite um e-mail válido.',
    'auth/email-already-in-use': 'Já existe uma conta com este e-mail. Use Entrar.',
    'auth/weak-password': 'A senha precisa ter pelo menos 6 caracteres.',
    'auth/network-request-failed': 'Sem conexão. Verifique sua internet e tente de novo.',
    'auth/too-many-requests': 'Muitas tentativas. Aguarde um pouco e tente de novo.'
  };
  return m[e.code] || 'Não foi possível concluir. Tente novamente.';
}

// ================= TELAS =================
const views = { home: $('viewHome'), login: $('viewLogin'), signup: $('viewSignup'), app: $('viewApp') };
function show(name) {
  Object.entries(views).forEach(([k, el]) => el.hidden = k !== name);
  $('loginError').textContent = $('signupError').textContent = '';
  document.querySelectorAll('[data-toggle]').forEach(b => { $(b.dataset.toggle).type = 'password'; b.textContent = 'Mostrar'; });
}
document.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => show(b.dataset.go)));

// Mostrar / ocultar senha
document.querySelectorAll('[data-toggle]').forEach(b => b.addEventListener('click', () => {
  const input = $(b.dataset.toggle), visible = input.type === 'password';
  input.type = visible ? 'text' : 'password';
  b.textContent = visible ? 'Ocultar' : 'Mostrar';
  b.setAttribute('aria-label', visible ? 'Ocultar senha' : 'Mostrar senha');
}));

// ================= CRIAR CONTA =================
$('signupForm').addEventListener('submit', async e => {
  e.preventDefault();
  const err = $('signupError'); err.textContent = '';
  if (!configured) return err.textContent = CONFIG_MSG;
  const name = $('signName').value.trim();
  const email = $('signEmail').value.trim().toLowerCase();
  const pass = $('signPass').value;
  if (!name || !email || !$('signEmail').checkValidity()) return err.textContent = 'Preencha nome e um e-mail válido.';
  if (pass.length < 6) return err.textContent = 'A senha precisa ter pelo menos 6 caracteres.';
  const btn = e.submitter; if (btn) btn.disabled = true;
  try {
    const nameRef = doc(db, 'usernames', nameKey(name));
    if ((await getDoc(nameRef)).exists()) return err.textContent = 'Este nome de usuário já está em uso. Escolha outro.';
    const cred = await createUserWithEmailAndPassword(auth, email, pass);   // a senha fica com o Firebase (nunca em texto puro)
    await updateProfile(cred.user, { displayName: name });
    await setDoc(nameRef, { email, uid: cred.user.uid });                   // permite entrar pelo nome de usuário
    $('userName').textContent = 'Olá, ' + name;
    $('signupForm').reset();
    notify('Conta criada com sucesso!');
  } catch (ex) { err.textContent = authMessage(ex); }
  finally { if (btn) btn.disabled = false; }
});

// ================= ENTRAR (e-mail ou nome de usuário) =================
$('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const err = $('loginError'); err.textContent = '';
  if (!configured) return err.textContent = CONFIG_MSG;
  const id = $('loginEmail').value.trim().toLowerCase(), pass = $('loginPass').value;
  if (!id || !pass) return err.textContent = 'Preencha o e-mail ou nome de usuário e a senha.';
  const btn = e.submitter; if (btn) btn.disabled = true;
  try {
    let email = id;
    if (!id.includes('@')) {                                  // foi digitado um nome de usuário
      const snap = await getDoc(doc(db, 'usernames', nameKey(id)));
      if (!snap.exists()) return err.textContent = 'E-mail ou senha incorretos.';
      email = snap.data().email;
    }
    await signInWithEmailAndPassword(auth, email, pass);
    $('loginForm').reset();
    notify('Login realizado com sucesso.');
  } catch (ex) { err.textContent = authMessage(ex); }
  finally { if (btn) btn.disabled = false; }
});

$('logout').addEventListener('click', async () => {
  try { await signOut(auth); } catch {}
  show('login');
  notify('Você saiu da conta.');
});

// ================= KANBAN (tarefas na nuvem, em tempo real) =================
const COLUMNS = [
  { id: 'todo',  title: 'A Fazer',      color: 'var(--todo)'  },
  { id: 'doing', title: 'Em Andamento', color: 'var(--doing)' },
  { id: 'done',  title: 'Concluído',    color: 'var(--done)'  },
];
let uid = null, tasks = [], draggedId = null, unsub = null, firstLoad = true;
const tasksCol = () => collection(db, 'users', uid, 'tasks');
const taskRef = id => doc(db, 'users', uid, 'tasks', id);
const colTitle = id => COLUMNS.find(c => c.id === id).title;

async function moveTask(id, status) {
  try { await updateDoc(taskRef(id), { status }); notify('Tarefa movida para "' + colTitle(status) + '".'); }
  catch { notify('Não foi possível mover a tarefa. Tente novamente.'); }
}
async function removeTask(id) {
  try { await deleteDoc(taskRef(id)); notify('Tarefa excluída.'); }
  catch { notify('Não foi possível excluir a tarefa. Tente novamente.'); }
}

function listen() {
  if (unsub) unsub();
  // onSnapshot atualiza o quadro sozinho quando a tarefa muda em outro dispositivo
  unsub = onSnapshot(tasksCol(), snap => {
    tasks = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    render();
  }, () => notify('Não foi possível carregar as tarefas. Verifique a conexão.'));
}

if (configured) {
  onAuthStateChanged(auth, user => {
    if (user) {
      uid = user.uid;
      $('userName').textContent = 'Olá, ' + (user.displayName || user.email);
      show('app'); listen();
    } else {
      uid = null; tasks = []; if (unsub) { unsub(); unsub = null; }
      if (firstLoad) show('home');
    }
    firstLoad = false;
  });
} else { show('home'); }

function render() {
  const board = $('board'); board.innerHTML = '';
  COLUMNS.forEach(col => {
    const items = tasks.filter(t => t.status === col.id);
    const section = document.createElement('section');
    section.className = 'column';
    section.innerHTML = `<div class="column-head"><span class="dot" style="background:${col.color}"></span><span>${col.title}</span><span class="count">${items.length}</span></div><div class="cards"></div>`;
    const list = section.querySelector('.cards');
    if (!items.length) list.innerHTML = '<div class="empty">Nenhuma tarefa aqui. Arraste um card até esta coluna.</div>';
    items.forEach(t => list.appendChild(createCard(t)));

    section.addEventListener('dragover', e => { e.preventDefault(); section.classList.add('drag-over'); });
    section.addEventListener('dragleave', e => { if (!section.contains(e.relatedTarget)) section.classList.remove('drag-over'); });
    section.addEventListener('drop', e => {
      e.preventDefault(); section.classList.remove('drag-over');
      const t = tasks.find(x => x.id === draggedId);
      if (t && t.status !== col.id) moveTask(t.id, col.id);
    });
    board.appendChild(section);
  });
}

function createCard(task) {
  const card = document.createElement('article');
  card.className = 'card'; card.draggable = true;
  const h3 = document.createElement('h3'); h3.textContent = task.title; card.appendChild(h3);
  if (task.desc) { const p = document.createElement('p'); p.textContent = task.desc; card.appendChild(p); }

  // Seletor "mover" para celulares e tablets (onde arrastar é difícil)
  const sel = document.createElement('select');
  sel.className = 'move'; sel.setAttribute('aria-label', 'Mover tarefa para outra coluna');
  COLUMNS.forEach(c => { const o = document.createElement('option'); o.value = c.id; o.textContent = c.title; o.selected = c.id === task.status; sel.appendChild(o); });
  sel.addEventListener('change', () => moveTask(task.id, sel.value));
  card.appendChild(sel);

  const del = document.createElement('button');
  del.className = 'delete'; del.innerHTML = '&times;';
  del.setAttribute('aria-label', 'Excluir tarefa ' + task.title);
  del.addEventListener('click', () => removeTask(task.id));
  card.appendChild(del);

  card.addEventListener('dragstart', e => {
    draggedId = task.id; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', task.id);
    setTimeout(() => card.classList.add('dragging'), 0);
  });
  card.addEventListener('dragend', () => card.classList.remove('dragging'));
  return card;
}

// ================= MODAL =================
const overlay = $('overlay');
const openModal = () => { overlay.classList.add('open'); $('title').focus(); };
const closeModal = () => { overlay.classList.remove('open'); $('taskForm').reset(); };
$('openModal').addEventListener('click', openModal);
$('cancel').addEventListener('click', closeModal);
overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
$('taskForm').addEventListener('submit', async e => {
  e.preventDefault();
  const title = $('title').value.trim(); if (!title) return;
  const desc = $('desc').value.trim();
  closeModal();
  try { await addDoc(tasksCol(), { title, desc, status: 'todo', createdAt: Date.now() }); notify('Tarefa adicionada.'); }
  catch { notify('Não foi possível salvar a tarefa. Tente novamente.'); }
});
