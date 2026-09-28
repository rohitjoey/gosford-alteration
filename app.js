firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const db = firebase.firestore();
const ordersCol = db.collection('orders');

let orders = [];
let state = { filter: 'all', search: '', view: 'list', editingId: null };
let dataReady = false;
let authState = 'checking'; // checking | out | in
let unsubscribe = null;

const STATUS_LABELS = { progress: 'In Progress', ready: 'Ready for Pickup', completed: 'Picked Up' };
const STATUS_ORDER = { ready: 0, progress: 1, completed: 2 };

function uid(){ return Date.now().toString(36) + Math.random().toString(36).slice(2,7); }

function escapeHtml(str){
  if(str===undefined || str===null) return '';
  return String(str).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function telHref(phone){
  return 'tel:' + String(phone).replace(/[^0-9+]/g,'');
}

function smsHref(phone){
  return 'sms:' + String(phone).replace(/[^0-9+]/g,'');
}

function preBuiltMessageText(name,garment){
  const message = `Hello%20${name}!I%20have%20finished%20altering%20your%20${garment?garment:"cloth"}.%20It%20is%20ready%20for%20pickup.%20Thank%20you.`
  return encodeURIComponent(message);
}

function showToast(msg){
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(()=>el.remove(), 1800);
}

/* ---------- Auth ---------- */
auth.onAuthStateChanged(user => {
  if(user){
    authState = 'in';
    subscribeOrders();
  } else {
    authState = 'out';
    dataReady = false;
    orders = [];
    if(unsubscribe){ unsubscribe(); unsubscribe = null; }
  }
  render();
});

function subscribeOrders(){
  unsubscribe = ordersCol.onSnapshot(snap => {
    orders = snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
    dataReady = true;
    render();
  }, err => {
    console.error(err);
    showToast("Couldn't load orders — check connection");
  });
}

function doSignIn(email, password, errEl){
  errEl.textContent = '';
  auth.signInWithEmailAndPassword(email, password).catch(err => {
    errEl.textContent = 'Could not sign in — check email and password.';
  });
}

/* ---------- Firestore writes ---------- */
async function saveOrder(order){
  try{
    const { id, ...data } = order;
    await ordersCol.doc(id).set(data);
  }catch(e){
    console.error(e);
    showToast("Couldn't save — try again");
  }
}

async function deleteOrder(id){
  try{
    await ordersCol.doc(id).delete();
  }catch(e){
    showToast("Couldn't delete — try again");
  }
}

function compressImage(file){
  return new Promise((resolve, reject)=>{
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        const maxDim = 480;
        let w = img.width, h = img.height;
        if(w > h && w > maxDim){ h = h*(maxDim/w); w = maxDim; }
        else if(h > maxDim){ w = w*(maxDim/h); h = maxDim; }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.7));
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function getFiltered(){
  let list = orders.slice();
  if(state.filter !== 'all'){
    list = list.filter(o => o.status === state.filter);
  }
  if(state.search.trim()){
    const q = state.search.trim().toLowerCase();
    list = list.filter(o =>
      (o.name||'').toLowerCase().includes(q) ||
      (o.phone||'').toLowerCase().includes(q) ||
      (o.garment||'').toLowerCase().includes(q)
    );
  }
  list.sort((a,b)=>{
    const s = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if(s !== 0) return s;
    return (b.updatedAt||0) - (a.updatedAt||0);
  });
  return list;
}

function counts(){
  const c = { all: orders.length, progress:0, ready:0, completed:0 };
  orders.forEach(o => c[o.status] = (c[o.status]||0) + 1);
  return c;
}

/* ---------- Render root ---------- */
function render(){
  const app = document.getElementById('app');

  if(authState === 'checking'){
    app.innerHTML = `<div class="loading">Opening the order book…</div>`;
    return;
  }
  if(authState === 'out'){
    renderLogin(app);
    return;
  }
  if(!dataReady){
    app.innerHTML = `<div class="loading">Syncing orders…</div>`;
    return;
  }
  if(state.view === 'form' || state.view === 'detail'){
    renderOverlay();
    return;
  }
  if(document.getElementById('searchInput')){
    updateListInPlace();
    return;
  }
  renderList(app);
}

function updateListInPlace(){
  renderResults();
  const c = counts();
  document.querySelectorAll('.filter-chip').forEach(chip=>{
    const countEl = chip.querySelector('.count');
    if(countEl) countEl.textContent = c[chip.dataset.filter] ?? 0;
    chip.classList.toggle('active', chip.dataset.filter === state.filter);
  });
}

function renderLogin(app){
  app.innerHTML = `
    <div class="login-wrap">
      <div class="login-card">
        <h1>Gosford Alterations</h1>
        <p class="sub">Sign in to open the order book</p>
        <div class="login-error" id="loginErr"></div>
        <input type="email" id="loginEmail" placeholder="Email" autocomplete="username" />
        <input type="password" id="loginPass" placeholder="Password" autocomplete="current-password" />
        <button id="loginBtn">Sign in</button>
      </div>
    </div>
  `;
  const errEl = document.getElementById('loginErr');
  document.getElementById('loginBtn').onclick = () => {
    doSignIn(document.getElementById('loginEmail').value.trim(), document.getElementById('loginPass').value, errEl);
  };
  document.getElementById('loginPass').onkeydown = (e) => {
    if(e.key === 'Enter') document.getElementById('loginBtn').click();
  };
}

function renderList(app){
  const list = getFiltered();
  const c = counts();

  app.innerHTML = `
    <header class="topbar">
      <div class="brand">
       <h1>Gosford<span class="stitch"></span>Alterations</h1>
        <div class="header-actions">
          <button class="add-btn" id="btnAdd">+ New order</button>
        </div>
      </div>
      <div class="search-row">
        <input type="text" id="searchInput" placeholder="Search name, phone, or garment" value="${escapeHtml(state.search)}" />
      </div>
      <div class="filters">
        ${filterChip('all','All', c.all)}
        ${filterChip('ready','Ready for pickup', c.ready)}
        ${filterChip('progress','In progress', c.progress)}
        ${filterChip('completed','Picked up', c.completed)}
      </div>
      <div class="sync-note">Synced • <button class="signout-link" id="btnSignOut">Sign out</button></div>
    </header>
    <main>
      ${list.length === 0 ? renderEmpty() : list.map(renderCard).join('')}
    </main>
  `;

  document.getElementById('btnAdd').onclick = () => openForm(null);
  document.getElementById('btnSignOut').onclick = () => auth.signOut();
  document.getElementById('searchInput').oninput = (e) => {
    state.search = e.target.value;
    renderResults();
  };
  document.querySelectorAll('.filter-chip').forEach(chip=>{
    chip.onclick = () => { state.filter = chip.dataset.filter; render(); };
  });
  attachCardHandlers();
}

function renderResults(){
  const main = document.querySelector('main');
  if(!main) return;
  const list = getFiltered();
  main.innerHTML = list.length === 0
    ? renderEmpty()
    : list.map(renderCard).join('');
  attachCardHandlers();
}

function attachCardHandlers(){
  document.querySelectorAll('.order-card').forEach(card=>{
    card.onclick = (e) => {
      if(e.target.closest('.call-btn') || e.target.closest('.advance-btn')) return;
      openDetail(card.dataset.id);
    };
  });
  document.querySelectorAll('.advance-btn').forEach(btn=>{
    btn.onclick = (e) => { e.stopPropagation(); advanceStatus(btn.dataset.id); };
  });
}

function filterChip(key, label, count){
  return `<button class="filter-chip ${state.filter===key?'active':''}" data-filter="${key}">${label}<span class="count">${count}</span></button>`;
}

function renderEmpty(){
  if(state.search || state.filter !== 'all'){
    return `<div class="empty-state"><h2>No matches</h2><p>Try a different search or filter.</p></div>`;
  }
  return `<div class="empty-state">
    <h2>No orders yet</h2>
    <p>Add your first client's order — contact details, dress photo, measurements and price all in one place.</p>
  </div>`;
}

function renderCard(o){
  const nextLabel = o.status === 'progress' ? '→ Ready' : (o.status === 'ready' ? '→ Picked up' : '');
  return `
    <div class="order-card" data-id="${o.id}">
      ${o.photo ? `<img class="thumb" src="${o.photo}" alt="">` : `<div class="thumb">🧵</div>`}
      <div class="order-info">
        <div class="order-top">
          <p class="order-name">${escapeHtml(o.name)}</p>
          <span class="order-price">${o.price ? '$'+escapeHtml(o.price) : ''}</span>
        </div>
        <p class="order-garment">${escapeHtml(o.garment)}</p>
        <div class="order-bottom">
          <span class="status-badge status-${o.status}">${STATUS_LABELS[o.status]}</span>
          <div class="card-actions">
            ${nextLabel ? `<button class="icon-btn advance-btn" data-id="${o.id}">${nextLabel}</button>` : ''}
            <a class="icon-btn call-btn" href="${smsHref(o.phone)}?body=${preBuiltMessageText(o.name,o.garment)}" title="Text ${escapeHtml(o.name)}">💬</a>
          </div>
        </div>
      </div>
    </div>
  `;
}

function advanceStatus(id){
  const o = orders.find(x=>x.id===id);
  if(!o) return;
  const next = o.status === 'progress' ? 'ready' : (o.status === 'ready' ? 'completed' : o.status);
  const updated = Object.assign({}, o, { status: next, updatedAt: Date.now() });
  saveOrder(updated);
  showToast(next === 'ready' ? "Marked ready — time to call " + o.name : "Marked picked up");
}

/* ---------- Form / Detail overlay ---------- */

let draftPhoto = null;

function openForm(id){
  state.view = 'form';
  state.editingId = id;
  draftPhoto = id ? (orders.find(o=>o.id===id)||{}).photo || null : null;
  render();
}

function openDetail(id){
  state.view = 'detail';
  state.editingId = id;
  render();
}

function closeOverlay(){
  state.view = 'list';
  state.editingId = null;
  draftPhoto = null;
  render();
}

function renderOverlay(){
  const app = document.getElementById('app');
  if(state.view === 'detail'){
    renderDetailOverlay(app);
  } else {
    renderFormOverlay(app);
  }
}

function renderDetailOverlay(app){
  const o = orders.find(x=>x.id===state.editingId);
  if(!o){ closeOverlay(); return; }
  const stages = ['progress','ready','completed'];
  const idx = stages.indexOf(o.status);

  app.innerHTML = `
    <div class="overlay">
      <div class="overlay-header">
        <button class="text-btn" id="btnClose">Close</button>
        <h2>${escapeHtml(o.name)}</h2>
        <button class="text-btn save-btn" id="btnEdit">Edit</button>
      </div>
      <div class="overlay-body">
        ${o.photo ? `<img class="photo-preview" style="width:100%;height:180px;border-radius:12px;margin-bottom:16px;" src="${o.photo}">` : ''}

        <div class="pipeline">
          <div class="dot ${idx>=0?'done':''}"></div>
          <div class="seg ${idx>=1?'done':''}"></div>
          <div class="dot ${idx>=1?'done':''}"></div>
          <div class="seg ${idx>=2?'done':''}"></div>
          <div class="dot ${idx>=2?'done':''}"></div>
        </div>
        <div class="pipeline-labels"><span>In progress</span><span>Ready</span><span>Picked up</span></div>

        <a class="detail-call" href="${smsHref(o.phone)}?body=${preBuiltMessageText(o.name,o.garment)}">💬 Text ${escapeHtml(o.name)}</a>

        <div class="status-actions">
          <button data-s="progress" class="${o.status==='progress'?'active':''}">In progress</button>
          <button data-s="ready" class="${o.status==='ready'?'active':''}">Ready</button>
          <button data-s="completed" class="${o.status==='completed'?'active':''}">Picked up</button>
        </div>

        <div class="detail-row"><span>Phone</span><span>${escapeHtml(o.phone)}</span></div>
        <div class="detail-row"><span>Garment / job</span><span>${escapeHtml(o.garment)}</span></div>
        <div class="detail-row"><span>Price estimate</span><span>${o.price ? '$'+escapeHtml(o.price) : '—'}</span></div>
        ${o.measurements && Object.values(o.measurements).some(v=>v) ? `
          <div class="section-label" style="margin-top:18px;">Measurements</div>
          ${['bust','waist','hips','shoulder','sleeve','length'].filter(k=>o.measurements[k]).map(k=>
            `<div class="detail-row"><span>${k.charAt(0).toUpperCase()+k.slice(1)}</span><span>${escapeHtml(o.measurements[k])}</span></div>`
          ).join('')}
        ` : ''}
        ${o.measurements && o.measurements.notes ? `<div class="detail-row"><span>Fit notes</span><span>${escapeHtml(o.measurements.notes)}</span></div>` : ''}
        ${o.notes ? `<div class="detail-row"><span>Other notes</span><span>${escapeHtml(o.notes)}</span></div>` : ''}

        <button class="danger-btn" id="btnDelete">Delete order</button>
      </div>
    </div>
  `;
  document.getElementById('btnClose').onclick = closeOverlay;
  document.getElementById('btnEdit').onclick = () => openForm(o.id);
  document.querySelectorAll('.status-actions button').forEach(btn=>{
    btn.onclick = () => {
      const updated = Object.assign({}, o, { status: btn.dataset.s, updatedAt: Date.now() });
      saveOrder(updated);
    };
  });
  document.getElementById('btnDelete').onclick = () => {
    if(confirm(`Delete the order for ${o.name}? This can't be undone.`)){
      deleteOrder(o.id);
      closeOverlay();
      showToast('Order deleted');
    }
  };
}

function renderFormOverlay(app){
  const editing = state.editingId ? orders.find(o=>o.id===state.editingId) : null;
  const m = (editing && editing.measurements) || {};

  app.innerHTML = `
    <div class="overlay">
      <div class="overlay-header">
        <button class="text-btn" id="btnCancel">Cancel</button>
        <h2>${editing ? 'Edit order' : 'New order'}</h2>
        <button class="text-btn save-btn" id="btnSave">Save</button>
      </div>
      <div class="overlay-body">
        <div class="field">
          <label>Client name</label>
          <input type="text" id="fName" value="${escapeHtml(editing?editing.name:'')}" placeholder="e.g. Priya Nair" />
        </div>
        <div class="field">
          <label>Phone number</label>
          <input type="tel" id="fPhone" value="${escapeHtml(editing?editing.phone:'')}" placeholder="e.g. 04XX XXX XXX" />
        </div>
        <div class="field">
          <label>Garment / job</label>
          <textarea id="fGarment" placeholder="e.g. Navy blue evening gown — hem and waist take-in">${escapeHtml(editing?editing.garment:'')}</textarea>
        </div>
        <div class="field">
          <label>Photo</label>
          <div class="photo-row">
            ${draftPhoto ? `<img class="photo-preview" id="photoPreview" src="${draftPhoto}">` : `<div class="photo-placeholder" id="photoPreview">🧵</div>`}
            <label class="file-label">Choose photo
              <input type="file" accept="image/*" capture="environment" id="fPhoto" />
            </label>
          </div>
        </div>
        <div class="field">
          <label>Price estimate ($)</label>
          <input type="number" inputmode="decimal" id="fPrice" value="${editing&&editing.price?editing.price:''}" placeholder="e.g. 45" />
        </div>

        <div class="section-label">Measurements (optional)</div>
        <div class="measure-grid">
          <div class="field"><label>Bust / Chest</label><input type="text" id="mBust" value="${escapeHtml(m.bust||'')}"></div>
          <div class="field"><label>Waist</label><input type="text" id="mWaist" value="${escapeHtml(m.waist||'')}"></div>
          <div class="field"><label>Hips</label><input type="text" id="mHips" value="${escapeHtml(m.hips||'')}"></div>
          <div class="field"><label>Shoulder</label><input type="text" id="mShoulder" value="${escapeHtml(m.shoulder||'')}"></div>
          <div class="field"><label>Sleeve</label><input type="text" id="mSleeve" value="${escapeHtml(m.sleeve||'')}"></div>
          <div class="field"><label>Length</label><input type="text" id="mLength" value="${escapeHtml(m.length||'')}"></div>
        </div>
        <div class="field">
          <label>Fit notes</label>
          <textarea id="mNotes" placeholder="e.g. Take in 2cm at waist, keep hem length">${escapeHtml(m.notes||'')}</textarea>
        </div>

        <div class="field">
          <label>Other notes</label>
          <textarea id="fNotes" placeholder="Anything else to remember">${escapeHtml(editing?editing.notes:'')}</textarea>
        </div>
      </div>
    </div>
  `;

  document.getElementById('btnCancel').onclick = closeOverlay;
  document.getElementById('fPhoto').onchange = async (e) => {
    const file = e.target.files[0];
    if(!file) return;
    try{
      draftPhoto = await compressImage(file);
      const prev = document.getElementById('photoPreview');
      const img = document.createElement('img');
      img.className = 'photo-preview';
      img.id = 'photoPreview';
      img.src = draftPhoto;
      prev.replaceWith(img);
    }catch(err){
      showToast("Couldn't load that photo");
    }
  };
  document.getElementById('btnSave').onclick = () => {
    const name = document.getElementById('fName').value.trim();
    const phone = document.getElementById('fPhone').value.trim();
    const garment = document.getElementById('fGarment').value.trim();
    if(!name || !phone){
      showToast('Please add a name and phone number');
      return;
    }
    const data = {
      name, phone, garment,
      price: document.getElementById('fPrice').value.trim(),
      photo: draftPhoto,
      measurements: {
        bust: document.getElementById('mBust').value.trim(),
        waist: document.getElementById('mWaist').value.trim(),
        hips: document.getElementById('mHips').value.trim(),
        shoulder: document.getElementById('mShoulder').value.trim(),
        sleeve: document.getElementById('mSleeve').value.trim(),
        length: document.getElementById('mLength').value.trim(),
        notes: document.getElementById('mNotes').value.trim(),
      },
      notes: document.getElementById('fNotes').value.trim(),
      updatedAt: Date.now(),
    };
    const record = editing
      ? Object.assign({}, editing, data)
      : Object.assign({ id: uid(), status: 'progress', createdAt: Date.now() }, data);

    saveOrder(record);
    showToast(editing ? 'Order updated' : 'Order added');
    state.view = 'list';
    state.editingId = null;
    draftPhoto = null;
    render();
  };
}

render();
