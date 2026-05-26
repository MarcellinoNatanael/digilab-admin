/* ============================================================
   DigiLab — feedback-admin.js  (Panel Admin Feedback)
   ============================================================ */
'use strict';

const ADMIN_CFG = {
  supabaseUrl: 'https://wzsqtpnvkjbgndymdjci.supabase.co',
  supabaseKey: 'sb_publishable_BPAM_GRlDKiSp-Z1FxyrEw_TVn685ez',
  sessionKey : 'btl_admin_ok',
};

const TYPE_META = {
  short_text     : { label: 'Teks Pendek',   icon: '✏️' },
  long_text      : { label: 'Teks Panjang',  icon: '📝' },
  scale          : { label: 'Skala',         icon: '⭐' },
  multiple_choice: { label: 'Pilihan Ganda', icon: '🔘' },
  checkbox       : { label: 'Checkbox',      icon: '☑️' },
  dropdown       : { label: 'Dropdown',      icon: '📋' },
};

const AVATAR_COLORS = [
  '#6366f1','#8b5cf6','#ec4899','#f43f5e',
  '#f97316','#22c55e','#14b8a6','#0ea5e9','#3b82f6',
];

let state = {
  questions    : [],
  responses    : [],
  editingId    : null,
  currentTab   : 'questions',
  adminName    : '',
  adminEmail   : '',
  adminId      : null,
};

let supabaseClient  = null;
let presenceChannel = null;
let changesChannel  = null;

/* ── Avatar helpers ─────────────────────────────────────── */
function getAvatarColor(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = str.charCodeAt(i) + ((hash << 5) - hash);
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function getInitials(name) {
  return (name || '?').split(' ').slice(0, 2).map(w => w[0] || '').join('').toUpperCase() || '?';
}

/* ── DB ─────────────────────────────────────────────────── */
const adminDB = {
  h: () => ({
    'apikey'       : ADMIN_CFG.supabaseKey,
    'Authorization': 'Bearer ' + ADMIN_CFG.supabaseKey,
    'Content-Type' : 'application/json',
    'Prefer'       : 'return=representation',
  }),

  async getQuestions() {
    const r = await fetch(
      ADMIN_CFG.supabaseUrl + '/rest/v1/feedback_questions?select=*&order=sort_order.asc,id.asc',
      { headers: adminDB.h() }
    );
    if (!r.ok) throw new Error('Gagal mengambil pertanyaan');
    return r.json();
  },

  async insertQuestion(data) {
    const r = await fetch(ADMIN_CFG.supabaseUrl + '/rest/v1/feedback_questions', {
      method: 'POST', headers: adminDB.h(), body: JSON.stringify(data),
    });
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.message || 'Gagal tambah'); }
    return r.json();
  },

  async updateQuestion(id, data) {
    const r = await fetch(ADMIN_CFG.supabaseUrl + '/rest/v1/feedback_questions?id=eq.' + id, {
      method: 'PATCH', headers: adminDB.h(), body: JSON.stringify(data),
    });
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.message || 'Gagal update'); }
    return r.json();
  },

  async deleteQuestion(id) {
    const r = await fetch(ADMIN_CFG.supabaseUrl + '/rest/v1/feedback_questions?id=eq.' + id, {
      method: 'DELETE', headers: adminDB.h(),
    });
    if (!r.ok) throw new Error('Gagal hapus');
  },

  async getResponses() {
    const r = await fetch(
      ADMIN_CFG.supabaseUrl + '/rest/v1/feedback_responses?select=*,feedback_answers(question_id,answer_value)&order=created_at.desc',
      { headers: adminDB.h() }
    );
    if (!r.ok) throw new Error('Gagal mengambil respons');
    return r.json();
  },

  async findAdmin(email, password) {
    const r = await fetch(
      ADMIN_CFG.supabaseUrl + '/rest/v1/admin_users?email=eq.' + encodeURIComponent(email) +
      '&password=eq.' + encodeURIComponent(password) + '&select=id,name,email',
      { headers: adminDB.h() }
    );
    const data = await r.json();
    return Array.isArray(data) && data.length > 0 ? data[0] : null;
  },

  async emailAdminExists(email) {
    const r = await fetch(
      ADMIN_CFG.supabaseUrl + '/rest/v1/admin_users?email=eq.' + encodeURIComponent(email) + '&select=id',
      { headers: adminDB.h() }
    );
    const data = await r.json();
    return Array.isArray(data) && data.length > 0;
  },

  async createAdmin(name, email, password) {
    const r = await fetch(ADMIN_CFG.supabaseUrl + '/rest/v1/admin_users', {
      method : 'POST',
      headers: adminDB.h(),
      body   : JSON.stringify({ name, email, password }),
    });
    if (r.status === 409) throw new Error('Email sudah terdaftar!');
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.message || 'Gagal daftar'); }
    return r.json();
  },
};

