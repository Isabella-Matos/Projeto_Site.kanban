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
  members: [],
  filters: { priority: "", label: "", assignee: "" },
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

  // Mantém a configuração de limites e Definition of Done restrita ao proprietário.
  $("openBoardSettings").addEventListener("click", openSettingsModal);
  $("cancelSettings").addEventListener("click", () => setOverlay($("settingsOverlay"), false));
  $("settingsOverlay").addEventListener("click", event => {
    if (event.target === $("settingsOverlay")) setOverlay($("settingsOverlay"), false);
  });
  $("settingsForm").addEventListener("submit", saveBoardSettings);

  // Aplica filtros somente à renderização e preserva a escuta Firestore sem filtros.
  ["filterPriority", "filterLabel", "filterAssignee"].forEach(id => {
    $(id).addEventListener("change", () => {
      state.filters = {
        priority: $("filterPriority").value,
        label: $("filterLabel").value,
        assignee: $("filterAssignee").value
      };
      renderTasks();
    });
  });
  $("clearBoardFilters").addEventListener("click", clearBoardFilters);

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
      setOverlay($("settingsOverlay"), false);
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
      else {
        state.currentBoard = current;
        renderTasks();
      }
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
  state.members = [];
  state.filters = { priority: "", label: "", assignee: "" };
  state.currentBoard = null;
  state.role = null;
  state.directBoardAttempt = null;
  $("ownedBoards").replaceChildren();
  $("sharedBoards").replaceChildren();
  $("board").replaceChildren();
  $("memberList").replaceChildren();
  resetBoardFilters();
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
      wip: { todo: 0, doing: 3, done: 0 },
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
    $("openBoardSettings").hidden = state.role !== "OWNER";
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
    state.filters = { priority: "", label: "", assignee: "" };
    resetBoardFilters();
    listenToMembers(board.id);
  } catch (error) {
    state.notify(errorMessage(error, "abrir o quadro"));
  }
}

// Converte limites recebidos do Firestore em inteiros válidos e usa o padrão da interface para dados antigos.
function boardWip(board = state.currentBoard) {
  const saved = board?.wip || {};
  return {
    todo: Number.isInteger(Number(saved.todo)) && Number(saved.todo) >= 0 ? Number(saved.todo) : 0,
    doing: Number.isInteger(Number(saved.doing)) && Number(saved.doing) >= 0 ? Number(saved.doing) : 3,
    done: Number.isInteger(Number(saved.done)) && Number(saved.done) >= 0 ? Number(saved.done) : 0
  };
}

// Abre as configurações já preenchidas, evitando substituir limites que já estejam salvos.
function openSettingsModal() {
  if (state.role !== "OWNER" || !state.currentBoard) return;
  const wip = boardWip();
  $("wipTodo").value = String(wip.todo);
  $("wipDoing").value = String(wip.doing);
  $("wipDone").value = String(wip.done);
  $("definitionOfDone").value = state.currentBoard.definitionOfDone || "";
  setOverlay($("settingsOverlay"), true, "wipTodo");
}

// Valida os três números e grava WIP e Definition of Done sem modificar outros campos do quadro.
async function saveBoardSettings(event) {
  event.preventDefault();
  if (state.role !== "OWNER" || !state.currentBoard) {
    state.notify("Você não tem permissão para fazer isso.");
    return;
  }
  const values = {
    todo: $("wipTodo").valueAsNumber,
    doing: $("wipDoing").valueAsNumber,
    done: $("wipDone").valueAsNumber
  };
  if (Object.values(values).some(value => !Number.isInteger(value) || value < 0)) {
    state.notify("Os limites de WIP devem ser números inteiros iguais ou maiores que zero.");
    return;
  }
  const button = event.submitter;
  if (button) button.disabled = true;
  try {
    const definitionOfDone = $("definitionOfDone").value.trim();
    await updateDoc(doc(state.db, "boards", state.currentBoard.id), {
      wip: values,
      definitionOfDone
    });
    state.currentBoard = { ...state.currentBoard, wip: values, definitionOfDone };
    setOverlay($("settingsOverlay"), false);
    renderTasks();
    state.notify("Configurações do quadro salvas.");
  } catch (error) {
    state.notify(errorMessage(error, "salvar as configurações do quadro"));
  } finally {
    if (button) button.disabled = false;
  }
}

