// firebase-integration.js
// -------------------------------------------------
// Integração Firebase (Auth, Firestore, offline, chats, avatar)
// Projetado para ser colocado AO LADO do seu site v2
// NÃO substitui nada: apenas "wire" (liga) comportamentos existentes do v2.
// Exporá algumas funções em window (saveProgress, sendChatMessage) para uso manual.
// -------------------------------------------------

// carregado como módulo para usar imports ESM do Firebase
export default (async function initFirebaseIntegration(){
  try {
    // imports dinâmicos (funciona se carregado como <script type="module" src="...">)
    const { initializeApp } = await import("https://www.gstatic.com/firebasejs/9.6.1/firebase-app.js");
    const authModule = await import("https://www.gstatic.com/firebasejs/9.6.1/firebase-auth.js");
    const fsModule = await import("https://www.gstatic.com/firebasejs/9.6.1/firebase-firestore.js");

    const { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged } = authModule;
    const { getFirestore, doc, setDoc, getDoc, updateDoc, collection, addDoc, query, orderBy, onSnapshot, serverTimestamp, arrayUnion, enableIndexedDbPersistence } = fsModule;

    // === SUA CONFIG CONFIRMADA (cole aqui se quiser mudar) ===
    const firebaseConfig = {
      apiKey: "AIzaSyBuLs2bZ8-_8ci1Q4Nt4pYMZc1BplmDjOs",
      authDomain: "isk-ia.firebaseapp.com",
      projectId: "isk-ia",
      storageBucket: "isk-ia.firebasestorage.app",
      messagingSenderId: "442504849543",
      appId: "1:442504849543:web:52c05c5aac9cb5a1e3b022",
      measurementId: "G-KMHL5D27FP"
    };

    const app = initializeApp(firebaseConfig);
    const auth = getAuth(app);
    const db = getFirestore(app);

    // tenta ativar persistência offline (IndexedDB)
    enableIndexedDbPersistence(db).catch(err => {
      if (err && err.code === 'failed-precondition') console.warn('Persistência offline não ativada (múltiplas abas).');
      if (err && err.code === 'unimplemented') console.warn('IndexedDB não suportado neste navegador.');
    });

    // estado local — tenta reaproveitar window.state do v2 sem sobrescrever
    const localState = window.state || { level:1, xp:0, xpToNextLevel:100, gold:0, profilePicture:null };
    let currentUser = null;
    let userUnsubscribe = null;
    let currentChatUnsubscribe = null;

    // salvar progresso (uso público — pode ser chamado pelo v2 quando quiser)
    async function saveProgress(uid) {
      if (!uid) return;
      try {
        // sincroniza com window.state se existir
        const stateToSave = Object.assign({}, localState, window.state || {});
        stateToSave.level = Number(stateToSave.level || 1);
        stateToSave.xp = Number(stateToSave.xp || 0);
        stateToSave.gold = Number(stateToSave.gold || 0);
        await setDoc(doc(db, 'users', uid), stateToSave, { merge: true });
        console.log('saveProgress: salvo', uid);
      } catch (e) {
        console.error('saveProgress error', e);
      }
    }

    // ouvir doc do usuário e propagar para window.state (mantendo renderAll)
    async function attachUserListener(uid) {
      try {
        if (userUnsubscribe) userUnsubscribe(); // remove listener anterior
        const userRef = doc(db, 'users', uid);
        const snap = await getDoc(userRef);
        if (!snap.exists()) {
          // cria doc inicial com o localState (merge)
          await setDoc(userRef, Object.assign({}, localState, { name: currentUser && currentUser.displayName || null }), { merge: true });
        }
        userUnsubscribe = onSnapshot(userRef, ds => {
          if (!ds.exists()) return;
          const d = ds.data();
          window.state = window.state || {};
          // coerção numérica para evitar strings
          window.state.level = Number(d.level ?? window.state.level ?? 1);
          window.state.xp = Number(d.xp ?? window.state.xp ?? 0);
          window.state.gold = Number(d.gold ?? window.state.gold ?? 0);
          window.state.profilePicture = d.profilePicture || window.state.profilePicture || null;
          // se sua função de render do v2 existir, chama para atualizar UI
          if (typeof window.renderAll === 'function') {
            try { window.renderAll(); } catch(err) { console.warn('renderAll() erro', err); }
          }
        }, e => console.error('user onSnapshot', e));
      } catch (e) {
        console.error('attachUserListener error', e);
      }
    }

    // AUTH: liga botões existentes ao fluxo Google
    function wireAuthButtons() {
      // botão(s) padrão no v2: #google-login-btn e #logout-btn
      document.querySelectorAll('#google-login-btn, button[data-login="google"]').forEach(b => {
        if (!b) return;
        b.addEventListener('click', async () => {
          try { await signInWithPopup(auth, new GoogleAuthProvider()); }
          catch(e){ console.error('login error', e); alert('Erro no login: '+(e.message || e)); }
        });
      });
      document.querySelectorAll('#logout-btn, button[data-logout="true"]').forEach(b => {
        if (!b) return;
        b.addEventListener('click', async () => {
          try { await signOut(auth); } catch(e){ console.error('logout', e); }
        });
      });
    }

    // estado de autenticação
    onAuthStateChanged(auth, async user => {
      currentUser = user;
      if (user) {
        // conectar listener no Firestore para esse usuário
        await attachUserListener(user.uid);
        // garante nome/avatar no doc do usuário
        try { await setDoc(doc(db, 'users', user.uid), { name: user.displayName, email: user.email, profilePicture: user.photoURL }, { merge: true }); }
        catch(e){ console.error('ensure user doc', e); }
        // atualiza qualquer campo de UI simples (se existir)
        const emailEl = document.getElementById('user-email'); if (emailEl) emailEl.textContent = user.email || '';
        // chama renderAll para atualizar UI do v2
        if (typeof window.renderAll === 'function') {
          try { window.renderAll(); } catch(e) { console.warn('renderAll() erro', e); }
        }
      } else {
        // usuário deslogou: remove listener mas não destrói window.state
        if (userUnsubscribe) { userUnsubscribe(); userUnsubscribe = null; }
        if (typeof window.renderAll === 'function') {
          try { window.renderAll(); } catch(e) { console.warn('renderAll() erro', e); }
        }
      }
    });

    // Chat: escuta mensagens de uma sala (global ou comunidade)
    function listenChatRoom(roomId, onList) {
      try {
        if (currentChatUnsubscribe) currentChatUnsubscribe();
        const q = query(collection(db, 'chats', roomId, 'messages'), orderBy('timestamp', 'asc'));
        currentChatUnsubscribe = onSnapshot(q, snap => {
          const msgs = [];
          snap.forEach(s => msgs.push({ id: s.id, ...s.data() }));
          onList(msgs);
        }, e => console.error('listenChatRoom error', e));
      } catch (e) { console.error('listenChatRoom', e); }
    }

    // Envia mensagem (expondo função)
    async function sendChatMessage(roomId, text) {
      if (!currentUser) return alert('Faça login para enviar mensagens.');
      if (!text || !text.trim()) return;
      try {
        await addDoc(collection(db, 'chats', roomId, 'messages'), {
          userId: currentUser.uid,
          userName: currentUser.displayName || null,
          avatar: currentUser.photoURL || null,
          text: text.trim(),
          timestamp: serverTimestamp()
        });
      } catch (e) { console.error('sendChatMessage', e); alert('Erro ao enviar: '+(e.message||e)); }
    }

    // Comunidades: lista em tempo real e criação
    function wireCommunityListUI() {
      const listEl = document.getElementById('community-list');
      const createBtn = document.getElementById('create-community-btn');
      const newNameInput = document.getElementById('new-community-name');
      if (!listEl || !createBtn) return;
      const q = query(collection(db, 'communities'), orderBy('name'));
      onSnapshot(q, snap => {
        listEl.innerHTML = '';
        snap.forEach(ds => {
          const d = ds.data(); const id = ds.id;
          const div = document.createElement('div');
          div.className = 'community-row';
          div.innerHTML = `<div><strong>${d.name||id}</strong><p class="text-xs text-secondary">${d.description||''}</p></div>
            <div class="flex gap-2"><button class="join-community-btn" data-join="${id}">Entrar</button><button class="open-community-chat-btn" data-open="${id}">Chat</button></div>`;
          listEl.appendChild(div);
        });
      }, e => console.error('communities onSnapshot', e));

      createBtn.addEventListener('click', async () => {
        const name = (newNameInput.value || '').trim(); if (!name) return alert('Digite um nome');
        const id = name.toLowerCase().replace(/[^a-z0-9-_]/g,'-');
        try { await setDoc(doc(db,'communities',id), { name, description:'', members:[] }, { merge:true }); newNameInput.value=''; alert('Comunidade criada: '+id); }
        catch(e){ console.error('create community', e); alert('Erro: '+(e.message||e)); }
      });

      // delegação: botão Entrar
      listEl.addEventListener('click', async e => {
        const btn = e.target.closest('button[data-join]'); if (!btn) return;
        const id = btn.getAttribute('data-join'); if (!currentUser) return alert('Faça login para entrar');
        try { await updateDoc(doc(db,'communities',id), { members: arrayUnion(currentUser.uid) }); alert('Entrou: '+id); }
        catch(e){ console.error('join community', e); alert('Erro: '+(e.message||e)); }
      });
    }

    // UI de chat da comunidade (usa elementos do v2 se existirem)
    function wireCommunityChatUI() {
      const chatBox = document.getElementById('community-chat-box');
      const chatInput = document.getElementById('community-chat-input');
      const chatSend = document.getElementById('community-chat-send-btn');
      const chatTitle = document.getElementById('community-chat-title');
      const backBtn = document.getElementById('back-to-communities-btn');
      if (!chatBox || !chatInput || !chatSend) return;
      let currentRoom = 'global';
      listenChatRoom(currentRoom, msgs => renderCommunityMessages(chatBox, msgs));
      chatSend.addEventListener('click', async () => { await sendChatMessage(currentRoom, chatInput.value); chatInput.value=''; });
      backBtn && backBtn.addEventListener('click', () => {
        const listView = document.getElementById('community-list-view');
        const chatView = document.getElementById('community-chat-view');
        listView && listView.classList.remove('hidden'); chatView && chatView.classList.add('hidden');
        if (currentChatUnsubscribe) currentChatUnsubscribe();
      });
      document.addEventListener('click', e => {
        const btn = e.target.closest('[data-open]'); if (!btn) return;
        const id = btn.getAttribute('data-open'); if (!id) return;
        currentRoom = id;
        const listView = document.getElementById('community-list-view');
        const chatView = document.getElementById('community-chat-view');
        listView && listView.classList.add('hidden'); chatView && chatView.classList.remove('hidden');
        chatTitle && (chatTitle.textContent = id);
        listenChatRoom(currentRoom, msgs => renderCommunityMessages(chatBox, msgs));
      });
    }

    // render helper
    function renderCommunityMessages(container, msgs) {
      if (!container) return;
      container.innerHTML = '';
      msgs.forEach(m => {
        const el = document.createElement('div');
        el.className = 'chat-row';
        const avatar = m.avatar ? `<img src="${m.avatar}" class="w-8 h-8 rounded-full mr-2">` : `<div class="w-8 h-8 rounded-full bg-gray-600 mr-2"></div>`;
        el.innerHTML = `<div class="flex items-start"><div>${avatar}</div><div><div class="text-xs text-secondary">${m.userName||m.userId.slice(0,6)}</div><div class="chat-bubble p-2 rounded">${m.text}</div></div></div>`;
        container.appendChild(el);
      });
      container.scrollTop = container.scrollHeight;
    }

    // generic global chat binder (se existir chat elements do v2)
    function wireGenericChatSenders() {
      const chatInput = document.getElementById('chat-input');
      const chatSend = document.getElementById('chat-send');
      const chatMessages = document.getElementById('chat-messages');
      if (!chatInput || !chatSend || !chatMessages) return;
      chatSend.addEventListener('click', async () => { if (!currentUser) return alert('Faça login'); await sendChatMessage('global', chatInput.value); chatInput.value=''; });
      listenChatRoom('global', msgs => {
        chatMessages.innerHTML = '';
        msgs.forEach(m => {
          const el = document.createElement('div');
          const avatar = m.avatar ? `<img src="${m.avatar}" class="w-6 h-6 rounded-full inline-block mr-2 align-middle">` : `<div class="w-6 h-6 rounded-full bg-gray-600 inline-block mr-2 align-middle"></div>`;
          el.innerHTML = `${avatar}<strong class="text-sm">${m.userName||m.userId.slice(0,6)}</strong> <span class="text-xs text-secondary"> - ${m.timestamp && m.timestamp.toDate? new Date(m.timestamp.toDate()).toLocaleTimeString():''}</span><div class="text-sm">${m.text}</div>`;
          chatMessages.appendChild(el);
        });
        chatMessages.scrollTop = chatMessages.scrollHeight;
      });
    }

    // profile picture input (prototype: salva DataURL em users/{uid}.profilePicture)
    function wireProfilePictureInput() {
      const input = document.getElementById('profile-picture-input');
      const img = document.getElementById('profile-picture-img');
      const container = document.getElementById('profile-picture-container');
      if (!input || !container) return;
      container.addEventListener('click', () => input.click());
      input.addEventListener('change', () => {
        const file = input.files[0]; if (!file) return;
        const reader = new FileReader();
        reader.onload = async () => {
          const dataUrl = reader.result;
          if (img) { img.src = dataUrl; img.classList.remove('hidden'); }
          if (currentUser) {
            try { await setDoc(doc(db,'users',currentUser.uid), { profilePicture: dataUrl }, { merge: true }); alert('Foto de perfil salva.'); }
            catch(e){ console.error('save profile pic', e); alert('Erro ao salvar imagem'); }
          } else alert('Faça login para salvar a foto.');
        };
        reader.readAsDataURL(file);
      });
    }

    // Boot: wiring após DOM pronto — mas sem sobrescrever init/renderAll do v2
    document.addEventListener('DOMContentLoaded', () => {
      try {
        wireAuthButtons();
        wireCommunityListUI();
        wireCommunityChatUI();
        wireGenericChatSenders();
        wireProfilePictureInput();
        // expõe funções úteis para o v2/usuário dev
        window.saveProgress = saveProgress;
        window.sendChatMessage = sendChatMessage;
      } catch (e) {
        console.error('Erro ao iniciar firebase-integration wires', e);
      }
      // Se o v2 defininiu init() mas não chamou, NÃO chamar automaticamente aqui para evitar efeitos colaterais.
      // Porém, se desejar forçar init() logo após integração, descomente a linha abaixo:
       if (typeof window.init === 'function') { window.init(); }
    });

    console.log('Firebase integration initialized (wire-only).');
    // retorna API pública se alguém quiser usar via import
    return { saveProgress, sendChatMessage, listenChatRoom };

  } catch (err) {
    console.error('Erro ao carregar firebase-integration.js', err);
    return null;
  }
})();