/* ══════════════════════════════════════════════════════════
   REALTIME — Presence (siapa online) + Sync perubahan DB
   ══════════════════════════════════════════════════════════ */
function initRealtime() {
  try {
    const { createClient } = window.supabase;
    supabaseClient = createClient(ADMIN_CFG.supabaseUrl, ADMIN_CFG.supabaseKey);

    // ── 1. Presence: siapa yang sedang online ──────────────
    presenceChannel = supabaseClient.channel('admin-presence-room');
    presenceChannel
      .on('presence', { event: 'sync' }, () => {
        renderOnlineUsers(presenceChannel.presenceState());
      })
      .on('presence', { event: 'join' }, () => {
        renderOnlineUsers(presenceChannel.presenceState());
        showToast('👋 Admin baru bergabung!');
      })
      .on('presence', { event: 'leave' }, () => {
        renderOnlineUsers(presenceChannel.presenceState());
      })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          await presenceChannel.track({
            id       : state.adminId,
            name     : state.adminName,
            email    : state.adminEmail,
            color    : getAvatarColor(state.adminName),
            joined_at: new Date().toISOString(),
          });
        }
      });

    // ── 2. Postgres Changes: sync perubahan pertanyaan ─────
    // Pastikan sudah jalankan SQL:
    // ALTER PUBLICATION supabase_realtime ADD TABLE feedback_questions;
    changesChannel = supabaseClient
      .channel('feedback-questions-changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'feedback_questions' },
        (payload) => {
          const actor = payload?.new?.updated_by || payload?.old?.updated_by || '';
          const isMe  = actor === state.adminEmail;
          if (!isMe) {
            showToast('🔄 Pertanyaan diperbarui oleh admin lain');
          }
          loadQuestions();
        }
      )
      .subscribe();

  } catch (err) {
    console.warn('Realtime tidak tersedia:', err);
  }
}

function cleanupRealtime() {
  try {
    presenceChannel?.untrack();
    presenceChannel?.unsubscribe();
    changesChannel?.unsubscribe();
    supabaseClient?.removeAllChannels();
  } catch (_) {}
  presenceChannel = null;
  changesChannel  = null;
  supabaseClient  = null;
}

function renderOnlineUsers(presenceState) {
  const container = document.getElementById('onlineAvatars');
  const countEl   = document.getElementById('onlineCount');
  if (!container) return;

  const users  = Object.values(presenceState).flat();
  const unique = [];
  const seen   = new Set();
  users.forEach(u => {
    const key = u.email || u.id;
    if (!seen.has(key)) { seen.add(key); unique.push(u); }
  });

  if (countEl) countEl.textContent = unique.length;

  container.innerHTML = unique.map((u, i) => {
    const color    = u.color || getAvatarColor(u.name || u.email || '?');
    const initials = getInitials(u.name || u.email || '?');
    const isMe     = (u.email === state.adminEmail);
    return `
      <div class="online-avatar ${isMe ? 'is-me' : ''}"
           style="background:${color};z-index:${10 - i}"
           data-tooltip="${u.name || u.email}${isMe ? ' (Kamu)' : ''}">
        ${initials}
        ${isMe ? '<span class="online-dot"></span>' : ''}
      </div>`;
  }).join('');
}

