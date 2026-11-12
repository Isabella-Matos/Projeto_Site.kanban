// Carrega uma tarefa independente, aplica os papéis do quadro e sincroniza comentários em tempo real.
import { auth, db } from "./firebase.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  addDoc,
  collection,
  doc,
  getDoc,
  onSnapshot,
  orderBy,
  query,
  updateDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// Armazena os identificadores e listeners para operar apenas na tarefa autorizada.
const params = new URLSearchParams(window.location.search);
const boardId = params.get("board");
const taskId = params.get("id");
const state = {
  user: null,
  role: null,
  task: null,
  members: [],
  labels: [],
  checklist: [],
  dirty: false,
  taskUnsubscribe: null,
  membersUnsubscribe: null,
  commentsUnsubscribe: null
};

// Mantém atalhos de seleção e de anúncios locais simples.
const $ = id => document.getElementById(id);
let toastTimer;

// Exibe mensagens acessíveis e preserva o tempo de leitura do aviso mais recente.
function notify(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 3200);
}

// Traduz erros do Firebase sem mascarar falta de acesso ou falhas de rede.
function errorMessage(error, action) {
  if (error.code === "permission-denied") return "Você não tem permissão para fazer isso.";
  if (error.code === "unavailable" || error.code === "network-request-failed") {
    return "Sem conexão. Verifique sua internet e tente de novo.";
  }
  console.error(`Falha ao ${action}:`, error);
  return `Não foi possível ${action}. Tente novamente.`;
}

// Volta para o índice autenticado sem perder o identificador do quadro.
function boardUrl() {
  const url = new URL("index.html", window.location.href);
  if (boardId) url.searchParams.set("board", boardId);
  return url.href;
}

// Atualiza mensagens de estado e impede a exibição parcial de conteúdo não autorizado.
function showState(message, showPanel = false) {
  $("taskState").textContent = message;
  $("taskState").hidden = showPanel;
  $("taskPanel").hidden = !showPanel;
}

// Torna todos os campos e ações de escrita indisponíveis para o papel de leitor.
function applyRole() {
  const readOnly = state.role === "VIEWER";
  $("taskReadonlyBadge").hidden = !readOnly;
  ["taskTitle", "taskDescription", "taskStatus", "taskAssignee", "taskDueDate", "taskPriority", "newLabel",
    "addLabel", "newChecklistItem", "addChecklistItem", "saveTaskChanges"].forEach(id => {
    $(id).disabled = readOnly;
  });
  $("labelEntry").hidden = readOnly;
  $("checklistEntry").hidden = readOnly;
  $("saveTaskChanges").hidden = readOnly;
  $("commentForm").hidden = readOnly;
}

// Converte o valor de prioridade para um rótulo em português usado na página.
function priorityLabel(priority) {
  return ({ low: "Baixa", medium: "Média", high: "Alta" })[priority] || "Média";
}

// Aplica os dados recebidos sem sobrescrever alterações locais ainda não salvas.
function populateTask(task) {
  state.task = task;
  if (state.dirty) return;
  $("taskTitle").value = task.title || "";
  $("taskDescription").value = task.desc || "";
  $("taskStatus").value = ["todo", "doing", "done"].includes(task.status) ? task.status : "todo";
  $("taskDueDate").value = task.dueDate || "";
  $("taskPriority").value = ["low", "medium", "high"].includes(task.priority) ? task.priority : "medium";
  state.labels = Array.isArray(task.labels) ? [...task.labels] : [];
  state.checklist = Array.isArray(task.checklist)
    ? task.checklist.map(item => ({ text: String(item.text || ""), done: Boolean(item.done) }))
    : [];
  renderLabels();
  renderChecklist();
  renderAssigneeOptions();
  const badge = $("taskPriorityBadge");
  badge.textContent = priorityLabel(task.priority);
  badge.dataset.priority = task.priority || "medium";
  badge.hidden = false;
}

// Marca o formulário como alterado para que snapshots remotos não removam a edição em andamento.
function markDirty() {
  if (state.role !== "VIEWER") state.dirty = true;
}

