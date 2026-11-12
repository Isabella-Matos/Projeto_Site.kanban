// Implementa listas, membros, permissões e tarefas dos quadros compartilhados do Trilha.
import {
  addDoc,
  arrayRemove,
  arrayUnion,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  setDoc,
  updateDoc,
  where,
  writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// Define as colunas válidas para tarefas e mantém a mesma ordem em todas as telas.
const COLUMNS = [
  { id: "todo", title: "A Fazer", color: "var(--todo)" },
  { id: "doing", title: "Em Andamento", color: "var(--doing)" },
  { id: "done", title: "Concluído", color: "var(--done)" }
];

// Conserva em um único estado os dados da sessão e os listeners que precisam ser encerrados.
const state = {
  db: null,
  user: null,
  notify: () => {},
  boardsUnsubscribe: null,
  tasksUnsubscribe: null,
  membersUnsubscribe: null,
  boards: [],
  tasks: [],
  currentBoard: null,
  role: null,
  draggedId: null,
  editingTaskId: null,
  initialized: false,
  listRequest: 0,
  directBoardAttempt: null
};

// Simplifica a seleção de elementos usados pelo módulo.
const $ = id => document.getElementById(id);

// Converte erros do Firestore em mensagens consistentes e informa falhas inesperadas.
function errorMessage(error, action) {
  if (error.code === "permission-denied") return "Você não tem permissão para fazer isso.";
  if (error.code === "unavailable" || error.code === "network-request-failed") {
    return "Sem conexão. Verifique sua internet e tente de novo.";
  }
  console.error(`Falha ao ${action}:`, error);
  return `Não foi possível ${action}. Tente novamente.`;
}

// Controla abertura e fechamento acessível dos modais comuns da aplicação.
function setOverlay(overlay, open, initialFocusId) {
  overlay.classList.toggle("open", open);
  overlay.setAttribute("aria-hidden", String(!open));
  if (open && initialFocusId) $(initialFocusId).focus();
}

// Alterna entre a listagem de quadros e o Kanban sem ocultar o contêiner autenticado.
function showBoardsView(showBoard) {
  $("viewBoards").hidden = showBoard;
  $("viewKanban").hidden = !showBoard;
}

// Inicia listeners e eventos uma única vez, mesmo que a sessão de autenticação seja renovada.
export function initBoardUi({ db, user, notify }) {
  state.db = db;
  state.user = user;
  state.notify = notify;
  if (state.initialized) return;
  state.initialized = true;

  // Abre o formulário de criação mantendo a navegação por teclado no campo principal.
  $("openBoardModal").addEventListener("click", () => {
    setOverlay($("boardOverlay"), true, "boardNameInput");
  });
  $("cancelBoard").addEventListener("click", () => setOverlay($("boardOverlay"), false));
  $("boardOverlay").addEventListener("click", event => {
    if (event.target === $("boardOverlay")) setOverlay($("boardOverlay"), false);
  });
  $("boardForm").addEventListener("submit", createBoard);

  // Liga as ações de convite e remoção, visíveis apenas para a pessoa proprietária.
  $("shareBoard").addEventListener("click", openShareModal);
  $("closeShare").addEventListener("click", () => setOverlay($("shareOverlay"), false));
  $("shareOverlay").addEventListener("click", event => {
    if (event.target === $("shareOverlay")) setOverlay($("shareOverlay"), false);
  });
  $("inviteForm").addEventListener("submit", inviteMember);

  // Prepara o formulário de tarefas para criação e edição usando a mesma interface existente.
  $("openModal").addEventListener("click", () => openTaskModal());
  $("cancel").addEventListener("click", () => closeTaskModal());
  $("overlay").addEventListener("click", event => {
    if (event.target === $("overlay")) closeTaskModal();
  });
  $("taskForm").addEventListener("submit", saveTask);

  // Permite voltar ao índice de quadros e mantém o link direto coerente com a URL.
  $("backToBoards").addEventListener("click", () => returnToBoards(true));
  window.addEventListener("popstate", handlePopState);
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      setOverlay($("boardOverlay"), false);
      setOverlay($("shareOverlay"), false);
      closeTaskModal();
    }
  });
}