/* ── Toast notifikasi ───────────────────────────────────── */
function showToast(msg) {
  let toast = document.getElementById('adminToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'adminToast';
    toast.style.cssText = `
      position:fixed;bottom:1.5rem;right:1.5rem;
      background:#1e293b;color:#fff;
      padding:0.65rem 1.1rem;border-radius:0.6rem;
      font-size:0.85rem;font-weight:500;
      box-shadow:0 4px 20px rgba(0,0,0,.25);
      z-index:9999;opacity:0;transition:opacity .25s;
      pointer-events:none;`;
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.style.opacity = '1';
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { toast.style.opacity = '0'; }, 3000);
}

/* ══════════════════════════════════════════════════════════
   AUTH — localStorage (bukan sessionStorage)
   ══════════════════════════════════════════════════════════ */
function isLoggedIn() {
  return !!localStorage.getItem(ADMIN_CFG.sessionKey);
}

async function login() {
  const email = (document.getElementById('adminEmail')?.value    || '').trim();
  const pw    = (document.getElementById('adminPassword')?.value || '').trim();
  const errEl = document.getElementById('loginError');
  const btn   = document.getElementById('loginBtn');

  if (errEl) errEl.style.display = 'none';
  if (!email || !pw) {
    if (errEl) { errEl.textContent = '❌ Email dan password wajib diisi!'; errEl.style.display = 'block'; }
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = 'Memverifikasi...'; }

  try {
    const admin = await adminDB.findAdmin(email, pw);
    if (!admin) {
      if (errEl) { errEl.textContent = '❌ Email atau password salah!'; errEl.style.display = 'block'; }
      return;
    }
    localStorage.setItem(ADMIN_CFG.sessionKey, JSON.stringify({ id: admin.id, name: admin.name, email: admin.email }));
    state.adminName  = admin.name  || admin.email;
    state.adminEmail = admin.email || '';
    state.adminId    = admin.id;
    showPanel();
  } catch (err) {
    if (errEl) { errEl.textContent = '❌ Gagal koneksi. Coba lagi.'; errEl.style.display = 'block'; }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Masuk'; }
  }
}

async function register() {
  const name  = (document.getElementById('regName')?.value      || '').trim();
  const email = (document.getElementById('regEmail2')?.value    || '').trim();
  const pw    = (document.getElementById('regPassword')?.value  || '').trim();
  const pw2   = (document.getElementById('regPassword2')?.value || '').trim();
  const errEl = document.getElementById('regError');
  const sucEl = document.getElementById('regSuccessMsg');
  const btn   = document.getElementById('registerBtn');

  if (errEl) errEl.style.display = 'none';
  if (sucEl) sucEl.style.display = 'none';

  if (!name || !email || !pw || !pw2) {
    if (errEl) { errEl.textContent = '❌ Semua field wajib diisi!'; errEl.style.display = 'block'; } return;
  }
  if (!email.includes('@')) {
    if (errEl) { errEl.textContent = '❌ Format email tidak valid!'; errEl.style.display = 'block'; } return;
  }
  if (pw.length < 6) {
    if (errEl) { errEl.textContent = '❌ Password minimal 6 karakter!'; errEl.style.display = 'block'; } return;
  }
  if (pw !== pw2) {
    if (errEl) { errEl.textContent = '❌ Konfirmasi password tidak cocok!'; errEl.style.display = 'block'; } return;
  }
  if (btn) { btn.disabled = true; btn.textContent = 'Mendaftar...'; }

  try {
    const exists = await adminDB.emailAdminExists(email);
    if (exists) {
      if (errEl) { errEl.textContent = '❌ Email sudah terdaftar!'; errEl.style.display = 'block'; } return;
    }
    await adminDB.createAdmin(name, email, pw);
    if (sucEl) { sucEl.textContent = '✅ Akun berhasil dibuat! Silakan login.'; sucEl.style.display = 'block'; }
    ['regName','regEmail2','regPassword','regPassword2'].forEach(id => {
      const el = document.getElementById(id); if (el) el.value = '';
    });
    setTimeout(() => showLoginTab(), 2000);
  } catch (err) {
    if (errEl) { errEl.textContent = '❌ ' + (err.message || 'Gagal. Coba lagi.'); errEl.style.display = 'block'; }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Buat Akun Admin'; }
  }
}

