// Aplica e persiste o tema de cores escolhido, respeitando a preferência inicial do sistema.
(function () {
  // Tenta recuperar a preferência do usuário salva no navegador.
  // Se não existir ou for inválida, usa a preferência do sistema.
  let theme;
  try {
    theme = localStorage.getItem('kanban-theme');
  } catch {}

  if (theme !== 'light' && theme !== 'dark') {
    theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  // Aplica o tema no elemento raiz para que o CSS possa reagir via [data-theme].
  const root = document.documentElement;
  root.setAttribute('data-theme', theme);

  // Atualiza o texto e os atributos acessíveis do botão de alternância.
  function updateButton(button) {
    const isDark = root.getAttribute('data-theme') === 'dark';
    button.textContent = isDark ? '☀️ Claro' : '🌙 Escuro';
    button.setAttribute('aria-label', isDark ? 'Ativar modo claro' : 'Ativar modo escuro');
    button.setAttribute('aria-pressed', String(isDark));
  }

  // Só liga o comportamento quando a página estiver pronta e o botão existir.
  document.addEventListener('DOMContentLoaded', function () {
    const button = document.getElementById('themeToggle');
    if (!button) return;

    // Ajusta o botão com o tema atual antes de qualquer interação.
    updateButton(button);

    // Alterna entre claro e escuro e persiste a escolha no navegador.
    button.addEventListener('click', function () {
      const nextTheme = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      root.setAttribute('data-theme', nextTheme);

      try {
        localStorage.setItem('kanban-theme', nextTheme);
      } catch {}

      updateButton(button);
    });
  });
})();