// Recria as opções dos filtros usando labels e membros já sincronizados no quadro.
function renderBoardFilters() {
  const labelSelect = $("filterLabel");
  const selectedLabel = state.filters.label;
  const labels = [...new Set(state.tasks.flatMap(task => Array.isArray(task.labels) ? task.labels : []))]
    .sort((left, right) => left.localeCompare(right, "pt-BR"));
  labelSelect.replaceChildren();
  const allLabels = document.createElement("option");
  allLabels.value = "";
  allLabels.textContent = "Todas";
  labelSelect.appendChild(allLabels);
  labels.forEach(label => {
    const option = document.createElement("option");
    option.value = label;
    option.textContent = label;
    labelSelect.appendChild(option);
  });
  labelSelect.value = labels.includes(selectedLabel) ? selectedLabel : "";
  state.filters.label = labelSelect.value;

  const assigneeSelect = $("filterAssignee");
  const selectedAssignee = state.filters.assignee;
  assigneeSelect.replaceChildren();
  const allAssignees = document.createElement("option");
  allAssignees.value = "";
  allAssignees.textContent = "Todos";
  assigneeSelect.appendChild(allAssignees);
  const memberOptions = state.members.filter(member => member.uid);
  memberOptions.forEach(member => {
    const option = document.createElement("option");
    option.value = member.uid;
    option.textContent = member.name || member.email || "Membro";
    assigneeSelect.appendChild(option);
  });
  const unassigned = document.createElement("option");
  unassigned.value = "__unassigned";
  unassigned.textContent = "Sem responsável";
  assigneeSelect.appendChild(unassigned);
  assigneeSelect.value = memberOptions.some(member => member.uid === selectedAssignee)
    || selectedAssignee === "__unassigned" ? selectedAssignee : "";
  state.filters.assignee = assigneeSelect.value;
}

// Restaura os filtros ao estado inicial quando o quadro muda ou quando a pessoa pede para limpar.
function resetBoardFilters() {
  if (!$("filterPriority")) return;
  $("filterPriority").value = "";
  $("filterLabel").value = "";
  $("filterAssignee").value = "";
  state.filters = { priority: "", label: "", assignee: "" };
}

// Remove filtros ativos e redesenha os cartões sem alterar seu estado salvo.
function clearBoardFilters() {
  resetBoardFilters();
  renderTasks();
}

// Confere a capacidade da coluna antes de qualquer movimentação feita pelo Kanban.
function isWipFull(status, movingTaskId) {
  const limit = boardWip()[status];
  if (!limit) return false;
  const count = state.tasks.filter(task => task.status === status && task.id !== movingTaskId).length;
  return count >= limit;
}

// Observa as tarefas aninhadas no quadro atual para atualizar cartões em tempo real.
function listenToTasks(boardId) {
  if (state.tasksUnsubscribe) state.tasksUnsubscribe();
  state.tasksUnsubscribe = onSnapshot(
    query(collection(state.db, "boards", boardId, "tasks"), orderBy("createdAt", "asc")),
    snapshot => {
      state.tasks = snapshot.docs.map(taskDocument => ({ id: taskDocument.id, ...taskDocument.data() }));
      renderBoardFilters();
      renderTasks();
    },
    error => state.notify(errorMessage(error, "carregar as tarefas"))
  );
}

// Exibe as três colunas e instala alvos de arrastar somente para proprietários e editores.
function renderTasks() {
  const board = $("board");
  board.replaceChildren();
  const limits = boardWip();
  COLUMNS.forEach(column => {
    const columnTasks = state.tasks.filter(task => task.status === column.id);
    const items = columnTasks.filter(matchesBoardFilters);
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
    const limit = limits[column.id];
    count.textContent = limit ? `${columnTasks.length}/${limit}` : String(columnTasks.length);
    count.setAttribute("aria-label", limit
      ? `${columnTasks.length} tarefas de limite ${limit}`
      : `${columnTasks.length} tarefas`);
    if (limit && columnTasks.length >= limit) count.classList.add("wip-reached");
    heading.append(dot, title, count);
    const list = document.createElement("div");
    list.className = "cards";
    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = state.filters.priority || state.filters.label || state.filters.assignee
        ? "Nenhuma tarefa corresponde aos filtros."
        : state.role === "VIEWER"
        ? "Nenhuma tarefa nesta coluna."
        : "Nenhuma tarefa aqui. Arraste um card até esta coluna.";
      list.appendChild(empty);
    }
    items.forEach(task => list.appendChild(createTaskCard(task)));
    section.append(heading, list);
    if (state.role !== "VIEWER") {
      section.addEventListener("dragover", event => {
        event.preventDefault();
        if (isWipFull(column.id, state.draggedId)) {
          section.classList.add("wip-blocked");
          return;
        }
        section.classList.add("drag-over");
      });
      section.addEventListener("dragleave", () => {
        section.classList.remove("drag-over", "wip-blocked");
      });
      section.addEventListener("drop", event => {
        event.preventDefault();
        section.classList.remove("drag-over", "wip-blocked");
        const task = state.tasks.find(item => item.id === state.draggedId);
        if (task && task.status !== column.id) moveTask(task.id, column.id);
      });
    }
    board.appendChild(section);
  });
}