function logout() {
  cleanupRealtime();
  localStorage.removeItem(ADMIN_CFG.sessionKey);
  document.getElementById('loginScreen').style.display = 'flex';
  document.getElementById('adminPanel').style.display  = 'none';
  showLoginTab();
}

function showLoginTab() {
  document.getElementById('loginTab').style.display    = 'block';
  document.getElementById('registerTab').style.display = 'none';
  document.getElementById('tabLogin').classList.add('active');
  document.getElementById('tabRegister').classList.remove('active');
  document.getElementById('loginError').style.display  = 'none';
}

function showRegisterTab() {
  document.getElementById('loginTab').style.display    = 'none';
  document.getElementById('registerTab').style.display = 'block';
  document.getElementById('tabRegister').classList.add('active');
  document.getElementById('tabLogin').classList.remove('active');
  document.getElementById('regError').style.display      = 'none';
  document.getElementById('regSuccessMsg').style.display = 'none';
}

async function showPanel() {
  try {
    const s = JSON.parse(localStorage.getItem(ADMIN_CFG.sessionKey));
    state.adminName  = s?.name  || s?.email || 'Admin';
    state.adminEmail = s?.email || '';
    state.adminId    = s?.id    || null;
  } catch { state.adminName = 'Admin'; }

  const myAvatarEl = document.getElementById('myAvatar');
  const myNameEl   = document.getElementById('myName');
  const color      = getAvatarColor(state.adminName);
  if (myAvatarEl) {
    myAvatarEl.textContent      = getInitials(state.adminName);
    myAvatarEl.style.background = color;
  }
  if (myNameEl) myNameEl.textContent = state.adminName;

  document.getElementById('loginScreen').style.display = 'none';
  document.getElementById('adminPanel').style.display  = 'block';

  initRealtime();
  await loadQuestions();
}

/* ══════════════════════════════════════════════════════════
   TABS
   ══════════════════════════════════════════════════════════ */
function showTab(tab) {
  state.currentTab = tab;
  document.querySelectorAll('.admin-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.tab-content').forEach(c => c.style.display = 'none');
  document.getElementById('tab-' + tab).style.display = 'block';
  if (tab === 'responses') loadResponses();
}

/* ══════════════════════════════════════════════════════════
   QUESTIONS
   ══════════════════════════════════════════════════════════ */
async function loadQuestions() {
  const el = document.getElementById('questionList');
  if (el) el.innerHTML = '<div style="padding:1.5rem;text-align:center;color:var(--text-3)">⏳ Memuat pertanyaan...</div>';
  try {
    state.questions = await adminDB.getQuestions();
    renderQuestions();
  } catch (err) {
    if (el) el.innerHTML = `<div style="padding:1rem;color:var(--danger)">⚠️ ${err.message}</div>`;
  }
}