// Carrega uma vez os quadros que incluem o usuário e os separa no cliente entre próprios e compartilhados.
export function startBoardSession({ db, user, notify }) {
  state.db = db;
  state.user = user;
  state.notify = notify;
  stopBoardListeners();
  const boardsQuery = query(
    collection(db, "boards"),
    where("memberIds", "array-contains", user.uid)
  );
  state.boardsUnsubscribe = onSnapshot(boardsQuery, snapshot => {
    state.boards = snapshot.docs.map(boardDocument => ({
      id: boardDocument.id,
      ...boardDocument.data()
    }));
    renderBoardLists();
    if (state.currentBoard) {
      const current = state.boards.find(board => board.id === state.currentBoard.id);
      if (!current) returnToBoards(false);
      else state.currentBoard = current;
    }
    const requestedId = new URLSearchParams(window.location.search).get("board");
    if (requestedId && state.directBoardAttempt !== requestedId) {
      const requestedBoard = state.boards.find(board => board.id === requestedId);
      if (requestedBoard) {
        state.directBoardAttempt = requestedId;
        openBoard(requestedBoard, false);
      }
    }
  }, error => state.notify(errorMessage(error, "carregar os quadros")));
  showBoardsView(false);
}

// Encerra todos os listeners e limpa dados privados para não exibir tarefas de outra sessão.
export function stopBoardSession() {
  stopBoardListeners();
  state.boards = [];
  state.tasks = [];
  state.currentBoard = null;
  state.role = null;
  state.directBoardAttempt = null;
  $("ownedBoards").replaceChildren();
  $("sharedBoards").replaceChildren();
  $("board").replaceChildren();
  $("memberList").replaceChildren();
}

// Para os listeners que dependem do usuário ou do quadro atualmente aberto.
function stopBoardListeners() {
  if (state.boardsUnsubscribe) state.boardsUnsubscribe();
  if (state.tasksUnsubscribe) state.tasksUnsubscribe();
  if (state.membersUnsubscribe) state.membersUnsubscribe();
  state.boardsUnsubscribe = null;
  state.tasksUnsubscribe = null;
  state.membersUnsubscribe = null;
}

// Lê os papéis dos quadros próprios e compartilhados e renderiza os resultados sem HTML dinâmico.
async function renderBoardLists() {
  const requestId = ++state.listRequest;
  const owned = [];
  const shared = [];
  await Promise.all(state.boards.map(async board => {
    const isOwner = board.ownerId === state.user.uid;
    let role = isOwner ? "OWNER" : null;
    if (!isOwner) {
      try {
        const memberSnapshot = await getDoc(doc(state.db, "boards", board.id, "members", state.user.uid));
        if (memberSnapshot.exists()) role = memberSnapshot.data().role;
      } catch (error) {
        state.notify(errorMessage(error, "carregar seu papel no quadro"));
      }
    }
    const entry = { ...board, role };
    (isOwner ? owned : shared).push(entry);
  }));
  if (requestId !== state.listRequest) return;
  drawBoardList($("ownedBoards"), owned, "Você ainda não criou quadros.");
  drawBoardList($("sharedBoards"), shared, "Nenhum quadro foi compartilhado com você.");
}

// Cria cartões simples e seguros para a lista, usando textContent para nomes vindos do banco.
function drawBoardList(container, boards, emptyMessage) {
  container.replaceChildren();
  if (!boards.length) {
    const empty = document.createElement("p");
    empty.className = "list-empty";
    empty.textContent = emptyMessage;
    container.appendChild(empty);
    return;
  }
  boards.forEach(board => {
    const item = document.createElement("article");
    item.className = "board-item";
    const openButton = document.createElement("button");
    openButton.className = "board-open";
    openButton.type = "button";
    openButton.textContent = board.name || "Quadro sem nome";
    openButton.addEventListener("click", () => openBoard(board, true));
    const role = document.createElement("span");
    role.className = "role-label";
    role.textContent = roleName(board.role);
    item.append(openButton, role);
    container.appendChild(item);
  });
}

// Converte os códigos internos em rótulos legíveis na interface.
function roleName(role) {
  return ({ OWNER: "Proprietário", EDITOR: "Editor", VIEWER: "Leitor" })[role] || "Membro";
}