// Renderiza labels e seus controles de remoção com nós de texto para evitar interpretação de conteúdo.
function renderLabels() {
  const container = $("taskLabels");
  container.replaceChildren();
  state.labels.forEach((label, index) => {
    const chip = document.createElement("span");
    chip.className = "task-chip";
    const text = document.createElement("span");
    text.textContent = label;
    chip.appendChild(text);
    if (state.role !== "VIEWER") {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `Remover label ${label}`);
      remove.addEventListener("click", () => {
        state.labels.splice(index, 1);
        markDirty();
        renderLabels();
      });
      chip.appendChild(remove);
    }
    container.appendChild(chip);
  });
  if (!state.labels.length) {
    const empty = document.createElement("span");
    empty.className = "task-muted";
    empty.textContent = "Nenhuma label";
    container.appendChild(empty);
  }
}

// Atualiza itens e progresso do checklist sem usar HTML construído a partir dos dados.
function renderChecklist() {
  const container = $("taskChecklist");
  container.replaceChildren();
  state.checklist.forEach((item, index) => {
    const row = document.createElement("div");
    row.className = "checklist-item";
    const label = document.createElement("label");
    label.className = "checklist-label";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = item.done;
    checkbox.disabled = state.role === "VIEWER";
    checkbox.setAttribute("aria-label", `Concluído: ${item.text}`);
    checkbox.addEventListener("change", () => {
      state.checklist[index].done = checkbox.checked;
      markDirty();
      renderChecklist();
    });
    const text = document.createElement("span");
    text.textContent = item.text;
    if (item.done) text.classList.add("checklist-done");
    label.append(checkbox, text);
    row.appendChild(label);
    if (state.role !== "VIEWER") {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "checklist-remove";
      remove.textContent = "Remover";
      remove.setAttribute("aria-label", `Remover item ${item.text}`);
      remove.addEventListener("click", () => {
        state.checklist.splice(index, 1);
        markDirty();
        renderChecklist();
      });
      row.appendChild(remove);
    }
    container.appendChild(row);
  });
  const completed = state.checklist.filter(item => item.done).length;
  $("checklistProgress").textContent = `${completed}/${state.checklist.length}`;
  $("checklistProgress").setAttribute("aria-label", `${completed} de ${state.checklist.length} itens concluídos`);
  $("checklistProgressBar").max = Math.max(state.checklist.length, 1);
  $("checklistProgressBar").value = completed;
  $("checklistProgressBar").setAttribute("aria-label", `Progresso: ${completed} de ${state.checklist.length}`);
  if (!state.checklist.length) {
    const empty = document.createElement("p");
    empty.className = "task-muted";
    empty.textContent = "Nenhum item no checklist.";
    container.appendChild(empty);
  }
}

// Mostra somente membros do quadro como opções de responsável e preserva a atribuição recebida.
function renderAssigneeOptions() {
  const select = $("taskAssignee");
  const selectedId = state.dirty ? select.value : state.task?.assigneeId || "";
  select.replaceChildren();
  const unassigned = document.createElement("option");
  unassigned.value = "";
  unassigned.textContent = "Sem responsável";
  select.appendChild(unassigned);
  state.members.forEach(member => {
    const option = document.createElement("option");
    option.value = member.uid;
    option.textContent = member.name || member.email || "Membro";
    option.selected = member.uid === selectedId;
    select.appendChild(option);
  });
  if (!selectedId) unassigned.selected = true;
}

// Escuta alterações da tarefa e apresenta seu conteúdo somente após confirmar o papel do membro.
function listenToTask() {
  const taskReference = doc(db, "boards", boardId, "tasks", taskId);
  state.taskUnsubscribe = onSnapshot(taskReference, snapshot => {
    if (!snapshot.exists()) {
      showState("Esta tarefa não existe ou foi removida.");
      return;
    }
    const task = { id: snapshot.id, ...snapshot.data() };
    populateTask(task);
    $("taskHeading").textContent = task.title || "Detalhes da tarefa";
    $("taskPageTitle").textContent = task.title ? `${task.title} | Trilha` : "Tarefa | Trilha";
    showState("", true);
  }, error => {
    const message = errorMessage(error, "carregar a tarefa");
    showState(message);
    notify(message);
  });
}