function renderQuestions() {
  const el      = document.getElementById('questionList');
  const countEl = document.getElementById('questionCount');
  if (!el) return;
  if (countEl) countEl.textContent = state.questions.length;

  if (state.questions.length === 0) {
    el.innerHTML = `
      <div style="padding:3rem;text-align:center;color:var(--text-3)">
        <div style="font-size:2.5rem;margin-bottom:0.75rem">📋</div>
        <div style="font-weight:600">Belum ada pertanyaan</div>
        <div style="font-size:0.875rem;margin-top:0.25rem">Klik <strong>+ Tambah Pertanyaan</strong> untuk mulai.</div>
      </div>`;
    return;
  }

  el.innerHTML = state.questions.map((q, i) => {
    const meta    = TYPE_META[q.type] || { label: q.type, icon: '❓' };
    const hasOpts = ['multiple_choice', 'checkbox', 'dropdown'].includes(q.type);
    const optsPreview = hasOpts && q.options?.length
      ? `<div style="margin-top:0.35rem;font-size:0.8rem;color:var(--text-3)">
           ${q.options.slice(0,4).map(o => `<span style="background:var(--bg-2);border-radius:4px;padding:0.1rem 0.4rem">${o}</span>`).join(' ')}
           ${q.options.length > 4 ? `<span style="color:var(--text-4)">+${q.options.length-4} lagi</span>` : ''}
         </div>` : '';
    const scalePreview = q.type === 'scale'
      ? `<div style="margin-top:0.35rem;font-size:0.8rem;color:var(--text-3)">
           Skala ${q.scale_min}–${q.scale_max}
           ${q.scale_label_min ? ` · "${q.scale_label_min}"` : ''}
           ${q.scale_label_max ? ` → "${q.scale_label_max}"` : ''}
         </div>` : '';
    return `
      <div class="question-card">
        <div style="display:flex;align-items:flex-start;gap:1rem">
          <div style="display:flex;flex-direction:column;gap:0.25rem;padding-top:0.1rem">
            <button class="icon-btn" onclick="moveQuestion(${q.id},-1)" ${i===0?'disabled':''}>▲</button>
            <button class="icon-btn" onclick="moveQuestion(${q.id},1)"  ${i===state.questions.length-1?'disabled':''}>▼</button>
          </div>
          <div style="flex:1;min-width:0">
            <div style="display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;margin-bottom:0.35rem">
              <span style="font-size:0.78rem;font-weight:600;color:var(--text-4)">#${i+1}</span>
              <span class="type-badge">${meta.icon} ${meta.label}</span>
              ${q.required ? '<span class="req-badge">Wajib</span>' : '<span class="opt-badge">Opsional</span>'}
            </div>
            <div style="font-weight:600;line-height:1.5">${q.question_text}</div>
            ${optsPreview}${scalePreview}
          </div>
          <div style="display:flex;gap:0.4rem;flex-shrink:0">
            <button class="btn-edit" onclick="openModal(${q.id})">✏️ Edit</button>
            <button class="btn-delete" onclick="deleteQuestion(${q.id})">🗑️</button>
          </div>
        </div>
      </div>`;
  }).join('');
}

async function moveQuestion(id, dir) {
  const idx = state.questions.findIndex(q => q.id === id);
  const newIdx = idx + dir;
  if (newIdx < 0 || newIdx >= state.questions.length) return;
  const a = state.questions[idx], b = state.questions[newIdx];
  try {
    await adminDB.updateQuestion(a.id, { sort_order: b.sort_order });
    await adminDB.updateQuestion(b.id, { sort_order: a.sort_order });
    await loadQuestions();
  } catch (err) { alert('Gagal mengubah urutan: ' + err.message); }
}

async function deleteQuestion(id) {
  if (!confirm('Hapus pertanyaan ini? Semua jawaban terkait akan ikut terhapus.')) return;
  try { await adminDB.deleteQuestion(id); await loadQuestions(); }
  catch (err) { alert('Gagal hapus: ' + err.message); }
}

/* ══════════════════════════════════════════════════════════
   MODAL
   ══════════════════════════════════════════════════════════ */
function openModal(id = null) {
  state.editingId = id;
  const title = document.getElementById('modalTitle');
  if (id !== null) {
    const q = state.questions.find(q => q.id === id);
    if (!q) return;
    title.textContent = 'Edit Pertanyaan';
    document.getElementById('mqText').value       = q.question_text;
    document.getElementById('mqRequired').checked = q.required;
    selectType(q.type, false);
    setTimeout(() => {
      if (q.type === 'scale') {
        document.getElementById('mqScaleMin').value      = q.scale_min ?? 1;
        document.getElementById('mqScaleMax').value      = q.scale_max ?? 5;
        document.getElementById('mqScaleLabelMin').value = q.scale_label_min || '';
        document.getElementById('mqScaleLabelMax').value = q.scale_label_max || '';
      } else if (['multiple_choice','checkbox','dropdown'].includes(q.type)) {
        const c = document.getElementById('mqOptionsContainer');
        if (c) { c.innerHTML = ''; (Array.isArray(q.options)?q.options:[]).forEach(opt=>addOptionField(opt)); }
      }
    }, 30);
  } else {
    title.textContent = 'Tambah Pertanyaan';
    document.getElementById('mqText').value       = '';
    document.getElementById('mqRequired').checked = true;
    document.getElementById('mqOptionsContainer').innerHTML = '';
    selectType('short_text', true);
  }
  document.getElementById('questionModal').style.display = 'flex';
  document.getElementById('mqText').focus();
}