// Cria o documento principal antes do documento do proprietário conforme as regras de segurança.
async function createBoard(event) {
  event.preventDefault();
  const name = $("boardNameInput").value.trim();
  if (!name) return;
  const submitButton = event.submitter;
  if (submitButton) submitButton.disabled = true;
  try {
    const boardReference = await addDoc(collection(state.db, "boards"), {
      name,
      ownerId: state.user.uid,
      memberIds: [state.user.uid],
      createdAt: Date.now()
    });
    await setDoc(doc(state.db, "boards", boardReference.id, "members", state.user.uid), {
      role: "OWNER",
      name: state.user.displayName,
      email: state.user.email.toLowerCase()
    });
    $("boardForm").reset();
    setOverlay($("boardOverlay"), false);
    state.notify("Quadro criado com sucesso.");
  } catch (error) {
    state.notify(errorMessage(error, "criar o quadro"));
  } finally {
    if (submitButton) submitButton.disabled = false;
  }
}

// Confere a associação antes de abrir o quadro e liga os listeners apropriados ao papel do usuário.
async function openBoard(board, updateUrl) {
  try {
    const memberSnapshot = await getDoc(doc(state.db, "boards", board.id, "members", state.user.uid));
    if (!memberSnapshot.exists()) {
      state.notify("Você não tem permissão para fazer isso.");
      return;
    }
    state.currentBoard = board;
    state.role = memberSnapshot.data().role;
    $("currentBoardName").textContent = board.name || "Trilha";
    $("shareBoard").hidden = state.role !== "OWNER";
    $("readonlyBadge").hidden = state.role !== "VIEWER";
    $("openModal").hidden = state.role === "VIEWER";
    $("boardSubtitle").textContent = state.role === "VIEWER"
      ? "As tarefas deste quadro estão disponíveis em modo de leitura."
      : "Arraste os cards entre as colunas.";
    showBoardsView(true);
    if (updateUrl) {
      const url = new URL(window.location.href);
      url.searchParams.set("board", board.id);
      window.history.pushState({ board: board.id }, "", url);
    }
    listenToTasks(board.id);
    if (state.role === "OWNER") listenToMembers(board.id);
    else {
      if (state.membersUnsubscribe) state.membersUnsubscribe();
      state.membersUnsubscribe = null;
    }
  } catch (error) {
    state.notify(errorMessage(error, "abrir o quadro"));
  }
}

// Observa as tarefas aninhadas no quadro atual para atualizar cartões em tempo real.
function listenToTasks(boardId) {
  if (state.tasksUnsubscribe) state.tasksUnsubscribe();
  state.tasksUnsubscribe = onSnapshot(
    query(collection(state.db, "boards", boardId, "tasks"), orderBy("createdAt", "asc")),
    snapshot => {
      state.tasks = snapshot.docs.map(taskDocument => ({ id: taskDocument.id, ...taskDocument.data() }));
      renderTasks();
    },
    error => state.notify(errorMessage(error, "carregar as tarefas"))
  );
}

// Exibe as três colunas e instala alvos de arrastar somente para proprietários e editores.
function renderTasks() {
  const board = $("board");
  board.replaceChildren();
  COLUMNS.forEach(column => {
    const items = state.tasks.filter(task => task.status === column.id);
    const section = document.createElement("section");
    section.className = "column";
    const heading = document.createElement("div");
    heading.className = "column-head";
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = column.color;
    const title = document.createElement("span");
    title.textContent = column.title;
    const count = document.createElement("span");
    count.className = "count";
    count.textContent = String(items.length);
    heading.append(dot, title, count);
    const list = document.createElement("div");
    list.className = "cards";
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = state.role === "VIEWER"
        ? "Nenhuma tarefa nesta coluna."
        : "Nenhuma tarefa aqui. Arraste um card até esta coluna.";
      list.appendChild(empty);
    }
    items.forEach(task => list.appendChild(createTaskCard(task)));
    section.append(heading, list);
    if (state.role !== "VIEWER") {
      section.addEventListener("dragover", event => {
        event.preventDefault();
        section.classList.add("drag-over");
      });
      section.addEventListener("dragleave", event => {
        if (!section.contains(event.relatedTarget)) section.classList.remove("drag-over");
      });
      section.addEventListener("drop", event => {
        event.preventDefault();
        section.classList.remove("drag-over");
        const task = state.tasks.find(item => item.id === state.draggedId);
        if (task && task.status !== column.id) moveTask(task.id, column.id);
      });
    }
    board.appendChild(section);
  });
}