// Combina os filtros ativos para exibir cartões sem interferir na contagem real de WIP.
function matchesBoardFilters(task) {
  const priority = task.priority || "medium";
  if (state.filters.priority && priority !== state.filters.priority) return false;
  if (state.filters.label && !(Array.isArray(task.labels) && task.labels.includes(state.filters.label))) return false;
  if (state.filters.assignee === "__unassigned" && task.assigneeId) return false;
  if (state.filters.assignee && state.filters.assignee !== "__unassigned"
    && task.assigneeId !== state.filters.assignee) return false;
  return true;
}

// Monta um cartão compacto sem interpretar títulos, descrições ou labels como HTML.
function createTaskCard(task) {
  const card = document.createElement("article");
  card.className = "card";
  card.draggable = state.role !== "VIEWER";

  // Mantém ações compactas no topo do cartão e textos acessíveis nos controles de ícone.
  const actions = document.createElement("div");
  actions.className = "card-actions";
  const taskUrl = new URL("task.html", window.location.href);
  taskUrl.searchParams.set("board", state.currentBoard.id);
  taskUrl.searchParams.set("id", task.id);
  const openLink = document.createElement("a");
  openLink.className = "card-icon-action";
  openLink.href = taskUrl.href;
  openLink.target = "_blank";
  openLink.rel = "noopener";
  openLink.textContent = "↗";
  openLink.title = "Abrir tarefa em nova aba";
  openLink.setAttribute("aria-label", `Abrir tarefa ${task.title || ""} em nova aba`);
  actions.appendChild(openLink);
  if (state.role !== "VIEWER") {
    const edit = document.createElement("button");
    edit.className = "card-icon-action";
    edit.type = "button";
    edit.textContent = "✎";
    edit.title = "Editar tarefa";
    edit.setAttribute("aria-label", `Editar título e descrição da tarefa ${task.title || ""}`);
    edit.addEventListener("click", () => openTaskModal(task));
    actions.appendChild(edit);

    const remove = document.createElement("button");
    remove.className = "card-icon-action card-delete-action";
    remove.type = "button";
    remove.textContent = "×";
    remove.title = "Excluir tarefa";
    remove.setAttribute("aria-label", `Excluir tarefa ${task.title || ""}`);
    remove.addEventListener("click", () => removeTask(task.id));
    actions.appendChild(remove);
  }
  card.appendChild(actions);

  // Exibe até três labels na capa e resume as restantes para manter o cartão compacto.
  if (Array.isArray(task.labels) && task.labels.length) {
    const labels = document.createElement("div");
    labels.className = "card-labels";
    task.labels.slice(0, 3).forEach(label => {
      const chip = document.createElement("span");
      chip.className = `task-chip ${labelColorClass(label)}`;
      chip.textContent = label;
      labels.appendChild(chip);
    });
    if (task.labels.length > 3) {
      const extra = document.createElement("span");
      extra.className = "task-chip label-overflow";
      extra.textContent = `+${task.labels.length - 3}`;
      extra.setAttribute("aria-label", `${task.labels.length - 3} labels adicionais`);
      labels.appendChild(extra);
    }
    card.appendChild(labels);
  }

  // Limita títulos extensos a duas linhas sem alterar o texto salvo no Firestore.
  const title = document.createElement("h3");
  title.textContent = task.title || "";
  card.appendChild(title);
  if (task.desc) {
    const description = document.createElement("p");
    description.textContent = task.desc;
    card.appendChild(description);
  }

  // Resume prioridade e prazo em uma linha, destacando prazo vencido apenas em tarefas abertas.
  const info = document.createElement("div");
  info.className = "card-info";
  const priorityNames = { low: "Baixa", medium: "Média", high: "Alta" };
  const priority = task.priority || "medium";
  card.dataset.priority = priority;
  const priorityLabel = document.createElement("span");
  priorityLabel.className = "card-priority";
  priorityLabel.dataset.priority = priority;
  const priorityDot = document.createElement("span");
  priorityDot.className = "priority-dot";
  priorityDot.setAttribute("aria-hidden", "true");
  const priorityText = document.createElement("span");
  priorityText.textContent = priorityNames[priority] || "Média";
  priorityLabel.append(priorityDot, priorityText);
  info.appendChild(priorityLabel);
  const storyPoints = [1, 2, 3, 5, 8, 13].includes(Number(task.storyPoints))
    ? Number(task.storyPoints) : 1;
  const points = document.createElement("span");
  points.className = "story-points-chip";
  points.textContent = `${storyPoints} pts`;
  points.setAttribute("aria-label", `${storyPoints} story points`);
  info.appendChild(points);

  const due = document.createElement("span");
  due.className = "task-due";
  if (task.dueDate && /^\d{4}-\d{2}-\d{2}$/.test(task.dueDate)) {
    const [year, month, day] = task.dueDate.split("-");
    due.classList.add("has-due-date");
    due.setAttribute("aria-label", `Prazo: ${day}/${month}/${year}`);
    const calendar = document.createElement("span");
    calendar.textContent = "▦";
    calendar.setAttribute("aria-hidden", "true");
    const dateText = document.createElement("span");
    dateText.textContent = `${day}/${month}`;
    due.append(calendar, dateText);
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    if (task.dueDate < today && task.status !== "done") due.classList.add("overdue");
  } else {
    due.classList.add("no-due-date");
    due.textContent = "Sem prazo";
  }
  info.appendChild(due);
  card.appendChild(info);

  // Agrupa responsável e progresso no rodapé, usando avatar de cor estável para cada nome.
  const footer = document.createElement("div");
  footer.className = "card-footer";
  const assignee = document.createElement("div");
  assignee.className = "card-assignee";
  if (task.assigneeName) {
    const avatar = document.createElement("span");
    avatar.className = "assignee-avatar";
    avatar.textContent = assigneeInitials(task.assigneeName);
    avatar.style.setProperty("--avatar-color", assigneeColor(task.assigneeName));
    avatar.setAttribute("aria-hidden", "true");
    const name = document.createElement("span");
    name.className = "assignee-name";
    name.textContent = firstName(task.assigneeName);
    name.title = task.assigneeName;
    assignee.append(avatar, name);
  } else {
    assignee.classList.add("unassigned");
    assignee.textContent = "Sem responsável";
  }
  footer.appendChild(assignee);
  if (Array.isArray(task.checklist) && task.checklist.length) {
    const completed = task.checklist.filter(item => item.done).length;
    const progress = document.createElement("div");
    progress.className = "card-checklist";
    const bar = document.createElement("span");
    bar.className = "card-checklist-bar";
    const fill = document.createElement("span");
    fill.className = "card-checklist-fill";
    fill.style.width = `${Math.round((completed / task.checklist.length) * 100)}%`;
    bar.appendChild(fill);
    const progressText = document.createElement("span");
    progressText.textContent = `${completed}/${task.checklist.length}`;
    progress.append(bar, progressText);
    progress.setAttribute("aria-label", `Checklist: ${completed} de ${task.checklist.length} itens concluídos`);
    footer.appendChild(progress);
  }
  card.appendChild(footer);

  // Mantém o seletor de mudança de coluna no rodapé, inclusive em telas pequenas.
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

// Converte rótulos conhecidos em classes visuais sem reutilizar texto de usuário como CSS.
function labelColorClass(label) {
  const normalized = String(label).trim().toLocaleLowerCase("pt-BR");
  if (normalized === "bug") return "label-bug";
  if (normalized === "feature") return "label-feature";
  if (normalized === "urgente") return "label-urgent";
  return "label-neutral";
}

// Exibe somente o primeiro nome no rodapé para reduzir a largura ocupada pelo responsável.
function firstName(name) {
  return String(name).trim().split(/\s+/)[0] || "";
}

// Deriva até duas iniciais do nome para identificação visual sem dependência de imagens.
function assigneeInitials(name) {
  return String(name).trim().split(/\s+/).filter(Boolean).slice(0, 2)
    .map(part => part.charAt(0).toLocaleUpperCase("pt-BR")).join("");
}

// Deriva uma cor estável para cada nome sem persistir campos adicionais no Firestore.
function assigneeColor(name) {
  let hash = 0;
  for (const character of String(name).toLocaleLowerCase("pt-BR")) {
    hash = (hash * 31 + character.codePointAt(0)) >>> 0;
  }
  return `hsl(${hash % 360} 48% 42%)`;
}

// Atualiza o status da tarefa e informa explicitamente falhas de autorização.
async function moveTask(taskId, status) {
  if (state.role === "VIEWER" || !state.currentBoard) {
    state.notify("Você não tem permissão para fazer isso.");
    return;
  }
  const task = state.tasks.find(item => item.id === taskId);
  if (task && task.status !== status && isWipFull(status, taskId)) {
    state.notify("Limite de WIP da coluna atingido.");
    renderTasks();
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
  if (!state.editingTaskId && isWipFull("todo", null)) {
    state.notify("Limite de WIP da coluna atingido.");
    return;
  }
  try {
    if (state.editingTaskId) {
      await updateDoc(doc(taskCollection, state.editingTaskId), { title, desc: description });
      state.notify("Tarefa atualizada.");
    } else {
      await addDoc(taskCollection, {
        title,
        desc: description,
        status: "todo",
        storyPoints: 1,
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
    snapshot => {
      state.members = snapshot.docs.map(member => ({ uid: member.id, ...member.data() }));
      renderBoardFilters();
      renderMembers(state.members);
    },
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
    if (state.role === "OWNER" && member.role !== "OWNER") {
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