function closeModal() {
  document.getElementById('questionModal').style.display = 'none';
  state.editingId = null;
}

function selectType(type, resetOptions = true) {
  document.querySelectorAll('.type-card').forEach(c => c.classList.toggle('active', c.dataset.type === type));
  document.getElementById('mqSelectedType').value = type;
  document.getElementById('scaleFields').style.display  = type === 'scale' ? 'block' : 'none';
  const hasOpts = ['multiple_choice','checkbox','dropdown'].includes(type);
  document.getElementById('optionFields').style.display = hasOpts ? 'block' : 'none';
  if (hasOpts && resetOptions) {
    const c = document.getElementById('mqOptionsContainer');
    c.innerHTML = ''; addOptionField(''); addOptionField('');
  }
}

function addOptionField(value = '') {
  const c = document.getElementById('mqOptionsContainer');
  const d = document.createElement('div');
  d.style.cssText = 'display:flex;gap:0.5rem;margin-bottom:0.5rem;align-items:center';
  d.innerHTML = `
    <span style="color:var(--text-4);font-size:0.8rem;min-width:1rem">●</span>
    <input class="form-input" placeholder="Teks opsi..." value="${value}" style="flex:1;padding:0.5rem 0.75rem"/>
    <button type="button" onclick="this.parentElement.remove()"
      style="background:none;border:none;cursor:pointer;color:var(--danger);font-size:1.1rem;padding:0 0.25rem">✕</button>`;
  c.appendChild(d);
}

async function saveQuestion() {
  const text     = (document.getElementById('mqText')?.value || '').trim();
  const type     = document.getElementById('mqSelectedType')?.value || 'short_text';
  const required = document.getElementById('mqRequired')?.checked ?? true;
  if (!text) { alert('Teks pertanyaan wajib diisi!'); return; }

  const data = { question_text: text, type, required };
  if (type === 'scale') {
    const min = parseInt(document.getElementById('mqScaleMin')?.value) || 1;
    const max = parseInt(document.getElementById('mqScaleMax')?.value) || 5;
    if (max <= min) { alert('Nilai maksimum harus lebih besar dari minimum!'); return; }
    data.scale_min = min; data.scale_max = max;
    data.scale_label_min = document.getElementById('mqScaleLabelMin')?.value?.trim() || '';
    data.scale_label_max = document.getElementById('mqScaleLabelMax')?.value?.trim() || '';
    data.options = [];
  } else if (['multiple_choice','checkbox','dropdown'].includes(type)) {
    const inputs = document.querySelectorAll('#mqOptionsContainer input[type!=hidden]');
    data.options = [...inputs].map(i => i.value.trim()).filter(Boolean);
    if (data.options.length < 2) { alert('Minimal 2 opsi harus diisi!'); return; }
  } else { data.options = []; }

  const btn = document.getElementById('modalSaveBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Menyimpan...'; }
  try {
    if (state.editingId !== null) { await adminDB.updateQuestion(state.editingId, data); }
    else { data.sort_order = state.questions.length; await adminDB.insertQuestion(data); }
    closeModal(); await loadQuestions();
  } catch (err) { alert('Gagal menyimpan: ' + err.message); }
  finally { if (btn) { btn.disabled = false; btn.textContent = 'Simpan Pertanyaan'; } }
}

/* ══════════════════════════════════════════════════════════
   RESPONSES
   ══════════════════════════════════════════════════════════ */
async function loadResponses() {
  const el = document.getElementById('responseContent');
  if (el) el.innerHTML = '<div style="padding:2rem;text-align:center;color:var(--text-3)">⏳ Memuat respons...</div>';
  try { state.responses = await adminDB.getResponses(); renderResponses(); }
  catch (err) { if (el) el.innerHTML = `<div style="padding:1rem;color:var(--danger)">⚠️ ${err.message}</div>`; }
}