// Carrega os membros do quadro em tempo real para selecionar responsáveis e refletir nomes atualizados.
function listenToMembers() {
  state.membersUnsubscribe = onSnapshot(collection(db, "boards", boardId, "members"), snapshot => {
    state.members = snapshot.docs.map(member => ({ uid: member.id, ...member.data() }));
    renderAssigneeOptions();
  }, error => notify(errorMessage(error, "carregar os membros do quadro")));
}

// Converte valores de data/hora para formato brasileiro com proteção contra datas inválidas.
function formatCommentDate(value) {
  const date = new Date(Number(value));
  if (Number.isNaN(date.getTime())) return "Data desconhecida";
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short"
  }).format(date);
}

// Renderiza a conversa em ordem cronológica com autor, horário local e texto seguro.
function renderComments(comments) {
  const list = $("commentList");
  list.replaceChildren();
  if (!comments.length) {
    const empty = document.createElement("li");
    empty.className = "task-muted";
    empty.textContent = "Ainda não há comentários.";
    list.appendChild(empty);
    return;
  }
  comments.forEach(comment => {
    const item = document.createElement("li");
    item.className = "comment-item";
    const heading = document.createElement("div");
    heading.className = "comment-heading";
    const author = document.createElement("strong");
    author.textContent = comment.authorName || "Membro";
    const date = document.createElement("time");
    date.textContent = formatCommentDate(comment.createdAt);
    const timestamp = new Date(Number(comment.createdAt));
    if (!Number.isNaN(timestamp.getTime())) date.dateTime = timestamp.toISOString();
    heading.append(author, date);
    const text = document.createElement("p");
    text.textContent = comment.text || "";
    item.append(heading, text);
    list.appendChild(item);
  });
}

// Escuta comentários no caminho da tarefa e os ordena cronologicamente no Firestore.
function listenToComments() {
  const commentsQuery = query(
    collection(db, "boards", boardId, "tasks", taskId, "comments"),
    orderBy("createdAt", "asc")
  );
  state.commentsUnsubscribe = onSnapshot(commentsQuery, snapshot => {
    renderComments(snapshot.docs.map(comment => ({ id: comment.id, ...comment.data() })));
  }, error => notify(errorMessage(error, "carregar os comentários")));
}

// Bloqueia a página antes de consultar tarefa, membros ou comentários caso a pessoa não pertença ao quadro.
async function authorizeAndLoad(user) {
  if (!boardId || !taskId) {
    showState("Não foi possível identificar o quadro e a tarefa.");
    return;
  }
  try {
    const membership = await getDoc(doc(db, "boards", boardId, "members", user.uid));
    if (!membership.exists()) {
      showState("Você não tem acesso a este quadro.");
      return;
    }
    state.role = membership.data().role;
    if (!["OWNER", "EDITOR", "VIEWER"].includes(state.role)) {
      showState("Você não tem acesso a este quadro.");
      return;
    }
    applyRole();
    $("taskUserName").textContent = `Olá, ${user.displayName || user.email || ""}`;
    $("backToBoard").href = boardUrl();
    listenToMembers();
    listenToTask();
    listenToComments();
  } catch (error) {
    if (error.code === "permission-denied") {
      showState("Você não tem acesso a este quadro.");
      return;
    }
    showState(errorMessage(error, "verificar seu acesso"));
    notify(errorMessage(error, "verificar seu acesso"));
  }
}