// Monta um cartão sem interpretar títulos e descrições como marcação HTML.
function createTaskCard(task) {
  const card = document.createElement("article");
  card.className = "card";
  card.draggable = state.role !== "VIEWER";
  const title = document.createElement("h3");
  title.textContent = task.title || "";
  card.appendChild(title);
  const taskUrl = new URL("task.html", window.location.href);
  taskUrl.searchParams.set("board", state.currentBoard.id);
  taskUrl.searchParams.set("id", task.id);
  const openLink = document.createElement("a");
  openLink.className = "open-task-link";
  openLink.href = taskUrl.href;
  openLink.target = "_blank";
  openLink.rel = "noopener";
  openLink.textContent = "Abrir ↗";
  openLink.setAttribute("aria-label", `Abrir tarefa ${task.title || ""} em nova aba`);
  card.appendChild(openLink);
  if (task.desc) {
    const description = document.createElement("p");
    description.textContent = task.desc;
    card.appendChild(description);
  }

  // Apresenta metadados mantidos pela página própria da tarefa também no quadro em tempo real.
  const metadata = document.createElement("div");
  metadata.className = "task-metadata";
  const assignee = document.createElement("span");
  assignee.className = "task-assignee";
  assignee.textContent = task.assigneeName || "Sem responsável";
  metadata.appendChild(assignee);
  const priorityNames = { low: "Baixa", medium: "Média", high: "Alta" };
  const priority = task.priority || "medium";
  const priorityBadge = document.createElement("span");
  priorityBadge.className = "priority-badge";
  priorityBadge.dataset.priority = priority;
  priorityBadge.textContent = priorityNames[priority] || "Média";
  metadata.appendChild(priorityBadge);
  const due = document.createElement("span");
  due.className = "task-due";
  if (task.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(task.dueDate)) {
    const [year, month, day] = task.dueDate.split("-");
    due.textContent = `Prazo: ${day}/${month}/${year}`;
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    if (task.dueDate < today) due.classList.add("overdue");
  } else {
    due.textContent = "Sem prazo";
  }
  metadata.appendChild(due);
  if (Array.isArray(task.labels) && task.labels.length) {
    const labels = document.createElement("div");
    labels.className = "card-labels";
    task.labels.forEach(label => {
      const chip = document.createElement("span");
      chip.className = "task-chip";
      chip.textContent = label;
      labels.appendChild(chip);
    });
    metadata.appendChild(labels);
  }
  if (Array.isArray(task.checklist) && task.checklist.length) {
    const completed = task.checklist.filter(item => item.done).length;
    const progress = document.createElement("span");
    progress.className = "card-checklist-progress";
    progress.textContent = `Checklist ${completed}/${task.checklist.length}`;
    metadata.appendChild(progress);
  }
  card.appendChild(metadata);

  // Mantém o seletor móvel de status para papéis que podem editar tarefas.
  if (state.role !== "VIEWER") {
    const selector = document.createElement("select");
    selector.className = "move";
    selector.setAttribute("aria-label", `Mover tarefa ${task.title || ""} para outra coluna`);
    COLUMNS.forEach(column => {
      const option = document.createElement("option");
      option.value = column.id;
      option.textContent = column.title;
      option.selected = column.id === task.status;
      selector.appendChild(option);
    });
    selector.addEventListener("change", () => moveTask(task.id, selector.value));
    card.appendChild(selector);

    // Exibe ações de edição e exclusão apenas para membros com permissão de escrita.
    const edit = document.createElement("button");
    edit.className = "edit-task";
    edit.type = "button";
    edit.textContent = "✎";
    edit.setAttribute("aria-label", `Editar título e descrição da tarefa ${task.title || ""}`);
    edit.addEventListener("click", () => openTaskModal(task));
    card.appendChild(edit);

    const remove = document.createElement("button");
    remove.className = "delete";
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Excluir tarefa ${task.title || ""}`);
    remove.addEventListener("click", () => removeTask(task.id));
    card.appendChild(remove);

    card.addEventListener("dragstart", event => {
      state.draggedId = task.id;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", task.id);
      setTimeout(() => card.classList.add("dragging"), 0);
    });
    card.addEventListener("dragend", () => card.classList.remove("dragging"));
  }
  return card;
}

// Atualiza o status da tarefa e informa explicitamente falhas de autorização.
async function moveTask(taskId, status) {
  if (state.role === "VIEWER" || !state.currentBoard) {
    state.notify("Você não tem permissão para fazer isso.");
    return;
  }
  const column = COLUMNS.find(item => item.id === status);
  try {
    await updateDoc(doc(state.db, "boards", state.currentBoard.id, "tasks", taskId), { status });
    state.notify(`Tarefa movida para "${column.title}".`);
  } catch (error) {
    state.notify(errorMessage(error, "mover a tarefa"));
  }
}

// Exclui uma tarefa do quadro aberto após validar o papel atual.
async function removeTask(taskId) {
  if (state.role === "VIEWER" || !state.currentBoard) {
    state.notify("Você não tem permissão para fazer isso.");
    return;
  }
  try {
    await deleteDoc(doc(state.db, "boards", state.currentBoard.id, "tasks", taskId));
    state.notify("Tarefa excluída.");
  } catch (error) {
    state.notify(errorMessage(error, "excluir a tarefa"));
  }
}

// Abre o modal para criar ou editar, preenchendo os campos quando há uma tarefa existente.
function openTaskModal(task = null) {
  if (state.role === "VIEWER") return;
  state.editingTaskId = task ? task.id : null;
  $("modalTitle").textContent = task ? "Editar tarefa" : "Nova tarefa";
  $("title").value = task ? task.title || "" : "";
  $("desc").value = task ? task.desc || "" : "";
  $("taskForm").querySelector('[type="submit"]').textContent = task ? "Salvar alterações" : "Salvar tarefa";
  setOverlay($("overlay"), true, "title");
}

// Fecha e reinicializa o formulário para que a próxima ação não reutilize dados anteriores.
function closeTaskModal() {
  setOverlay($("overlay"), false);
  $("taskForm").reset();
  $("modalTitle").textContent = "Nova tarefa";
  $("taskForm").querySelector('[type="submit"]').textContent = "Salvar tarefa";
  state.editingTaskId = null;
}

// Persiste tarefa nova ou alterada no caminho do quadro atual, nunca no perfil do usuário.
async function saveTask(event) {
  event.preventDefault();
  if (state.role === "VIEWER" || !state.currentBoard) {
    state.notify("Você não tem permissão para fazer isso.");
    return;
  }
  const title = $("title").value.trim();
  if (!title) return;
  const description = $("desc").value.trim();
  const taskCollection = collection(state.db, "boards", state.currentBoard.id, "tasks");
  try {
    if (state.editingTaskId) {
      await updateDoc(doc(taskCollection, state.editingTaskId), { title, desc: description });
      state.notify("Tarefa atualizada.");
    } else {
      await addDoc(taskCollection, {
        title,
        desc: description,
        status: "todo",
        createdAt: Date.now()
      });
      state.notify("Tarefa adicionada.");
    }
    closeTaskModal();
  } catch (error) {
    state.notify(errorMessage(error, "salvar a tarefa"));
  }
}

// Abre a administração de membros e inicia a atualização em tempo real dos papéis.
function openShareModal() {
  if (state.role !== "OWNER" || !state.currentBoard) return;
  $("inviteForm").reset();
  setOverlay($("shareOverlay"), true, "inviteEmail");
  listenToMembers(state.currentBoard.id);
}

// Consulta membros do quadro para apresentar papel e ações de remoção ao proprietário.
function listenToMembers(boardId) {
  if (state.membersUnsubscribe) state.membersUnsubscribe();
  state.membersUnsubscribe = onSnapshot(
    collection(state.db, "boards", boardId, "members"),
    snapshot => renderMembers(snapshot.docs.map(member => ({ uid: member.id, ...member.data() }))),
    error => state.notify(errorMessage(error, "carregar os membros"))
  );
}

// Exibe nomes e papéis com nós de texto e impede que o proprietário seja removido pela interface.
function renderMembers(members) {
  const list = $("memberList");
  list.replaceChildren();
  members.forEach(member => {
    const row = document.createElement("div");
    row.className = "member-row";
    const identity = document.createElement("div");
    identity.className = "member-identity";
    const name = document.createElement("strong");
    name.textContent = member.name || member.email || "Membro";
    const detail = document.createElement("span");
    detail.textContent = `${member.email || ""} · ${roleName(member.role)}`;
    identity.append(name, detail);
    row.appendChild(identity);
    if (member.role !== "OWNER") {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "btn-ghost remove-member";
      remove.textContent = "Remover";
      remove.setAttribute("aria-label", `Remover ${member.name || member.email || "membro"} do quadro`);
      remove.addEventListener("click", () => removeMember(member.uid));
      row.appendChild(remove);
    }
    list.appendChild(row);
  });
}

// Localiza usuários pelo e-mail normalizado e convida por meio de uma gravação atômica.
async function inviteMember(event) {
  event.preventDefault();
  if (state.role !== "OWNER" || !state.currentBoard) {
    state.notify("Você não tem permissão para fazer isso.");
    return;
  }
  const email = $("inviteEmail").value.trim().toLowerCase();
  const role = $("inviteRole").value;
  const submitButton = event.submitter;
  if (submitButton) submitButton.disabled = true;
  try {
    const userQuery = query(collection(state.db, "users"), where("email", "==", email));
    const userSnapshot = await getDocs(userQuery);
    if (userSnapshot.empty) {
      state.notify("Esse e-mail ainda não tem conta.");
      return;
    }
    const invitedUser = userSnapshot.docs[0].data();
    if (state.currentBoard.memberIds?.includes(invitedUser.uid)) {
      state.notify("Essa pessoa já é membro do quadro.");
      return;
    }
    const memberReference = doc(state.db, "boards", state.currentBoard.id, "members", invitedUser.uid);
    const existingMember = await getDoc(memberReference);
    if (existingMember.exists()) {
      state.notify("Essa pessoa já é membro do quadro.");
      return;
    }
    const batch = writeBatch(state.db);
    batch.set(memberReference, {
      role,
      name: invitedUser.name,
      email: invitedUser.email.toLowerCase()
    });
    batch.update(doc(state.db, "boards", state.currentBoard.id), {
      memberIds: arrayUnion(invitedUser.uid)
    });
    await batch.commit();
    $("inviteForm").reset();
    state.notify("Convite enviado com sucesso.");
  } catch (error) {
    state.notify(errorMessage(error, "convidar a pessoa"));
  } finally {
    if (submitButton) submitButton.disabled = false;
  }
}

// Remove o membro e sua associação ao quadro na mesma operação atômica.
async function removeMember(uid) {
  if (state.role !== "OWNER" || !state.currentBoard || uid === state.user.uid) {
    state.notify("Você não tem permissão para fazer isso.");
    return;
  }
  try {
    const batch = writeBatch(state.db);
    batch.delete(doc(state.db, "boards", state.currentBoard.id, "members", uid));
    batch.update(doc(state.db, "boards", state.currentBoard.id), { memberIds: arrayRemove(uid) });
    await batch.commit();
    state.notify("Membro removido do quadro.");
  } catch (error) {
    state.notify(errorMessage(error, "remover o membro"));
  }
}

// Retorna para a lista, encerra listeners do quadro e remove o parâmetro de acesso direto se solicitado.
function returnToBoards(updateUrl) {
  if (state.tasksUnsubscribe) state.tasksUnsubscribe();
  if (state.membersUnsubscribe) state.membersUnsubscribe();
  state.tasksUnsubscribe = null;
  state.membersUnsubscribe = null;
  state.currentBoard = null;
  state.role = null;
  state.tasks = [];
  $("board").replaceChildren();
  showBoardsView(false);
  if (updateUrl) {
    const url = new URL(window.location.href);
    url.searchParams.delete("board");
    window.history.pushState({}, "", url);
  }
}

// Reabre a lista ou o quadro de acordo com o histórico do navegador e o parâmetro board atual.
function handlePopState() {
  const boardId = new URLSearchParams(window.location.search).get("board");
  if (!boardId) {
    returnToBoards(false);
    return;
  }
  const board = state.boards.find(item => item.id === boardId);
  if (board) openBoard(board, false);
}