function renderResponses() {
  const el = document.getElementById('responseContent');
  const countEl = document.getElementById('responseCount');
  if (!el) return;
  if (countEl) countEl.textContent = state.responses.length;
  if (state.responses.length === 0) {
    el.innerHTML = `
      <div style="padding:3.5rem;text-align:center;color:var(--text-3)">
        <div style="font-size:2.5rem;margin-bottom:0.75rem">📭</div>
        <div style="font-weight:600">Belum ada respons masuk</div>
      </div>`;
    return;
  }
  el.innerHTML = renderSummary() + renderTable();
}

function renderSummary() {
  if (!state.questions.length) return '';
  const cards = state.questions.map(q => {
    const answers = state.responses.flatMap(r=>(r.feedback_answers||[]).filter(a=>a.question_id===q.id).map(a=>a.answer_value)).filter(Boolean);
    const meta = TYPE_META[q.type] || { label:q.type, icon:'❓' };
    if (!answers.length) return `<div class="summary-card"><div class="summary-q">${q.question_text} <span class="type-badge">${meta.icon} ${meta.label}</span></div><div style="color:var(--text-3);font-size:0.85rem">Belum ada jawaban.</div></div>`;
    if (q.type === 'scale') {
      const nums = answers.map(Number).filter(n=>!isNaN(n));
      const avg  = (nums.reduce((a,b)=>a+b,0)/nums.length).toFixed(1);
      const counts = {}; for(let n=q.scale_min;n<=q.scale_max;n++) counts[n]=0;
      nums.forEach(n=>{if(counts[n]!==undefined)counts[n]++;});
      const maxCnt = Math.max(...Object.values(counts),1);
      const bars = Object.entries(counts).map(([v,c])=>`
        <div style="display:flex;align-items:center;gap:0.5rem;margin-bottom:0.3rem">
          <span style="min-width:1.25rem;text-align:right;font-size:0.8rem;font-weight:600">${v}</span>
          <div style="flex:1;background:var(--bg-3,#f1f5f9);border-radius:4px;height:14px;overflow:hidden">
            <div style="width:${Math.round(c/maxCnt*100)}%;background:var(--primary);height:100%;border-radius:4px"></div>
          </div>
          <span style="min-width:1.5rem;font-size:0.8rem;color:var(--text-3)">${c}</span>
        </div>`).join('');
      return `<div class="summary-card"><div class="summary-q">${q.question_text} <span class="type-badge">⭐ Skala</span></div><div style="font-size:1.75rem;font-weight:800;color:var(--primary);margin-bottom:0.75rem">${avg} <span style="font-size:0.9rem;font-weight:400;color:var(--text-3)">/ ${q.scale_max}</span></div>${bars}<div style="font-size:0.78rem;color:var(--text-4);margin-top:0.5rem">${nums.length} jawaban</div></div>`;
    }
    if (['multiple_choice','checkbox','dropdown'].includes(q.type)) {
      const counts = {}; (q.options||[]).forEach(o=>counts[o]=0);
      answers.forEach(a=>a.split(', ').forEach(v=>{counts[v]=(counts[v]||0)+1;}));
      const total = answers.length, maxCnt = Math.max(...Object.values(counts),1);
      const bars = Object.entries(counts).map(([opt,cnt])=>`
        <div style="margin-bottom:0.6rem">
          <div style="display:flex;justify-content:space-between;font-size:0.83rem;margin-bottom:0.2rem">
            <span>${opt}</span><span style="color:var(--text-3)">${cnt} (${total?Math.round(cnt/total*100):0}%)</span>
          </div>
          <div style="background:var(--bg-3,#f1f5f9);border-radius:4px;height:12px;overflow:hidden">
            <div style="width:${Math.round(cnt/maxCnt*100)}%;background:var(--primary);height:100%;border-radius:4px"></div>
          </div>
        </div>`).join('');
      return `<div class="summary-card"><div class="summary-q">${q.question_text} <span class="type-badge">${meta.icon} ${meta.label}</span></div>${bars}<div style="font-size:0.78rem;color:var(--text-4);margin-top:0.25rem">${total} jawaban</div></div>`;
    }
    return `<div class="summary-card"><div class="summary-q">${q.question_text} <span class="type-badge">${meta.icon} ${meta.label}</span></div><div style="max-height:180px;overflow-y:auto;display:flex;flex-direction:column;gap:0.4rem">${answers.map(a=>`<div style="padding:0.4rem 0.65rem;background:var(--bg-2,#f8fafc);border-radius:6px;font-size:0.85rem;border:1px solid var(--border)">${a}</div>`).join('')}</div><div style="font-size:0.78rem;color:var(--text-4);margin-top:0.5rem">${answers.length} jawaban</div></div>`;
  }).join('');
  return `<h4 style="margin:0 0 1rem;font-size:1rem">📊 Ringkasan Jawaban</h4><div class="summary-grid">${cards}</div>`;
}

