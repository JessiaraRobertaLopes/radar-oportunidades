/* =====================================================================
   TELA DE LOGIN
   - Entrar (e-mail + senha)
   - Criar conta (somente @santacasabh.org.br; o banco também bloqueia)
   - Esqueci a senha / nova senha
   ===================================================================== */
(function () {
  const { sb, ICONES, config } = window.Radar;
  const $ = id => document.getElementById(id);
  const DOMINIO = '@' + config.DOMINIO_PERMITIDO;

  const forms = ['form-entrar', 'form-cadastro', 'form-recuperar', 'form-nova-senha'];
  const textos = {
    'form-entrar':     ['Acesse sua conta', ''],
    'form-cadastro':   ['Crie sua conta', ''],
    'form-recuperar':  ['Redefinir senha', 'Informe seu e-mail e enviaremos um link para criar uma nova senha.'],
    'form-nova-senha': ['Crie uma nova senha', 'Depois de salvar, você já entra no Radar.']
  };

  // ---------- Ícones ----------
  document.querySelectorAll('[data-icone]').forEach(el => { el.innerHTML = ICONES[el.dataset.icone] || ''; });
  document.querySelectorAll('.ver-senha').forEach(btn => {
    btn.innerHTML = ICONES.olho;
    btn.addEventListener('click', () => {
      const campo = $(btn.dataset.alvo);
      const mostrar = campo.type === 'password';
      campo.type = mostrar ? 'text' : 'password';
      btn.innerHTML = mostrar ? ICONES.olhoFechado : ICONES.olho;
      btn.setAttribute('aria-label', mostrar ? 'Ocultar senha' : 'Mostrar senha');
    });
  });

  // ---------- Mensagens ----------
  function mensagem(tipo, texto, detalhe) {
    const icone = tipo === 'sucesso' ? ICONES.ok : ICONES.alerta;
    const esc = window.Radar.escapar;
    const det = detalhe ? `<small class="detalhe-tecnico">Detalhe técnico: ${esc(detalhe)}</small>` : '';
    $('mensagem').innerHTML = texto
      ? `<div class="alerta alerta-${tipo}">${icone}<span>${esc(texto)}${det}</span></div>`
      : '';
  }

  // Mostra a mensagem amigável e, se o erro não for conhecido,
  // o texto original para facilitar o diagnóstico
  function mostrarErro(err) {
    console.error('[Radar] erro de autenticação:', err);
    const texto = traduzirErro(err);
    const conhecido = !texto.startsWith('Não foi possível concluir');
    const detalhe = conhecido ? '' : [err && err.status, err && (err.code || err.name), err && err.message].filter(Boolean).join(' | ');
    mensagem('erro', texto, detalhe);
  }

  function traduzirErro(err) {
    const m = (err && err.message || '').toLowerCase();
    if (m.includes('invalid login credentials')) return 'E-mail ou senha incorretos.';
    if (m.includes('already registered') || m.includes('already been registered')) return 'Este e-mail já tem cadastro. Use a aba Entrar.';
    if (m.includes('database error') || m.includes('santacasabh')) return 'Cadastro permitido apenas com e-mail ' + DOMINIO + '.';
    if (m.includes('rate limit') || m.includes('too many')) return 'Muitas tentativas seguidas. Aguarde um minuto e tente de novo.';
    if (m.includes('password') && m.includes('characters')) return 'A senha precisa ter pelo menos 8 caracteres.';
    if (m.includes('same password') || m.includes('different from the old')) return 'A nova senha precisa ser diferente da anterior.';
    if (m.includes('failed to fetch') || m.includes('network')) return 'Sem conexão com o servidor. Verifique a internet e tente de novo.';
    return 'Não foi possível concluir agora. Tente de novo em instantes.';
  }

  // ---------- Navegação entre formulários ----------
  function mostrar(idForm) {
    forms.forEach(f => $(f).classList.toggle('oculto', f !== idForm));
    $('abas').classList.toggle('oculto', !(idForm === 'form-entrar' || idForm === 'form-cadastro'));
    $('aba-entrar').setAttribute('aria-selected', String(idForm === 'form-entrar'));
    $('aba-cadastro').setAttribute('aria-selected', String(idForm === 'form-cadastro'));
    $('titulo-form').textContent = textos[idForm][0];
    $('subtitulo-form').textContent = textos[idForm][1];
    $('subtitulo-form').classList.toggle('oculto', !textos[idForm][1]);
    mensagem();
    const primeiro = $(idForm).querySelector('input');
    if (primeiro) primeiro.focus();
  }

  $('aba-entrar').addEventListener('click', () => mostrar('form-entrar'));
  $('aba-cadastro').addEventListener('click', () => mostrar('form-cadastro'));
  $('link-esqueci').addEventListener('click', () => {
    $('rec-email').value = $('entrar-email').value;
    mostrar('form-recuperar');
  });
  $('voltar-entrar').addEventListener('click', () => mostrar('form-entrar'));

  function ocupado(btn, sim, textoOriginal) {
    btn.disabled = sim;
    btn.classList.toggle('carregando', sim);
    btn.textContent = sim ? 'Aguarde' : textoOriginal;
  }

  function emailValido(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }
  function dominioValido(email) {
    return email.toLowerCase().endsWith(DOMINIO);
  }
  function marcarInvalido(campo, invalido) {
    campo.setAttribute('aria-invalid', invalido ? 'true' : 'false');
  }

  function irParaSistema() { window.location.replace('app.html'); }

  // ---------- Sem conexão com a biblioteca ----------
  if (!sb) {
    mensagem('erro', 'Não foi possível carregar o sistema. Verifique a internet e recarregue a página.');
    document.querySelectorAll('form button[type="submit"]').forEach(b => b.disabled = true);
    return;
  }

  // ---------- Entrar ----------
  $('form-entrar').addEventListener('submit', async e => {
    e.preventDefault();
    const email = $('entrar-email').value.trim().toLowerCase();
    const senha = $('entrar-senha').value;
    marcarInvalido($('entrar-email'), false);

    if (!emailValido(email) || !senha) {
      marcarInvalido($('entrar-email'), !emailValido(email));
      return mensagem('erro', 'Preencha o e-mail e a senha.');
    }

    const btn = $('btn-entrar');
    ocupado(btn, true, 'Entrar');
    const { error } = await sb.auth.signInWithPassword({ email, password: senha });
    ocupado(btn, false, 'Entrar');

    if (error) return mostrarErro(error);
    irParaSistema();
  });

  // ---------- Criar conta ----------
  $('form-cadastro').addEventListener('submit', async e => {
    e.preventDefault();
    const nome = $('cad-nome').value.trim();
    const email = $('cad-email').value.trim().toLowerCase();
    const senha = $('cad-senha').value;
    const senha2 = $('cad-senha2').value;
    ['cad-nome', 'cad-email', 'cad-senha', 'cad-senha2'].forEach(id => marcarInvalido($(id), false));

    if (nome.length < 3) { marcarInvalido($('cad-nome'), true); return mensagem('erro', 'Informe seu nome completo.'); }
    if (!emailValido(email)) { marcarInvalido($('cad-email'), true); return mensagem('erro', 'Informe um e-mail válido.'); }
    if (!dominioValido(email)) { marcarInvalido($('cad-email'), true); return mensagem('erro', 'Cadastro permitido apenas com e-mail ' + DOMINIO + '.'); }
    if (senha.length < 8) { marcarInvalido($('cad-senha'), true); return mensagem('erro', 'A senha precisa ter pelo menos 8 caracteres.'); }
    if (senha !== senha2) { marcarInvalido($('cad-senha2'), true); return mensagem('erro', 'As senhas não são iguais.'); }

    const btn = $('btn-cadastrar');
    ocupado(btn, true, 'Criar conta');
    const { data, error } = await sb.auth.signUp({
      email,
      password: senha,
      options: { data: { nome } }
    });
    ocupado(btn, false, 'Criar conta');

    if (error) return mostrarErro(error);

    // Com a confirmação de e-mail desligada, a sessão já vem pronta
    if (data && data.session) return irParaSistema();

    // Se a confirmação for ligada no ambiente oficial
    mostrar('form-entrar');
    $('entrar-email').value = email;
    mensagem('sucesso', 'Conta criada. Confirme pelo link enviado ao seu e-mail e depois entre.');
  });

  // ---------- Esqueci a senha ----------
  $('form-recuperar').addEventListener('submit', async e => {
    e.preventDefault();
    const email = $('rec-email').value.trim().toLowerCase();
    if (!emailValido(email)) { marcarInvalido($('rec-email'), true); return mensagem('erro', 'Informe um e-mail válido.'); }

    const btn = $('btn-recuperar');
    ocupado(btn, true, 'Enviar link de redefinição');
    const destino = window.location.href.split('#')[0].split('?')[0];
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: destino });
    ocupado(btn, false, 'Enviar link de redefinição');

    if (error && !/rate limit|too many/i.test(error.message)) {
      return mostrarErro(error);
    }
    // Mensagem neutra: não revela se o e-mail tem cadastro
    mensagem('sucesso', 'Se este e-mail tiver cadastro, você vai receber um link para criar uma nova senha. Confira também o lixo eletrônico.');
  });

  // ---------- Nova senha ----------
  $('form-nova-senha').addEventListener('submit', async e => {
    e.preventDefault();
    const senha = $('nova-senha').value;
    const senha2 = $('nova-senha2').value;
    if (senha.length < 8) { marcarInvalido($('nova-senha'), true); return mensagem('erro', 'A senha precisa ter pelo menos 8 caracteres.'); }
    if (senha !== senha2) { marcarInvalido($('nova-senha2'), true); return mensagem('erro', 'As senhas não são iguais.'); }

    const btn = $('btn-nova-senha');
    ocupado(btn, true, 'Salvar nova senha');
    const { error } = await sb.auth.updateUser({ password: senha });
    ocupado(btn, false, 'Salvar nova senha');

    if (error) return mostrarErro(error);
    mensagem('sucesso', 'Senha atualizada. Entrando no Radar.');
    setTimeout(irParaSistema, 1200);
  });

  // ---------- Estado inicial ----------
  const veioDeRecuperacao = window.location.hash.includes('type=recovery');

  sb.auth.onAuthStateChange(evento => {
    if (evento === 'PASSWORD_RECOVERY') mostrar('form-nova-senha');
  });

  (async () => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('motivo') === 'inativo') {
      mensagem('erro', 'Seu acesso está desativado. Fale com a administração do Radar.');
    }
    if (veioDeRecuperacao) { mostrar('form-nova-senha'); return; }

    const { data: { session } } = await sb.auth.getSession();
    if (session && params.get('motivo') !== 'inativo') irParaSistema();
  })();
})();