// Persiste dados editáveis no documento atual sem alterar campos administrativos da tarefa.
async function saveTask(event) {
  event.preventDefault();
  if (state.role === "VIEWER" || !state.task) return;
  const title = $("taskTitle").value.trim();
  if (!title) {
    $("taskTitle").focus();
    notify("O título da tarefa é obrigatório.");
    return;
  }
  const assigneeId = $("taskAssignee").value;
  const assignee = state.members.find(member => member.uid === assigneeId);
  const changes = {
    title,
    desc: $("taskDescription").value.trim(),
    status: $("taskStatus").value,
    assigneeId,
    assigneeName: assignee ? assignee.name || assignee.email || "" : "",
    dueDate: $("taskDueDate").value,
    priority: $("taskPriority").value,
    labels: [...state.labels],
    checklist: state.checklist.map(item => ({ text: item.text, done: item.done }))
  };
  const saveButton = $("saveTaskChanges");
  saveButton.disabled = true;
  try {
    await updateDoc(doc(db, "boards", boardId, "tasks", taskId), changes);
    state.task = { ...state.task, ...changes };
    state.dirty = false;
    $("taskHeading").textContent = title;
    $("taskPageTitle").textContent = `${title} | Trilha`;
    notify("Tarefa atualizada.");
  } catch (error) {
    notify(errorMessage(error, "salvar as alterações"));
  } finally {
    saveButton.disabled = false;
  }
}

// Adiciona uma label única a partir do campo de texto e mantém a entrada acessível por teclado.
function addLabel() {
  const input = $("newLabel");
  const label = input.value.trim();
  if (!label) return;
  if (state.labels.some(existing => existing.toLocaleLowerCase("pt-BR") === label.toLocaleLowerCase("pt-BR"))) {
    notify("Essa label já foi adicionada.");
    return;
  }
  state.labels.push(label);
  input.value = "";
  markDirty();
  renderLabels();
}

// Inclui um item pendente no checklist sem enviar dados até a pessoa salvar as alterações.
function addChecklistItem() {
  const input = $("newChecklistItem");
  const text = input.value.trim();
  if (!text) return;
  state.checklist.push({ text, done: false });
  input.value = "";
  markDirty();
  renderChecklist();
}

// Registra um comentário com a identidade autenticada e horário em milissegundos.
async function addComment(event) {
  event.preventDefault();
  if (state.role === "VIEWER") return;
  const text = $("commentText").value.trim();
  if (!text) return;
  const submitButton = $("submitComment");
  submitButton.disabled = true;
  try {
    await addDoc(collection(db, "boards", boardId, "tasks", taskId, "comments"), {
      authorId: state.user.uid,
      authorName: state.user.displayName || state.user.email || "Membro",
      text,
      createdAt: Date.now()
    });
    $("commentForm").reset();
    notify("Comentário adicionado.");
  } catch (error) {
    notify(errorMessage(error, "adicionar o comentário"));
  } finally {
    submitButton.disabled = false;
  }
}

// Inicializa os formulários e deixa o observador de autenticação decidir se deve carregar ou redirecionar.
function initializeTaskPage() {
  $("taskPageTitle").textContent = "Tarefa | Trilha";
  $("backToBoard").href = boardUrl();
  $("taskForm").addEventListener("input", markDirty);
  $("taskForm").addEventListener("change", markDirty);
  $("taskForm").addEventListener("submit", saveTask);
  $("addLabel").addEventListener("click", addLabel);
  $("newLabel").addEventListener("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      addLabel();
    }
  });
  $("addChecklistItem").addEventListener("click", addChecklistItem);
  $("newChecklistItem").addEventListener("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      addChecklistItem();
    }
  });
  $("commentForm").addEventListener("submit", addComment);
  $("taskLogout").addEventListener("click", async () => {
    try {
      await signOut(auth);
      window.location.replace("index.html");
    } catch (error) {
      notify(errorMessage(error, "encerrar a sessão"));
    }
  });
  onAuthStateChanged(auth, async user => {
    if (!user) {
      try {
        sessionStorage.setItem("trilha-return-url", window.location.href);
      } catch (error) {
        console.error("Não foi possível guardar a página solicitada:", error);
      }
      window.location.replace("index.html");
      return;
    }
    state.user = user;
    $("taskLogout").hidden = false;
    await authorizeAndLoad(user);
  });
}

// Libera listeners ao sair da página para evitar atualizações em uma tela já fechada.
window.addEventListener("pagehide", () => {
  if (state.taskUnsubscribe) state.taskUnsubscribe();
  if (state.membersUnsubscribe) state.membersUnsubscribe();
  if (state.commentsUnsubscribe) state.commentsUnsubscribe();
});

initializeTaskPage();