function renderTable() {
  return `
    <h4 style="margin:2rem 0 1rem;font-size:1rem">👥 Semua Respons (${state.responses.length})</h4>
    <div style="overflow-x:auto;border:1px solid var(--border);border-radius:0.75rem;overflow:hidden">
      <table class="resp-table">
        <thead><tr><th style="width:2.5rem">#</th><th>Nama</th><th>Email</th><th>Waktu</th><th style="width:6rem">Aksi</th></tr></thead>
        <tbody>
          ${state.responses.map((r,i)=>`
            <tr>
              <td style="color:var(--text-3);font-size:0.8rem">${i+1}</td>
              <td style="font-weight:500">${r.respondent_name||'—'}</td>
              <td style="color:var(--text-3)">${r.respondent_email||'—'}</td>
              <td style="font-size:0.8rem;color:var(--text-3)">${new Date(r.created_at).toLocaleString('id-ID',{day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'})}</td>
              <td><button class="btn-edit" onclick="toggleDetail(${r.id},this)">👁 Detail</button></td>
            </tr>
            <tr id="detail_${r.id}" style="display:none;background:var(--bg-2,#f8fafc)">
              <td colspan="5" style="padding:0.75rem 1.25rem">${renderAnswerDetail(r)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

function renderAnswerDetail(r) {
  const answers = r.feedback_answers || [];
  if (!answers.length) return '<em style="color:var(--text-3);font-size:0.85rem">Tidak ada jawaban tercatat.</em>';
  return `<div style="display:grid;gap:0.6rem">`+answers.map(a=>{
    const q = state.questions.find(q=>q.id===a.question_id);
    return `<div><div style="font-size:0.78rem;color:var(--text-3);margin-bottom:0.15rem">${q?q.question_text:'Pertanyaan #'+a.question_id}</div><div style="font-weight:500;font-size:0.9rem">${a.answer_value||'—'}</div></div>`;
  }).join('')+'</div>';
}

function toggleDetail(id, btn) {
  const row = document.getElementById('detail_'+id);
  if (!row) return;
  const isOpen = row.style.display !== 'none';
  row.style.display = isOpen ? 'none' : 'table-row';
  if (btn) btn.textContent = isOpen ? '👁 Detail' : '🔼 Tutup';
}

/* ══════════════════════════════════════════════════════════
   INIT
   ══════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  if (isLoggedIn()) {
    try {
      const s = JSON.parse(localStorage.getItem(ADMIN_CFG.sessionKey));
      state.adminName  = s?.name  || s?.email || 'Admin';
      state.adminEmail = s?.email || '';
      state.adminId    = s?.id    || null;
    } catch {}
    showPanel();
  } else {
    document.getElementById('loginScreen').style.display = 'flex';
    document.getElementById('adminPanel').style.display  = 'none';
    document.getElementById('adminEmail')?.addEventListener('keydown', e => { if(e.key==='Enter') login(); });
    document.getElementById('adminPassword')?.addEventListener('keydown', e => { if(e.key==='Enter') login(); });
  }
  document.getElementById('questionModal')?.addEventListener('click', e => {
    if (e.target.id === 'questionModal') closeModal();
  });
});